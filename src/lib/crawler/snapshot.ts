/**
 * Havesay own-archive pipeline — per blueprint-v6 §7.5 infrastructure.
 *
 * Why this exists (methodology research iter-10):
 *   - Claude Code's WebFetch tool is BLOCKED from web.archive.org / archive.ph
 *   - ~68% of candidate campaign domains are DNS-dead within 18 months
 *   - Live sites silently rewrite history (some now cite 2025 laws
 *     on their "2024 campaign" pages) — iter-06
 *
 * Verdict: Havesay must be its own archive. Every source we ingest as
 * evidence gets a byte-level snapshot + full provenance row in `snapshots`.
 *
 * This module is the foundation. It deliberately covers the cheap/always-works
 * path first (plain HTTP + Supabase Storage). Playwright for SPAs and PDF
 * parsing are flagged TODO — they require heavier deps (playwright, pdf-parse)
 * that we install in a follow-up once we've validated the end-to-end plumbing.
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const SNAPSHOT_BUCKET = 'snapshots';

/** How snapshots are classified. Matches the `source_type` column CHECK values. */
export type SnapshotSourceType =
  | 'candidate_site'
  | 'ballotpedia'
  | 'news'
  | 'voter_guide'
  | 'debate_video'
  | 'endorsement_list'
  | 'official'
  | 'campaign_finance'
  | 'wayback'
  | 'other';

/** Which fetcher produced the snapshot. */
export type SnapshotFetcher = 'plain' | 'playwright' | 'wayback_cdx' | 'pdf';

export interface FetchResult {
  url: string;
  finalUrl: string; // after redirects
  status: number;
  contentType: string | null;
  bodyBytes: Uint8Array;
  extractedText: string | null; // best-effort; may be null for binary
  notes: string | null;
}

export interface SnapshotInput {
  url: string;
  sourceType: SnapshotSourceType;
  candidateId?: string;
  candidateSourceId?: string;
  fetcher?: SnapshotFetcher;
}

export interface SnapshotRecord {
  id: string;
  url: string;
  url_hash: string;
  fetched_at: string;
  http_status: number | null;
  content_type: string | null;
  storage_path: string;
  raw_size_bytes: number;
  fetcher: SnapshotFetcher;
  source_type: SnapshotSourceType;
  candidate_id: string | null;
  candidate_source_id: string | null;
  extracted_text: string | null;
  fetch_notes: string | null;
}

// ---------------------------------------------------------------------------
// URL normalization + hashing
// ---------------------------------------------------------------------------

/**
 * Normalize a URL before hashing so tiny string variations don't de-dup badly.
 * - lowercase host
 * - sort query params
 * - strip utm_* tracking params (they're noise)
 * - strip trailing slash (treat /issues and /issues/ as the same page)
 */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hostname = u.hostname.toLowerCase();

  // Drop UTM and other tracking params
  const dropKeys = new Set<string>();
  for (const key of u.searchParams.keys()) {
    if (key.toLowerCase().startsWith('utm_')) dropKeys.add(key);
    if (key === 'fbclid' || key === 'gclid') dropKeys.add(key);
  }
  for (const k of dropKeys) u.searchParams.delete(k);

  // Sort remaining params for stable hashing
  const sorted = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of sorted) u.searchParams.append(k, v);

  // Strip trailing slash from the path (but keep "/")
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

export function hashUrl(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

// ---------------------------------------------------------------------------
// Plain-HTTP fetcher (the cheap always-works path)
// ---------------------------------------------------------------------------

/**
 * Hosts we will not ingest from. Two different reasons are collapsed onto the
 * same gate because the outcome is identical (FetchResult with status=0 and
 * an audit-trail note, no bytes saved):
 *
 *   1. UA-gated Ballotpedia hosts (ballotpedia.org, www.ballotpedia.org):
 *      empirically filter our explicit Havesay UA. Rather than rotate to
 *      a generic Chrome UA (arms-race path) we skip and defer to an
 *      out-of-band access arrangement. See 08-research/ballotpedia-access-2026-04-17.
 *   2. License-gated Ballotpedia subdomains (news.ballotpedia.org): carry
 *      CC-BY-SA editorial prose whose share-alike terms we are not currently
 *      set up to honor. Verify-only, do not ingest.
 *
 * All ballotpedia.org subdomains are CC-BY-SA; verify-only, do not ingest.
 * See 05-legal/ for licensing decision.
 */
const UA_GATED_HOSTS = new Set<string>([
  'ballotpedia.org',
  'www.ballotpedia.org',
  'news.ballotpedia.org',
]);

/**
 * Plain HTTP fetch. Works for static HTML, JSON APIs, plain text.
 * Does NOT work for:
 *   - React SPAs (electionresults.utah.gov, enhancedvoting.com, some campaign
 *     sites) → use fetchViaPlaywright() when we have playwright installed
 *   - PDFs (they fetch fine as bytes but need pdf-parse for text extraction)
 *     → use fetchAndExtractPdf() when we have pdf-parse installed
 *   - web.archive.org (blocked by Cloudflare challenges against Node fetch)
 *     → use fetchFromWaybackCdx() via the Wayback CDX API (not the UI)
 *   - Ballotpedia (UA-gated — see UA_GATED_HOSTS above) — out of scope until
 *     we negotiate access; skip rather than scrape
 *
 * Includes a polite UA string identifying Havesay so admins can see us
 * in their logs and contact us if they'd rather we slow down. We do not
 * rotate / spoof UAs to evade per-host filtering; where a host explicitly
 * walls our UA we skip and seek proper access instead.
 */
export async function fetchPlain(url: string): Promise<FetchResult> {
  const normalized = normalizeUrl(url);

  // Skip UA-gated hosts rather than switch to a Chrome UA. See module comment.
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    if (UA_GATED_HOSTS.has(host)) {
      return {
        url: normalized,
        finalUrl: normalized,
        status: 0,
        contentType: null,
        bodyBytes: new Uint8Array(),
        extractedText: null,
        notes:
          `skipped: ${host} is gated. All ballotpedia.org subdomains are CC-BY-SA ` +
          `(verify-only, do not ingest). ballotpedia.org + www.ballotpedia.org also ` +
          `UA-filter our explicit Havesay UA. See 05-legal/ for the licensing ` +
          `decision and 08-research/ballotpedia-access-2026-04-17 for the access path. ` +
          `Remove from UA_GATED_HOSTS only when a licensed route is live.`,
      };
    }
  } catch {
    /* if the URL is malformed, fall through and let fetch() fail naturally */
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(normalized, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Havesay/1.0 (nonpartisan voter-information project, in development)',
        Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
      },
    });

    const bytes = new Uint8Array(await res.arrayBuffer());
    const ct = res.headers.get('content-type');

    // Best-effort text extraction for text-ish content types. NEVER try for
    // known-binary types, which sometimes get mis-served as generic
    // application/octet-stream or even text/html (and the xlsx case, where
    // we'd otherwise happily decode ZIP bytes into a string full of NULs).
    // Council-review 2026-04-17 Blocker B1: PG TEXT columns reject U+0000,
    // which is what the TextDecoder happily produces from binary content.
    const isKnownBinary =
      !!ct &&
      (ct.startsWith('application/vnd.openxmlformats') ||
        ct.startsWith('application/pdf') ||
        ct.startsWith('application/zip') ||
        ct.startsWith('application/octet-stream') ||
        ct.startsWith('image/') ||
        ct.startsWith('video/') ||
        ct.startsWith('audio/'));

    let extractedText: string | null = null;
    if (
      !isKnownBinary &&
      ct &&
      (ct.startsWith('text/') || ct.includes('json') || ct.includes('xml'))
    ) {
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      // Even for declared-text content, a malformed stream can surface U+0000;
      // PostgreSQL TEXT columns reject those. Strip defensively.
      extractedText = decoded.replace(/\u0000/g, '');
    }

    return {
      url: normalized,
      finalUrl: res.url,
      status: res.status,
      contentType: ct,
      bodyBytes: bytes,
      extractedText,
      notes:
        res.url === normalized ? null : `redirected from ${normalized}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      url: normalized,
      finalUrl: normalized,
      status: 0,
      contentType: null,
      bodyBytes: new Uint8Array(),
      extractedText: null,
      notes: `fetch failed: ${msg}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Wayback CDX API fetcher
// ---------------------------------------------------------------------------

/**
 * Query the Wayback Machine's CDX API for the closest snapshot to a target
 * date. The CDX API works where WebFetch-on-web.archive.org doesn't — it's
 * designed for programmatic access and returns JSON describing available
 * snapshots without a browser challenge.
 *
 * https://archive.org/developers/wayback-cdx-server.html
 *
 * Example use: find the closest October 2024 snapshot of a now-dead candidate
 * campaign site so we can show its real 2024 positions rather than its
 * current (rewritten) content.
 */
export async function findWaybackSnapshot(
  url: string,
  targetDateYYYYMMDD: string,
): Promise<{ snapshotUrl: string; timestamp: string } | null> {
  const cdxUrl =
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}` +
    `&output=json&limit=1&closest=${targetDateYYYYMMDD}&filter=statuscode:200`;

  try {
    const res = await fetch(cdxUrl, {
      headers: {
        'User-Agent':
          'Havesay/1.0 (nonpartisan voter guide; using Wayback CDX API per their ToS)',
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as string[][];
    // First row is headers, second row is the snapshot (if found)
    if (json.length < 2) return null;
    const [, row] = json;
    const [timestamp, original] = [row[1], row[2]];
    if (!timestamp || !original) return null;
    return {
      snapshotUrl: `https://web.archive.org/web/${timestamp}/${original}`,
      timestamp,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Storage + snapshot record
// ---------------------------------------------------------------------------

/**
 * Path convention for Supabase Storage:
 *   snapshots/{yyyymm}/{url_hash}_{timestamp}.bin
 * Partitioning by month keeps the bucket browsable at scale.
 */
function storagePath(urlHash: string, fetchedAt: Date): string {
  const yyyy = fetchedAt.getUTCFullYear();
  const mm = String(fetchedAt.getUTCMonth() + 1).padStart(2, '0');
  const ts = fetchedAt.toISOString().replace(/[:.]/g, '-');
  return `${yyyy}${mm}/${urlHash}_${ts}.bin`;
}

/**
 * Full snapshot pipeline: fetch, store bytes to Supabase Storage, write
 * provenance row. Idempotent only in the sense that it's append-only — each
 * call creates a new snapshot; the intended pattern is to re-snapshot when
 * source material changes or periodically as an integrity check.
 */
export async function takeSnapshot(
  supabase: SupabaseClient,
  input: SnapshotInput,
): Promise<SnapshotRecord> {
  const fetched = await fetchPlain(input.url);
  const fetchedAt = new Date();
  const normalized = fetched.url;
  const urlHash = hashUrl(normalized);
  const fetcher: SnapshotFetcher = input.fetcher ?? 'plain';

  // Upload bytes. If fetch failed (status 0), we still record the attempt
  // but store a zero-byte file to keep the audit trail complete.
  const path = storagePath(urlHash, fetchedAt);
  // Snapshots are append-only; re-using a storagePath from a clock-collision
  // replay is the only way to hit a 409 here, and the path embeds an ISO
  // timestamp so it's essentially unique. upsert:true makes re-runs safe.
  const { error: upErr } = await supabase.storage
    .from(SNAPSHOT_BUCKET)
    .upload(path, fetched.bodyBytes, {
      contentType: fetched.contentType ?? 'application/octet-stream',
      upsert: true,
    });

  if (upErr) {
    throw new Error(`snapshot storage upload failed: ${upErr.message}`);
  }

  const { data: inserted, error: insErr } = await supabase
    .from('snapshots')
    .insert({
      url: normalized,
      url_hash: urlHash,
      fetched_at: fetchedAt.toISOString(),
      http_status: fetched.status || null,
      content_type: fetched.contentType,
      storage_path: path,
      raw_size_bytes: fetched.bodyBytes.byteLength,
      fetcher,
      source_type: input.sourceType,
      candidate_id: input.candidateId ?? null,
      candidate_source_id: input.candidateSourceId ?? null,
      extracted_text: fetched.extractedText,
      fetch_notes: fetched.notes,
    })
    .select()
    .single();

  if (insErr || !inserted) {
    throw new Error(`snapshot row insert failed: ${insErr?.message}`);
  }

  return inserted as SnapshotRecord;
}

/**
 * Check whether we've already snapshotted a URL within the staleness window.
 * Useful for cheap re-runs where we don't want to re-snapshot what's still
 * fresh.
 */
export async function findRecentSnapshot(
  supabase: SupabaseClient,
  url: string,
  maxAgeDays: number,
): Promise<SnapshotRecord | null> {
  const normalized = normalizeUrl(url);
  const urlHash = hashUrl(normalized);
  const cutoff = new Date(Date.now() - maxAgeDays * 864e5).toISOString();

  const { data, error } = await supabase
    .from('snapshots')
    .select('*')
    .eq('url_hash', urlHash)
    .gte('fetched_at', cutoff)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return (data as SnapshotRecord | null) ?? null;
}

// ---------------------------------------------------------------------------
// Deferred: Playwright + PDF
// ---------------------------------------------------------------------------

/**
 * TODO: Implement when we install `playwright` + `chromium`.
 * Use for: Ballotpedia (all pages return empty via plain fetch per iter-02),
 * Utah's electionresults SPA, iVoterGuide (some content gates on JS).
 *
 * Signature preview:
 *   fetchViaPlaywright(url: string): Promise<FetchResult>
 */

/**
 * TODO: Implement when we install `pdf-parse` (or use Adobe Extract API).
 * Use for: Utah's 2.9MB Statewide Canvass PDF (where state house vote
 * totals live), voter information pamphlet PDFs, candidate press releases.
 *
 * Signature preview:
 *   extractPdfText(bytes: Uint8Array): Promise<string>
 */
