/**
 * prefetch-sources.ts — dispatcher-side primary-source pre-fetch.
 *
 * THE BUG THIS SOLVES (2026-05-27):
 *   Claude Code's WebFetch tool auto-upgrades http→https. The HTTP shim
 *   listens only on http://localhost:4002 — so the agent literally can't
 *   reach it from inside the CLI. The MCP path is also blocked by an
 *   allowlist hook. Result: agent had NO productive path to fetch
 *   primary .gov sources, so every "authoritative" claim was either
 *   hallucinated from training data or supported only by plain WebFetch
 *   results from Wikipedia.
 *
 * THE FIX:
 *   Dispatcher fetches the primary sources BEFORE spawning the agent,
 *   in-process via runPageFetch. The fetched markdown is embedded
 *   directly in the prompt as PRE-FETCHED SOURCES. Agent extracts from
 *   the embedded content; no tool-use needed for primary sources.
 *
 *   Each pre-fetch is logged to the same data/shim-runs/*.jsonl
 *   with the correlation params, so the writer's evidence cross-check
 *   continues to validate that citations correspond to actually-fetched
 *   URLs (now: actually-fetched-by-the-dispatcher).
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runPageFetch } from '../agent-tools/page-fetch';
import { lookupPrimarySources } from './primary-source-lookup';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PrefetchedSource {
  url: string;
  kind: 'roster' | 'statute' | 'charter' | 'home';
  content: string;          // shim-rendered markdown / html, post-truncation
  tier: string;             // 'plain' | 'error'
  status: number;
  bytes: number;             // post-truncation length (what the agent saw)
  original_bytes: number;    // pre-truncation length (what we fetched)
  truncated: boolean;        // true when original_bytes > PER_SOURCE_CAP_BYTES
  ok: boolean;
}

export interface PrefetchResult {
  sources: PrefetchedSource[];
  prompt_block: string;     // ready to splice into the agent prompt
  total_bytes: number;
  warnings: string[];
  // Aggregate truncation signal — true if ANY source was truncated. Writer
  // persists this to meta.prefetch_truncation so Pipeline B can pick the
  // body up for verify-harder treatment.
  any_truncated: boolean;
  truncated_sources: Array<{ url: string; kind: string; original_bytes: number; cap_bytes: number }>;
}

const SHIM_LOG_DIR = process.env.SHIM_LOG_DIR
  ?? join(process.cwd(), 'data', 'shim-runs');

function ensureLogDir() {
  if (!existsSync(SHIM_LOG_DIR)) mkdirSync(SHIM_LOG_DIR, { recursive: true });
}

function shimLogPath(): string {
  const d = new Date();
  const tag = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return join(SHIM_LOG_DIR, `${tag}.jsonl`);
}

function normalizeUrl(u: string): string {
  try {
    const p = new URL(u);
    p.hash = '';
    let path = p.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    return `${p.protocol}//${p.hostname.toLowerCase()}${path}${p.search}`;
  } catch {
    return u.toLowerCase();
  }
}

function logShimFetch(entry: {
  url: string; tier: string; status: number; bytes: number; elapsed_ms: number;
  bb_run_id?: string; bb_body_id?: string;
}) {
  try {
    ensureLogDir();
    const line = JSON.stringify({
      ts_ms: Date.now(),
      ts_iso: new Date().toISOString(),
      normalized_url: normalizeUrl(entry.url),
      url: entry.url,
      host: (() => { try { return new URL(entry.url).hostname.toLowerCase(); } catch { return ''; } })(),
      tier: entry.tier,
      status: entry.status,
      bytes: entry.bytes,
      elapsed_ms: entry.elapsed_ms,
      bb_run_id: entry.bb_run_id ?? null,
      bb_body_id: entry.bb_body_id ?? null,
      source_of_fetch: 'dispatcher-prefetch',
    }) + '\n';
    appendFileSync(shimLogPath(), line, 'utf-8');
  } catch (e) {
    console.error(`[prefetch-log] failed: ${(e as Error).message}`);
  }
}

// Cap how much markdown we embed per source. Bumped 2026-05-27 from
// 80KB → 150KB after the overnight council correctly diagnosed that
// 80KB cuts off many state-legislature rosters mid-list. Even 150KB
// can be exceeded for large chambers with full bios (CA Assembly = 80
// members + bios → ~200KB rendered). The PrefetchedSource.truncated
// flag signals when we hit the cap so Pipeline B can re-fetch with
// different parameters (extract-just-the-roster, etc.).
const PER_SOURCE_CAP_BYTES = 150_000;

// Per-URL hard timeout for prefetch. A stuck connection can hang the whole
// dispatcher indefinitely. Without this cap the US Senate run on
// 2026-05-28 hung 10+ min with zero shim fetches logged before the
// watcher reaped it. 90s gives all three tiers a fair shot while
// guaranteeing the run progresses to the next source on hang.
// Env override: BB_PREFETCH_URL_TIMEOUT_MS. Default 90000 (90s).
const PREFETCH_URL_TIMEOUT_MS = parseInt(process.env.BB_PREFETCH_URL_TIMEOUT_MS ?? '90000', 10);

async function runPageFetchWithTimeout(url: string, timeoutMs: number): Promise<Awaited<ReturnType<typeof runPageFetch>>> {
  return await Promise.race([
    runPageFetch({ url }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`prefetch_timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

export async function prefetchPrimarySources(
  sb: SupabaseClient,
  opts: {
    body_kind: string;
    jurisdiction_name: string;
    state_fips?: string | null;
    run_id: string;
    body_id: string;
  },
): Promise<PrefetchResult> {
  const warnings: string[] = [];
  const sources: PrefetchedSource[] = [];

  const psu = await lookupPrimarySources(sb, {
    body_kind: opts.body_kind,
    jurisdiction_name: opts.jurisdiction_name,
    state_fips: opts.state_fips,
  });

  const toFetch: Array<{ url: string; kind: PrefetchedSource['kind'] }> = [];
  if (psu.roster_url) toFetch.push({ url: psu.roster_url, kind: 'roster' });
  if (psu.statute_url) toFetch.push({ url: psu.statute_url, kind: 'statute' });
  if (psu.charter_url) toFetch.push({ url: psu.charter_url, kind: 'charter' });

  if (toFetch.length === 0) {
    return {
      sources: [],
      prompt_block: `\n# NO PRE-FETCHED PRIMARY SOURCES — STAGE 2 REQUIRED (do NOT quit without trying)\n\nThe primary_source_urls table has NO mapped roster for this body. That does NOT mean you may give up: you MUST actively find the real source before returning anything.\n\nSTAGE 2 — find the official roster yourself:\n  1. WebSearch for the body's OWN official members/roster page (its .gov/.us site; for some bodies a recognized official .org/.com).\n  2. For state legislative chambers: the chamber's official "members"/"legislators"/"senators"/"representatives" listing on the state legislature .gov site.\n  3. For courts: the state judiciary .gov "justices"/"judges" directory.\n  4. smart_fetch each candidate page (via the shim) and CONFIRM the roster is actually present (names + districts/seats), not a JS/nav shell.\n  5. Only AFTER a genuine search comes up empty may you set authoritative=false — and you MUST state the reason in notes using one of: "no_published_roster", "js_walled", or "ambiguous". A bare empty result with no reason is treated as a defect.\n\nIf you find a working official roster URL, INCLUDE it verbatim in your citations[] (the dispatcher records confirmed primary citations back into the source map for next time).\n\n`,
      total_bytes: 0,
      warnings: ['no primary_source_urls entries — agent must discover URLs itself (Stage 2)'],
      any_truncated: false,
      truncated_sources: [],
    };
  }

  for (const { url, kind } of toFetch) {
    const startedAt = Date.now();
    let content = '';
    let tier = 'unknown';
    let status = 0;
    let bytes = 0;
    let ok = false;
    try {
      const result = await runPageFetchWithTimeout(url, PREFETCH_URL_TIMEOUT_MS);
      content = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      bytes = content.length;
      // Banner: <!-- smart_fetch: tier=X status=Y elapsed=Zms bytes=N -->
      const banner = content.match(/^<!-- smart_fetch: tier=(\w+) status=(\d+)/);
      tier = banner?.[1] ?? (result.isError ? 'error' : 'unknown');
      status = banner ? parseInt(banner[2], 10) : (result.isError ? 502 : 200);
      ok = !result.isError && bytes > 500;
    } catch (e: any) {
      const isTimeout = String(e.message ?? '').startsWith('prefetch_timeout');
      content = `(prefetch ${isTimeout ? 'timed out' : 'failed'}: ${e.message ?? String(e)})`;
      tier = isTimeout ? 'timeout' : 'error';
      status = isTimeout ? 504 : 500;
      bytes = content.length;
      ok = false;
      warnings.push(`prefetch ${isTimeout ? 'timed out' : 'failed'} for ${url}: ${e.message ?? String(e)}`);
    }
    const elapsed_ms = Date.now() - startedAt;
    logShimFetch({
      url, tier, status, bytes, elapsed_ms,
      bb_run_id: opts.run_id,
      bb_body_id: opts.body_id,
    });
    // Apply per-source cap. Critical: track original_bytes + truncated
    // flag so downstream signals know the agent saw a partial source.
    const original_bytes = bytes;
    let truncated = false;
    if (bytes > PER_SOURCE_CAP_BYTES) {
      const cut = content.slice(0, PER_SOURCE_CAP_BYTES);
      content = cut + `\n\n[…TRUNCATED at ${PER_SOURCE_CAP_BYTES} chars; original was ${original_bytes} chars. Roster entries typically appear in the first 50KB but the truncated portion ${original_bytes - PER_SOURCE_CAP_BYTES} chars may contain additional members. If your seat count seems low for this body, flag the run as authoritative=false and note "prefetch_truncation" in your notes.]`;
      bytes = content.length;
      truncated = true;
      warnings.push(`source ${url} (${original_bytes} bytes) truncated to ${PER_SOURCE_CAP_BYTES} for prompt embedding`);
    }
    sources.push({ url, kind, content, tier, status, bytes, original_bytes, truncated, ok });
  }

  const total_bytes = sources.reduce((n, s) => n + s.content.length, 0);
  const truncated_sources = sources
    .filter((s) => s.truncated)
    .map((s) => ({ url: s.url, kind: s.kind, original_bytes: s.original_bytes, cap_bytes: PER_SOURCE_CAP_BYTES }));
  const any_truncated = truncated_sources.length > 0;

  // Build the prompt block. Format optimizes for the agent extracting
  // structured data from each source: clear delimiters, content kind,
  // URL receipt for citation.
  const sourceBlocks = sources.map((s, i) => {
    const okMark = s.ok ? '✓' : '✗';
    return `### PRE-FETCHED SOURCE ${i + 1} — kind=${s.kind} tier=${s.tier} status=${s.status} bytes=${s.bytes} ${okMark}
URL: ${s.url}

${s.content}

### END PRE-FETCHED SOURCE ${i + 1}
`;
  }).join('\n');

  const prompt_block = `\n# PRE-FETCHED PRIMARY SOURCES (dispatcher-side, ${sources.length} source${sources.length === 1 ? '' : 's'}, ${total_bytes} bytes total)

The dispatcher has ALREADY fetched the following primary sources with a plain HTTP fetch (smart_fetch) and embedded the content below. The fetches are logged in data/shim-runs/*.jsonl with the correlation params bb_run_id=${opts.run_id} bb_body_id=${opts.body_id} so the writer's evidence cross-check passes when you cite these URLs.

CRITICAL: DO NOT attempt to re-fetch these URLs via WebFetch — WebFetch auto-upgrades http→https and breaks the localhost shim. Use the embedded content below directly.

For \`authoritative: true\`, your \`citations[]\` array MUST include the URLs of these pre-fetched sources you actually used (copy them verbatim from the URL: lines above). The writer cross-checks your citation URLs against the pre-fetch log. Citations to URLs NOT in the pre-fetched set are treated as hallucinated.

STAGE 2 — if the pre-fetched source(s) above do NOT actually contain a confirmable roster (e.g. the page was a JS shell, a 404, or the wrong page), do NOT give up: WebSearch for the body's real official members/roster page, smart_fetch it (via the shim, so it's logged), and cite THAT verbatim. Only after a genuine search comes up empty may you set authoritative=false — and you MUST state the reason in notes ("no_published_roster" | "js_walled" | "ambiguous"). A bare empty result is treated as a defect.

You may still call WebSearch / WebFetch for additional discovery (Wikipedia, finding a missing URL), but Wikipedia/OpenStates count as corroborating-only and cannot satisfy the primary-source requirement on their own.

${sourceBlocks}

`;

  return { sources, prompt_block, total_bytes, warnings, any_truncated, truncated_sources };
}
