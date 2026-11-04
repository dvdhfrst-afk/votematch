/**
 * enrich/types.ts -- shared types + the http-with-backoff helper used by every
 * enrichment wrapper. No external deps: native fetch + a tiny retry loop.
 */

export type EnrichSource =
  | 'fec'
  | 'congress'
  | 'openstates'
  | 'courtlistener'
  | 'edgar'
  | 'irs990';

export type RecordType =
  | 'campaign_finance'
  | 'sponsorship'
  | 'member_bio'
  | 'state_role'
  | 'litigation'
  | 'business'
  | 'nonprofit';

/**
 * A normalized candidate_records row. snake_case to mirror the table columns,
 * so the apply layer can map it straight to the INSERT without renaming.
 * person_id is filled by the wrapper from EnrichContext.
 */
export interface CandidateRecordRow {
  person_id: string;
  record_type: RecordType;
  source: EnrichSource;
  source_url: string | null;
  external_ref: string | null;
  payload: Record<string, unknown>;
  /** 'strong_id:<kind>' for deterministic binds; 'name_match' for staged rows. */
  bind_method: string;
  bind_confidence: number;
  /** TRUE only for strong-id structured facts. */
  verified: boolean;
  /** TRUE for name-only rows awaiting corroboration. */
  requires_strong_id: boolean;
  note: string | null;
  fetched_at: string; // ISO 8601
}

/** Context the dispatcher hands each wrapper. */
export interface EnrichContext {
  person_id: string;
  canonical_name: string | null;
  state_fips: string | null;
}

/** Strong ids + identity loaded from person_xref + people. */
export interface PersonStrongIds {
  person_id: string;
  canonical_name: string | null;
  state_fips: string | null;
  fec_candidate_id: string | null;
  bioguide_id: string | null;
  openstates_id: string | null;
}

// ---------------------------------------------------------------------------
// http helper -- native fetch + polite backoff, no dependency
// ---------------------------------------------------------------------------

export interface HttpJsonOptions {
  headers?: Record<string, string>;
  /** Max attempts (default 4). Retries on network error + 429/5xx. */
  maxAttempts?: number;
  /** Base backoff in ms (default 500). Exponential with jitter. */
  baseDelayMs?: number;
  /** Per-request timeout in ms (default 20000). */
  timeoutMs?: number;
}

export class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * fetchJson: GET a JSON endpoint with polite exponential backoff + jitter.
 * Retries on network errors, HTTP 429, and 5xx; gives up (throws HttpError)
 * on 4xx other than 429. Honors a Retry-After header when present.
 *
 * Returns the parsed JSON. Throws HttpError on a non-retryable / exhausted
 * failure so callers can decide whether to swallow (e.g. a 404 from a name
 * search = "no records", not an error) vs. surface it.
 */
export async function fetchJson<T = unknown>(
  url: string,
  opts: HttpJsonOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelay = opts.baseDelayMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        return (await res.json()) as T;
      }

      const body = await res.text().catch(() => '');
      // Retryable HTTP: 429 + 5xx. Everything else is terminal.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new HttpError(res.status, body);
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoff(baseDelay, attempt);
        if (attempt < maxAttempts) {
          await sleep(wait);
          continue;
        }
      }
      throw new HttpError(res.status, body);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) {
        throw e; // terminal HTTP error -- do not retry
      }
      lastErr = e;
      if (attempt < maxAttempts) {
        await sleep(backoff(baseDelay, attempt));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function backoff(base: number, attempt: number): number {
  const exp = base * Math.pow(2, attempt - 1);
  const jitter = Math.random() * base;
  return Math.min(exp + jitter, 15_000);
}

/** ISO timestamp for fetched_at. Exported so tests can stub a fixed clock. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build a CandidateRecordRow for a STRONG-ID source (auto-bind, verified).
 * bind_method is 'strong_id:<kind>', confidence 1.0, verified true.
 */
export function strongIdRow(args: {
  person_id: string;
  record_type: RecordType;
  source: EnrichSource;
  source_url: string | null;
  external_ref: string | null;
  payload: Record<string, unknown>;
  id_kind: string;
  fetched_at?: string;
}): CandidateRecordRow {
  return {
    person_id: args.person_id,
    record_type: args.record_type,
    source: args.source,
    source_url: args.source_url,
    external_ref: args.external_ref,
    payload: args.payload,
    bind_method: `strong_id:${args.id_kind}`,
    bind_confidence: 1.0,
    verified: true,
    requires_strong_id: false,
    note: null,
    fetched_at: args.fetched_at ?? nowIso(),
  };
}

/**
 * Build a CandidateRecordRow for a NAME-ONLY source (staged, NOT verified).
 * bind_method 'name_match', verified false, requires_strong_id true, with a
 * mandatory human-review note. Confidence defaults to 0.3 (well below the
 * 0.9 publish threshold in identity-resolve.ts) but is overridable.
 */
export function nameMatchRow(args: {
  person_id: string;
  record_type: RecordType;
  source: EnrichSource;
  source_url: string | null;
  external_ref: string | null;
  payload: Record<string, unknown>;
  note: string;
  bind_confidence?: number;
  fetched_at?: string;
}): CandidateRecordRow {
  return {
    person_id: args.person_id,
    record_type: args.record_type,
    source: args.source,
    source_url: args.source_url,
    external_ref: args.external_ref,
    payload: args.payload,
    bind_method: 'name_match',
    bind_confidence: args.bind_confidence ?? 0.3,
    verified: false,
    requires_strong_id: true,
    note: args.note,
    fetched_at: args.fetched_at ?? nowIso(),
  };
}
