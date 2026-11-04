/**
 * Client for Utah's 20A-7-801 Electronic Voter Information Website
 * (votesearch.utah.gov).
 *
 * Reverse-engineered from the site's main.bundle.js on 2026-04-17. See
 * 08-research/utah-primary-sources-2026-04-17.md for the discovery path
 * and scripts/probe-votesearch-session-v2.ts for the empirical probe.
 *
 * Flow:
 *   1. `new VotesearchClient()` -> warms up cookies (XSRF-TOKEN + F5 session)
 *   2. `submitAddress({ street, city, zip })` -> returns `{ precinctId, countyId, electionId }`
 *      (electionId is null outside active election windows)
 *   3. `getSampleBallot(precinctId, electionId)` -> race list with candidate IDs
 *   4. `resolveProfilePdfUrl(candidateId)` -> the /cb/<id>.pdf URL, then
 *      `fetchProfilePdf(url)` -> raw PDF bytes (clean text, no OCR needed).
 *      NOTE: the old `getCandidateProfile()` structured-JSON return is stale in
 *      the active election window (the live API returns the bare PDF URL string);
 *      see that method's docstring. Parse the PDF text, do not rely on its shape.
 *
 * Auth requirements:
 *   - Plain JSON request headers with the honest Havesay UA (no browser
 *     impersonation; if the site refuses this client, lookups fail cleanly)
 *   - XSRF-TOKEN cookie replayed as X-XSRF-TOKEN header
 *   - F5 session cookies preserved across the flow
 *
 * Rate limits / ToS: we throttle to ~1 req/sec and identify clearly via
 * Referer + Origin. If the LG's office asks us to slow down or authenticate,
 * we pause until we've talked to them.
 */

import { POLITE_USER_AGENT } from '@/lib/bot-user-agent';

const UA = POLITE_USER_AGENT;

const BASE = 'https://votesearch.utah.gov/voter-search';
// PDF profiles live at the site root, NOT under /voter-search (verified 2026-06-12 harvest smoke).
const PDF_BASE = 'https://votesearch.utah.gov/cb';

// Per-request timeout. A missing timeout on a hung fetch jammed the bb-host-exec
// bridge once (2026-06-11), so EVERY fetch in this client now carries an explicit
// AbortSignal.timeout. Override per call where a slow PDF is expected.
const DEFAULT_TIMEOUT_MS = 10_000;

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: `${BASE}/search/search-by-address/candidates-and-issues`,
  Origin: 'https://votesearch.utah.gov',
};

export interface AddressInput {
  street: string; // full street line: "210 East 400 South"
  city: string;
  zip: string;
}

/**
 * AddressResponse - note `residence` is always null for our consumers.
 *
 * The upstream `/my-address` endpoint can return a `residence` object that
 * contains voter PII (physicalAddress, mailingAddress, voterId, etc.) for
 * whoever is registered at the submitted address. Our seed addresses are
 * residential, but the residence blob is voter PII either way.
 *
 * Our handling (council-review 2026-04-17 legal R2):
 *   - Type is `null`, making it a compile-time error to read it
 *   - The client actively nulls out `residence` before returning - you can't
 *     accidentally persist it by logging the whole response
 *   - A warning is logged if residence was present so we notice if Utah
 *     rolls out a new field.
 */
export interface AddressResponse {
  precinctId: number | null;
  countyId: number | null;
  countyName: string | null;
  electionId: number | null;
  electionPhase: string | null; // "Primary" | "General" | "Caucus" | "Municipal"
  residence: null; // PII - stripped at client boundary. Always null.
  errorMessage: string | null;
  errorAddress: string | null;
  errorCity: string | null;
  errorZip: string | null;
}

export interface SampleBallotResponse {
  errorMessage: string | null;
  precinctId: number | null;
  electionId: number | null;
  raceList: RaceFromBallot[] | null;
}

export interface RaceFromBallot {
  raceId?: number;
  raceName?: string;
  candidates?: BallotCandidate[];
  [key: string]: unknown; // server may add fields; preserve via raw passthrough
}

export interface BallotCandidate {
  candidateId?: number;
  name?: string;
  party?: string;
  [key: string]: unknown;
}

export interface CandidateProfile {
  errorMessage: string | null;
  name?: string;
  age?: number | string;
  candidateImage?: string;
  cityOfResidence?: string;
  cityResidenceYear?: string;
  contactEmail?: string;
  message?: string; // the ~200-word candidate statement
  occupation?: string;
  websiteUrl?: string;
  [key: string]: unknown;
}

export class VotesearchClient {
  private cookies: Map<string, string> = new Map();
  private warmedUp = false;

  /** Warm up the session: visit the SPA root to pick up XSRF-TOKEN + F5 cookies. */
  async warmup(): Promise<void> {
    const res = await fetch(
      `${BASE}/search/search-by-address/candidates-and-issues`,
      { headers: { ...BROWSER_HEADERS, Accept: 'text/html' }, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) },
    );
    this.recordSetCookies(res.headers.get('set-cookie'));
    await res.text(); // drain
    if (!this.cookies.has('XSRF-TOKEN')) {
      throw new Error(
        'warmup: no XSRF-TOKEN cookie returned - did the site layout change?',
      );
    }
    this.warmedUp = true;
  }

  /**
   * Submit an address. If the election is not yet "active" in the system,
   * `electionId` will be null; the `precinctId` + `countyId` are still useful
   * for downstream lookups and as a district fingerprint.
   */
  async submitAddress(input: AddressInput): Promise<AddressResponse> {
    if (!this.warmedUp) await this.warmup();
    const res = await fetch(`${BASE}/public-api/my-address`, {
      method: 'POST',
      headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    this.recordSetCookies(res.headers.get('set-cookie'));
    const body = await res.text();
    if (!res.ok) throw new Error(`my-address HTTP ${res.status}: ${body.slice(0, 200)}`);

    // Strip `residence` at the client boundary - it can contain voter PII.
    // Council-review R2: type-enforced via `residence: null` on the
    // interface above, and actively nulled here as belt+suspenders.
    const parsed = JSON.parse(body) as AddressResponse & {
      residence?: unknown;
    };
    if (parsed.residence != null) {
      // One-liner warning so we notice if a seed address pulls PII. Don't
      // log the body - that's the whole point.
      console.warn(
        `[votesearch] residence present for ${input.street}; dropping PII blob`,
      );
    }
    return { ...parsed, residence: null };
  }

  /**
   * Fetch the sample ballot for a given (precinctId, electionId). Throws only
   * for HTTP errors - logical errors like "Access is denied" surface in the
   * response body.
   */
  async getSampleBallot(
    precinctId: number,
    electionId: number,
  ): Promise<SampleBallotResponse> {
    if (!this.warmedUp) await this.warmup();
    const url = `${BASE}/api/sampleBallot.json/${precinctId}/${electionId}`;
    const res = await fetch(url, { headers: this.buildHeaders(), signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
    this.recordSetCookies(res.headers.get('set-cookie'));
    const body = await res.text();
    if (!res.ok) throw new Error(`sampleBallot HTTP ${res.status}: ${body.slice(0, 200)}`);
    return JSON.parse(body) as SampleBallotResponse;
  }

  /**
   * STALE / WINDOW-DEPENDENT (verified 2026-06-12): during the active 2026
   * primary window this endpoint does NOT return a structured CandidateProfile
   * object. It returns the bare PDF URL as a JSON string, e.g.
   *   "https://votesearch.utah.gov/cb/638855506.pdf"
   * The April-era reverse-engineering (which produced the CandidateProfile shape
   * with name/occupation/message/websiteUrl) hit a different API mode that is no
   * longer served. The real contact + bio data lives ONLY in that PDF.
   *
   * For the harvest path use `resolveProfilePdfUrl()` + `fetchProfilePdf()`
   * instead. This method is preserved for backward compatibility but its
   * structured return is no longer populated by the live API.
   */
  async getCandidateProfile(candidateId: number | string): Promise<CandidateProfile> {
    if (!this.warmedUp) await this.warmup();
    const url = `${BASE}/api/getCandidateProfilePublic.json/${candidateId}`;
    const res = await fetch(url, { headers: this.buildHeaders(), signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
    this.recordSetCookies(res.headers.get('set-cookie'));
    const body = await res.text();
    if (!res.ok) throw new Error(`getCandidateProfile HTTP ${res.status}: ${body.slice(0, 200)}`);
    if (!body.trim()) return { errorMessage: 'No profile uploaded' };
    try {
      const parsed = JSON.parse(body);
      // Live API now returns a bare PDF-URL string; surface it without pretending
      // it is a structured profile.
      if (typeof parsed === 'string') return { errorMessage: null, message: undefined, websiteUrl: undefined, _pdfUrl: parsed } as CandidateProfile;
      return parsed as CandidateProfile;
    } catch {
      return { errorMessage: `non-JSON response: ${body.slice(0, 200)}` };
    }
  }

  /**
   * Resolve a candidate's profile-PDF URL. Tries the public-api endpoint first
   * (it returns the canonical URL string), falling back to the deterministic
   * `${PDF_BASE}/<id>.pdf` shape which is what that endpoint returns anyway.
   */
  async resolveProfilePdfUrl(candidateId: number | string): Promise<string> {
    try {
      const prof = await this.getCandidateProfile(candidateId);
      const u = (prof as Record<string, unknown>)._pdfUrl;
      if (typeof u === 'string' && u.startsWith('http')) return u;
    } catch {
      /* fall through to deterministic shape */
    }
    return `${PDF_BASE}/${candidateId}.pdf`;
  }

  /**
   * Fetch a candidate profile PDF as raw bytes. The PDF host (votesearch.utah.gov/cb)
   * is public and needs no session/XSRF, but we still send the polite UA + Referer.
   * Carries an explicit timeout (default 15s; PDFs are larger than JSON).
   * Returns null on a non-200 or non-PDF response.
   */
  async fetchProfilePdf(
    url: string,
    timeoutMs = 15_000,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/pdf,*/*',
        Referer: `${BASE}/search/search-by-address/candidates-and-issues`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    const buf = new Uint8Array(await res.arrayBuffer());
    // Guard: an HTML 404 shell can come back 200 in some misconfigs; require PDF magic.
    if (buf.length < 5 || !(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) {
      return null; // not "%PDF"
    }
    return { bytes: buf, contentType };
  }

  // ---- private helpers --------------------------------------------------

  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...BROWSER_HEADERS };
    const xsrf = this.cookies.get('XSRF-TOKEN');
    if (xsrf) h['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
    const cookieStr = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookieStr) h['Cookie'] = cookieStr;
    return { ...h, ...extra };
  }

  private recordSetCookies(header: string | null): void {
    if (!header) return;
    // Split cookies on `, cookieName=` boundaries (not inside expires= dates)
    const parts = header.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const val = part.slice(eq + 1).split(';')[0];
      this.cookies.set(name, val);
    }
  }
}
