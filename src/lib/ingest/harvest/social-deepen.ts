/**
 * social-deepen.ts -- Build 5 candidate-centric social DEEPENING (ToS-safe).
 *
 * GOAL: go beyond the one-line profile blurb we already store for a candidate's
 * OWN social accounts and capture ISSUE-relevant material -- pinned posts, the
 * full bio / "about", and recent issue-bearing posts -- WHERE the existing fetch
 * tiers already return it, WITHOUT ever doing logged-in scraping or anything a
 * platform's terms forbid.
 *
 * HOW IT STAYS COMPLIANT + HONEST ABOUT COVERAGE:
 *   - We fetch ONLY a candidate's OWN, already-attributed social URLs (the ones
 *     discover-sources.ts surfaced from our database -- so the person bind is
 *     authoritative). We never discover new accounts here.
 *   - We use ONLY what the plain page fetch (smart_fetch) returns for a
 *     logged-OUT request. No login, no cookies,
 *     no API tokens, no platform scraping endpoints.
 *   - LOGIN WALLS ARE SKIPPED. Most large platforms (Instagram, X/Twitter,
 *     Facebook, TikTok, LinkedIn) return a login/consent wall to a logged-out
 *     fetch and almost no public post text. We DETECT that wall and SKIP -- we
 *     do not pretend we extracted content we could not legally reach. Coverage
 *     is therefore real-but-partial and concentrated on open platforms
 *     (a candidate's Linktree, a Mastodon/Bluesky-style profile, a YouTube
 *     channel "about", an open blog), which is the honest state of the world.
 *   - Extracted content is emitted as candidate-centric raw_evidence through the
 *     EXISTING ingest path (ingestOne, person-bound), NOT the source-centric
 *     runner -- a candidate's own social posts are one-to-one, not one-to-many.
 *
 * Single TypeScript runtime, no Python, no new deps. The extraction is a small
 * deterministic HTML/text parse (PURE + exported for the offline test); the
 * fetch + ingest are injectable so the test runs fully offline.
 */

import type { Client } from 'pg';
import { ingestOne, type IngestResult } from '../raw-ingest';
import { runPageFetch } from '@/lib/agent-tools/page-fetch';
import { discoverSourcesForPerson, type QueryClient } from '../discover-sources';

// ---------------------------------------------------------------------------
// Login-wall detection + issue-relevant extraction (PURE; exported for tests).
// ---------------------------------------------------------------------------

/**
 * Signals that a logged-OUT fetch hit a login / consent / age wall rather than
 * public content. Conservative on purpose: a false "wall" just skips a page
 * (safe), while a false "content" could store a wall page as if it were the
 * candidate's words (bad). When in doubt we SKIP.
 */
const LOGIN_WALL_SIGNALS: RegExp[] = [
  /log\s*in\s+to\s+(see|continue|view|instagram|facebook|x|twitter|tiktok)/i,
  /sign\s*up\s+to\s+see/i,
  /you\s+must\s+log\s+in/i,
  /create\s+an?\s+account\s+to\s+(see|continue)/i,
  /this\s+content\s+isn'?t\s+available/i,
  /\benable\s+javascript\b.*\bto\s+(use|continue)\b/i,
  /\bcontent\s+is\s+blocked\b/i,
  /\bage[-\s]?restricted\b/i,
  /please\s+(log\s*in|sign\s*in)\s+to\s+continue/i,
];

/** Phrases that mark a chunk of text as ISSUE-relevant (vs. logistics chatter). */
const ISSUE_SIGNALS: RegExp[] = [
  /\b(issue|issues|policy|policies|platform|priorities|stance|position)\b/i,
  /\b(tax|taxes|spending|budget|economy|jobs|wages)\b/i,
  /\b(healthcare|health\s+care|abortion|reproductive)\b/i,
  /\b(immigration|border)\b/i,
  /\b(education|schools?|teachers?)\b/i,
  /\b(gun|guns|second\s+amendment|firearm)\b/i,
  /\b(climate|environment|energy|water|public\s+lands?)\b/i,
  /\b(crime|police|public\s+safety|justice)\b/i,
  /\b(housing|zoning|development|transit|transportation|roads?)\b/i,
  /\b(vote\s+for|i\s+will|i\s+support|i\s+oppose|i\s+believe|we\s+must|we\s+need)\b/i,
];

/** One extracted issue-bearing chunk (a bio line, a pinned post, a post body). */
export interface ExtractedChunk {
  kind: 'bio' | 'pinned' | 'post';
  text: string;
}

/** Result of running the extractor over one fetched social page. */
export interface SocialExtraction {
  /** True when the page was a login/consent/age wall -> caller SKIPS it. */
  loginWall: boolean;
  /** The profile bio / about text, when found. */
  bio: string | null;
  /** Issue-bearing chunks (pinned + posts), deduped, longest-first. */
  chunks: ExtractedChunk[];
  /** True when at least one issue-relevant chunk (or issue bio) was extracted. */
  hasIssueContent: boolean;
  /** Human-readable note on what happened (for the CLI log). */
  note: string;
}

/** Strip HTML tags + collapse whitespace into readable plain text. */
function htmlToText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when ANY login-wall signal fires on the raw body or its plain text. */
function isLoginWall(raw: string, text: string): boolean {
  const probe = `${text}\n${raw.slice(0, 4000)}`;
  return LOGIN_WALL_SIGNALS.some((re) => re.test(probe));
}

/** True when a chunk reads as issue-relevant (matches >=1 issue signal). */
export function isIssueRelevant(text: string): boolean {
  return ISSUE_SIGNALS.some((re) => re.test(text));
}

/**
 * Pull a bio / "about" line. We look for an og:description / twitter:description
 * meta tag (the open, logged-out-visible profile summary) plus a textual "about"
 * heading section, and prefer the longer of the two.
 */
function extractBio(raw: string, text: string): string | null {
  const metas = [
    /<meta[^>]+(?:property|name)=["'](?:og:description|twitter:description|description)["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:description|twitter:description|description)["']/i,
  ];
  let best: string | null = null;
  for (const re of metas) {
    const m = raw.match(re);
    if (m && m[1] && m[1].trim().length > (best?.length ?? 0)) best = htmlToText(m[1]).trim();
  }
  // An "about" paragraph in the visible text (first long line after an About heading).
  const aboutIdx = text.search(/\babout\b/i);
  if (aboutIdx >= 0) {
    const after = text.slice(aboutIdx, aboutIdx + 600).split('\n').map((l) => l.trim()).filter(Boolean);
    const para = after.find((l) => l.length > (best?.length ?? 0) && l.length > 40);
    if (para && para.length > (best?.length ?? 0)) best = para;
  }
  return best && best.length >= 20 ? best : best;
}

/**
 * extractSocialIssueContent -- PURE. Given a fetched social page body (the raw
 * fetch text, which may be HTML or Jina-rendered markdown) and the platform,
 * return the login-wall verdict + the bio + the issue-relevant chunks.
 *
 * EXPORTED for the offline test: feed it a page with issue posts (expect
 * chunks) and a login-wall page (expect loginWall=true, no chunks).
 */
export function extractSocialIssueContent(
  body: string,
  platform: string | null,
): SocialExtraction {
  const raw = body ?? '';
  const text = htmlToText(raw) || raw.trim();

  if (isLoginWall(raw, text)) {
    return {
      loginWall: true,
      bio: null,
      chunks: [],
      hasIssueContent: false,
      note: `login/consent wall detected${platform ? ` on ${platform}` : ''}; skipped (no logged-in scraping)`,
    };
  }

  const bio = extractBio(raw, text);

  // Candidate chunks: paragraphs / lines of reasonable length from the text.
  const rawChunks = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 40 && l.length <= 1200);

  // Keep only issue-relevant chunks, dedup, longest-first, cap the count.
  const seen = new Set<string>();
  const issueChunks: ExtractedChunk[] = [];
  for (const c of rawChunks) {
    if (!isIssueRelevant(c)) continue;
    const key = c.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    issueChunks.push({ kind: 'post', text: c });
  }
  issueChunks.sort((a, b) => b.text.length - a.text.length);
  const chunks = issueChunks.slice(0, 12);

  // A bio that itself reads as issue-relevant becomes a 'bio' chunk up front.
  if (bio && isIssueRelevant(bio)) {
    chunks.unshift({ kind: 'bio', text: bio });
  }

  const hasIssueContent = chunks.length > 0;
  return {
    loginWall: false,
    bio,
    chunks,
    hasIssueContent,
    note: hasIssueContent
      ? `extracted ${chunks.length} issue-relevant chunk(s)${bio ? ' + bio' : ''}`
      : `page reachable but no issue-relevant content found${bio ? ' (bio only)' : ''}`,
  };
}

/**
 * Compose the extracted chunks into a single deepened-social document. The bio
 * leads, then each post chunk, each labeled by kind + its source URL so the
 * provenance trail ("found on the candidate's <platform>") survives.
 */
export function composeDeepenedDocument(
  url: string,
  platform: string | null,
  extraction: SocialExtraction,
): string {
  const head = `Deepened social content from the candidate's own ${platform ?? 'social'} account.\nSource: ${url}`;
  const parts: string[] = [head];
  for (const c of extraction.chunks) {
    parts.push(`[${c.kind}] ${c.text}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// The fetch (injectable). Default: smart_fetch (plain HTTP).
// ---------------------------------------------------------------------------

export type SocialFetchImpl = (url: string) => Promise<string>;

/** Default fetch: smart_fetch's tiers, body only (the same tiers ingest uses). */
async function defaultSocialFetch(url: string): Promise<string> {
  try {
    const res = await runPageFetch({ url });
    if (res.isError) return '';
    const body = res.content?.[0]?.text ?? '';
    // smart_fetch prepends a "<!-- smart_fetch: ... -->" banner; strip it for
    // the wall/issue probe (the banner is metadata, not page content).
    return body.replace(/^<!--\s*smart_fetch:[^>]*-->\n?/, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// deepenSocialsForPerson -- the public entry point.
// ---------------------------------------------------------------------------

export interface DeepenSocialsOpts {
  /** Default false. When false, NO writes (dry-run; ingestOne dry-runs too). */
  apply?: boolean;
  /** Injected fetch for OFFLINE TESTS. Defaults to smart_fetch. */
  fetchImpl?: SocialFetchImpl;
  /** Injected ingestOne for OFFLINE TESTS. Defaults to the real ingestOne. */
  ingestImpl?: typeof ingestOne;
  /** Cap on social URLs probed per person (politeness). Default 8. */
  maxUrls?: number;
}

/** Per-URL outcome of the deepening pass. */
export interface SocialDeepenUnit {
  url: string;
  platform: string | null;
  /** 'ingested' (content found + ingested), 'login_wall', 'no_issue_content', 'fetch_failed'. */
  outcome: 'ingested' | 'login_wall' | 'no_issue_content' | 'fetch_failed';
  chunks: number;
  bind_confidence: number;
  /** ingestOne result when we ingested (else null). */
  ingest?: IngestResult | null;
  detail: string;
}

export interface DeepenSocialsResult {
  person_id: string;
  dry_run: boolean;
  social_urls_considered: number;
  ingested: number;
  login_walls: number;
  no_issue_content: number;
  fetch_failed: number;
  units: SocialDeepenUnit[];
  /** Honest coverage note (which platforms returned content vs walls). */
  coverage_note: string;
  notes: string[];
}

/**
 * deepenSocialsForPerson -- for a person already in the DB, fetch each of their
 * OWN already-attributed social URLs (logged-out), extract issue-relevant
 * content where the fetch tiers return it, skip login walls, and emit the found
 * content as candidate-centric raw_evidence via ingestOne (person-bound).
 *
 * DRY-RUN by default. Conservative + honest: a login wall or a content-free page
 * is reported, not stored. Total -- never throws; per-URL errors are recorded.
 *
 * @param client connected pg Client (live local Postgres via the bridge)
 * @param personId the people.id to deepen
 * @param opts { apply?, fetchImpl?, ingestImpl?, maxUrls? }
 */
export async function deepenSocialsForPerson(
  client: Client,
  personId: string,
  opts: DeepenSocialsOpts = {},
): Promise<DeepenSocialsResult> {
  const apply = opts.apply === true;
  const doFetch = opts.fetchImpl ?? defaultSocialFetch;
  const doIngest = opts.ingestImpl ?? ingestOne;
  const maxUrls = opts.maxUrls ?? 8;
  const notes: string[] = [];

  const result: DeepenSocialsResult = {
    person_id: personId,
    dry_run: !apply,
    social_urls_considered: 0,
    ingested: 0,
    login_walls: 0,
    no_issue_content: 0,
    fetch_failed: 0,
    units: [],
    coverage_note: '',
    notes,
  };

  // Pull the person's OWN attributed social URLs from our DB (authoritative bind).
  let discovered: Awaited<ReturnType<typeof discoverSourcesForPerson>> = [];
  try {
    discovered = await discoverSourcesForPerson(client as unknown as QueryClient, personId);
  } catch (e) {
    notes.push(`discoverSourcesForPerson failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const socials = discovered
    .filter((d) => d.source_family === 'social')
    .slice(0, maxUrls);
  result.social_urls_considered = socials.length;

  if (socials.length === 0) {
    result.coverage_note = 'no attributed social URLs on record for this person; nothing to deepen';
    return result;
  }

  for (const s of socials) {
    let body = '';
    try {
      body = await doFetch(s.url);
    } catch (e) {
      notes.push(`fetch threw for ${s.url}: ${e instanceof Error ? e.message : String(e)}`);
      body = '';
    }

    if (!body || body.trim().length === 0) {
      result.fetch_failed++;
      result.units.push({
        url: s.url,
        platform: s.platform ?? null,
        outcome: 'fetch_failed',
        chunks: 0,
        bind_confidence: s.bind_confidence,
        ingest: null,
        detail: 'fetch returned empty body (all tiers); skipped',
      });
      continue;
    }

    const extraction = extractSocialIssueContent(body, s.platform ?? null);

    if (extraction.loginWall) {
      result.login_walls++;
      result.units.push({
        url: s.url,
        platform: s.platform ?? null,
        outcome: 'login_wall',
        chunks: 0,
        bind_confidence: s.bind_confidence,
        ingest: null,
        detail: extraction.note,
      });
      continue;
    }

    if (!extraction.hasIssueContent) {
      result.no_issue_content++;
      result.units.push({
        url: s.url,
        platform: s.platform ?? null,
        outcome: 'no_issue_content',
        chunks: 0,
        bind_confidence: s.bind_confidence,
        ingest: null,
        detail: extraction.note,
      });
      continue;
    }

    // Issue content found -> emit via the canonical candidate-centric ingest path.
    // ingestOne owns canonicalize + denylist + fetch + scrub + hash + ledger; we
    // pass the person bind + a 'social_deepen' discovery_path so the deepened
    // evidence is attributed and provenance-tagged. (ingestOne re-fetches the
    // URL itself; the pre-fetch above is only the wall/issue gate so we never
    // ingest a wall page.)
    let ingest: IngestResult | null = null;
    try {
      ingest = await doIngest(
        client,
        {
          url: s.url,
          person_id: personId,
          source_family: 'social',
          discovery_path: 'social_deepen',
          bind_confidence: s.bind_confidence,
        },
        { apply },
      );
    } catch (e) {
      notes.push(`ingestOne threw for ${s.url}: ${e instanceof Error ? e.message : String(e)}`);
    }

    result.ingested++;
    result.units.push({
      url: s.url,
      platform: s.platform ?? null,
      outcome: 'ingested',
      chunks: extraction.chunks.length,
      bind_confidence: s.bind_confidence,
      ingest,
      detail: `${extraction.note}; ${apply ? 'ingested' : 'dry-run: would ingest'} person-bound (social_deepen)`,
    });
  }

  // Honest coverage summary.
  const open = result.ingested;
  const walled = result.login_walls;
  result.coverage_note =
    `coverage: ${open}/${socials.length} social URL(s) yielded public issue content; ` +
    `${walled} were login/consent walls (skipped, not scraped); ` +
    `${result.no_issue_content} reachable but content-free; ${result.fetch_failed} unreachable. ` +
    `Deepening is real-but-partial: open platforms surface content to a logged-out fetch, ` +
    `walled platforms (Instagram/X/Facebook/TikTok/LinkedIn) generally do not, and we do not scrape them.`;

  return result;
}
