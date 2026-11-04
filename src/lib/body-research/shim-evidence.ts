/**
 * shim-evidence.ts — cross-reference agent-reported citations against the
 * actual URLs the smart-fetch HTTP shim served during the run window.
 *
 * Trust model (per 2026-05-26 directives):
 *   Wikipedia + OpenStates can corroborate but NEVER count as source-of-
 *   truth. authoritative=true requires at least one primary-tier citation
 *   whose URL was actually fetched through the shim during this run.
 *   Otherwise the agent fabricated the citation (training-data hallucination)
 *   and we must downgrade.
 *
 * The shim writes JSONL to `data/shim-runs/YYYYMMDD.jsonl`. This
 * module loads any lines whose ts_ms falls within the run window and exposes
 * the set of fetched (normalized) URLs and hosts.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ShimLogEntry {
  ts_ms: number;
  ts_iso: string;
  normalized_url: string;
  url: string;
  host: string;
  tier: string;
  status: number;
  bytes: number;
  elapsed_ms: number;
  bb_run_id: string | null;
  bb_body_id: string | null;
}

export interface ShimEvidence {
  fetched_urls: Set<string>;            // normalized
  fetched_hosts: Set<string>;
  entries: ShimLogEntry[];
  log_paths_searched: string[];
}

const SHIM_LOG_DIR = process.env.SHIM_LOG_DIR
  ?? join(process.cwd(), 'data', 'shim-runs');

export function normalizeCitationUrl(u: string | null | undefined): string {
  if (!u) return '';
  try {
    const p = new URL(u);
    p.hash = '';
    let path = p.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    return `${p.protocol}//${p.hostname.toLowerCase()}${path}${p.search}`;
  } catch {
    return String(u).toLowerCase();
  }
}

function dayTag(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Load shim log entries within the time window. Spans midnight UTC by
 * concatenating both day files if needed.
 */
export function loadShimEvidence(opts: {
  ts_start_ms: number;
  ts_end_ms: number;
  body_id?: string | null;
  run_id?: string | null;
}): ShimEvidence {
  const { ts_start_ms, ts_end_ms, body_id, run_id } = opts;
  const tags = new Set<string>();
  tags.add(dayTag(ts_start_ms));
  tags.add(dayTag(ts_end_ms));
  // Conservative: include the day before in case of clock skew or write delay.
  tags.add(dayTag(ts_start_ms - 86_400_000));

  const log_paths_searched: string[] = [];
  const entries: ShimLogEntry[] = [];
  for (const tag of tags) {
    const path = join(SHIM_LOG_DIR, `${tag}.jsonl`);
    log_paths_searched.push(path);
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as ShimLogEntry;
          if (e.ts_ms < ts_start_ms || e.ts_ms > ts_end_ms) continue;
          // If a body_id/run_id is provided, restrict to entries that match
          // or that have null tags (older shim entries before correlation
          // was added). This keeps cross-watcher contamination low while
          // staying backward-compatible.
          if (body_id && e.bb_body_id && e.bb_body_id !== body_id) continue;
          if (run_id && e.bb_run_id && e.bb_run_id !== run_id) continue;
          entries.push(e);
        } catch { /* skip malformed line */ }
      }
    } catch { /* file unreadable */ }
  }

  const fetched_urls = new Set<string>();
  const fetched_hosts = new Set<string>();
  for (const e of entries) {
    // Only count successful fetches with non-trivial body. CF challenges
    // tend to return small bodies and Jina returns nothing useful on hard
    // failure; require >= 500 bytes for the URL to count as "actually
    // fetched" (the SilverStripe SPA shell case still passes since the
    // body comes back as Jina-rendered markdown >= 1KB).
    if (e.status >= 200 && e.status < 400 && e.bytes >= 500) {
      fetched_urls.add(e.normalized_url);
      fetched_hosts.add(e.host);
    }
  }

  return { fetched_urls, fetched_hosts, entries, log_paths_searched };
}

/**
 * Check whether a citation URL was actually fetched (or at least a same-host
 * URL was). Citation URL is acceptable if:
 *   1. Exact normalized URL appears in fetched_urls, OR
 *   2. Citation host appears in fetched_hosts (agent may have fetched a
 *      different page on the same site — still primary-source evidence).
 *
 * Returns:
 *   'exact'         — exact URL match (strongest)
 *   'host'          — same host but different page (acceptable)
 *   'none'          — never fetched (likely hallucinated)
 */
export function classifyCitationEvidence(
  citationUrl: string,
  evidence: ShimEvidence,
): 'exact' | 'host' | 'none' {
  const norm = normalizeCitationUrl(citationUrl);
  if (!norm) return 'none';
  if (evidence.fetched_urls.has(norm)) return 'exact';
  let host = '';
  try { host = new URL(citationUrl).hostname.toLowerCase(); } catch { /* */ }
  if (host && evidence.fetched_hosts.has(host)) return 'host';
  return 'none';
}
