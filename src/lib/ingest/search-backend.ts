/**
 * search-backend.ts -- a BACKEND-AGNOSTIC, self-hostable search layer for
 * AGGREGATOR-FREE active discovery.
 *
 * WHY THIS SHAPE (read first). The cheap general-search-API era is closed for a
 * new no-metered, aggregator-free, terms-of-service-clean build:
 *   - Bing Web Search API was retired 2025-08-11.
 *   - Google Custom Search JSON is closed to new customers.
 *   - Brave Search API dropped its free tier AND its terms forbid storing
 *     results or feeding them to an artificial-intelligence (AI) model --
 *     disqualifying for an ingest pipeline.
 *   - SerpAPI / SERP scrapers self-admittedly violate Google terms.
 * (See 12-positioning-engine/09-candidate-research-techniques-and-tools.md.)
 *
 * So this layer cannot lean on a search-API key. The viable posture is a
 * SELF-HOSTED metasearch engine (SearXNG) called politely as the only "search"
 * tier, with a keyless DuckDuckGo Instant Answer fallback that is explicitly
 * DEGRADED (it is not a web index; it returns topic/related links only).
 *
 * Backend selection (env-driven, self-hostable):
 *   - SEARX_URL set  -> primary backend: GET {SEARX_URL}/search?q=...&format=json
 *   - SEARX_URL unset -> DEGRADED fallback: GET https://api.duckduckgo.com/?q=...&format=json
 *
 * HARD RULES enforced here:
 *   1. NEVER persist SERP payloads as corpus. We return URL POINTERS only
 *      (string URLs + lightweight metadata). The caller fetches+stores via the
 *      raw-evidence pipeline; the search response itself is never stored.
 *   2. Aggregator denylist is applied to every result URL (reuse isDenied +
 *      canonicalizeUrl from raw-ingest.ts). A denylisted host never escapes
 *      this module.
 *   3. Polite, LOW rate. A per-call minimum spacing is enforced process-wide so
 *      a batch run cannot hammer a self-hosted SearXNG or DuckDuckGo.
 *
 * Single TypeScript runtime, no Python. Native fetch only, no new npm deps.
 */

import { canonicalizeUrl, isDenied } from '@/lib/ingest/raw-ingest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which backend produced the results (for logging + degraded-mode warnings). */
export type SearchBackend = 'searxng' | 'duckduckgo';

/** One ranked search result -- a URL POINTER, never stored as corpus. */
export interface SearchResult {
  /** Canonicalized result URL (through canonicalizeUrl, never denylisted). */
  url: string;
  /** Result title when the backend supplied one (SERP only -- not stored). */
  title?: string | null;
  /** Result snippet when the backend supplied one (SERP only -- not stored). */
  snippet?: string | null;
  /** Backend's own relevance rank/score when present (SearXNG only). */
  backendScore?: number | null;
  /** Which backend produced this row. */
  backend: SearchBackend;
}

export interface SearchResponse {
  /** Backend actually used for this query. */
  backend: SearchBackend;
  /**
   * True when running on the keyless DuckDuckGo Instant Answer fallback, which
   * is NOT a web index -- it returns Instant-Answer related/topic links only
   * and will miss most thin-footprint campaign sites. Callers should surface
   * this so a run on degraded search is not mistaken for full coverage.
   */
  degraded: boolean;
  /** Ranked result URL pointers (deduped, denylist-filtered). */
  results: SearchResult[];
  /** Human-readable note for the CLI log (backend, degraded reason, counts). */
  note: string;
}

export interface SearchOpts {
  /** Max results to return after dedup + denylist filtering. Default 20. */
  limit?: number;
  /**
   * Per-call timeout in milliseconds for the backend fetch. Default 12000.
   * Native fetch is aborted via AbortController when this elapses.
   */
  timeoutMs?: number;
  /**
   * Minimum spacing between successive search calls, process-wide (politeness).
   * Default 1500ms. A batch that calls search() in a loop is throttled to at
   * most one backend hit per this interval. Set 0 in tests.
   */
  minSpacingMs?: number;
  /**
   * Override SEARX_URL for tests / explicit wiring. When provided, the SearXNG
   * backend is used regardless of env. When null, force the DuckDuckGo
   * fallback. When undefined (default), read process.env.SEARX_URL.
   */
  searxUrl?: string | null;
  /**
   * Injected fetch for OFFLINE TESTS. Defaults to global fetch. Tests pass a
   * stub so no network call happens.
   */
  fetchImpl?: typeof fetch;
  /**
   * Descriptive User-Agent for polite identification. Defaults to a
   * Ballot-Bridge discovery agent string.
   */
  userAgent?: string;
}

// ---------------------------------------------------------------------------
// Polite, process-wide rate limiter (low rate)
// ---------------------------------------------------------------------------

/**
 * Last time (epoch ms) any search() backend call started. Module-level so a
 * loop of search() calls across the batch shares one polite cadence.
 */
let lastCallAtMs = 0;

async function waitForPoliteSlot(minSpacingMs: number): Promise<void> {
  if (minSpacingMs <= 0) return;
  const now = Date.now();
  const elapsed = now - lastCallAtMs;
  if (elapsed < minSpacingMs) {
    await new Promise((r) => setTimeout(r, minSpacingMs - elapsed));
  }
  lastCallAtMs = Date.now();
}

const DEFAULT_USER_AGENT =
  'Havesay-DiscoveryBot/1.0 (aggregator-free civic data; contact: no-reply@example.org)';

// ---------------------------------------------------------------------------
// Result canonicalization + denylist filter (URL pointers only)
// ---------------------------------------------------------------------------

/**
 * Canonicalize a raw result URL and DROP it if malformed or denylisted. Returns
 * the canonical string or null. Adds a scheme when one is missing so bare hosts
 * still resolve. This is the single chokepoint that guarantees a denylisted host
 * never leaves the search layer.
 */
function vetResultUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let candidate = raw.trim();
  if (!candidate) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  // Skip obvious non-http(s) schemes (mailto:, tel:, javascript:, etc.).
  if (!/^https?:\/\//i.test(candidate)) return null;
  let canonical: string;
  let registrable: string | null;
  let host: string;
  try {
    const c = canonicalizeUrl(candidate);
    canonical = c.canonical;
    registrable = c.registrableDomain;
    host = new URL(canonical).hostname;
  } catch {
    return null;
  }
  if (isDenied(registrable, host)) return null;
  return canonical;
}

/**
 * Dedup by canonical URL (first occurrence wins -- preserves backend rank
 * order), then truncate to `limit`.
 */
function dedupAndLimit(results: SearchResult[], limit: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Backend 1: self-hosted SearXNG JSON API (primary)
// ---------------------------------------------------------------------------

interface SearxngRawResult {
  url?: string;
  title?: string;
  content?: string;
  score?: number;
}

interface SearxngRawResponse {
  results?: SearxngRawResult[];
}

async function searchSearxng(
  query: string,
  searxUrl: string,
  opts: Required<Pick<SearchOpts, 'limit' | 'timeoutMs' | 'userAgent'>>,
  fetchImpl: typeof fetch,
): Promise<SearchResponse> {
  const base = searxUrl.replace(/\/$/, '');
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let payload: SearxngRawResponse;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': opts.userAgent },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        backend: 'searxng',
        degraded: false,
        results: [],
        note: `searxng backend returned http ${res.status} (no results)`,
      };
    }
    payload = (await res.json()) as SearxngRawResponse;
  } catch (e) {
    return {
      backend: 'searxng',
      degraded: false,
      results: [],
      note: `searxng backend error: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  const raw = Array.isArray(payload.results) ? payload.results : [];
  const mapped: SearchResult[] = [];
  for (const r of raw) {
    const canonical = vetResultUrl(r.url);
    if (!canonical) continue; // malformed or denylisted -> dropped
    mapped.push({
      url: canonical,
      title: r.title ?? null,
      snippet: r.content ?? null,
      backendScore: typeof r.score === 'number' ? r.score : null,
      backend: 'searxng',
    });
  }
  const results = dedupAndLimit(mapped, opts.limit);
  return {
    backend: 'searxng',
    degraded: false,
    results,
    note: `searxng: ${raw.length} raw -> ${results.length} kept (denylist + dedup applied)`,
  };
}

// ---------------------------------------------------------------------------
// Backend 2: DuckDuckGo Instant Answer API (DEGRADED keyless fallback)
// ---------------------------------------------------------------------------

interface DdgRelatedTopic {
  FirstURL?: string;
  Text?: string;
  // Nested topic groups carry a Topics[] array instead of a FirstURL.
  Topics?: DdgRelatedTopic[];
}

interface DdgResponse {
  AbstractURL?: string;
  AbstractText?: string;
  Heading?: string;
  Results?: DdgRelatedTopic[];
  RelatedTopics?: DdgRelatedTopic[];
}

/** Flatten DuckDuckGo's nested RelatedTopics into a flat (url, text) list. */
function flattenDdgTopics(topics: DdgRelatedTopic[] | undefined): Array<{ url: string; text: string }> {
  const out: Array<{ url: string; text: string }> = [];
  if (!Array.isArray(topics)) return out;
  for (const t of topics) {
    if (t.FirstURL) out.push({ url: t.FirstURL, text: t.Text ?? '' });
    if (Array.isArray(t.Topics)) out.push(...flattenDdgTopics(t.Topics));
  }
  return out;
}

async function searchDuckDuckGo(
  query: string,
  opts: Required<Pick<SearchOpts, 'limit' | 'timeoutMs' | 'userAgent'>>,
  fetchImpl: typeof fetch,
): Promise<SearchResponse> {
  // no_html=1 + no_redirect=1 keep the payload small and stable.
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
    query,
  )}&format=json&no_html=1&no_redirect=1&skip_disambig=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let payload: DdgResponse;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': opts.userAgent },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        backend: 'duckduckgo',
        degraded: true,
        results: [],
        note: `DEGRADED duckduckgo fallback returned http ${res.status} (no results). Set SEARX_URL for real search.`,
      };
    }
    payload = (await res.json()) as DdgResponse;
  } catch (e) {
    return {
      backend: 'duckduckgo',
      degraded: true,
      results: [],
      note: `DEGRADED duckduckgo fallback error: ${e instanceof Error ? e.message : String(e)}. Set SEARX_URL for real search.`,
    };
  } finally {
    clearTimeout(timer);
  }

  // Instant Answer returns: an Abstract (the canonical topic page), Results
  // (rare), and RelatedTopics (the bulk). All are topic links, NOT a web index.
  const collected: Array<{ url: string; text: string }> = [];
  if (payload.AbstractURL) {
    collected.push({ url: payload.AbstractURL, text: payload.AbstractText ?? payload.Heading ?? '' });
  }
  collected.push(...flattenDdgTopics(payload.Results));
  collected.push(...flattenDdgTopics(payload.RelatedTopics));

  const mapped: SearchResult[] = [];
  for (const c of collected) {
    const canonical = vetResultUrl(c.url);
    if (!canonical) continue;
    mapped.push({
      url: canonical,
      title: c.text || null,
      snippet: null,
      backendScore: null,
      backend: 'duckduckgo',
    });
  }
  const results = dedupAndLimit(mapped, opts.limit);
  return {
    backend: 'duckduckgo',
    degraded: true,
    results,
    note:
      `DEGRADED duckduckgo Instant Answer fallback: ${collected.length} topic link(s) -> ` +
      `${results.length} kept. NOT a web index; set SEARX_URL for real search.`,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * search(query, opts) -> ranked, deduped, denylist-filtered URL POINTERS.
 *
 * Backend: self-hosted SearXNG when SEARX_URL is set (opts.searxUrl overrides);
 * otherwise the DEGRADED keyless DuckDuckGo Instant Answer fallback (response
 * .degraded === true). NEVER persists SERP payloads -- returns URL pointers
 * only. Polite: a process-wide minimum spacing throttles the backend call.
 *
 * @returns SearchResponse with backend, degraded flag, results, and a note.
 */
export async function search(query: string, opts: SearchOpts = {}): Promise<SearchResponse> {
  const limit = opts.limit ?? 20;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const minSpacingMs = opts.minSpacingMs ?? 1500;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const required = { limit, timeoutMs, userAgent };

  const q = (query ?? '').trim();
  if (!q) {
    return {
      backend: opts.searxUrl ? 'searxng' : 'duckduckgo',
      degraded: opts.searxUrl == null,
      results: [],
      note: 'empty query',
    };
  }

  // Resolve the backend choice: explicit override > env > degraded fallback.
  let searxUrl: string | null | undefined = opts.searxUrl;
  if (searxUrl === undefined) {
    searxUrl = process.env.SEARX_URL ?? null;
  }

  // Polite, process-wide spacing before any backend call.
  await waitForPoliteSlot(minSpacingMs);

  if (searxUrl) {
    return searchSearxng(q, searxUrl, required, fetchImpl);
  }
  return searchDuckDuckGo(q, required, fetchImpl);
}

/**
 * Build the campaign-naming search queries for a person. These are the
 * operators from the recommended discovery chain (section 1 of the research
 * doc): "elect NAME", "NAME for OFFICE", plus locality scoping. Returned as an
 * ordered list (most specific first) so the caller can try them in turn and
 * stop early once enough confirmed sources are found.
 *
 * No site: operators that target denylisted aggregators are ever emitted.
 */
export function buildCampaignQueries(args: {
  name: string;
  office?: string | null;
  locality?: string | null;
  state?: string | null;
}): string[] {
  const name = (args.name ?? '').trim();
  if (!name) return [];
  const office = (args.office ?? '').trim();
  const locality = (args.locality ?? '').trim();
  const state = (args.state ?? '').trim();
  const place = [locality, state].filter(Boolean).join(' ');

  const queries: string[] = [];
  // Most specific: name + office + locality.
  if (office && place) queries.push(`"${name}" for ${office} ${place}`);
  if (office) queries.push(`"${name}" for ${office}`);
  // Campaign-convention operators.
  queries.push(`elect "${name}" ${place}`.trim());
  queries.push(`"${name}" campaign ${place}`.trim());
  // Bare name + locality as a last, broadest pass.
  if (place) queries.push(`"${name}" ${place}`);
  queries.push(`"${name}"`);

  // Dedup while preserving order.
  const seen = new Set<string>();
  return queries.filter((qq) => {
    const k = qq.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
