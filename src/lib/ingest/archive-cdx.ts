/**
 * archive-cdx.ts -- ARCHIVE MINING for Havesay (Build 4).
 *
 * Wraps the Wayback Machine CDX (Capture Index) Server API to enumerate the
 * historical captures of a candidate's web property, then derives two
 * civic-research products from that history:
 *   1. POSITION DRIFT: a stance changed between date A and date B (dated to the
 *      midpoint between the last-same-digest and the first-new-digest capture).
 *   2. DELETED-CONTENT RECOVERY: content present in the archive but gone from the
 *      live site (kept INTERNAL-only pending legal review).
 *
 * REUSE (no reinvention -- this module is a thin archive layer on top of the
 * raw-evidence pipeline's primitives):
 *   - normalizeContent / sha256Text / sha256Bytes  from raw-ingest -- a fetched
 *     Wayback snapshot is normalized + hashed with the EXACT same functions the
 *     live ingest uses, so an archived page and a live page that hold the same
 *     content produce the same normalized_hash and dedup against the SAME
 *     evidence_seen_ledger.
 *   - canonicalizeUrl                              from raw-ingest -- for binding
 *     a CDX `original` URL back to the same canonical key the ledger uses.
 *   - runPageFetch                                 (the plain page fetch)
 *     -- snapshots are fetched through it; we never reimplement fetching.
 *
 * RATE / POLITENESS (Internet Archive constraints, verified):
 *   - CDX endpoint: http://web.archive.org/cdx/search/cdx
 *   - Stay UNDER 60 requests/minute. We throttle to a configurable floor on the
 *     inter-request gap (default 1100ms => <= ~54/min) and honor HTTP 429 with
 *     exponential backoff + the Retry-After header when present.
 *   - A descriptive User-Agent is REQUIRED. We send 'Havesay-ArchiveMiner/1.0'.
 *
 * Single TypeScript runtime, no Python. Native fetch only; no new dependencies.
 */

import { createHash } from 'node:crypto';
import {
  normalizeContent,
  sha256Bytes,
  sha256Text,
  canonicalizeUrl,
} from '@/lib/ingest/raw-ingest';

/**
 * The smart_fetch result shape (a tool-style payload). Declared here so this
 * module's pure functions (enumeration, dedup, diff, artifact strip) can be
 * imported WITHOUT pulling in the page-fetch module and its dependency tree
 * (zod, the Agent SDK). The real runPageFetch is lazy-loaded inside
 * fetchSnapshot only when an actual snapshot fetch happens. Callers can also
 * inject a compatible fetch tool (the offline test does not need it at all).
 */
type SmartFetchResult = { isError?: boolean; content: Array<{ type: 'text'; text: string }> };
type SmartFetchFn = (args: {
  url: string;
}) => Promise<SmartFetchResult>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CDX (Capture Index) Server API endpoint. */
export const CDX_ENDPOINT = 'http://web.archive.org/cdx/search/cdx';

/** Descriptive User-Agent required by the Internet Archive. */
export const ARCHIVE_USER_AGENT = 'Havesay-ArchiveMiner/1.0';

/** The archive source we record on every row (room for common_crawl later). */
export const ARCHIVE_SOURCE_WAYBACK = 'wayback';

/**
 * Minimum gap between successive CDX / availability requests, in milliseconds.
 * 1100ms keeps us at <= ~54 requests/minute, comfortably under the 60/min ceiling
 * even accounting for round-trip jitter. Configurable per call.
 */
export const DEFAULT_MIN_REQUEST_GAP_MS = 1100;

/** Max 429 retries before giving up on a single request. */
const MAX_429_RETRIES = 5;
/** Base backoff for a 429 with no Retry-After header (ms). Doubles each retry. */
const BASE_429_BACKOFF_MS = 2000;
/**
 * Hard per-request timeout for a CDX call (ms). Node's native fetch has NO
 * default timeout, so a stalled web.archive.org connection would hang the whole
 * run forever. We abort after this and treat it as a retryable network failure.
 */
const CDX_REQUEST_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One enumerated capture, mapped from a CDX row (fl=timestamp,original,digest,statuscode). */
export interface CaptureRow {
  /** Raw CDX timestamp string, YYYYMMDDhhmmss (14 digits). */
  timestamp: string;
  /** Parsed capture instant. */
  capturedAt: Date;
  /** The ORIGINAL (live-web) URL the capture is of (CDX `original`). */
  original: string;
  /** The archive's SHA-1 (Secure Hash Algorithm 1) payload digest (CDX `digest`). */
  digest: string;
  /** HTTP status the archive recorded for the capture (CDX `statuscode`). */
  statusCode: number;
  /** Wayback playback URL: http://web.archive.org/web/{timestamp}/{url}. */
  snapshotUrl: string;
  /** Archive source label ('wayback'). */
  source: string;
}

export interface EnumerateOptions {
  /** Inclusive lower bound, YYYYMMDD or YYYYMMDDhhmmss. Maps to CDX `from`. */
  from?: string;
  /** Inclusive upper bound, YYYYMMDD or YYYYMMDDhhmmss. Maps to CDX `to`. */
  to?: string;
  /**
   * matchType: 'prefix' (default -- DOMAIN/* style: every path under the host),
   * 'domain' (host + all subdomains), 'exact' (one URL), 'host'. We default to
   * 'prefix' per the agreed pattern (doc-09 section 3).
   */
  matchType?: 'prefix' | 'domain' | 'exact' | 'host';
  /** Page size requested per CDX call (CDX `limit`). Default 5000. */
  pageLimit?: number;
  /** Hard cap on total captures returned across all pages. Default 50000. */
  maxCaptures?: number;
  /** Minimum inter-request gap (ms). Default DEFAULT_MIN_REQUEST_GAP_MS. */
  minRequestGapMs?: number;
  /**
   * Injectable fetch, for offline tests. Defaults to the global fetch. Receives
   * the full URL and the request init (carrying the User-Agent header).
   */
  fetchImpl?: typeof fetch;
}

export interface EnumerateResult {
  /** The captures, in CDX order (oldest-first when sorted by timestamp). */
  captures: CaptureRow[];
  /** Number of CDX pages fetched (resumeKey paginations + 1). */
  pages: number;
  /** True when maxCaptures stopped enumeration before exhausting the archive. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Throttle helper -- shared monotonic gate so concurrent callers stay polite
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * A tiny throttle that guarantees at least `minGapMs` between the START of
 * successive awaited acquisitions. Not global state -- one per enumeration run --
 * so tests are deterministic.
 */
class Throttle {
  private last = 0;
  constructor(private readonly minGapMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const since = now - this.last;
    if (this.last !== 0 && since < this.minGapMs) {
      await sleep(this.minGapMs - since);
    }
    this.last = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Timestamp + snapshot-URL helpers
// ---------------------------------------------------------------------------

/**
 * Parse a CDX timestamp (YYYYMMDDhhmmss, 14 digits; shorter forms padded) into a
 * Date. Wayback timestamps are UTC. Returns the epoch on malformed input rather
 * than throwing, so one bad row never aborts a page parse.
 */
export function parseCdxTimestamp(ts: string): Date {
  const digits = (ts ?? '').replace(/\D/g, '');
  if (digits.length < 4) return new Date(0);
  const padded = (digits + '00000000000000').slice(0, 14);
  const year = Number(padded.slice(0, 4));
  const month = Number(padded.slice(4, 6)) || 1;
  const day = Number(padded.slice(6, 8)) || 1;
  const hour = Number(padded.slice(8, 10));
  const min = Number(padded.slice(10, 12));
  const sec = Number(padded.slice(12, 14));
  return new Date(Date.UTC(year, month - 1, day, hour, min, sec));
}

/** Build the Wayback playback URL for a (timestamp, original-url) pair. */
export function buildSnapshotUrl(timestamp: string, url: string): string {
  return `http://web.archive.org/web/${timestamp}/${url}`;
}

// ---------------------------------------------------------------------------
// CDX response parsing
// ---------------------------------------------------------------------------

/**
 * Parse the CDX JSON response (output=json) for fl=timestamp,original,digest,statuscode.
 * The CDX JSON shape is an array-of-arrays whose FIRST element is a header row
 * naming the fields. When showResumeKey=true and more results remain, the LAST
 * one or two rows are a blank separator row followed by a single-cell resume-key
 * row. We map data rows to CaptureRow by header position (robust to field-order
 * changes) and return the resume key if present.
 *
 * Exported for the offline test.
 */
export function parseCdxJson(raw: unknown): { rows: CaptureRow[]; resumeKey: string | null } {
  const rows: CaptureRow[] = [];
  let resumeKey: string | null = null;

  if (!Array.isArray(raw) || raw.length === 0) return { rows, resumeKey };

  const header = raw[0];
  if (!Array.isArray(header)) return { rows, resumeKey };

  // Map field name -> column index from the header row.
  const col: Record<string, number> = {};
  header.forEach((name, i) => {
    if (typeof name === 'string') col[name] = i;
  });
  const iTs = col['timestamp'] ?? 0;
  const iOrig = col['original'] ?? 1;
  const iDigest = col['digest'] ?? 2;
  const iStatus = col['statuscode'];

  // Data rows start at index 1. The resume key, when present, is a single-cell
  // row that appears AFTER a blank separator row at the tail.
  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    if (!Array.isArray(r)) continue;

    // Blank separator row before the resume key.
    if (r.length === 0) continue;

    // A single-cell row at the tail is the resume key (showResumeKey=true).
    if (r.length === 1) {
      const cell = r[0];
      if (typeof cell === 'string' && cell.trim().length > 0) {
        resumeKey = cell.trim();
      }
      continue;
    }

    const timestamp = String(r[iTs] ?? '');
    const original = String(r[iOrig] ?? '');
    const digest = String(r[iDigest] ?? '');
    if (!timestamp || !original || !digest) continue;
    const statusCode =
      iStatus != null ? Number(r[iStatus]) || 0 : 0;

    rows.push({
      timestamp,
      capturedAt: parseCdxTimestamp(timestamp),
      original,
      digest,
      statusCode,
      snapshotUrl: buildSnapshotUrl(timestamp, original),
      source: ARCHIVE_SOURCE_WAYBACK,
    });
  }

  return { rows, resumeKey };
}

// ---------------------------------------------------------------------------
// Low-level CDX request with 429 backoff
// ---------------------------------------------------------------------------

function buildCdxUrl(
  domainOrUrl: string,
  opts: EnumerateOptions,
  resumeKey: string | null,
): string {
  const params = new URLSearchParams();
  params.set('url', domainOrUrl);
  params.set('matchType', opts.matchType ?? 'prefix');
  params.set('output', 'json');
  params.set('fl', 'timestamp,original,digest,statuscode');
  // Only successful HTML captures: drop redirects/errors and non-HTML payloads.
  params.append('filter', 'statuscode:200');
  params.append('filter', 'mimetype:text/html');
  // collapse=digest: adjacent captures with the SAME digest collapse to one,
  // so the archive itself does the first dedup pass.
  params.set('collapse', 'digest');
  params.set('limit', String(opts.pageLimit ?? 5000));
  params.set('showResumeKey', 'true');
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
  if (resumeKey) params.set('resumeKey', resumeKey);
  return `${CDX_ENDPOINT}?${params.toString()}`;
}

/**
 * Fetch one CDX page, honoring 429 with exponential backoff + Retry-After.
 * Throws on a non-recoverable error (network, non-200/429 status, JSON parse).
 */
async function fetchCdxPage(
  url: string,
  fetchImpl: typeof fetch,
  throttle: Throttle,
): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    await throttle.wait();
    let resp: Response;
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), CDX_REQUEST_TIMEOUT_MS);
      try {
        resp = await fetchImpl(url, {
          headers: { 'User-Agent': ARCHIVE_USER_AGENT, Accept: 'application/json' },
          signal: ac.signal,
        });
      } finally {
        clearTimeout(to);
      }
    } catch (e) {
      // Network-level failure -- retry a bounded number of times.
      if (attempt >= MAX_429_RETRIES) {
        throw new Error(`CDX request failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      attempt++;
      await sleep(BASE_429_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }

    if (resp.status === 429) {
      if (attempt >= MAX_429_RETRIES) {
        throw new Error('CDX rate-limited (429) after max retries');
      }
      attempt++;
      const retryAfter = Number(resp.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : BASE_429_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(backoff);
      continue;
    }

    if (!resp.ok) {
      throw new Error(`CDX request failed: HTTP ${resp.status}`);
    }

    const text = await resp.text();
    if (!text.trim()) return [];
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`CDX response was not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// enumerateCaptures -- the public enumeration entry point
// ---------------------------------------------------------------------------

/**
 * Enumerate every distinct-digest capture of a domain or URL from the Wayback
 * CDX Server API. Uses matchType=prefix + collapse=digest by default, paginates
 * via resumeKey, throttles to <60/min, and honors 429 backoff.
 *
 * @param domainOrUrl e.g. 'smith4mayor.org' (prefix matches smith4mayor.org/*)
 * @param opts        from/to window, matchType, page + total caps, fetch inject
 */
export async function enumerateCaptures(
  domainOrUrl: string,
  opts: EnumerateOptions = {},
): Promise<EnumerateResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const throttle = new Throttle(opts.minRequestGapMs ?? DEFAULT_MIN_REQUEST_GAP_MS);
  const maxCaptures = opts.maxCaptures ?? 50000;

  const captures: CaptureRow[] = [];
  let resumeKey: string | null = null;
  let pages = 0;
  let truncated = false;

  for (;;) {
    const url = buildCdxUrl(domainOrUrl, opts, resumeKey);
    const raw = await fetchCdxPage(url, fetchImpl, throttle);
    pages++;
    const { rows, resumeKey: nextKey } = parseCdxJson(raw);

    for (const row of rows) {
      if (captures.length >= maxCaptures) {
        truncated = true;
        break;
      }
      captures.push(row);
    }

    if (truncated || !nextKey) break;
    resumeKey = nextKey;
  }

  return { captures, pages, truncated };
}

// ---------------------------------------------------------------------------
// Wayback artifact stripping -- remove the toolbar / injected chrome
// ---------------------------------------------------------------------------

/**
 * The Wayback Machine injects a toolbar, banner, rewrite comments, and a wombat
 * client into the served HTML. These are NOT part of the captured page and must
 * be stripped BEFORE normalize+hash, or every snapshot of a page would differ
 * from the live page (and from each other across Wayback versions) on chrome we
 * do not care about.
 *
 * We strip, conservatively:
 *   - the BEGIN/END WAYBACK TOOLBAR INSERT block (and its <script>/<style>),
 *   - the #wm-ipp / wm-ipp-base toolbar container,
 *   - archive.org / web-static-* injected <script> and <link> tags,
 *   - the "Wayback Rewrite ... END" HTML comments,
 *   - the playback redirect / "Got an HTTP 302" interstitial markers,
 *   - URL-rewriting of in-page links is left to normalizeContent (it strips tags
 *     anyway); we only need the CONTENT text to be stable.
 *
 * Exported for the offline test.
 */
export function stripWaybackArtifacts(html: string): string {
  let out = html;

  // 1. The explicit toolbar insert block, however it is delimited.
  out = out.replace(
    /<!--\s*BEGIN WAYBACK TOOLBAR INSERT\s*-->[\s\S]*?<!--\s*END WAYBACK TOOLBAR INSERT\s*-->/gi,
    ' ',
  );

  // 2. The toolbar container div (id="wm-ipp..." / class with wm-ipp).
  out = out.replace(
    /<div[^>]*\bid=["']wm-ipp[^"']*["'][\s\S]*?<\/div>\s*(?:<\/div>\s*)?/gi,
    ' ',
  );

  // 3. Any Wayback "Rewrite" provenance comments.
  out = out.replace(/<!--\s*(?:BEGIN|END)?\s*Wayback Rewrite[\s\S]*?-->/gi, ' ');
  out = out.replace(/<!--[\s\S]*?\bWAYBACK[\s\S]*?-->/gi, ' ');

  // 4. Archive-injected <script> tags (analytics.archive.org, web-static,
  //    wombat.js, the playback bootstrap, __wm. references).
  out = out.replace(
    /<script[^>]*\bsrc=["'][^"']*(?:archive\.org|web-static|wombat|wm-static)[^"']*["'][^>]*>\s*<\/script>/gi,
    ' ',
  );
  out = out.replace(
    /<script[^>]*>[\s\S]*?(?:__wm\.|wombat|web-static|WB_wombat|analytics\.archive\.org)[\s\S]*?<\/script>/gi,
    ' ',
  );

  // 5. Archive-injected <link>/<style> for the toolbar.
  out = out.replace(
    /<link[^>]*\bhref=["'][^"']*(?:archive\.org|web-static|wm-static)[^"']*["'][^>]*>/gi,
    ' ',
  );

  // 6. The playback redirect interstitial markers, when present.
  out = out.replace(/Got an HTTP 30\d response at crawl time[\s\S]*?Impatient\?/gi, ' ');

  // 7. Wayback rewrites in-page resource URLs to /web/<ts>(im_|js_|cs_)?/<url>.
  //    These live inside attributes normalizeContent will strip with the tags;
  //    we leave them. No-op here by design.

  return out;
}

// ---------------------------------------------------------------------------
// fetchSnapshot -- fetch one Wayback snapshot, strip, normalize, hash
// ---------------------------------------------------------------------------

export interface SnapshotFetch {
  ok: boolean;
  /** The Wayback playback URL fetched. */
  snapshotUrl: string;
  /** Raw served HTML (with Wayback chrome) -- empty when fetch failed. */
  rawHtml: string;
  /** HTML after stripWaybackArtifacts. */
  strippedHtml: string;
  /** normalizeContent(strippedHtml) -- the canonical extracted text. */
  extractedText: string;
  /** sha256 of the stripped raw bytes (content_hash candidate). */
  contentHash: string;
  /** sha256 of the normalized extracted text (ledger key, matches live ingest). */
  normalizedHash: string;
  /** smart_fetch tier / error detail. */
  detail: string;
}

/**
 * Lightweight reuse of raw-ingest's smart_fetch result parsing. smart_fetch
 * prepends a "<!-- smart_fetch: tier=... -->" banner on success; we strip it so
 * we hash only the served body.
 */
function parseSmartFetchText(res: SmartFetchResult): { ok: boolean; body: string; tier: string; detail: string } {
  const text = res.content?.[0]?.text ?? '';
  if (res.isError) {
    const lastErr = text.match(/Last error:\s*(.+)$/m)?.[1];
    return { ok: false, body: '', tier: 'error', detail: lastErr ?? 'smart_fetch failed (all tiers)' };
  }
  const banner = text.match(
    /^<!--\s*smart_fetch:\s*tier=(\S+)\s+status=(\d+)\s+elapsed=\d+ms\s+bytes=(\d+)(?:\s+truncated)?\s*-->\n?/,
  );
  let tier = 'plain';
  let body = text;
  if (banner) {
    tier = banner[1];
    body = text.slice(banner[0].length);
  }
  return { ok: true, body, tier, detail: `tier=${tier}` };
}

/**
 * Fetch a single Wayback snapshot for (timestamp, url), strip Wayback artifacts,
 * then run the EXACT raw-ingest normalize + SHA-256 hashing so the result dedups
 * against the same evidence_seen_ledger the live pipeline uses.
 *
 * @param timestamp CDX timestamp (YYYYMMDDhhmmss)
 * @param url       the ORIGINAL (live-web) URL
 * @param fetchTool injectable smart_fetch, for offline tests; defaults to the
 *                  real runPageFetch, lazy-loaded so importing this module's
 *                  pure functions never drags in the page-fetch dependency tree.
 */
export async function fetchSnapshot(
  timestamp: string,
  url: string,
  fetchTool?: SmartFetchFn,
): Promise<SnapshotFetch> {
  const snapshotUrl = buildSnapshotUrl(timestamp, url);
  let parsed: { ok: boolean; body: string; tier: string; detail: string };
  try {
    // Lazy-load the real fetch tool only when no override is supplied and an
    // actual fetch is requested. The offline test injects its own / never calls
    // this, so it never loads page-fetch.
    const tool: SmartFetchFn =
      fetchTool ?? (await import('@/lib/agent-tools/page-fetch')).runPageFetch;
    const raw = await tool({ url: snapshotUrl });
    parsed = parseSmartFetchText(raw);
  } catch (e) {
    parsed = { ok: false, body: '', tier: 'error', detail: e instanceof Error ? e.message : String(e) };
  }

  if (!parsed.ok || !parsed.body) {
    return {
      ok: false,
      snapshotUrl,
      rawHtml: '',
      strippedHtml: '',
      extractedText: '',
      contentHash: '',
      normalizedHash: '',
      detail: parsed.detail,
    };
  }

  const strippedHtml = stripWaybackArtifacts(parsed.body);
  // content_hash: sha256 of the stripped bytes (so two Wayback versions of the
  // same captured page that differ only in chrome can still collide here).
  const contentHash = sha256Bytes(Buffer.from(strippedHtml, 'utf8'));
  // normalized_hash: identical pipeline to live ingest -> dedups against the
  // shared evidence_seen_ledger.
  const extractedText = normalizeContent(strippedHtml, 'text/html');
  const normalizedHash = sha256Text(extractedText);

  return {
    ok: true,
    snapshotUrl,
    rawHtml: parsed.body,
    strippedHtml,
    extractedText,
    contentHash,
    normalizedHash,
    detail: parsed.detail,
  };
}

// ---------------------------------------------------------------------------
// dedupeByDigest -- first gate (archive SHA-1) then normalized-hash (ledger)
// ---------------------------------------------------------------------------

export interface DigestDedupeResult {
  /** Captures with a distinct (digest, source) -- candidates for fetch/store. */
  unique: CaptureRow[];
  /** Captures dropped because their (digest, source) was already seen here. */
  duplicates: CaptureRow[];
}

/**
 * First dedup gate: collapse captures by the archive's SHA-1 `digest` (scoped by
 * `source`, mirroring the UNIQUE(digest, source) constraint). collapse=digest at
 * the CDX layer already removes ADJACENT duplicates; this removes ALL duplicates
 * regardless of position (a page that reverts to a prior digest enumerates the
 * same digest twice and we keep only the first occurrence). Order is preserved.
 *
 * Pure / offline-testable.
 */
export function dedupeByDigest(captures: CaptureRow[]): DigestDedupeResult {
  const seen = new Set<string>();
  const unique: CaptureRow[] = [];
  const duplicates: CaptureRow[] = [];
  for (const c of captures) {
    const key = `${c.source}\u0000${c.digest}`;
    if (seen.has(key)) {
      duplicates.push(c);
    } else {
      seen.add(key);
      unique.push(c);
    }
  }
  return { unique, duplicates };
}

/**
 * Second dedup gate: given a normalized_hash (from fetchSnapshot), recognize
 * content already in the shared evidence_seen_ledger WITHOUT re-storing it. The
 * caller supplies a lookup that returns true when the normalized_hash is already
 * present (live ingest, or a previously-stored snapshot). This keeps archive
 * mining idempotent against the SAME ledger the live pipeline uses.
 *
 * Returns 'recognize' (already in the ledger -- record the link, store no bytes)
 * or 'store' (new normalized content -- caller may persist a snapshot).
 *
 * The lookup is injected so this stays unit-testable offline; the live caller
 * passes a function that queries evidence_seen_ledger by normalized_hash.
 */
export async function dedupeByNormalizedHash(
  normalizedHash: string,
  ledgerHas: (normalizedHash: string) => Promise<boolean> | boolean,
): Promise<'recognize' | 'store'> {
  const present = await ledgerHas(normalizedHash);
  return present ? 'recognize' : 'store';
}

// ---------------------------------------------------------------------------
// diffCaptures -- position-drift detection + dated change window
// ---------------------------------------------------------------------------

export interface ChangeSegment {
  /** 'added' (present in curr, not prev), 'removed' (present in prev, not curr). */
  kind: 'added' | 'removed';
  /** The differing line/segment text. */
  text: string;
}

export interface DriftDiff {
  /** True when the two captures' normalized content differs. */
  changed: boolean;
  /** Per-segment additions/removals (line granularity). */
  segments: ChangeSegment[];
  /**
   * The dated change window: the change is bounded by the LAST capture that still
   * had the old content (prev) and the FIRST capture that had the new content
   * (curr). The best single-point estimate is the midpoint between them.
   */
  changeWindow: {
    lastSameAt: string; // ISO of prev.capturedAt (last capture with old content)
    firstNewAt: string; // ISO of curr.capturedAt (first capture with new content)
    midpointAt: string; // ISO of the midpoint -- our dated estimate of the change
  } | null;
}

/**
 * A capture paired with its normalized extracted text, for diffing. The text is
 * what fetchSnapshot produced (normalizeContent output); we diff on that, not on
 * raw HTML, so chrome/whitespace never registers as a position change.
 */
export interface CaptureWithText {
  capture: CaptureRow;
  /** normalizeContent(strippedHtml) for this capture. */
  extractedText: string;
}

/**
 * Split normalized text into comparable line segments. normalizeContent collapses
 * all whitespace to single spaces, so we segment on sentence-ish boundaries to
 * get meaningful change granularity rather than one giant line.
 */
function segmentText(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * diffCaptures(prev, curr): compute the change segments between two captures'
 * normalized text and DATE the change to the midpoint between the last-same-digest
 * capture (prev) and the first-new-digest capture (curr).
 *
 * Both args carry the capture row + its normalized extractedText. `prev` is the
 * last capture that still had the OLD content; `curr` is the first capture with
 * the NEW content. The midpoint of [prev.capturedAt, curr.capturedAt] is our
 * single-point estimate of when the position actually changed (we can only bound
 * it by the two surrounding crawls).
 *
 * Pure / offline-testable. Set-difference on segments (not a full Myers diff):
 * for position-drift detection we care WHICH statements appeared/disappeared,
 * not minimal edit scripts.
 */
export function diffCaptures(prev: CaptureWithText, curr: CaptureWithText): DriftDiff {
  const prevSegs = segmentText(prev.extractedText);
  const currSegs = segmentText(curr.extractedText);

  const prevSet = new Set(prevSegs);
  const currSet = new Set(currSegs);

  const segments: ChangeSegment[] = [];
  for (const s of currSegs) {
    if (!prevSet.has(s)) segments.push({ kind: 'added', text: s });
  }
  for (const s of prevSegs) {
    if (!currSet.has(s)) segments.push({ kind: 'removed', text: s });
  }

  const changed = segments.length > 0;

  let changeWindow: DriftDiff['changeWindow'] = null;
  if (changed) {
    const lastSame = prev.capture.capturedAt.getTime();
    const firstNew = curr.capture.capturedAt.getTime();
    const midpoint = Math.round((lastSame + firstNew) / 2);
    changeWindow = {
      lastSameAt: prev.capture.capturedAt.toISOString(),
      firstNewAt: curr.capture.capturedAt.toISOString(),
      midpointAt: new Date(midpoint).toISOString(),
    };
  }

  return { changed, segments, changeWindow };
}

// ---------------------------------------------------------------------------
// Small helpers exported for callers (binding a capture back to a canonical URL)
// ---------------------------------------------------------------------------

/**
 * The canonical key for a capture's ORIGINAL url, using the SAME canonicalizer
 * the live ingest + ledger use. Useful when binding archive captures to live
 * raw_evidence rows by URL. Returns null on a malformed original URL.
 */
export function canonicalOriginal(original: string): string | null {
  try {
    return canonicalizeUrl(original).canonical;
  } catch {
    return null;
  }
}

/** Re-export the hash primitive so callers need only import this module. */
export function sha1Hex(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex');
}
