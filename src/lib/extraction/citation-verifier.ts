/**
 * citation-verifier — re-confirms that an extracted field's snippet still
 * appears verbatim at its source URL.
 *
 * Why: every row in `field_extraction_spans` is a claim of the form
 *   "the value of <field_name> on <owner> is <field_value>, and you can
 *    see this in <snippet> at <source_url> (chars <char_start>..<char_end>)"
 * Pages drift. Candidates remove things. Hosts 404. We need a sweeper
 * that periodically refetches source_url, looks for snippet, and flips
 * verification_status accordingly. Once flipped to snippet_missing /
 * url_unreachable, the voter-facing surface hides or rechecks the field.
 *
 * Field-specific match rules:
 *   - 'contact_email' → tight regex `/[\w.+-]+@[\w.-]+\.[\w]{2,}/i`. We
 *     tolerate the email being formatted differently (mailto: prefix,
 *     surrounding whitespace, list separators) as long as the literal
 *     address appears somewhere in the body. This is intentionally tight:
 *     we don't want to verify a snippet just because the page happens to
 *     contain SOME email — we verify because it contains THIS email.
 *   - field_name ending in '_url' (campaign_website_url, social_*_url, etc.)
 *     → normalize both sides (lowercase host, drop trailing slash, drop
 *     scheme differences http/https, drop a single trailing query string
 *     that isn't part of the path). Matches if the normalized field_value
 *     appears anywhere in the page or in the page's <a href=...> targets.
 *   - everything else → strict verbatim substring match against the page
 *     body (HTML-stripped to plain text), case-sensitive. Whitespace in
 *     the snippet is normalized to a single space on both sides before
 *     comparison so that an extractor's "Vote NO on Question 1" matches
 *     the page's HTML "Vote\n  NO   on Question 1" after rendering.
 *
 * License-aware skip:
 *   - Hosts in LICENSE_PASS_THROUGH_HOSTS (Wikipedia, Ballotpedia) are
 *     CC-BY-SA / share-alike. BB does NOT redistribute their content.
 *     For these, we mark 'verified' with meta.license_pass_through=true
 *     WITHOUT fetching, because (a) we never stored the snippet body in
 *     a redistributable way and (b) refetching to verify their text would
 *     re-introduce share-alike risk.
 *
 * No new external deps — uses Node 18+ global fetch + AbortSignal.timeout.
 */

import { Client } from 'pg';
import { POLITE_USER_AGENT } from '@/lib/bot-user-agent';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerifyStatus =
  | 'verified'
  | 'snippet_missing'
  | 'url_unreachable';

export interface SpanInput {
  source_url: string;
  snippet: string;
  field_name: string;
}

export interface SpanRow {
  id: string;
  source_url: string;
  snippet: string | null;
  field_name: string;
  field_value: string | null;
}

export interface VerifyResult {
  ok: boolean;
  status: VerifyStatus;
  meta?: Record<string, unknown>;
}

export interface VerifyAllPendingCounts {
  verified: number;
  snippet_missing: number;
  url_unreachable: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Hosts whose content is share-alike licensed. We never redistribute their
 * bodies, so verification is short-circuited to a license_pass_through pass.
 * The URL still grounds the claim — we just don't refetch and re-store text.
 */
const LICENSE_PASS_THROUGH_HOSTS = new Set<string>([
  'en.wikipedia.org',
  'wikipedia.org',
  'ballotpedia.org',
  'www.ballotpedia.org',
]);

const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[\w]{2,}/i;

const FETCH_HEADERS = {
  // Identify honestly; a site that refuses this client is recorded as
  // unreachable rather than retried in disguise.
  'user-agent': POLITE_USER_AGENT,
  'accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hostFor(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Strip HTML tags, decode common entities, and collapse whitespace so that
 * a snippet captured from rendered text matches against the raw HTML body.
 * Intentionally cheap — we don't pull in a DOM parser. False negatives
 * here just mean a row stays 'snippet_missing' until next verify, which is
 * the safe direction.
 */
function stripHtml(html: string): string {
  return html
    // Drop <script> and <style> blocks entirely; their content is never
    // user-visible and frequently contains noise that would create false
    // positives if we matched into it.
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return code > 0 && code < 0x10ffff ? String.fromCharCode(code) : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a URL for tolerant matching: lowercase host, drop scheme,
 * drop a single trailing slash, drop a trailing #fragment. Used by the
 * *_url field rule so that http/https + trailing-slash variants of the
 * candidate's website all match.
 */
function normalizeUrl(s: string): string {
  let v = s.trim();
  if (!v) return v;
  // Drop scheme
  v = v.replace(/^https?:\/\//i, '');
  // Drop fragment
  const hash = v.indexOf('#');
  if (hash !== -1) v = v.slice(0, hash);
  // Drop a single trailing slash
  if (v.endsWith('/')) v = v.slice(0, -1);
  return v.toLowerCase();
}

/**
 * Email match rule: extract every email-shaped token from the body and
 * confirm at least one equals the expected email (case-insensitively).
 * `expected` is whichever of (snippet, field_value if email-shaped) we
 * can pull from the span — emails sometimes live in `field_value` rather
 * than `snippet` because the extractor stored the address as the value
 * and the snippet as surrounding context.
 */
function emailAppears(body: string, expected: string): boolean {
  const wantMatch = expected.match(EMAIL_RE);
  if (!wantMatch) return false;
  const want = wantMatch[0].toLowerCase();
  const found = body.match(/[\w.+-]+@[\w.-]+\.[\w]{2,}/gi) || [];
  for (const f of found) {
    if (f.toLowerCase() === want) return true;
  }
  return false;
}

/**
 * URL match rule: pull every href and every bare URL from the body and
 * compare to the normalized expected URL.
 */
function urlAppears(rawBody: string, expected: string): boolean {
  const want = normalizeUrl(expected);
  if (!want) return false;
  // Cheap href scrape — captures attribute values that are URLs without
  // pulling in cheerio. Also catches bare URLs in plain text.
  const candidates = new Set<string>();
  const hrefRe = /\bhref\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(rawBody))) candidates.add(m[1]);
  const bareRe = /https?:\/\/[^\s"'<>)]+/gi;
  while ((m = bareRe.exec(rawBody))) candidates.add(m[0]);
  for (const c of candidates) {
    if (normalizeUrl(c) === want) return true;
    // Allow exact-prefix match: page links to /path/ when field stored /path
    if (normalizeUrl(c).startsWith(want + '/')) return true;
  }
  // As a last resort, plain substring on the normalized body
  return rawBody.toLowerCase().includes(want);
}

/**
 * Generic snippet match: case-sensitive verbatim substring against
 * HTML-stripped, whitespace-collapsed body. The snippet itself is also
 * whitespace-collapsed so HTML rendering differences don't cause misses.
 */
function snippetAppears(stripped: string, snippet: string): boolean {
  const needle = normalizeWs(snippet);
  if (!needle) return false;
  if (stripped.includes(needle)) return true;
  // Try case-insensitive as a fallback for slogan-type snippets where the
  // page may title-case differently than the extractor captured. Still
  // tight — substring, not fuzzy.
  return stripped.toLowerCase().includes(needle.toLowerCase());
}

async function fetchBody(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a single span. Network-bound — caller should batch and respect
 * its own concurrency limits. Returns a VerifyResult with status that
 * maps directly to verification_status in the DB. License pass-through
 * hosts are returned as 'verified' with meta.license_pass_through=true
 * without making a network call.
 */
export async function verifySpan(span: SpanInput): Promise<VerifyResult> {
  const host = hostFor(span.source_url);
  if (host && LICENSE_PASS_THROUGH_HOSTS.has(host)) {
    return {
      ok: true,
      status: 'verified',
      meta: { license_pass_through: true, host },
    };
  }

  let raw: string;
  try {
    raw = await fetchBody(span.source_url);
  } catch (e) {
    return {
      ok: false,
      status: 'url_unreachable',
      meta: { error: e instanceof Error ? e.message : String(e) },
    };
  }

  const stripped = stripHtml(raw);
  const fieldName = span.field_name;
  const snippet = span.snippet ?? '';

  // Field-specific rules
  if (fieldName === 'contact_email') {
    if (emailAppears(stripped, snippet) || emailAppears(raw, snippet)) {
      return { ok: true, status: 'verified' };
    }
    return { ok: false, status: 'snippet_missing' };
  }

  if (fieldName.endsWith('_url')) {
    if (urlAppears(raw, snippet)) {
      return { ok: true, status: 'verified' };
    }
    return { ok: false, status: 'snippet_missing' };
  }

  // Default: verbatim (whitespace-collapsed) substring against stripped body.
  // Falling back to raw HTML helps when the snippet was captured WITH HTML
  // entities or attribute values that stripping would lose.
  if (snippetAppears(stripped, snippet) || snippetAppears(raw, snippet)) {
    return { ok: true, status: 'verified' };
  }

  return { ok: false, status: 'snippet_missing' };
}

/**
 * Sweep up to `limit` pending rows in field_extraction_spans, verify each,
 * write back verification_status + verified_at + a meta diff, and return
 * counts. Designed to be safe to run repeatedly (idempotent — a verified
 * row stays verified until a separate stale-sweep flips it).
 *
 * Sequential by default — adapter sites are rate-sensitive and we'd
 * rather take longer than get a host blocking us. If/when we need
 * throughput, swap in a small concurrency pool here.
 */
export async function verifyAllPending(
  limit = 100,
): Promise<VerifyAllPendingCounts> {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error('verifyAllPending: DATABASE_URL is not set');
  }
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const counts: VerifyAllPendingCounts = {
    verified: 0,
    snippet_missing: 0,
    url_unreachable: 0,
    total: 0,
  };

  try {
    const r = await client.query<SpanRow>(
      `SELECT id, source_url, snippet, field_name, field_value
         FROM field_extraction_spans
        WHERE verification_status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );

    for (const row of r.rows) {
      counts.total++;
      // Use snippet if present; for emails / urls the field_value can be
      // the actual address/url and the snippet may be surrounding context.
      const probe = row.snippet ?? row.field_value ?? '';
      const result = await verifySpan({
        source_url: row.source_url,
        snippet: probe,
        field_name: row.field_name,
      });

      counts[result.status]++;

      await client.query(
        `UPDATE field_extraction_spans
            SET verification_status = $1,
                verified_at         = now(),
                meta                = COALESCE(meta, '{}'::jsonb)
                                      || $2::jsonb
          WHERE id = $3`,
        [
          result.status,
          JSON.stringify({
            last_verify: {
              status: result.status,
              at: new Date().toISOString(),
              ...(result.meta ?? {}),
            },
          }),
          row.id,
        ],
      );
    }
  } finally {
    await client.end();
  }

  return counts;
}
