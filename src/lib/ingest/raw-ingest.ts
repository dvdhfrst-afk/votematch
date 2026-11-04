/**
 * raw-ingest.ts -- the raw-evidence INGEST pipeline for Havesay.
 *
 * Council-approved architecture (migration 20260614000000): an immutable RAW
 * evidence store + a seen-before ledger keyed on NORMALIZED text + a URL
 * negative cache. Together these make discovery idempotent and make the
 * find-forget-refind loop structurally impossible: re-encountered content is a
 * cheap no-op (a ledger touch), not a re-store + re-classify.
 *
 * Per-URL flow (see ingestOne below):
 *   1. canonicalize URL (lowercase host, drop fragment, strip tracking params),
 *      compute registrable domain.
 *   2. DENYLIST check on registrable domain. A denied URL is NEVER fetched: we
 *      upsert url_negative_cache(reason='denylist', recheck_after=null) and
 *      return 'denied'.
 *   3. url_negative_cache check: if a row exists and (recheck_after is null OR
 *      now < recheck_after), increment times_hit and return 'negative_cached'.
 *   4. FETCH via runPageFetch (single plain fetch; we never
 *      reimplement fetching). On throw / empty / non-2xx: upsert
 *      url_negative_cache(reason 'fetch_failed'|'http_error'|'dead',
 *      http_status, recheck_after = now + 7 days) and return 'fetch_failed'.
 *   5. content_hash = sha256(raw bytes).
 *   6. normalize -> normalized_hash = sha256(extracted_text).
 *   7. evidence_seen_ledger lookup by normalized_hash. IDEMPOTENCY GUARD: if
 *      found, update last_seen_at / times_seen+1 / append url to meta.urls and
 *      return 'seen' (NO new row, NO re-store).
 *   8. applyIngestScrubs. If blocked (clear contraband), log and return
 *      'blocked' (do NOT store).
 *   9. store the scrubbed raw bytes to the HOST FILESYSTEM at
 *      app/data/raw-evidence/<content_hash[0:2]>/<content_hash>;
 *      storage_ref = 'file://data/raw-evidence/<...>'.
 *  10. insert raw_evidence (apply mode; dry-run prints the row it would insert).
 *  11. upsert evidence_seen_ledger.
 *
 * Each URL is wrapped in try/catch by ingestOne so one failure never aborts a
 * batch. DRY-RUN is the DEFAULT (opts.apply !== true): fetch and compute, but
 * do NOT write the DB or any files; the result.detail records the plan.
 *
 * Redaction policy: per the migration comment, general redaction happens later
 * at OUTPUT, never here. The ingest-time scrubs are limited to the contraband
 * floor (clear child-sexual-abuse-material / sealed-or-juvenile-record
 * indicators -> REFUSE to store) plus Social Security number / financial-account
 * masking and a conservative minor-name masking hook. These run at INGEST per
 * the founder decision (2026-06-13).
 *
 * Single TypeScript runtime, no Python (architecture rule). The pg Client
 * handles all DB work; raw bytes go to the host filesystem.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { runPageFetch } from '@/lib/agent-tools/page-fetch';
import { validateEmail, validatePhone, type ValidationResult } from './validators';

// ---------------------------------------------------------------------------
// source_family vocabulary -- coordinated across the pipeline
// ---------------------------------------------------------------------------

/**
 * The source_family strings the POSITIONING classifier is allowed to read.
 * Kept here as the single source of truth so the ingest path and the classifier
 * runner (scripts/classify-signals.ts) agree. Anything NOT in this set (notably
 * 'filing') is kept for contact-data only and EXCLUDED from positioning.
 *
 *   - 'candidate_site'  : the candidate's own site / about / issues page.
 *   - 'social'          : social posts attributed to the candidate.
 *   - 'video_transcript': transcribed candidate video/audio (parallel build).
 */
export const POSITIONING_SOURCE_FAMILIES: readonly string[] = [
  'candidate_site',
  'social',
  'video_transcript',
];

/**
 * The source_family used for declaration-of-candidacy / filing documents. These
 * are LEGAL FILINGS, useful only for contact + identity data, and must NEVER be
 * fed to the positioning classifier (they would dominate by sheer size and
 * garble the signal). Tagged at ingest by isFilingUrl(), enforced as an
 * EXCLUSION in the classifier's evidence selection.
 */
export const FILING_SOURCE_FAMILY = 'filing';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-URL input, snake_case to match the JSON Lines batch format. */
export interface IngestOneInput {
  url: string;
  person_id?: string | null;
  source_family?: string | null;
  discovery_path?: string | null;
  /**
   * Optional bind confidence in [0, 1]. Persisted to raw_evidence.bind_confidence
   * (numeric(4,3)) when a person_id is supplied. Added 2026-06-14 for the
   * person-bound discovery path (discover-sources.ts): when discovery surfaces a
   * URL already attributed to a person in the database, the bind is authoritative
   * and that confidence flows through to the stored row. Default null (the old
   * behavior): callers that do not bind to a person leave it unset. Low binds
   * (below the publish threshold) still must never auto-publish; that gate lives
   * downstream, not here.
   */
  bind_confidence?: number | null;
}

/** Options for ingestOne. apply !== true => DRY-RUN (no writes). */
export interface IngestOneOptions {
  /** Default false. When false, NO writes happen (dry-run). */
  apply?: boolean;
  /**
   * Host-filesystem root for raw bytes. Defaults to <cwd>/data/raw-evidence
   * (scripts run from app/, so that is app/data/raw-evidence). The stored
   * storage_ref is always the repo-relative 'file://data/raw-evidence/...'.
   */
  fsRoot?: string;
  /**
   * Build 6: when true, run the deterministic contact validators on any
   * email/phone found in the page text and record the results in
   * raw_evidence.provenance.contacts. Email validation may do a DNS MX (mail
   * exchange) lookup; that lookup only runs when checkContactDns is also true.
   * Default true (contacts are scanned + validated). A fabricated / placeholder
   * contact is recorded with valid=false and NEVER stored as verified.
   */
  validateContacts?: boolean;
  /**
   * Build 6: enable the DNS MX lookup inside email validation. Default false in
   * dry-run (keeps dry-run fully offline) and true in apply mode, but the caller
   * can force it either way. When false, email validation is syntax + placeholder
   * + top-level-domain only (no network).
   */
  checkContactDns?: boolean;
  /**
   * Inject the PDF text extractor (the offline test stubs this with a fake). The
   * live default lazily imports the shared pdfjs-dist extractor. When a fetched
   * artifact is a PDF, its actual text is extracted with this and stored as
   * extracted_text -- the raw %PDF bytes are NEVER stored as text.
   */
  pdfTextExtractor?: PdfTextExtractor;
  /**
   * Inject a fetcher that returns the raw PDF BYTES for a URL (the offline test
   * stubs this). The live default uses politeFetch + arrayBuffer(). Needed
   * because smart_fetch returns a PDF body as res.text() (a lossy decode of the
   * binary); to extract text and to store faithful bytes we re-fetch the PDF as
   * an ArrayBuffer. Returns null on failure (the caller falls back to recovering
   * bytes from the smart_fetch body via latin1).
   */
  pdfBytesFetcher?: (url: string) => Promise<Buffer | null>;
}

export type IngestStatus =
  | 'stored' // new content fetched, scrubbed, stored, raw_evidence inserted (or would be, in dry-run)
  | 'seen' // normalized_hash already in ledger -- cheap no-op, no new row
  | 'negative_cached' // url_negative_cache hit, not due for recheck
  | 'denied' // registrable domain on the denylist -- never fetched
  | 'fetch_failed' // all fetch tiers failed / empty body / non-2xx
  | 'blocked'; // contraband indicator -- refused to store

export interface IngestResult {
  url: string;
  status: IngestStatus;
  /** Human-readable detail: reason, plan (dry-run), hashes, or error. */
  detail: string;
  // Optional structured fields useful for logging / summaries.
  canonicalUrl?: string;
  registrableDomain?: string | null;
  finalUrl?: string;
  fetchTier?: string;
  httpStatus?: number;
  byteSize?: number;
  contentHash?: string;
  normalizedHash?: string;
  storageRef?: string;
  scrubs?: string[];
  timesSeen?: number;
  /** True when nothing was written (dry-run). */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// (1) URL canonicalization + registrable domain
// ---------------------------------------------------------------------------

/** Tracking query params we strip during canonicalization. */
const TRACKING_PARAM_PATTERNS: RegExp[] = [
  /^utm_/i, // utm_source, utm_medium, utm_campaign, utm_term, utm_content, ...
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^msclkid$/i,
  /^mc_/i, // mc_cid, mc_eid (Mailchimp)
  /^igshid$/i,
  /^yclid$/i,
  /^twclid$/i,
  /^s_kwcid$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
];

function isTrackingParam(key: string): boolean {
  return TRACKING_PARAM_PATTERNS.some((p) => p.test(key));
}

/**
 * Compute the registrable domain (effective top-level domain plus one label,
 * approximately) from a hostname.
 *
 * We do NOT vendor a full Public Suffix List (zero-new-dep constraint, and the
 * denylist works on a "domain ends with X" basis anyway). Heuristic:
 *   - IP literals return as-is.
 *   - Known multi-label public suffixes (co.uk, gov.uk, com.au, ...) take the
 *     last 3 labels; everything else takes the last 2.
 * This is sufficient for denylist matching, dedup grouping, and provenance.
 * The denylist match below uses endsWith so a missed boundary still catches
 * subdomains.
 */
export function registrableDomainOf(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  // IPv4 / IPv6 literal -> return as-is.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host;

  const labels = host.split('.');
  if (labels.length <= 2) return host;

  // A small set of common two-label public suffixes. Not exhaustive; the
  // denylist uses endsWith so this only affects the displayed grouping value.
  const twoLabelSuffixes = new Set([
    'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk',
    'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au',
    'co.nz', 'org.nz', 'govt.nz',
    'co.za', 'org.za',
    'com.br', 'gov.br',
    'co.jp', 'or.jp', 'go.jp',
    'co.in', 'gov.in',
  ]);
  const lastTwo = labels.slice(-2).join('.');
  if (twoLabelSuffixes.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

export interface CanonicalUrl {
  /** Canonical URL string. */
  canonical: string;
  /** Registrable domain of the canonical host (effective TLD plus one label). */
  registrableDomain: string | null;
}

/**
 * canonicalizeUrl(url):
 *   - lowercase the scheme and host (NOT the path/query, which are
 *     case-sensitive on many servers)
 *   - drop the fragment
 *   - strip tracking params (utm_*, fbclid, gclid, mc_*, ...)
 *   - keep path + meaningful query, with query keys sorted for stability
 *   - drop a trailing slash on a non-root path
 *   - drop the default port for the scheme
 *
 * Returns the canonical string plus the registrable domain. Throws on
 * malformed input (caller turns that into a 'fetch_failed').
 */
export function canonicalizeUrl(url: string): CanonicalUrl {
  const u = new URL(url.trim());
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  // Strip tracking params, keep the rest, sort for stability.
  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (isTrackingParam(k)) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const params = new URLSearchParams();
  for (const [k, v] of kept) params.append(k, v);
  u.search = params.toString() ? `?${params.toString()}` : '';

  // Normalize trailing slash on a non-root path.
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  // Drop the default port for the scheme.
  if (
    (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443')
  ) {
    u.port = '';
  }

  return {
    canonical: u.toString(),
    registrableDomain: registrableDomainOf(u.hostname),
  };
}

// ---------------------------------------------------------------------------
// (2) DENYLIST -- aggregators we must NOT ingest (data-source policy)
// ---------------------------------------------------------------------------

/**
 * Registrable domains we hard-block. These are aggregators / competitors /
 * license-encumbered sources per the data-source policy in CLAUDE.md ("Never
 * build pipelines on legally ambiguous sources"; "Especially avoid depending
 * on sources we will compete with or replace"). A denied URL is NEVER fetched.
 *
 * Matched with endsWith against the registrable domain AND the full host, so
 * subdomains (news.ballotpedia.org) are also caught.
 */
export const DENYLIST: readonly string[] = [
  'ballotpedia.org',
  'vote411.org',
  'isidewith.com',
  'votesmart.org',
  'ontheissues.org',
  'votecompass.com',
  'votecompass.org',
  'ballotready.org',
];

/**
 * True if the registrable domain (or full host) is on the denylist.
 */
export function isDenied(registrable: string | null, fullHost: string): boolean {
  const candidates = [registrable, fullHost].filter((x): x is string => !!x);
  for (const c of candidates) {
    const lower = c.toLowerCase();
    for (const denied of DENYLIST) {
      if (lower === denied || lower.endsWith('.' + denied)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// (2b) FILING detection -- declaration-of-candidacy / legal filings
// ---------------------------------------------------------------------------

/**
 * Patterns that mark a URL as a declaration-of-candidacy / candidate legal
 * filing (NOT a positioning document). The canonical case is Utah's
 * votesearch.utah.gov/cb/<id>.pdf candidate-filing PDFs, but we also catch other
 * obvious declaration / candidate-filing document URLs across states so they are
 * never mistaken for the candidate's own platform content.
 *
 * A match sets source_family='filing' at ingest, which the positioning
 * classifier EXCLUDES (FILING_SOURCE_FAMILY). The filing is still stored and its
 * contact data is still extracted -- it just never becomes positioning evidence.
 */
const FILING_URL_PATTERNS: RegExp[] = [
  // Utah candidate-filing / candidate-bond profile PDFs:
  //   https://votesearch.utah.gov/cb/<id>.pdf
  /(?:^|\.)votesearch\.utah\.gov\/cb\//i,
  // Utah Lt. Gov declaration-of-candidacy uploads (vote.utah.gov/.../<office>-<name>.pdf).
  /(?:^|\.)vote\.utah\.gov\/wp-content\/uploads\/.+\.pdf(?:$|[?#])/i,
  // Generic "declaration of candidacy" filing documents (path tokens).
  /declaration[-_]of[-_]candidacy/i,
  /\bdecl(?:aration)?[-_]?of[-_]?cand\b/i,
  // "candidate filing" / "statement of candidacy" document paths.
  /candidate[-_]?filing/i,
  /statement[-_]of[-_]candidacy/i,
];

/**
 * isFilingUrl(url): true when the URL is a declaration-of-candidacy / candidate
 * legal-filing document. Matched against the full URL (host + path) so both the
 * votesearch /cb/ host-path pattern and generic path tokens are caught. A real
 * campaign site (e.g. https://smith4mayor.org/issues) returns false.
 *
 * Defensive: a malformed URL string is simply tested as-is; we never throw here
 * (the caller's canonicalization already guards malformed input).
 */
export function isFilingUrl(url: string): boolean {
  if (!url) return false;
  const u = url.trim();
  if (!u) return false;
  // Test against the host+path (and the raw string) so a pattern anchored on the
  // host-relative path (votesearch.utah.gov/cb/) matches regardless of scheme.
  let hostPath = u;
  try {
    const parsed = new URL(u);
    hostPath = parsed.hostname.toLowerCase() + parsed.pathname + parsed.search;
  } catch {
    /* not a full URL -- fall back to the raw string */
  }
  return FILING_URL_PATTERNS.some((re) => re.test(hostPath) || re.test(u));
}

// ---------------------------------------------------------------------------
// (5b) PDF detection + text extraction
// ---------------------------------------------------------------------------

/** The %PDF magic bytes a real PDF body starts with (allowing leading BOM/ws). */
const PDF_MAGIC_RE = /^[﻿\s]*%PDF-/;

/**
 * isPdfContent(contentType, body): true when the fetched artifact is a PDF, by
 * EITHER the HTTP content-type (application/pdf) OR the %PDF magic bytes at the
 * start of the body. We check the magic bytes because smart_fetch's success
 * banner does not always surface a content-type, and some servers mislabel PDFs
 * as octet-stream / text. The body check is what catches the raw-bytes bug.
 */
export function isPdfContent(contentType: string, body: string): boolean {
  if (/application\/pdf/i.test(contentType ?? '')) return true;
  if (typeof body === 'string' && PDF_MAGIC_RE.test(body.slice(0, 64))) return true;
  return false;
}

/**
 * The result of attempting PDF text extraction. text is the extracted text (may
 * be empty for a scanned image PDF with no text layer); ok is true when
 * extraction ran without throwing. noText flags the empty-extraction case so the
 * caller records provenance 'pdf_no_text' INSTEAD of ever storing raw bytes as
 * text again.
 */
export interface PdfExtractOutcome {
  text: string;
  ok: boolean;
  noText: boolean;
  /** Machine-stable detail tag for provenance/logging. */
  reason: 'extracted' | 'pdf_no_text' | 'extract_error';
  /** Page count when known (best-effort). */
  numPages?: number;
}

/**
 * The PDF text extractor seam. Given the raw PDF bytes, returns the extracted
 * plain text. Injectable so the offline test can stub it with a fake extractor
 * (no pdfjs, no network). The live default lazily imports the shared
 * extractTextFromPdf (pdfjs-dist legacy build, Node-hardened) so importing
 * raw-ingest never pulls pdfjs into a bundle that does not need it.
 */
export type PdfTextExtractor = (bytes: Buffer) => Promise<{ text: string; numPages?: number }>;

/** The live default PDF text extractor (lazy import of the shared pdfjs helper). */
const defaultPdfTextExtractor: PdfTextExtractor = async (bytes: Buffer) => {
  // Lazy import: the shared extractor uses pdfjs-dist's legacy Node build with
  // embedded-JS / remote-font hardening (it is already used by the state-SoS
  // candidacy adapters). Reusing it means zero new dependency for this fix.
  const { extractTextFromPdf } = await import(
    '@/lib/adapters/state-sos/shared/pdf-extract'
  );
  const { pages, metadata } = await extractTextFromPdf(bytes);
  return { text: pages.join('\n\n'), numPages: metadata?.numPages };
};

/**
 * The live default PDF-bytes fetcher: politeFetch + arrayBuffer(). Lazily imports
 * politeFetch so the offline test (which injects its own fetcher) never loads it.
 * Returns null on any failure so the caller can fall back to recovering bytes from
 * the smart_fetch body.
 */
const defaultPdfBytesFetcher = async (url: string): Promise<Buffer | null> => {
  try {
    const { politeFetch } = await import('@/lib/adapters/fetch-polite');
    const res = await politeFetch(url, { headers: { Accept: 'application/pdf,*/*' } });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
};

/**
 * extractPdfText(bytes, extractor?): run the PDF text extractor over the raw
 * bytes and classify the outcome. NEVER throws: a malformed / encrypted PDF
 * returns ok=false reason='extract_error' with empty text. An extraction that
 * yields little/no text (a scanned image PDF with no text layer) returns
 * noText=true reason='pdf_no_text' with empty text. The caller stores empty text
 * + the provenance flag in both cases -- raw %PDF bytes are NEVER stored as text.
 *
 * The "little/no text" threshold reuses MIN_CONTENT_LEN so a scanned PDF that
 * extracts only a few stray characters is treated as no-text rather than stored
 * as garbage that would starve the classifier.
 */
export async function extractPdfText(
  bytes: Buffer,
  extractor: PdfTextExtractor = defaultPdfTextExtractor,
): Promise<PdfExtractOutcome> {
  try {
    const { text, numPages } = await extractor(bytes);
    const trimmed = (text ?? '').trim();
    if (trimmed.length < MIN_CONTENT_LEN) {
      return { text: '', ok: true, noText: true, reason: 'pdf_no_text', numPages };
    }
    return { text, ok: true, noText: false, reason: 'extracted', numPages };
  } catch {
    // Encrypted / corrupt / unsupported PDF: fail soft. Empty text, flagged.
    return { text: '', ok: false, noText: true, reason: 'extract_error' };
  }
}

// ---------------------------------------------------------------------------
// (6) normalizeContent -- the core of idempotency
// ---------------------------------------------------------------------------

// Volatile substrings stripped so that two crawls of the SAME page normalize
// (and therefore hash) identically.
const ISO_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?\b/g;
const LONG_DIGIT_NONCE_RE = /\b\d{8,}\b/g;
// CSRF / token-like: long mixed alphanumeric (and -/_) strings, 24+ chars.
const TOKEN_LIKE_RE = /\b[A-Za-z0-9_-]{24,}\b/g;
// Named token=value markup fragments (view-state, session id, authenticity).
const NAMED_TOKEN_RE =
  /\b(csrf|xsrf|nonce|token|sessionid|sid|__viewstate|__eventvalidation|authenticity_token)\s*[=:]\s*[^\s"'&;]+/gi;
// "Last updated" / "last viewed" / "last modified" lines (date-stamped chrome
// that changes per-crawl without the substance changing).
const LAST_UPDATED_LINE_RE =
  /(?:^|\n)[^\n]*\b(?:last\s+(?:updated|modified|viewed|reviewed|revised|edited))\b[^\n]*/gi;

/** True when the smart-fetch result is Jina markdown rather than raw HTML. */
function looksLikeJinaMarkdown(body: string): boolean {
  // Jina Reader returns a "Title: ... / URL Source: ... / Markdown Content:"
  // preamble followed by clean markdown. If we see that preamble OR there are
  // effectively no HTML tags, treat it as markdown (skip the HTML strip).
  if (/^\s*Title:\s.+\n/m.test(body) && /Markdown Content:/i.test(body)) return true;
  const tagCount = (body.match(/<[a-z!/][^>]*>/gi) ?? []).length;
  return tagCount < 5;
}

/**
 * Strip HTML boilerplate (script/style/nav/header/footer) and tags, returning
 * the main-content text. cheerio is already a dependency; if the input is not
 * HTML (Jina markdown or a PDF text extract) we fall through to a regex-based
 * strip that is a near no-op on plain text.
 */
function htmlToText(body: string, contentType: string): string {
  const looksHtml =
    !looksLikeJinaMarkdown(body) &&
    (/<html[\s>]/i.test(body) ||
      /<body[\s>]/i.test(body) ||
      /text\/html/i.test(contentType) ||
      /<[a-z][^>]*>/i.test(body));

  if (looksHtml) {
    try {
      // Lazy require so non-HTML callers do not pay the cheerio load and a
      // missing optional dep never crashes the batch.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cheerio = require('cheerio') as typeof import('cheerio');
      const $ = cheerio.load(body);
      $('script, style, noscript, nav, header, footer, svg, iframe, form, link, meta').remove();
      $('[role="navigation"], [role="banner"], [role="contentinfo"], .nav, .navbar, .header, .footer, .sidebar, .cookie, .cookie-banner').remove();
      const main = $('main').first();
      const text = (main.length ? main : $('body')).text();
      return text;
    } catch {
      // cheerio failed / unavailable -- fall through to the regex strip.
    }
  }

  // Non-HTML or cheerio-unavailable: strip stray tags and comments, leave the
  // text alone. smart_fetch prepends a "<!-- smart_fetch: ... -->" comment we
  // also drop here.
  return body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * normalizeContent(rawBody, contentType): convert HTML to text (or keep the
 * Jina markdown), strip volatile substrings (ISO 8601 timestamps, long digit
 * nonces, token-like strings, "last updated"/"last viewed" lines), and collapse
 * whitespace so a re-crawl of the same content hashes identically. Returns the
 * extracted_text.
 *
 * The volatile substrings are REPLACED with stable placeholders (not deleted)
 * so that two pages differing ONLY in a timestamp normalize identically, while
 * two pages with different real content stay distinct.
 */
export function normalizeContent(rawBody: string, contentType = ''): string {
  let t = htmlToText(rawBody, contentType);
  // Strip date-stamped "last updated/viewed/modified" chrome lines first (whole
  // lines), before we collapse whitespace.
  t = t.replace(LAST_UPDATED_LINE_RE, ' ');
  // Order matters: named token=value first (most specific), then bare tokens.
  t = t.replace(NAMED_TOKEN_RE, '$1=<tok>');
  t = t.replace(ISO_TIMESTAMP_RE, '<ts>');
  t = t.replace(LONG_DIGIT_NONCE_RE, '<num>');
  t = t.replace(TOKEN_LIKE_RE, '<tok>');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// ---------------------------------------------------------------------------
// (5/6) sha256 helpers + content-length floor
// ---------------------------------------------------------------------------

/**
 * Minimum length (in characters) of normalized extracted text required for a
 * page to be stored and ledgered. Pages shorter than this after normalization
 * are overwhelmingly navigation shells, error pages, or redirect stubs --
 * not useful evidence. More critically, every such page would hash to a
 * near-identical sha256 and collide in the evidence_seen_ledger, causing
 * legitimate future pages to be wrongly skipped as 'seen'.
 *
 * When extracted_text.trim().length < MIN_CONTENT_LEN the pipeline upserts
 * url_negative_cache(reason='no_content', recheck_after=+7d) and returns
 * status='fetch_failed' -- reusing the existing status so CLI summary counters
 * are unaffected. No ledger row, no raw_evidence row, no file on disk.
 *
 * Exported so callers and tests can reference the threshold without
 * hard-coding it.
 */
export const MIN_CONTENT_LEN = 64;

/** content_hash: sha256 of the raw fetched bytes. */
export function sha256Bytes(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** normalized_hash: sha256 of the normalized extracted_text. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// (8) applyIngestScrubs -- contraband floor + minors ONLY
// ---------------------------------------------------------------------------

export interface ScrubOutcome {
  /** Cleaned text with redactions applied (empty when blocked). */
  scrubbed_text: string;
  /** Human-readable scrub tags, e.g. ['ssn:2', 'card:1', 'minor_scan']. */
  scrubs: string[];
  /** When true, the artifact is contraband and MUST NOT be stored. */
  blocked: boolean;
}

const PLACEHOLDER_SSN = '[REDACTED-SSN]';
const PLACEHOLDER_CARD = '[REDACTED-CARD]';
const PLACEHOLDER_ROUTING = '[REDACTED-ROUTING]';
const PLACEHOLDER_MINOR = '[REDACTED-MINOR-NAME]';

// Social Security number: ddd-dd-dddd. Spec pattern is \b\d{3}-\d{2}-\d{4}\b.
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

/** Luhn check for a digit string (credit / debit card numbers). */
function passesLuhn(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Redact candidate credit-card numbers: 13-19 digit groups (allowing single
 * space or dash separators) that pass a Luhn check.
 */
function scrubCards(text: string): { text: string; count: number } {
  let count = 0;
  // 13-19 digits, optionally separated by single spaces or dashes.
  const out = text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
      count++;
      return PLACEHOLDER_CARD;
    }
    return match;
  });
  return { text: out, count };
}

/**
 * Redact bank routing numbers: a 9-digit group occurring near the word
 * "routing" (within a small window). We require the proximity so we do not mask
 * arbitrary 9-digit ids (zip+4 without a dash, phone runs, etc.).
 */
function scrubRouting(text: string): { text: string; count: number } {
  let count = 0;
  // Match a 9-digit run that has "routing" within ~40 chars before or after.
  const out = text.replace(/\b\d{9}\b/g, (m, offset: number) => {
    const windowStart = Math.max(0, offset - 40);
    const windowEnd = Math.min(text.length, offset + 9 + 40);
    const around = text.slice(windowStart, windowEnd).toLowerCase();
    if (/\brouting\b/.test(around)) {
      count++;
      return PLACEHOLDER_ROUTING;
    }
    return m;
  });
  return { text: out, count };
}

/**
 * Contraband detector -- CONSERVATIVE. Returns a reason string when the
 * artifact must be REFUSED (not stored), else null.
 *
 * Two floors per the founder decision (2026-06-13):
 *   1. Clear child-sexual-abuse-material indicators.
 *   2. Sealed / juvenile-record disclosure indicators.
 *
 * Keyword + context heuristic, deliberately tuned to AVOID false positives on
 * legitimate civic content. A candidate's platform on child welfare, juvenile
 * justice POLICY, or court reform must NOT trip this -- we require explicit
 * contraband-distribution / sealed-record-disclosure phrasing, not a topical
 * keyword.
 */
function detectContraband(text: string): string | null {
  const t = text.toLowerCase();

  // Floor 1: child sexual abuse material.
  const csamPhrases = [
    'child sexual abuse material',
    'child sexual abuse imagery',
    'child pornography',
    'child porn',
    'underage porn',
    'underage nude',
    'underage nudes',
    'jailbait',
    'preteen porn',
    'lolicon',
  ];
  for (const p of csamPhrases) {
    if (t.includes(p)) return `csam_indicator:"${p}"`;
  }

  // Floor 2: sealed / juvenile records. Require a disclosure phrase pairing
  // "sealed"/"expunged"/"juvenile record" with record-content language. Reform
  // or policy mentions of "juvenile justice" must NOT trigger.
  const sealedPhrases = [
    'sealed juvenile record',
    'sealed juvenile records',
    'expunged juvenile record',
    'sealed court record contains',
    'confidential juvenile record',
    'this sealed record',
    'leaked sealed record',
  ];
  for (const p of sealedPhrases) {
    if (t.includes(p)) return `sealed_record_indicator:"${p}"`;
  }

  return null;
}

/**
 * Conservative minor-name masking. Flags the pass with 'minor_scan' and masks a
 * single capitalized name token that sits IMMEDIATELY adjacent to a minor
 * indicator ("my son" / "my daughter" / "age 14" / "grade 9"). Returns the
 * masked text plus a count of names masked.
 *
 * TODO(legal, PENDING): the EXACT line of what counts as a maskable minor-name
 * vs. a public figure (a 17-year-old candidate, an elected official's named
 * adult child in a public bio) is PENDING LEGAL FINALIZATION. This heuristic is
 * intentionally narrow: it only masks the one name token immediately next to an
 * explicit minor indicator. Do NOT broaden the window, the indicator list, or
 * the name pattern without legal sign-off.
 */
function minorScrub(text: string): { text: string; masked: number; scanned: boolean } {
  // Indicators that strongly imply the adjacent name is a minor.
  //   "my son" / "my daughter" (and his/her/their variants)
  //   "age 1X" / "aged 1X" (10-19)
  //   "grade" (school grade reference)
  const indicatorBefore =
    /\b(?:my|his|her|their)\s+(?:son|daughter|child)\b[\s,:-]+/i;
  const ageIndicator = /\bage[ds]?\s*1\d\b/i;
  const gradeIndicator = /\bgrade\b/i;

  // A single capitalized name token (the immediately adjacent name).
  const nameToken = /[A-Z][a-z]+/;

  let masked = 0;

  // Case A: "my son Jacob" / "her daughter, Maria" -- name follows the
  // indicator. Mask the name token immediately after the indicator.
  let out = text.replace(
    new RegExp(indicatorBefore.source + '(' + nameToken.source + ')', 'g'),
    (whole: string, name: string) => {
      masked++;
      return whole.slice(0, whole.length - name.length) + PLACEHOLDER_MINOR;
    },
  );

  // Case B: "Jacob (age 14)" / "Maria, grade 9" -- name precedes a strong age
  // or grade indicator within a tight window. Mask the name token immediately
  // before the indicator.
  out = out.replace(
    new RegExp('(' + nameToken.source + ')[\\s,(]{1,3}(?:' + ageIndicator.source + '|' + gradeIndicator.source + ')', 'g'),
    (whole: string, name: string) => {
      masked++;
      return PLACEHOLDER_MINOR + whole.slice(name.length);
    },
  );

  // The minors pass always runs (detect-and-flag) even when nothing matched.
  return { text: out, masked, scanned: true };
}

/**
 * applyIngestScrubs(text): the contraband floor + minors hook. Runs at INGEST
 * per the founder decision (2026-06-13). Order:
 *   1. Contraband floor FIRST. If tripped, return blocked=true with empty
 *      scrubbed_text (the caller skips storing and logs it).
 *   2. Social Security number redaction.
 *   3. Candidate credit-card (Luhn) redaction.
 *   4. Bank routing-number (near "routing") redaction.
 *   5. Conservative minor-name masking (always flagged with 'minor_scan').
 *
 * Returns { scrubbed_text, scrubs, blocked }. scrubs is a string[] of tags.
 */
export function applyIngestScrubs(text: string): ScrubOutcome {
  const blockReason = detectContraband(text);
  if (blockReason) {
    return {
      scrubbed_text: '',
      scrubs: [`contraband_block:${blockReason}`],
      blocked: true,
    };
  }

  const scrubs: string[] = [];
  let t = text;

  // SSN
  let ssnCount = 0;
  t = t.replace(SSN_RE, () => {
    ssnCount++;
    return PLACEHOLDER_SSN;
  });
  if (ssnCount > 0) scrubs.push(`ssn:${ssnCount}`);

  // Credit-card (Luhn)
  const cards = scrubCards(t);
  t = cards.text;
  if (cards.count > 0) scrubs.push(`card:${cards.count}`);

  // Bank routing (near "routing")
  const routing = scrubRouting(t);
  t = routing.text;
  if (routing.count > 0) scrubs.push(`routing:${routing.count}`);

  // Minors: detect-and-flag pass always runs.
  const minor = minorScrub(t);
  t = minor.text;
  if (minor.scanned) scrubs.push('minor_scan');
  if (minor.masked > 0) scrubs.push(`minor_name:${minor.masked}`);

  return { scrubbed_text: t, scrubs, blocked: false };
}

// ---------------------------------------------------------------------------
// Contact extraction + DETERMINISTIC validation at ingest (Build 6)
// ---------------------------------------------------------------------------

/**
 * One validated contact candidate found in the page text, plus the deterministic
 * validator's verdict. Recorded in raw_evidence.provenance.contacts so a
 * fabricated / placeholder contact is NEVER stored as verified: downstream only
 * trusts entries with valid===true. This is the ingest-time half of the
 * extraction gate's stage 4.
 */
export interface ValidatedContact {
  kind: 'email' | 'phone';
  /** The raw value as it appeared in the page. */
  raw: string;
  /** The validator's canonical form (lowercased email / E.164 phone), or null. */
  normalized: string | null;
  /** True only when the deterministic validator passed every stage. */
  valid: boolean;
  /** Machine-stable reason tag ('ok', 'placeholder', 'mx_missing', ...). */
  reason: string;
}

// Conservative email + North-American phone matchers for scanning page text.
// These find CANDIDATES; the validators decide which are real.
const EMAIL_SCAN_RE = /\b[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Phones: optional +1 / 1, area code in parens or not, common separators.
const PHONE_SCAN_RE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

/**
 * Extract contact candidates from the (scrubbed) page text and run the
 * deterministic validators on each. Email validation can do a DNS MX lookup, so
 * the caller passes a flag to enable / disable DNS (off in dry-run by default to
 * keep dry-run fully offline). Deduped by normalized value. Capped so a junk
 * page cannot blow up the provenance row.
 *
 * Pure-ish: the only side effect is the optional DNS lookup inside validateEmail
 * when checkEmailDns is true; with checkEmailDns=false it is fully offline.
 */
export async function extractAndValidateContacts(
  text: string,
  opts: { checkEmailDns?: boolean; emailResolver?: import('./validators').MxResolver; max?: number } = {},
): Promise<ValidatedContact[]> {
  const max = opts.max ?? 25;
  const out: ValidatedContact[] = [];
  const seen = new Set<string>();

  const emails = text.match(EMAIL_SCAN_RE) ?? [];
  for (const raw of emails) {
    if (out.length >= max) break;
    const res: ValidationResult = await validateEmail(raw, {
      skipDns: !opts.checkEmailDns,
      resolver: opts.emailResolver,
    });
    const dedupKey = `email:${(res.normalized ?? raw).toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ kind: 'email', raw, normalized: res.normalized, valid: res.valid, reason: res.reason });
  }

  const phones = text.match(PHONE_SCAN_RE) ?? [];
  for (const raw of phones) {
    if (out.length >= max) break;
    const res = validatePhone(raw);
    const dedupKey = `phone:${res.normalized ?? raw}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ kind: 'phone', raw, normalized: res.normalized, valid: res.valid, reason: res.reason });
  }

  return out;
}

// ---------------------------------------------------------------------------
// (4) smart_fetch wrapper -- parse runPageFetch's text output back to fields
// ---------------------------------------------------------------------------

interface FetchOutcome {
  ok: boolean;
  body: string;
  method: string; // fetch tier: plain | error
  status: number;
  contentType: string;
  finalUrl: string;
  errorMessage?: string;
}

/**
 * smart_fetch returns a tool-style payload: on success content[0].text is
 * "<!-- smart_fetch: tier=X status=Y elapsed=Zms bytes=N truncated -->\n"
 * followed by the body; on error isError=true with a JSON meta block. We parse
 * the metadata banner and strip it so the body we hash is the actual content.
 */
function parseSmartFetchResult(
  res: { isError?: boolean; content: Array<{ type: 'text'; text: string }> },
  url: string,
): FetchOutcome {
  const text = res.content?.[0]?.text ?? '';

  if (res.isError) {
    let status = 0;
    let method = 'error';
    let finalUrl = url;
    let contentType = '';
    const jsonStart = text.indexOf('{');
    if (jsonStart >= 0) {
      try {
        const meta = JSON.parse(text.slice(jsonStart, text.lastIndexOf('}') + 1)) as {
          status?: number;
          fetch_method?: string;
          final_url?: string;
          content_type?: string;
        };
        status = meta.status ?? 0;
        method = meta.fetch_method ?? 'error';
        finalUrl = meta.final_url ?? url;
        contentType = meta.content_type ?? '';
      } catch {
        /* keep defaults */
      }
    }
    const lastErr = text.match(/Last error:\s*(.+)$/m)?.[1];
    return {
      ok: false,
      body: '',
      method,
      status,
      contentType,
      finalUrl,
      errorMessage: lastErr ?? 'smart_fetch failed (all tiers)',
    };
  }

  // Success: parse the banner comment, strip it from the body.
  const banner = text.match(
    /^<!--\s*smart_fetch:\s*tier=(\S+)\s+status=(\d+)\s+elapsed=\d+ms\s+bytes=(\d+)(?:\s+truncated)?\s*-->\n?/,
  );
  let method = 'plain';
  let status = 200;
  let body = text;
  if (banner) {
    method = banner[1];
    status = Number(banner[2]);
    body = text.slice(banner[0].length);
  }
  return {
    ok: true,
    body,
    method,
    status,
    // smart_fetch's success banner does not surface content-type; Jina returns
    // markdown, the other tiers HTML. We infer a coarse type below.
    contentType: method === 'jina' ? 'text/markdown' : 'text/html',
    finalUrl: url,
  };
}

/**
 * Map smart_fetch's tier vocabulary to the migration's fetch_tier vocabulary
 * (direct|jina|cf_bypass|headless|api). The raw smart_fetch method is also
 * preserved in provenance.smart_fetch_method.
 */
function mapTier(method: string): string {
  switch (method) {
    case 'plain':
      return 'direct';
    case 'jina':
      return 'jina';
    default:
      return method;
  }
}

// ---------------------------------------------------------------------------
// (9) Host-filesystem storage
// ---------------------------------------------------------------------------

/** Default host-fs root: <cwd>/data/raw-evidence (app/data/raw-evidence). */
function defaultFsRoot(): string {
  return join(process.cwd(), 'data', 'raw-evidence');
}

/**
 * Store the scrubbed raw bytes to the host filesystem at
 *   <fsRoot>/<content_hash[0:2]>/<content_hash>
 * creating directories as needed. Returns the repo-relative storage_ref
 *   file://data/raw-evidence/<content_hash[0:2]>/<content_hash>
 * Idempotent: the same content_hash overwrites the same path with identical
 * bytes, so re-running never duplicates a file.
 */
function storeBytesToHostFs(
  fsRoot: string,
  contentHash: string,
  bytes: Buffer,
): string {
  const prefix = contentHash.slice(0, 2);
  const dir = join(fsRoot, prefix);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, contentHash), bytes);
  // Repo-relative ref regardless of the absolute fsRoot used on disk.
  return `file://data/raw-evidence/${prefix}/${contentHash}`;
}

// ---------------------------------------------------------------------------
// DB helpers (pg) -- all writes gated behind apply
// ---------------------------------------------------------------------------

const FETCH_FAIL_RECHECK_DAYS = 7;

async function readNegativeCache(
  client: Client,
  urlCanonical: string,
): Promise<{ reason: string; recheck_after: Date | string | null } | null> {
  const { rows } = await client.query(
    'select reason, recheck_after from url_negative_cache where url_canonical = $1 limit 1',
    [urlCanonical],
  );
  return rows[0] ?? null;
}

async function upsertNegativeCache(
  client: Client,
  args: {
    urlCanonical: string;
    reason: string;
    httpStatus: number | null;
    registrable: string | null;
    recheckAfter: Date | null;
    notes: string | null;
  },
): Promise<void> {
  await client.query(
    `insert into url_negative_cache
       (url_canonical, reason, http_status, registrable_domain, last_checked_at, recheck_after, times_hit, notes)
     values ($1, $2, $3, $4, now(), $5, 1, $6)
     on conflict (url_canonical) do update set
       reason = excluded.reason,
       http_status = excluded.http_status,
       registrable_domain = excluded.registrable_domain,
       last_checked_at = now(),
       recheck_after = excluded.recheck_after,
       times_hit = url_negative_cache.times_hit + 1,
       notes = excluded.notes`,
    [
      args.urlCanonical,
      args.reason,
      args.httpStatus,
      args.registrable,
      args.recheckAfter ? args.recheckAfter.toISOString() : null,
      args.notes,
    ],
  );
}

async function bumpNegativeCacheHit(client: Client, urlCanonical: string): Promise<void> {
  await client.query(
    'update url_negative_cache set times_hit = times_hit + 1, last_checked_at = now() where url_canonical = $1',
    [urlCanonical],
  );
}

async function readLedger(
  client: Client,
  normalizedHash: string,
): Promise<{ times_seen: number; first_raw_evidence_id: string | null } | null> {
  const { rows } = await client.query(
    'select times_seen, first_raw_evidence_id from evidence_seen_ledger where normalized_hash = $1 limit 1',
    [normalizedHash],
  );
  return rows[0] ?? null;
}

/**
 * Touch an existing ledger row: last_seen_at=now(), times_seen+1, and append
 * the URL to meta.urls (deduped). Returns the new times_seen.
 */
async function touchLedger(
  client: Client,
  normalizedHash: string,
  url: string,
): Promise<number> {
  const { rows } = await client.query(
    `update evidence_seen_ledger
       set last_seen_at = now(),
           times_seen = times_seen + 1,
           meta = jsonb_set(
             coalesce(meta, '{}'::jsonb),
             '{urls}',
             ( select to_jsonb(array(
                 select distinct e from unnest(
                   array_append(
                     coalesce(
                       array(select jsonb_array_elements_text(coalesce(meta->'urls','[]'::jsonb))),
                       array[]::text[]
                     ),
                     $2::text
                   )
                 ) as e
               )) ),
             true
           )
     where normalized_hash = $1
     returning times_seen`,
    [normalizedHash, url],
  );
  return (rows[0]?.times_seen as number) ?? 0;
}

async function insertRawEvidence(
  client: Client,
  row: {
    contentHash: string;
    normalizedHash: string;
    sourceUrl: string;
    finalUrl: string | null;
    registrable: string | null;
    fetchTier: string | null;
    httpStatus: number | null;
    contentType: string | null;
    byteSize: number;
    storageRef: string;
    extractedText: string;
    sourceFamily: string | null;
    discoveryPath: string | null;
    personId: string | null;
    bindConfidence: number | null;
    ingestScrubs: string[];
    provenance: Record<string, unknown>;
    fetchedAt: Date;
  },
): Promise<string> {
  // ON CONFLICT (content_hash) keeps re-ingest of identical bytes idempotent
  // even if the ledger somehow missed it (belt and suspenders). When an existing
  // row is re-encountered with a person_id + bind_confidence, fill them in only
  // if they were null before, and never DOWNGRADE an existing bind (COALESCE +
  // GREATEST) -- a later, weaker re-bind must not lower a stronger prior one.
  const { rows } = await client.query(
    `insert into raw_evidence
       (content_hash, normalized_hash, source_url, final_url, registrable_domain,
        fetch_tier, http_status, content_type, byte_size, storage_ref,
        extracted_text, source_family, discovery_path, person_id, bind_confidence,
        ingest_scrubs, provenance, fetched_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18)
     on conflict (content_hash) do update set
       normalized_hash = excluded.normalized_hash,
       person_id = coalesce(raw_evidence.person_id, excluded.person_id),
       bind_confidence = greatest(
         coalesce(raw_evidence.bind_confidence, 0),
         coalesce(excluded.bind_confidence, 0)
       )
     returning id`,
    [
      row.contentHash,
      row.normalizedHash,
      row.sourceUrl,
      row.finalUrl,
      row.registrable,
      row.fetchTier,
      row.httpStatus,
      row.contentType,
      row.byteSize,
      row.storageRef,
      row.extractedText,
      row.sourceFamily,
      row.discoveryPath,
      row.personId,
      row.bindConfidence,
      JSON.stringify(row.ingestScrubs),
      JSON.stringify(row.provenance),
      row.fetchedAt.toISOString(),
    ],
  );
  return rows[0].id as string;
}

async function insertLedger(
  client: Client,
  args: { normalizedHash: string; firstRawEvidenceId: string; url: string },
): Promise<void> {
  await client.query(
    `insert into evidence_seen_ledger
       (normalized_hash, first_raw_evidence_id, first_seen_at, last_seen_at, times_seen, classified, meta)
     values ($1, $2, now(), now(), 1, false, $3::jsonb)
     on conflict (normalized_hash) do update set
       last_seen_at = now(),
       times_seen = evidence_seen_ledger.times_seen + 1`,
    [
      args.normalizedHash,
      args.firstRawEvidenceId,
      JSON.stringify({ urls: [args.url] }),
    ],
  );
}

// ---------------------------------------------------------------------------
// ingestOne -- the full per-URL flow
// ---------------------------------------------------------------------------

/**
 * Ingest a single URL through the full pipeline. Resilient: never throws for one
 * bad URL -- all failure modes return a structured IngestResult. Idempotent:
 * re-ingesting the same content is a cheap ledger touch (no new bytes, no new
 * row). DRY-RUN is the default (opts.apply !== true).
 *
 * @param client connected pg Client (live local Postgres via the bridge)
 * @param input  { url, person_id?, source_family?, discovery_path? }
 * @param opts   { apply?, fsRoot? }  -- apply !== true means dry-run
 */
export async function ingestOne(
  client: Client,
  input: IngestOneInput,
  opts: IngestOneOptions = {},
): Promise<IngestResult> {
  const apply = opts.apply === true;
  const dryRun = !apply;
  const fsRoot = opts.fsRoot ?? defaultFsRoot();

  try {
    // ---- (1) canonicalize + registrable domain ----
    let canonical: string;
    let registrable: string | null;
    let host: string;
    try {
      const c = canonicalizeUrl(input.url);
      canonical = c.canonical;
      registrable = c.registrableDomain;
      host = new URL(canonical).hostname;
    } catch (e) {
      return {
        url: input.url,
        status: 'fetch_failed',
        detail: `malformed URL: ${e instanceof Error ? e.message : String(e)}`,
        dryRun,
      };
    }

    const base = { url: input.url, canonicalUrl: canonical, registrableDomain: registrable, dryRun };

    // ---- (1b) FILING tagging: a declaration-of-candidacy / legal-filing URL is
    //           kept for contact data only and EXCLUDED from positioning. Set
    //           source_family='filing' here, overriding any incoming family, so
    //           the classifier's whitelist never selects it. The contact-data
    //           value of the filing is unaffected (still ingested + scanned).
    const isFiling = isFilingUrl(canonical) || isFilingUrl(input.url);
    const effectiveSourceFamily = isFiling
      ? FILING_SOURCE_FAMILY
      : (input.source_family ?? null);

    // ---- (2) DENYLIST: a denied URL is NEVER fetched ----
    if (isDenied(registrable, host)) {
      if (apply) {
        await upsertNegativeCache(client, {
          urlCanonical: canonical,
          reason: 'denylist',
          httpStatus: null,
          registrable,
          recheckAfter: null, // permanent
          notes: 'registrable domain on aggregator denylist',
        });
      }
      return {
        ...base,
        status: 'denied',
        detail: `denylist: ${registrable ?? host}${dryRun ? ' (dry-run: would upsert url_negative_cache reason=denylist recheck_after=null)' : ' (upserted url_negative_cache reason=denylist)'}`,
      };
    }

    // ---- (3) url_negative_cache ----
    const neg = await readNegativeCache(client, canonical);
    if (neg) {
      const recheckDue =
        neg.recheck_after !== null && new Date() >= new Date(neg.recheck_after);
      if (!recheckDue) {
        if (apply) await bumpNegativeCacheHit(client, canonical);
        return {
          ...base,
          status: 'negative_cached',
          detail: `negative-cached (${neg.reason}); recheck_after=${neg.recheck_after ?? 'never'}${dryRun ? ' (dry-run: would bump times_hit)' : ' (bumped times_hit)'}`,
        };
      }
      // else: due for recheck -- fall through and fetch.
    }

    // ---- (4) FETCH via smart_fetch (never reimplemented) ----
    let fetched: FetchOutcome;
    try {
      const raw = await runPageFetch({ url: canonical });
      fetched = parseSmartFetchResult(raw, canonical);
    } catch (e) {
      fetched = {
        ok: false,
        body: '',
        method: 'error',
        status: 0,
        contentType: '',
        finalUrl: canonical,
        errorMessage: e instanceof Error ? e.message : String(e),
      };
    }

    const non2xx = fetched.status !== 0 && (fetched.status < 200 || fetched.status >= 300);
    if (!fetched.ok || !fetched.body || fetched.body.trim().length === 0 || non2xx) {
      // Classify the negative-cache reason: dead (no response), http_error
      // (non-2xx response), or fetch_failed (everything else / empty body).
      let reason: 'dead' | 'http_error' | 'fetch_failed';
      if (fetched.status === 0) reason = 'dead';
      else if (non2xx) reason = 'http_error';
      else reason = 'fetch_failed';
      const recheckAfter = new Date(Date.now() + FETCH_FAIL_RECHECK_DAYS * 86_400_000);
      if (apply) {
        await upsertNegativeCache(client, {
          urlCanonical: canonical,
          reason,
          httpStatus: fetched.status || null,
          registrable,
          recheckAfter,
          notes: (fetched.errorMessage ?? 'empty body').slice(0, 500),
        });
      }
      return {
        ...base,
        status: 'fetch_failed',
        fetchTier: mapTier(fetched.method),
        httpStatus: fetched.status || undefined,
        finalUrl: fetched.finalUrl,
        detail: `fetch ${reason}: ${fetched.errorMessage ?? `http ${fetched.status}`}${dryRun ? ` (dry-run: would upsert url_negative_cache reason=${reason} recheck_after=+7d)` : ` (upserted url_negative_cache reason=${reason} recheck_after=+7d)`}`,
        dryRun,
      };
    }

    // ---- (5) initial body buffer ----
    // Note: content_hash (sha256 of the active body) is computed AFTER step (6b)
    // where the active body is determined. This buffer is used only to seed the
    // activeBody variable before the retry decision.

    // ---- (5b) PDF detection + text extraction ----
    // THE FIX: a fetched PDF must have its TEXT extracted before storage. Without
    // this, smart_fetch's res.text() decode of the binary (a string starting
    // '%PDF-...') was stored as extracted_text -- raw PDF bytes masquerading as
    // positioning text, the largest evidence unit per candidate, starving the
    // classifier. We detect a PDF by content-type OR the %PDF magic bytes, fetch
    // the FAITHFUL bytes (smart_fetch's text() decode is lossy on binary), extract
    // the text, and substitute the extracted text as the body that flows into
    // normalization. The raw bytes stored on the host are the faithful PDF bytes.
    //
    // pdfText/pdfBytes/pdfNoText are set here and consulted below where they
    // replace the body and the host-stored bytes.
    let pdfHandled = false;
    let pdfBytesForStore: Buffer | null = null;
    let pdfReason: PdfExtractOutcome['reason'] | null = null;
    let pdfNumPages: number | undefined;
    if (isPdfContent(fetched.contentType, fetched.body)) {
      pdfHandled = true;
      // Recover faithful PDF bytes. Prefer a clean re-fetch as an ArrayBuffer; if
      // that fails, fall back to re-encoding the smart_fetch body as latin1 (a
      // best-effort recovery of the bytes res.text() decoded).
      const bytesFetcher = opts.pdfBytesFetcher ?? defaultPdfBytesFetcher;
      let bytes: Buffer | null = null;
      try {
        bytes = await bytesFetcher(canonical);
      } catch {
        bytes = null;
      }
      if (!bytes) bytes = Buffer.from(fetched.body, 'latin1');
      pdfBytesForStore = bytes;

      const extractor = opts.pdfTextExtractor ?? defaultPdfTextExtractor;
      const pdfOut = await extractPdfText(bytes, extractor);
      pdfReason = pdfOut.reason;
      pdfNumPages = pdfOut.numPages;
      // Substitute the extracted text (possibly empty for a scanned image PDF) as
      // the body that flows into normalization. The raw %PDF string is discarded;
      // it is NEVER stored as text again.
      fetched = {
        ...fetched,
        body: pdfOut.text,
        contentType: 'application/pdf',
      };
    }

    // ---- (6) normalize -> normalized_hash ----
    const extractedText = normalizeContent(fetched.body, fetched.contentType);

    // ---- (6b) empty-content guard ----
    // Pages whose normalized text is below MIN_CONTENT_LEN (navigation shells,
    // redirect stubs, blank pages, JavaScript-only pages) must NOT be hashed
    // and ledgered: sha256("") = e3b0c44... so EVERY empty page would collide
    // to one ledger entry and be wrongly deduped as 'seen' on every subsequent
    // encounter. Instead, treat them as a fetch failure so the URL is rechecked
    // after 7 days, and store nothing in raw_evidence or the ledger.
    const trimmedLen = extractedText.trim().length;
    const activeBody = fetched.body;
    const activeContentType = fetched.contentType;
    const activeFetchMethod = fetched.method;
    const activeFinalUrl = fetched.finalUrl;
    const activeHttpStatus = fetched.status;
    const activeExtractedText = extractedText;

    // pdf_no_text: a scanned image PDF (no extractable text layer). We still STORE
    // the row -- the faithful PDF bytes go to the host raw-store and the filing's
    // contact/identity value is preserved -- but with EMPTY extracted_text plus a
    // provenance flag 'pdf_no_text'. We NEVER store the raw %PDF bytes as text
    // again. To avoid the sha256("") ledger collision (every empty-text row would
    // hash identically and be wrongly deduped as 'seen'), the normalized_hash for a
    // no-text PDF is derived from the unique content_hash instead of from "".
    const isPdfNoText = pdfHandled && trimmedLen < MIN_CONTENT_LEN;

    if (trimmedLen < MIN_CONTENT_LEN && !isPdfNoText) {
      // The fetch did not produce usable content. Negative-cache the URL so it
      // is rechecked after 7 days.
      const recheckAfter = new Date(Date.now() + FETCH_FAIL_RECHECK_DAYS * 86_400_000);
      const notesDetail = `no usable content after normalization (len=${trimmedLen})`;
      if (apply) {
        await upsertNegativeCache(client, {
          urlCanonical: canonical,
          reason: 'no_content',
          httpStatus: activeHttpStatus || null,
          registrable,
          recheckAfter,
          notes: notesDetail,
        });
      }
      return {
        ...base,
        status: 'fetch_failed',
        fetchTier: mapTier(activeFetchMethod),
        httpStatus: activeHttpStatus || undefined,
        finalUrl: activeFinalUrl,
        detail: `${notesDetail}${dryRun ? ` (dry-run: would upsert url_negative_cache reason=no_content recheck_after=+7d)` : ` (upserted url_negative_cache reason=no_content recheck_after=+7d)`}`,
        dryRun,
      };
    }

    // If we get here, either the fetch was sufficient or this is a handled PDF (text-bearing or no-text).
    //
    // content_hash is the sha256 of the RAW BYTES we store on the host. For a
    // non-PDF that is the (text) body; for a PDF it is the FAITHFUL PDF bytes
    // (pdfBytesForStore), NOT the extracted text -- so storage dedup keys on the
    // real file and the host raw-store keeps the real PDF, per spec.
    const activeBodyBytes =
      pdfHandled && pdfBytesForStore ? pdfBytesForStore : Buffer.from(activeBody, 'utf8');
    const contentHash = sha256Bytes(activeBodyBytes);
    // normalized_hash is normally sha256(extracted_text). For a no-text PDF the
    // extracted text is "" and sha256("") would collide across all such rows and
    // be wrongly deduped as 'seen'. Derive it from the unique content_hash instead
    // so each scanned PDF gets a distinct ledger key.
    const normalizedHash = isPdfNoText
      ? sha256Text(`pdf_no_text:${contentHash}`)
      : sha256Text(activeExtractedText);

    // ---- (7) seen-ledger lookup -- IDEMPOTENCY GUARD ----
    const ledger = await readLedger(client, normalizedHash);
    if (ledger) {
      let timesSeen = ledger.times_seen + 1;
      if (apply) {
        timesSeen = await touchLedger(client, normalizedHash, canonical);
      }
      return {
        ...base,
        status: 'seen',
        contentHash,
        normalizedHash,
        fetchTier: mapTier(activeFetchMethod),
        httpStatus: activeHttpStatus || undefined,
        finalUrl: activeFinalUrl,
        byteSize: activeBodyBytes.byteLength,
        timesSeen,
        detail: `content already in ledger (nhash=${normalizedHash.slice(0, 12)}); no bytes stored, no row inserted${dryRun ? ' (dry-run: would touch ledger)' : ` (ledger touched, times_seen=${timesSeen})`}`,
        dryRun,
      };
    }

    // ---- (8) ingest-time scrubs (contraband floor + minors) ----
    const scrub = applyIngestScrubs(activeExtractedText);
    if (scrub.blocked) {
      // REFUSE to store. Record a permanent negative-cache entry so we never
      // refetch contraband. No bytes, no extracted text stored.
      const blockTag = scrub.scrubs[0] ?? 'contraband';
      if (apply) {
        await upsertNegativeCache(client, {
          urlCanonical: canonical,
          reason: 'irrelevant', // schema's documented reason set; the block tag goes in notes
          httpStatus: activeHttpStatus || null,
          registrable,
          recheckAfter: null, // permanent -- never refetch
          notes: `BLOCKED_CONTRABAND: ${blockTag}`,
        });
      }
      // Log it (caller skips storing the artifact and logs it).
      console.error(`[BLOCKED] contraband refused, not stored: ${canonical} (${blockTag})`);
      return {
        ...base,
        status: 'blocked',
        contentHash,
        normalizedHash,
        fetchTier: mapTier(activeFetchMethod),
        httpStatus: activeHttpStatus || undefined,
        finalUrl: activeFinalUrl,
        scrubs: scrub.scrubs,
        detail: `REFUSED to store (contraband): ${blockTag}${dryRun ? ' (dry-run: would upsert url_negative_cache reason=irrelevant recheck_after=null)' : ' (upserted url_negative_cache)'}`,
        dryRun,
      };
    }

    const fetchedAt = new Date();
    // Bytes written to the host raw-store. For a PDF we store the FAITHFUL PDF
    // bytes (so the original document is preserved and re-extractable); for
    // everything else we store the scrubbed text bytes as before. content_hash
    // was already computed over activeBodyBytes (PDF bytes or text), so the
    // storage_ref path matches.
    const bytesToStore =
      pdfHandled && pdfBytesForStore ? pdfBytesForStore : Buffer.from(scrub.scrubbed_text, 'utf8');
    const storageRefPlanned = `file://data/raw-evidence/${contentHash.slice(0, 2)}/${contentHash}`;

    // ---- (8b) contact extraction + DETERMINISTIC validation (Build 6) ----
    // Scan the SCRUBBED text for emails / phones and run the deterministic
    // validators. Results go in provenance.contacts; valid=false entries are
    // recorded but never treated as a verified contact downstream. The DNS MX
    // check runs only when explicitly enabled (default: on in apply, off in
    // dry-run) so dry-run stays fully offline.
    const doValidateContacts = opts.validateContacts !== false; // default true
    const doContactDns = opts.checkContactDns ?? apply; // default: apply => DNS, dry-run => offline
    let validatedContacts: ValidatedContact[] = [];
    if (doValidateContacts) {
      try {
        validatedContacts = await extractAndValidateContacts(scrub.scrubbed_text, {
          checkEmailDns: doContactDns,
        });
      } catch (e) {
        // A contact-scan failure must never abort ingest; record the error tag.
        validatedContacts = [];
        console.error(
          `[contact-validate] non-fatal error for ${canonical}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    const contactSummary = {
      scanned: doValidateContacts,
      dns_checked: doValidateContacts ? doContactDns : false,
      total: validatedContacts.length,
      valid: validatedContacts.filter((c) => c.valid).length,
      items: validatedContacts,
    };

    const provenance: Record<string, unknown> = {
      fetched_at: fetchedAt.toISOString(),
      smart_fetch_method: activeFetchMethod,
      // Build 6: deterministic contact validation results. Downstream trusts only
      // items with valid=true; a placeholder/fabricated contact is here as
      // evidence-of-attempt, never as a usable contact.
      contacts: contactSummary,
      fetch_tier: mapTier(activeFetchMethod),
      final_url: activeFinalUrl,
      http_status: activeHttpStatus,
      discovery_path: input.discovery_path ?? null,
      // The EFFECTIVE source_family (filing-tagged when isFilingUrl matched), so
      // provenance agrees with the stored column and the classifier whitelist.
      source_family: effectiveSourceFamily,
      // Provenance flags for the data-quality fix:
      //   is_filing  -- declaration-of-candidacy / legal filing (contact-only).
      //   pdf        -- the fetched artifact was a PDF; text was extracted.
      //   pdf_no_text-- the PDF had no extractable text layer (scanned image);
      //                 extracted_text is empty by design, raw bytes are stored.
      ...(isFiling ? { is_filing: true } : {}),
      ...(pdfHandled
        ? {
            pdf: true,
            pdf_extract_reason: pdfReason,
            ...(pdfNumPages != null ? { pdf_num_pages: pdfNumPages } : {}),
            ...(isPdfNoText ? { pdf_no_text: true } : {}),
          }
        : {}),
      scrubs: scrub.scrubs,
    };

    // ---- DRY-RUN: print the row we would insert; do NOT write anything ----
    if (dryRun) {
      const plannedRow = {
        content_hash: contentHash,
        normalized_hash: normalizedHash,
        source_url: canonical,
        final_url: activeFinalUrl,
        registrable_domain: registrable,
        fetch_tier: mapTier(activeFetchMethod),
        http_status: activeHttpStatus,
        content_type: activeContentType,
        byte_size: bytesToStore.byteLength,
        storage_ref: storageRefPlanned,
        extracted_text_len: scrub.scrubbed_text.length,
        source_family: effectiveSourceFamily,
        discovery_path: input.discovery_path ?? null,
        person_id: input.person_id ?? null,
        bind_confidence: input.bind_confidence ?? null,
        ingest_scrubs: scrub.scrubs,
        contacts: contactSummary,
        provenance,
      };
      console.log(
        `[DRY-RUN] would insert raw_evidence + upsert ledger for ${canonical}:\n` +
          JSON.stringify(plannedRow, null, 2),
      );
      const dryDetail = pdfHandled
        ? `DRY-RUN: PDF (${pdfReason}); would store faithful PDF bytes to ${storageRefPlanned}, store extracted_text (len=${scrub.scrubbed_text.length}), family=${effectiveSourceFamily ?? '-'} (chash=${contentHash.slice(0, 12)} nhash=${normalizedHash.slice(0, 12)})`
        : `DRY-RUN: would store scrubbed bytes to ${storageRefPlanned}, insert raw_evidence, upsert ledger, family=${effectiveSourceFamily ?? '-'} (chash=${contentHash.slice(0, 12)} nhash=${normalizedHash.slice(0, 12)})`;
      return {
        ...base,
        status: 'stored',
        contentHash,
        normalizedHash,
        fetchTier: mapTier(activeFetchMethod),
        httpStatus: activeHttpStatus || undefined,
        finalUrl: activeFinalUrl,
        byteSize: bytesToStore.byteLength,
        scrubs: scrub.scrubs,
        storageRef: storageRefPlanned,
        detail: dryDetail,
        dryRun,
      };
    }

    // ---- (9) store the raw bytes to the host filesystem (faithful PDF bytes for
    //          a PDF, scrubbed text bytes otherwise) ----
    const storageRef = storeBytesToHostFs(fsRoot, contentHash, bytesToStore);

    // ---- (10) insert raw_evidence ----
    const rawId = await insertRawEvidence(client, {
      contentHash,
      normalizedHash,
      sourceUrl: canonical,
      finalUrl: activeFinalUrl,
      registrable,
      fetchTier: mapTier(activeFetchMethod),
      httpStatus: activeHttpStatus || null,
      contentType: activeContentType || null,
      byteSize: bytesToStore.byteLength,
      storageRef,
      // The EXTRACTED text (never the raw %PDF bytes). Empty for a no-text PDF.
      extractedText: scrub.scrubbed_text,
      // The EFFECTIVE family: 'filing' for declaration PDFs (contact-only,
      // excluded from positioning), else the incoming family.
      sourceFamily: effectiveSourceFamily,
      discoveryPath: input.discovery_path ?? null,
      personId: input.person_id ?? null,
      bindConfidence: input.bind_confidence ?? null,
      ingestScrubs: scrub.scrubs,
      provenance,
      fetchedAt,
    });

    // ---- (11) upsert evidence_seen_ledger ----
    await insertLedger(client, {
      normalizedHash,
      firstRawEvidenceId: rawId,
      url: canonical,
    });

    return {
      ...base,
      status: 'stored',
      contentHash,
      normalizedHash,
      fetchTier: mapTier(activeFetchMethod),
      httpStatus: activeHttpStatus || undefined,
      finalUrl: activeFinalUrl,
      byteSize: bytesToStore.byteLength,
      scrubs: scrub.scrubs,
      storageRef,
      timesSeen: 1,
      detail: pdfHandled
        ? `stored faithful PDF bytes to ${storageRef} (${pdfReason}); inserted raw_evidence ${rawId} family=${effectiveSourceFamily ?? '-'}; ledger created`
        : `stored bytes to ${storageRef}; inserted raw_evidence ${rawId} family=${effectiveSourceFamily ?? '-'}; ledger created`,
      dryRun,
    };
  } catch (e) {
    // Belt and suspenders: one URL never aborts a batch.
    return {
      url: input.url,
      status: 'fetch_failed',
      detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      dryRun,
    };
  }
}
