/**
 * Polite fetch wrapper for outbound adapter requests.
 *
 * Every outbound adapter request identifies itself honestly with a single
 * bot User-Agent (`POLITE_USER_AGENT`) and is spaced per host (1 req/sec
 * default, or whatever `data_sources.meta.min_request_interval_ms` says).
 * Sources that refuse this client are treated as unavailable by the calling
 * adapter; this module does not try to look like a browser.
 *
 * Complementary to `rate-limit.ts`'s token buckets:
 *   - Token buckets (rate-limit.ts) throttle our own API-quota consumption
 *     (FEC, Congress.gov, OpenStates key limits). Adapter code opts in with
 *     `await bucket.acquire()` before each call.
 *   - This module throttles per-host spacing across the whole process so a
 *     single adapter doesn't hammer one SoS domain even when it has plenty
 *     of token-bucket budget.
 *
 * Both layers run — they answer different questions.
 *
 * Design constraints
 * ------------------
 * - Zero new npm deps. Node 20 `fetch` + `setTimeout` only.
 * - The User-Agent is a fixed, identifying string (`POLITE_USER_AGENT`).
 * - The per-host interval is cached at module scope (survives within the
 *   same process). Cache miss → supabase lookup → 1h TTL. If supabase isn't
 *   reachable we fall back to the 1000ms default without throwing; an
 *   adapter that can't reach supabase has bigger problems than spacing.
 * - `options.headers` wins over defaults so an adapter that needs a specific
 *   `Accept: application/xml` header can still set it.
 * - This module does NOT retry on 5xx. That's the adapter's responsibility
 *   (and often better handled at the runAdapter level with partial-run
 *   classification).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { lookup as dnsLookup } from 'node:dns/promises';
import { POLITE_USER_AGENT } from '../bot-user-agent';

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------
//
// Council security finding (2026-05-02): outbound fetches from politeFetch
// (and any other adapter using fetch) can be coerced into hitting internal
// network targets if a hostname comes from un-trusted input — campaign
// website URLs from candidate data, redirect chains, etc.
//
// We block:
//   - schemes other than http/https
//   - localhost / loopback (127.0.0.0/8, ::1)
//   - link-local (169.254.0.0/16) — covers AWS/GCP/Azure metadata at .169.254
//   - RFC1918 private (10/8, 172.16/12, 192.168/16)
//   - carrier-grade NAT (100.64/10)
//
// We do BOTH a literal-IP check on the hostname AND a DNS lookup so a
// hostname like `attacker.example.com` that resolves to 169.254.169.254
// is also caught (DNS rebinding mitigation). The DNS lookup uses
// node:dns/promises#lookup which respects the OS resolver.

/** Thrown when SSRF guard refuses to fetch a URL. */
export class SSRFBlockedError extends Error {
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`SSRF guard blocked fetch to ${url}: ${reason}`);
    this.name = 'SSRFBlockedError';
    this.url = url;
    this.reason = reason;
  }
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Parse "10.0.0.1" → [10, 0, 0, 1] or null if not an IPv4 literal. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
  ] as [number, number, number, number];
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts;
}

/**
 * Returns a reason string if the IPv4 address is in a blocked range,
 * else null. Ranges: loopback (127/8), link-local (169.254/16),
 * RFC1918 (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), unspecified
 * (0.0.0.0/8).
 */
function blockedIPv4Reason(ip: [number, number, number, number]): string | null {
  const [a, b] = ip;
  if (a === 127) return 'loopback (127/8)';
  if (a === 0) return 'unspecified (0.0.0.0/8)';
  if (a === 169 && b === 254) return 'link-local (169.254/16) — includes cloud metadata';
  if (a === 10) return 'RFC1918 private (10/8)';
  if (a === 172 && b >= 16 && b <= 31) return 'RFC1918 private (172.16/12)';
  if (a === 192 && b === 168) return 'RFC1918 private (192.168/16)';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT (100.64/10)';
  return null;
}

/**
 * Returns a reason string if the IPv6 address is in a blocked range,
 * else null. We cover loopback (::1), unspecified (::), link-local
 * (fe80::/10), unique local (fc00::/7), and IPv4-mapped (::ffff:0:0/96)
 * forms of the blocked IPv4 ranges.
 */
function blockedIPv6Reason(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return 'IPv6 loopback (::1)';
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return 'IPv6 unspecified (::)';
  // fe80::/10 — link-local
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return 'IPv6 link-local (fe80::/10)';
  // fc00::/7 — unique local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return 'IPv6 unique local (fc00::/7)';
  // ::ffff:a.b.c.d  — IPv4-mapped IPv6. Extract the trailing IPv4 and
  // re-check via blockedIPv4Reason.
  const v4mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4mapped) {
    const v4 = parseIPv4(v4mapped[1]!);
    if (v4) {
      const r = blockedIPv4Reason(v4);
      if (r) return `IPv4-mapped IPv6 → ${r}`;
    }
  }
  return null;
}

/** Strip square brackets from IPv6 hostnames in URLs (`[::1]` → `::1`). */
function stripIPv6Brackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

/**
 * SSRF guard: validate the URL's scheme + hostname before allowing a fetch.
 * Throws {@link SSRFBlockedError} when blocked. Resolves DNS for hostname
 * literals so DNS-rebinding to internal IPs is also caught.
 *
 * Exported for use by callers that don't go through politeFetch (e.g.
 * the inngest scrape function's robots.txt + page fetches).
 */
export async function assertSafeUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SSRFBlockedError(url, 'malformed URL');
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new SSRFBlockedError(url, `scheme ${parsed.protocol} not allowed`);
  }

  const rawHost = stripIPv6Brackets(parsed.hostname);
  if (!rawHost) {
    throw new SSRFBlockedError(url, 'empty hostname');
  }

  // Literal-IP fast path. If the hostname IS an IP, check it directly
  // and skip DNS (DNS would just echo it back).
  const v4 = parseIPv4(rawHost);
  if (v4) {
    const r = blockedIPv4Reason(v4);
    if (r) throw new SSRFBlockedError(url, r);
    return;
  }
  if (rawHost.includes(':')) {
    // Looks like an IPv6 literal. We don't fully parse arbitrary IPv6
    // here — we cover the common blocked forms via regex in
    // blockedIPv6Reason and reject anything else as "literal IPv6 not
    // allowed" to be safe.
    const r = blockedIPv6Reason(rawHost);
    if (r) throw new SSRFBlockedError(url, r);
    throw new SSRFBlockedError(url, 'literal IPv6 not allowed');
  }

  // Common alias hostnames that don't always resolve via DNS (resolver
  // config dependent). Block by name first.
  const lowered = rawHost.toLowerCase();
  if (
    lowered === 'localhost'
    || lowered.endsWith('.localhost')
    || lowered === 'broadcasthost'
  ) {
    throw new SSRFBlockedError(url, 'localhost hostname');
  }

  // DNS rebinding mitigation: resolve the hostname and check every
  // returned address. Any blocked address fails the whole URL — we
  // don't want a round-robin record where one A is public and one is
  // 127.0.0.1.
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsLookup(rawHost, { all: true });
  } catch (err) {
    // DNS failure → can't verify safety. We let it through here so the
    // subsequent fetch surfaces the real "ENOTFOUND" / "EAI_AGAIN" to
    // the caller; the alternative (block on DNS failure) would mask
    // legitimate transient failures behind an SSRFBlockedError. The
    // attack surface is narrow because a hostname that doesn't resolve
    // can't actually reach an internal target either.
    void err;
    return;
  }

  for (const { address, family } of addresses) {
    if (family === 4) {
      const v = parseIPv4(address);
      if (v) {
        const r = blockedIPv4Reason(v);
        if (r) throw new SSRFBlockedError(url, `DNS resolves to ${address} — ${r}`);
      }
    } else if (family === 6) {
      const r = blockedIPv6Reason(address);
      if (r) throw new SSRFBlockedError(url, `DNS resolves to ${address} — ${r}`);
    }
  }
}

// ---------------------------------------------------------------------------
// User-Agent
// ---------------------------------------------------------------------------
//
// One honest, identifying User-Agent with a contact URL. Operators of a
// source can recognize, rate-limit or block it; adapters treat a refusal as
// "source unavailable".

export { POLITE_USER_AGENT };

// ---------------------------------------------------------------------------
// Per-host interval cache
// ---------------------------------------------------------------------------

/**
 * Council #40 (2026-04-25): conservative fallback when the host isn't in
 * `host_rate_limits` and `data_sources.meta.min_request_interval_ms` doesn't
 * set a value. Bumped from 1000ms → 2000ms to match the seed default in
 * migration 20260425000007.
 */
const DEFAULT_INTERVAL_MS = 2000;
/** Council #40: matches the seed default in migration 20260425000007. */
const DEFAULT_BURST = 2;
/**
 * Council #40: in-process cache TTL for host_rate_limits lookups.
 * The migration's seed values change rarely; re-checking once/min keeps the
 * runner cheap while staying responsive to manual operator edits.
 */
const HOST_LIMITS_CACHE_TTL_MS = 60 * 1000; // 60s
/** Cache TTL for the legacy data_sources lookup path (kept for compatibility). */
const INTERVAL_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

type IntervalCacheEntry = {
  intervalMs: number;
  fetchedAt: number;
};

/**
 * Council #40 cache shape: hostname → calibrated config or null when the host
 * is absent from `host_rate_limits`. Null entries are cached to avoid
 * re-querying every request for unknown hosts.
 */
type HostLimitEntry = {
  intervalMs: number | null;
  burst: number | null;
  fetchedAt: number;
};

const intervalCache = new Map<string, IntervalCacheEntry>();
const hostLimitCache = new Map<string, HostLimitEntry>();
const lastRequestAt = new Map<string, number>();

/** Test-only: clear the module-scope state. */
export function __clearPoliteFetchState(): void {
  intervalCache.clear();
  hostLimitCache.clear();
  lastRequestAt.clear();
}

// Supabase lookup client — lazily constructed so test runs that don't set
// env vars don't blow up. We cache a failed init result and keep going with
// the default interval.
let cachedClient: SupabaseClient | null | undefined;

function getSupabaseClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    cachedClient = null;
    return null;
  }
  try {
    cachedClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    cachedClient = null;
  }
  return cachedClient;
}

/** Test-only: swap in a pre-built supabase client (or null to disable lookup). */
export function __setSupabaseClient(client: SupabaseClient | null): void {
  cachedClient = client;
}

/**
 * Council #40: read calibrated pacing from `host_rate_limits` (cached 60s).
 * Returns null when the host is absent from the table, in which case the
 * caller falls back through `data_sources.meta` and finally
 * `DEFAULT_INTERVAL_MS`.
 */
async function lookupHostRateLimit(
  host: string,
): Promise<{ intervalMs: number; burst: number } | null> {
  const now = Date.now();
  const cached = hostLimitCache.get(host);
  if (cached && now - cached.fetchedAt < HOST_LIMITS_CACHE_TTL_MS) {
    if (cached.intervalMs === null) return null;
    return { intervalMs: cached.intervalMs, burst: cached.burst ?? DEFAULT_BURST };
  }

  const client = getSupabaseClient();
  if (!client) {
    // No DB → cache a null miss so we don't re-attempt every request.
    hostLimitCache.set(host, { intervalMs: null, burst: null, fetchedAt: now });
    return null;
  }

  try {
    const { data, error } = await client
      .from('host_rate_limits')
      .select('min_interval_ms, burst')
      .eq('hostname', host)
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      hostLimitCache.set(host, { intervalMs: null, burst: null, fetchedAt: now });
      return null;
    }
    const row = data as { min_interval_ms?: number; burst?: number };
    if (
      typeof row.min_interval_ms !== 'number'
      || !Number.isFinite(row.min_interval_ms)
      || row.min_interval_ms <= 0
    ) {
      hostLimitCache.set(host, { intervalMs: null, burst: null, fetchedAt: now });
      return null;
    }
    const burst =
      typeof row.burst === 'number' && Number.isFinite(row.burst) && row.burst >= 1
        ? row.burst
        : DEFAULT_BURST;
    hostLimitCache.set(host, {
      intervalMs: row.min_interval_ms,
      burst,
      fetchedAt: now,
    });
    return { intervalMs: row.min_interval_ms, burst };
  } catch {
    hostLimitCache.set(host, { intervalMs: null, burst: null, fetchedAt: now });
    return null;
  }
}

async function lookupHostIntervalMs(host: string): Promise<number> {
  // Council #40: prefer host_rate_limits over the legacy data_sources path.
  // host_rate_limits is the canonical seed; data_sources.meta override is
  // kept for backwards compat (some adapters set a custom interval there).
  const calibrated = await lookupHostRateLimit(host);
  if (calibrated) return calibrated.intervalMs;

  const now = Date.now();
  const cached = intervalCache.get(host);
  if (cached && now - cached.fetchedAt < INTERVAL_CACHE_TTL_MS) {
    return cached.intervalMs;
  }

  const client = getSupabaseClient();
  if (!client) {
    // No DB available — cache the default so we don't re-try every request.
    intervalCache.set(host, { intervalMs: DEFAULT_INTERVAL_MS, fetchedAt: now });
    return DEFAULT_INTERVAL_MS;
  }

  try {
    // data_sources stores `meta` as jsonb; we filter client-side so any
    // shape variation across migrations is tolerated. Limit 100 rows per
    // host keeps the payload bounded if the same SoS URL appears in many
    // rows (different election cycles).
    const { data, error } = await client
      .from('data_sources')
      .select('url, meta')
      .ilike('url', `%${host}%`)
      .limit(100);

    if (error || !data) {
      intervalCache.set(host, { intervalMs: DEFAULT_INTERVAL_MS, fetchedAt: now });
      return DEFAULT_INTERVAL_MS;
    }

    let best = DEFAULT_INTERVAL_MS;
    for (const row of data as Array<{ url?: string | null; meta?: unknown }>) {
      if (!row.url) continue;
      try {
        const u = new URL(row.url);
        if (u.host !== host) continue;
      } catch {
        continue;
      }
      const meta = row.meta as Record<string, unknown> | null | undefined;
      const raw = meta?.['min_request_interval_ms'];
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        // Take the most conservative (largest) interval across rows for this
        // host — one upstream saying "1 req per 5s" trumps one that says
        // "1 req per second".
        if (raw > best) best = raw;
      }
    }

    intervalCache.set(host, { intervalMs: best, fetchedAt: now });
    return best;
  } catch {
    intervalCache.set(host, { intervalMs: DEFAULT_INTERVAL_MS, fetchedAt: now });
    return DEFAULT_INTERVAL_MS;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

async function enforceHostInterval(host: string, explicit?: number): Promise<void> {
  const intervalMs =
    typeof explicit === 'number' && explicit >= 0
      ? explicit
      : await lookupHostIntervalMs(host);
  if (intervalMs <= 0) {
    lastRequestAt.set(host, Date.now());
    return;
  }
  const last = lastRequestAt.get(host);
  const now = Date.now();
  if (last !== undefined) {
    const waitMs = last + intervalMs - now;
    if (waitMs > 0) await sleep(waitMs);
  }
  lastRequestAt.set(host, Date.now());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Extra knobs on top of `RequestInit` for politeFetch. */
export type PoliteFetchOptions = RequestInit & {
  /**
   * Explicit per-host minimum interval in ms. Overrides the
   * data_sources.meta lookup. Pass 0 to bypass throttling entirely
   * (useful in tests).
   */
  minIntervalMs?: number;
};

/**
 * Fetch wrapper that identifies itself honestly and spaces requests per host.
 *
 * Every call:
 *   1. Sends {@link POLITE_USER_AGENT} plus plain Accept / Accept-Language.
 *   2. Honors caller's `options.headers` as an override.
 *   3. Awaits any remaining host-interval time before firing.
 *
 * Returns the native Response unchanged. Callers handle status codes and
 * retries themselves.
 *
 * @example
 *   const res = await politeFetch('https://liveresults.ohiosos.gov/');
 *   if (!res.ok) throw new Error(`HTTP ${res.status}`);
 *   const body = await res.text();
 */
export async function politeFetch(
  url: string,
  options: PoliteFetchOptions = {},
): Promise<Response> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    // Malformed URL — let fetch() surface the real error.
    return fetch(url, options);
  }

  // SSRF guard runs BEFORE host-interval throttling so a blocked URL
  // doesn't burn a slot against the per-host budget.
  await assertSafeUrl(url);

  await enforceHostInterval(host, options.minIntervalMs);

  const defaultHeaders: Record<string, string> = {
    'User-Agent': POLITE_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const mergedHeaders = mergeHeaders(defaultHeaders, options.headers);

  // Strip our extras before forwarding to native fetch so it doesn't see
  // unknown RequestInit keys.
  const {
    minIntervalMs: _minIntervalMs,
    headers: _headers,
    ...rest
  } = options;
  void _minIntervalMs;
  void _headers;

  // A 403 / 429 is returned to the caller as-is: the source has declined
  // this client, and the adapter records the run as unproductive.
  return fetch(url, { ...rest, headers: mergedHeaders });
}

/**
 * Merge caller-provided headers (any of HeadersInit's shapes) on top of our
 * default headers. Caller keys win, case-insensitive.
 */
function mergeHeaders(
  defaults: Record<string, string>,
  overrides: HeadersInit | undefined,
): Record<string, string> {
  if (!overrides) return { ...defaults };

  // Normalize the caller's headers into a flat record keyed by the header
  // name the caller actually used (we only need the casing to be consistent
  // internally — fetch() normalizes anyway).
  const callerMap = new Map<string, { key: string; value: string }>();

  const record = (key: string, value: string): void => {
    callerMap.set(key.toLowerCase(), { key, value });
  };

  if (Array.isArray(overrides)) {
    for (const [k, v] of overrides) record(k, v);
  } else if (overrides instanceof Headers) {
    overrides.forEach((v, k) => record(k, v));
  } else {
    for (const [k, v] of Object.entries(overrides)) {
      if (typeof v === 'string') record(k, v);
    }
  }

  // Start from defaults, then overwrite any keys the caller set.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(defaults)) {
    const override = callerMap.get(k.toLowerCase());
    if (override) {
      out[override.key] = override.value;
      callerMap.delete(k.toLowerCase());
    } else {
      out[k] = v;
    }
  }
  // Any remaining caller headers that didn't overlap a default.
  for (const { key, value } of callerMap.values()) {
    out[key] = value;
  }
  return out;
}
