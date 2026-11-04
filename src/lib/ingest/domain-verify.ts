/**
 * domain-verify.ts -- free, open domain-ownership confirmation primitives for
 * AGGREGATOR-FREE active discovery.
 *
 * These are the "CONFIRM the domain" rung of the discovery chain (section 1 of
 * 12-positioning-engine/09-candidate-research-techniques-and-tools.md): given a
 * candidate domain that ranked as plausibly owned, corroborate it with three
 * free open signals that no aggregator gates:
 *
 *   1. rdapLookup(domain)      -- RDAP (Registration Data Access Protocol, the
 *      JavaScript Object Notation (JSON) successor to WHOIS as of 2025) via the
 *      rdap.org bootstrap: registration date (a domain registered near the
 *      election cycle is a positive owned-domain signal), registrar, handle.
 *   2. crtShSubdomains(domain) -- crt.sh certificate-transparency log query:
 *      live-certificate presence + subdomain enumeration (donate., issues.,
 *      blog. subdomains corroborate a real campaign property). Polite, ~60/min.
 *   3. dnsResolve(domain)      -- node:dns/promises: does it resolve at all
 *      (liveness) and to what addresses (infra clustering signal).
 *
 * NONE of these stores third-party content as corpus -- they return small
 * confirmation SIGNALS only. Native fetch + node dns, no new npm deps, no Python.
 *
 * Resilience: every function is total -- it never throws. Each returns a result
 * object whose `ok` flag plus typed fields tell the caller what was confirmed;
 * a network/parse error becomes ok:false with an error note, never an exception
 * that could abort a batch.
 */

import { resolve4, resolve6 } from 'node:dns/promises';

// ---------------------------------------------------------------------------
// shared fetch helper (polite, timeout-bounded, injectable for tests)
// ---------------------------------------------------------------------------

const DEFAULT_USER_AGENT =
  'Havesay-DiscoveryBot/1.0 (aggregator-free civic data; contact: no-reply@example.org)';

export interface DomainVerifyOpts {
  /** Per-call timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Injected fetch for OFFLINE TESTS. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Descriptive User-Agent for polite identification. */
  userAgent?: string;
}

/** Normalize a host to a bare registrable-ish domain (strip scheme/path/port). */
function normalizeDomain(input: string): string | null {
  let d = (input ?? '').trim().toLowerCase();
  if (!d) return null;
  // Strip a scheme if present.
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Strip any path / query / port.
  d = d.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  // Strip a leading "www." for the lookup key (RDAP/crt.sh want the apex).
  d = d.replace(/^www\./, '').replace(/\.$/, '');
  if (!d || !d.includes('.')) return null;
  // Reject anything with whitespace or obviously invalid characters.
  if (/[\s"'<>]/.test(d)) return null;
  return d;
}

// ---------------------------------------------------------------------------
// (1) RDAP -- registration metadata via the rdap.org bootstrap
// ---------------------------------------------------------------------------

export interface RdapResult {
  /** True when the RDAP query succeeded and the domain is registered. */
  ok: boolean;
  domain: string;
  /** ISO date string of the registration event when present. */
  registrationDate?: string | null;
  /** ISO date string of the last-changed/updated event when present. */
  lastChangedDate?: string | null;
  /** ISO date string of the expiration event when present. */
  expirationDate?: string | null;
  /** Registrar entity name when present. */
  registrar?: string | null;
  /** RDAP object status array (e.g. ['active'], ['client transfer prohibited']). */
  status?: string[];
  /** HTTP status of the RDAP call (404 typically means unregistered). */
  httpStatus?: number;
  /** Error note when ok is false. */
  error?: string;
}

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}
interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown;
  handle?: string;
}
interface RdapPayload {
  events?: RdapEvent[];
  entities?: RdapEntity[];
  status?: string[];
  ldhName?: string;
}

/** Pull the "fn" (formatted name) out of an RDAP vCard jCard array. */
function vcardName(vcardArray: unknown): string | null {
  // jCard shape: ["vcard", [ ["version",{},"text","4.0"], ["fn",{},"text","Name"], ... ]]
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return null;
  const props = vcardArray[1];
  if (!Array.isArray(props)) return null;
  for (const p of props) {
    if (Array.isArray(p) && p[0] === 'fn' && typeof p[3] === 'string') return p[3];
  }
  return null;
}

/**
 * rdapLookup(domain): query https://rdap.org/domain/<domain> (the IANA-blessed
 * bootstrap that 302-redirects to the authoritative registry RDAP server) and
 * extract registration metadata. Returns ok:false (not a throw) on any error;
 * an HTTP 404 is reported as ok:false with httpStatus 404 (domain not
 * registered -- itself a useful signal).
 */
export async function rdapLookup(
  domainInput: string,
  opts: DomainVerifyOpts = {},
): Promise<RdapResult> {
  const domain = normalizeDomain(domainInput);
  if (!domain) {
    return { ok: false, domain: domainInput, error: 'invalid domain' };
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': userAgent },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, domain, httpStatus: res.status, error: `rdap http ${res.status}` };
    }
    const payload = (await res.json()) as RdapPayload;
    const events = Array.isArray(payload.events) ? payload.events : [];
    const findEvent = (action: string): string | null =>
      events.find((e) => e.eventAction === action)?.eventDate ?? null;

    let registrar: string | null = null;
    for (const ent of payload.entities ?? []) {
      if (Array.isArray(ent.roles) && ent.roles.includes('registrar')) {
        registrar = vcardName(ent.vcardArray) ?? ent.handle ?? null;
        break;
      }
    }

    return {
      ok: true,
      domain,
      registrationDate: findEvent('registration'),
      lastChangedDate: findEvent('last changed'),
      expirationDate: findEvent('expiration'),
      registrar,
      status: Array.isArray(payload.status) ? payload.status : [],
      httpStatus: res.status,
    };
  } catch (e) {
    return { ok: false, domain, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// (2) crt.sh -- certificate transparency: live cert + subdomain enumeration
// ---------------------------------------------------------------------------

export interface CrtShResult {
  /** True when the crt.sh query succeeded (regardless of how many certs). */
  ok: boolean;
  domain: string;
  /** True when at least one certificate exists -- the domain has had TLS. */
  hasCert: boolean;
  /**
   * Distinct subdomains observed in certificate-transparency logs for the
   * domain (apex + any *.domain). e.g. ['donate.smith4mayor.org',
   * 'smith4mayor.org']. A campaign property cluster corroborates ownership.
   */
  subdomains: string[];
  /** HTTP status of the crt.sh call. */
  httpStatus?: number;
  /** Error note when ok is false. */
  error?: string;
}

interface CrtShRow {
  name_value?: string;
  common_name?: string;
}

/**
 * crtShSubdomains(domain): query crt.sh certificate-transparency logs for
 * %.<domain> as JSON and return the distinct subdomains seen, plus a hasCert
 * flag. crt.sh is rate-sensitive (respect roughly 60 requests/minute); the
 * caller is responsible for spacing batch calls. Returns ok:false on any error.
 *
 * The "%25.<domain>" query (URL-encoded "%.") matches the apex and every
 * subdomain. Wildcard cert entries ("*.domain") are normalized to the apex.
 */
export async function crtShSubdomains(
  domainInput: string,
  opts: DomainVerifyOpts = {},
): Promise<CrtShResult> {
  const domain = normalizeDomain(domainInput);
  if (!domain) {
    return { ok: false, domain: domainInput, hasCert: false, subdomains: [], error: 'invalid domain' };
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  // %25 == "%", so q=%.domain matches apex + all subdomains.
  const url = `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        domain,
        hasCert: false,
        subdomains: [],
        httpStatus: res.status,
        error: `crt.sh http ${res.status}`,
      };
    }
    const rows = (await res.json()) as CrtShRow[];
    const names = new Set<string>();
    for (const row of Array.isArray(rows) ? rows : []) {
      // name_value can be a newline-separated list of SANs.
      const candidates = [
        ...(row.name_value ? row.name_value.split(/\s+/) : []),
        ...(row.common_name ? [row.common_name] : []),
      ];
      for (const c of candidates) {
        let n = c.trim().toLowerCase();
        if (!n) continue;
        n = n.replace(/^\*\./, ''); // wildcard -> apex
        if (n === domain || n.endsWith('.' + domain)) names.add(n);
      }
    }
    const subdomains = Array.from(names).sort();
    return {
      ok: true,
      domain,
      hasCert: subdomains.length > 0,
      subdomains,
      httpStatus: res.status,
    };
  } catch (e) {
    return {
      ok: false,
      domain,
      hasCert: false,
      subdomains: [],
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// (3) DNS resolution -- liveness + addresses
// ---------------------------------------------------------------------------

export interface DnsResult {
  /** True when the domain resolves to at least one A or AAAA address. */
  resolves: boolean;
  domain: string;
  /** IPv4 addresses. */
  a: string[];
  /** IPv6 addresses. */
  aaaa: string[];
  /** Error note when resolution failed (NXDOMAIN, timeout, etc.). */
  error?: string;
}

/**
 * dnsResolve(domain): resolve A + AAAA records via node:dns/promises. Returns
 * resolves:true when at least one address exists. NXDOMAIN / SERVFAIL / no
 * records becomes resolves:false (never a throw). Used as a cheap liveness +
 * infra-clustering signal.
 */
export async function dnsResolve(domainInput: string): Promise<DnsResult> {
  const domain = normalizeDomain(domainInput);
  if (!domain) {
    return { resolves: false, domain: domainInput, a: [], aaaa: [], error: 'invalid domain' };
  }
  const a: string[] = [];
  const aaaa: string[] = [];
  let lastErr: string | undefined;
  try {
    const v4 = await resolve4(domain);
    a.push(...v4);
  } catch (e) {
    lastErr = e instanceof Error ? e.message : String(e);
  }
  try {
    const v6 = await resolve6(domain);
    aaaa.push(...v6);
  } catch (e) {
    // Only surface the v6 error if v4 also failed.
    if (a.length === 0) lastErr = e instanceof Error ? e.message : String(e);
  }
  const resolves = a.length > 0 || aaaa.length > 0;
  return { resolves, domain, a, aaaa, error: resolves ? undefined : lastErr };
}

// ---------------------------------------------------------------------------
// Combined convenience: run all three and summarize the confirmation signals
// ---------------------------------------------------------------------------

export interface DomainConfirmation {
  domain: string;
  /** DNS resolves to at least one address. */
  resolves: boolean;
  /** At least one certificate exists in CT logs (live/historical TLS). */
  hasCert: boolean;
  /** Domain is registered (RDAP returned data). */
  registered: boolean;
  /** Registration date (ISO) when known. */
  registrationDate?: string | null;
  /** Subdomains observed in CT logs (campaign-property cluster). */
  subdomains: string[];
  /** Count of corroborating signals present (resolves + hasCert + registered). */
  signalCount: number;
  /** Raw sub-results for logging / audit. */
  rdap: RdapResult;
  crtsh: CrtShResult;
  dns: DnsResult;
}

/**
 * verifyDomain(domain): run RDAP + crt.sh + DNS and roll the three into a
 * single confirmation summary. The three calls run in PARALLEL (they hit
 * different services, so concurrency is fine and stays within each service's
 * polite per-host budget). Total -- never throws.
 */
export async function verifyDomain(
  domainInput: string,
  opts: DomainVerifyOpts = {},
): Promise<DomainConfirmation> {
  const domain = normalizeDomain(domainInput) ?? domainInput;
  const [rdap, crtsh, dns] = await Promise.all([
    rdapLookup(domainInput, opts),
    crtShSubdomains(domainInput, opts),
    dnsResolve(domainInput),
  ]);
  const resolves = dns.resolves;
  const hasCert = crtsh.hasCert;
  const registered = rdap.ok;
  const signalCount = (resolves ? 1 : 0) + (hasCert ? 1 : 0) + (registered ? 1 : 0);
  return {
    domain,
    resolves,
    hasCert,
    registered,
    registrationDate: rdap.registrationDate ?? null,
    subdomains: crtsh.subdomains,
    signalCount,
    rdap,
    crtsh,
    dns,
  };
}
