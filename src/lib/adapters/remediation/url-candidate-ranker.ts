/**
 * URL-candidate ranker — pure helpers for the Adapter Doctor.
 *
 * The Doctor is a continuous worker that tries to fix "dormant" adapters —
 * adapters pointed at a landing page that returns 0 rows because the actual
 * machine-readable data lives on a sub-page (bulk-download, API, CSV, etc.).
 * This module is the pure/testable half: given some landing HTML and a base
 * URL, extract the outbound links, score them, and return a ranked list of
 * candidate remediation URLs.
 *
 * Kept in its own file (not inside `scripts/`) because
 *   1. the scripts glob is excluded from tsconfig so tests that import from
 *      there would not be type-checked by `npx tsc --noEmit`; and
 *   2. pure functions + fixture-driven assertions pair naturally with
 *      node:test. See `./__tests__/url-candidate-ranker.test.ts`.
 *
 * Zero new npm deps. `cheerio` is already in package.json for the per-state
 * CF adapters.
 */

import { load as loadHtml } from 'cheerio';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Rough bucket for why we think this URL is interesting. */
export type CandidateKind =
  | 'bulk_download'          // anchor/href points to .zip/.csv/.xlsx/.json/.xml
  | 'exact_phrase_match'     // anchor text matches a well-known data phrase
  | 'subdomain_hint'         // host looks like data.*/api.* / open.*
  | 'aspx_form'              // ASP.NET .aspx — likely needs POST from the form
  | 'keyword_match'          // anchor/href contains one of our keywords
  | 'generic';               // fallback; url looked somewhat interesting

export type UrlCandidate = {
  url: string;
  anchorText: string;
  kind: CandidateKind;
  score: number;
  /** Raw reasons that contributed — shown in the proposal evidence. */
  reasons: string[];
};

// ---------------------------------------------------------------------------
// Keyword / phrase tables
// ---------------------------------------------------------------------------

/** Keyword set used by the coarse `keyword_match` bucket (anchor text / href). */
export const DOCTOR_KEYWORDS: readonly string[] = [
  'data',
  'download',
  'export',
  'bulk',
  'api',
  'filings',
  'contributions',
  'expenditures',
  'reports',
  'search',
  'disclosure',
  'disclosures',
  'campaign finance',
  'cf',
  'pac',
  'candidate',
  'committee',
] as const;

/**
 * Anchor-text strings that almost always mean "the data is here". Matched
 * case-insensitively but otherwise exactly (after trim + collapse of internal
 * whitespace).
 */
export const DOCTOR_EXACT_PHRASES: readonly string[] = [
  'data download',
  'bulk data',
  'bulk download',
  'bulk downloads',
  'export',
  'reports',
  'download data',
  'data exports',
  'data portal',
  'open data',
  'campaign finance data',
  'contribution data',
  'expenditure data',
  'filings search',
  'search filings',
  'view filings',
  'public search',
  'api',
  'developer api',
] as const;

/** Regex fragments for "subdomain hint" hosts. */
export const SUBDOMAIN_PATTERNS: readonly RegExp[] = [
  /^data\./i,
  /^open-?data\./i,
  /^api\./i,
  /^developer\./i,
  /^reports?\./i,
  /^disclosures?\./i,
  /^campaignfinance\./i,
  /^cf\./i,
] as const;

/** File extensions that signal bulk data. */
export const BULK_EXTENSIONS: readonly string[] = [
  '.zip',
  '.csv',
  '.tsv',
  '.xlsx',
  '.xls',
  '.json',
  '.jsonl',
  '.xml',
  '.txt',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize anchor text: trim + collapse internal whitespace + lowercase. */
export function normalizeAnchorText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Resolve a possibly-relative href against the base URL. Returns null if the
 * href can't be parsed or ends up on a non-http(s) scheme (mailto:, tel:, JS).
 */
export function resolveHref(href: string, baseUrl: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  // Reject common non-fetchable schemes up front.
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('#')
  ) {
    return null;
  }
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    // Strip fragment identifiers — they don't change what the server returns.
    resolved.hash = '';
    return resolved.toString();
  } catch {
    return null;
  }
}

/** True if the URL path ends with one of our bulk extensions. */
export function hasBulkExtension(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return BULK_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

/** True if the URL path ends with .aspx (ASP.NET form — usually needs POST). */
export function isAspxLink(url: string): boolean {
  try {
    return /\.aspx(?:$|\?)/i.test(new URL(url).pathname + new URL(url).search);
  } catch {
    return false;
  }
}

/** True if the URL host matches one of our "subdomain hint" patterns. */
export function hasSubdomainHint(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase();
    return SUBDOMAIN_PATTERNS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

/** True if the anchor text exactly matches a known-good phrase. */
export function matchesExactPhrase(anchorText: string): boolean {
  const n = normalizeAnchorText(anchorText);
  return DOCTOR_EXACT_PHRASES.some((p) => p === n);
}

/** Return the list of keywords matching either anchor text or href path/query. */
export function keywordsHit(anchorText: string, url: string): string[] {
  const rawHaystack = (() => {
    try {
      const u = new URL(url);
      return `${normalizeAnchorText(anchorText)} ${u.pathname} ${u.search}`.toLowerCase();
    } catch {
      return normalizeAnchorText(anchorText);
    }
  })();
  // URL paths use hyphens/underscores where anchor text uses spaces. Build a
  // second haystack with separators normalized to spaces so "campaign finance"
  // matches `/campaign-finance/` as well as "Campaign Finance".
  const normalizedHaystack = rawHaystack.replace(/[-_/]+/g, ' ');
  const hits: string[] = [];
  for (const kw of DOCTOR_KEYWORDS) {
    if (rawHaystack.includes(kw) || normalizedHaystack.includes(kw)) hits.push(kw);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single (anchorText, url) pair. Higher = more likely to be the real
 * data URL. Returns null if nothing about the candidate is interesting — the
 * caller drops it.
 */
export function scoreCandidate(
  anchorText: string,
  url: string,
): UrlCandidate | null {
  const reasons: string[] = [];
  let score = 0;
  let kind: CandidateKind = 'generic';

  const bulk = hasBulkExtension(url);
  if (bulk) {
    score += 100;
    kind = 'bulk_download';
    reasons.push('path ends with a bulk-data extension');
  }

  if (matchesExactPhrase(anchorText)) {
    score += 60;
    if (kind === 'generic') kind = 'exact_phrase_match';
    reasons.push(`anchor text matches exact phrase "${normalizeAnchorText(anchorText)}"`);
  }

  if (hasSubdomainHint(url)) {
    score += 40;
    if (kind === 'generic') kind = 'subdomain_hint';
    reasons.push('host looks like a data/api subdomain');
  }

  const kwHits = keywordsHit(anchorText, url);
  if (kwHits.length > 0) {
    // Cap at 4 hits to keep the total score bounded; diminishing returns
    // past that — a link with 10 keyword hits isn't 10x better than one
    // with 4, it's more likely to be a nav sidebar with every link on it.
    const effective = Math.min(kwHits.length, 4);
    score += effective * 8;
    if (kind === 'generic') kind = 'keyword_match';
    reasons.push(`keyword hits: ${kwHits.slice(0, 6).join(',')}`);
  }

  if (isAspxLink(url)) {
    // ASP.NET forms often need POST — we still surface them (the human
    // reviewer can decide), but rank them lower than a plain bulk .zip.
    score += 12;
    if (kind === 'generic') kind = 'aspx_form';
    reasons.push('.aspx — likely needs POST from search form');
  }

  if (score === 0) return null;

  return {
    url,
    anchorText: normalizeAnchorText(anchorText),
    kind,
    score,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Landing-page extractor
// ---------------------------------------------------------------------------

export type ExtractOptions = {
  /** Base URL for resolving relative hrefs. Usually the fetched URL. */
  baseUrl: string;
  /** Cap on how many candidates to return. Default 50. */
  maxCandidates?: number;
  /** If true, also include FORM action URLs. Default true. */
  includeForms?: boolean;
};

/**
 * Extract & rank candidate remediation URLs from a landing-page HTML body.
 *
 * Deduplicates on the resolved URL (keeping the highest-scoring anchor text
 * for each unique URL) and returns the top `maxCandidates` by score, descending.
 *
 * Same-origin filtering is deliberately NOT enforced: the real data URL for
 * some portals lives on a sibling subdomain (e.g. data.example.gov vs
 * www.example.gov). The caller can filter further if they want to be strict.
 */
export function extractCandidatesFromHtml(
  html: string,
  opts: ExtractOptions,
): UrlCandidate[] {
  if (!html || html.length < 16) return [];
  const $ = loadHtml(html);
  const maxCandidates = opts.maxCandidates ?? 50;
  const includeForms = opts.includeForms ?? true;
  const byUrl = new Map<string, UrlCandidate>();

  const register = (cand: UrlCandidate | null): void => {
    if (!cand) return;
    const prev = byUrl.get(cand.url);
    if (!prev || cand.score > prev.score) {
      byUrl.set(cand.url, cand);
    } else if (prev && cand.anchorText && !prev.anchorText) {
      // Keep old score but fill in better anchor text
      byUrl.set(cand.url, { ...prev, anchorText: cand.anchorText });
    }
  };

  $('a[href]').each((_i, el) => {
    const $el = $(el);
    const href = $el.attr('href') ?? '';
    const text = $el.text() ?? '';
    const url = resolveHref(href, opts.baseUrl);
    if (!url) return;
    register(scoreCandidate(text, url));
  });

  if (includeForms) {
    $('form[action]').each((_i, el) => {
      const $el = $(el);
      const action = $el.attr('action') ?? '';
      // Try several plausible "labels" for the form: submit button value,
      // form id, or the first heading/legend inside the form.
      const submitText =
        $el.find('input[type=submit],button[type=submit]').first().attr('value') ??
        $el.find('button[type=submit]').first().text() ??
        $el.attr('id') ??
        $el.find('legend,h1,h2,h3').first().text() ??
        '';
      const url = resolveHref(action, opts.baseUrl);
      if (!url) return;
      const scored = scoreCandidate(submitText, url);
      // Even a bare form with no useful submit text should surface at
      // low score if it's .aspx — that's the most common ASP.NET pattern.
      if (scored) {
        register(scored);
      } else if (isAspxLink(url)) {
        register({
          url,
          anchorText: normalizeAnchorText(submitText),
          kind: 'aspx_form',
          score: 8,
          reasons: ['form action on .aspx page'],
        });
      }
    });
  }

  return Array.from(byUrl.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);
}

/**
 * Guess a state abbreviation from an adapter name. Adapter names are of the
 * form `cf-${sourceName}` (see state-cf/shared/base.ts). Most source names
 * include either the lowercase state abbr (`ut-disclosures-cf`) or the full
 * state name (`indiana-cfa`, `utah-sunshine`).
 *
 * Returns lowercase two-letter abbr or null.
 */
export function guessStateFromAdapterName(adapterName: string): string | null {
  const name = adapterName.toLowerCase();
  // Strip the "cf-" prefix the runner adds.
  const body = name.replace(/^cf-/, '');
  // Also build a separator-stripped form so "north-dakota" matches
  // STATE_NAME_TO_ABBR's "northdakota".
  const bodyStripped = body.replace(/[-_\s]+/g, '');

  // (1) Leading two-letter token: "ut-", "ca-", "ny-"...
  const lead = /^([a-z]{2})(?:-|$)/.exec(body);
  if (lead) {
    const abbr = lead[1];
    if (STATE_ABBRS.has(abbr)) return abbr;
  }

  // (2) Full state-name substring (hyphens stripped both sides).
  for (const [fullName, abbr] of STATE_NAME_TO_ABBR.entries()) {
    if (bodyStripped.includes(fullName)) return abbr;
  }
  return null;
}

const STATE_NAME_TO_ABBR = new Map<string, string>([
  ['alabama', 'al'], ['alaska', 'ak'], ['arizona', 'az'], ['arkansas', 'ar'],
  ['california', 'ca'], ['colorado', 'co'], ['connecticut', 'ct'],
  ['delaware', 'de'], ['florida', 'fl'], ['georgia', 'ga'],
  ['hawaii', 'hi'], ['idaho', 'id'], ['illinois', 'il'], ['indiana', 'in'],
  ['iowa', 'ia'], ['kansas', 'ks'], ['kentucky', 'ky'], ['louisiana', 'la'],
  ['maine', 'me'], ['maryland', 'md'], ['massachusetts', 'ma'],
  ['michigan', 'mi'], ['minnesota', 'mn'], ['mississippi', 'ms'],
  ['missouri', 'mo'], ['montana', 'mt'], ['nebraska', 'ne'],
  ['nevada', 'nv'], ['newhampshire', 'nh'], ['newjersey', 'nj'],
  ['newmexico', 'nm'], ['newyork', 'ny'], ['northcarolina', 'nc'],
  ['northdakota', 'nd'], ['ohio', 'oh'], ['oklahoma', 'ok'],
  ['oregon', 'or'], ['pennsylvania', 'pa'], ['rhodeisland', 'ri'],
  ['southcarolina', 'sc'], ['southdakota', 'sd'], ['tennessee', 'tn'],
  ['texas', 'tx'], ['utah', 'ut'], ['vermont', 'vt'], ['virginia', 'va'],
  ['washington', 'wa'], ['westvirginia', 'wv'], ['wisconsin', 'wi'],
  ['wyoming', 'wy'], ['districtofcolumbia', 'dc'],
]);

const STATE_ABBRS = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga',
  'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md',
  'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
  'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc',
  'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy',
  'dc',
]);
