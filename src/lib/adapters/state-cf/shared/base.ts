/**
 * Shared base for every per-state campaign-finance adapter.
 *
 * Mirrors the design of state-sos/base.ts but targets the `state_cf_events`
 * table (see supabase/migrations/20260418000002_retention_engine.sql). Every
 * state's CF portal has a different shape — JSON API, CSV bulk, HTML scrape,
 * or login-gated — but they all reduce to:
 *
 *   1. Fetch the portal (rate-limited, provenance-captured).
 *   2. Parse filings into a {@link StateCfEventRow} in reported form.
 *   3. Optionally resolve each filer to a candidacy via resolveCandidacy()
 *      from state-sos (the name/office/year tuple is the join key).
 *   4. Upsert into state_cf_events.
 *
 * Unlike state-sos/base.ts this factory does NOT force a resolution step —
 * many CF portals expose committee filings (PACs) that have no candidacy,
 * so resolution is opportunistic, and rows without a candidacy are still
 * retained (committee_name + filer_name alone are enough for retention-engine
 * subscribers).
 *
 * This file does NOT modify base adapter files (run.ts / rate-limit.ts /
 * types.ts) — it composes them.
 */

import { createHash } from 'node:crypto';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';
import { resolveCandidacy } from '../../state-sos/candidate-resolver';
import { politeFetch } from '../../fetch-polite';

// ---------------------------------------------------------------------------
// row_uid — content hash for dedup
// ---------------------------------------------------------------------------
//
// Must match the SQL in migration 20260425000012_state_cf_events_dedupe.sql
// EXACTLY. Used as ON CONFLICT target by the insert path below.
//
//   md5(state | event_date | amount | candidate_name | counterparty |
//       committee_name | event_type)
//
// The SQL uses '::text' casts on event_date / amount; in JS we render them as
// strings the same way Postgres would (event_date is ISO 'yyyy-mm-dd' from
// the parsers; amount is a JS number — we use String(n), which matches PG's
// numeric→text cast for finite integers and most decimals encountered in CF
// data. Edge cases like 1e21 won't appear in CF amounts).
function computeRowUid(r: {
  state: string;
  event_date?: string | null;
  amount: number | null;
  candidate_name?: string | null;
  counterparty?: string | null;
  committee_name?: string | null;
  event_type: CfEventType;
}): string {
  const parts = [
    r.state ?? '',
    r.event_date ?? '',
    r.amount === null || r.amount === undefined ? '' : String(r.amount),
    r.candidate_name ?? '',
    r.counterparty ?? '',
    r.committee_name ?? '',
    r.event_type ?? '',
  ];
  return createHash('md5').update(parts.join('|')).digest('hex');
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/** Matches the CHECK constraint we record in state_cf_events.event_type. */
export type CfEventType =
  | 'contribution'
  | 'expenditure'
  | 'loan'
  | 'filing'
  | 'independent_expenditure'
  | 'in_kind';

/**
 * One parsed CF row BEFORE resolution. The factory's insert() pass
 * opportunistically fills `resolved_candidacy_id` and `resolved_person_id`
 * via resolveCandidacy() when filer_name + office can be matched.
 */
export type StateCfEventRow = {
  state: string;                 // 2-letter abbr, e.g. 'MA', matches state_cf_events.state
  event_type: CfEventType;
  /** Canonical display name. F1a/F1b populate explicitly; F1c omits (filled by insert() from candidate_name || committee_name). */
  filer_name?: string;
  candidate_name?: string | null;
  candidate_office?: string | null;
  committee_name?: string | null;
  amount: number | null;
  event_date?: string | null;    // ISO yyyy-mm-dd
  /** ISO timestamp. F1a/F1b populate explicitly; F1c omits (filled by insert() with now() if absent). */
  reported_at?: string;
  counterparty?: string | null;
  /** Top-level source URL. F1a/F1b populate; F1c omits (filled from adapter sourceUrl at insert time). */
  source_url?: string;
  filing_url?: string | null;    // optional deep-link to specific filing page
  /** Raw source payload preserved for audit. F1a/F1b populate; F1c omits (filled with {} if absent). */
  raw_data?: Record<string, unknown>;

  // -------- Resolved (filled by base adapter before DB write) --------
  resolved_candidacy_id?: string | null;
  resolved_person_id?: string | null;
  confidence_score?: number | null;   // 0..1 (F1c convention); null = not scored

  // -------- Provenance --------
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type CfFetchResult = {
  rawBody: string;
  contentHash?: string;
  resolvedUrl?: string;
  meta?: Record<string, unknown>;
};

export type StateCfAdapterOptions = {
  /** Two-character state FIPS, e.g. '25' for Massachusetts. DC = '11'. */
  stateFips: string;
  /** 2-letter USPS abbreviation, used as state_cf_events.state. */
  stateAbbr: string;
  /** Kebab-case identifier appended to 'cf-' in the adapter name. */
  sourceName: string;
  sourceUrl: string;
  /**
   * Matches data_sources.source_type CHECK — both sos_campaign_finance and
   * ethics_commission exist in the seed data; base doesn't care which.
   */
  sourceType: 'sos_campaign_finance' | 'ethics_commission';
  license: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Below this count the run is marked partial. Default 0 (off-cycle pull). */
  expectedMinRows?: number;
  /** Election year used for opportunistic candidacy resolution. */
  electionYear?: number;
  /** Alias for electionYear (F1c convention). */
  cycleYear?: number;
  /** Reporting period, if passed in from CLI (e.g. '2026-Q1'). Stored in meta. */
  reportingPeriod?: string;
  /**
   * Fetch implementation. Called exactly once per run(). Adapter-author
   * controls the protocol (HTTP GET, CSV download, ASP.NET POST, etc.).
   */
  fetch: (ctx: AdapterContext) => Promise<CfFetchResult>;
  /**
   * Parse raw bytes into CF rows. All candidacy resolution is performed
   * centrally; the parser just pulls fields out of the source schema.
   */
  parse: (
    rawBody: string,
    ctx: AdapterContext,
  ) => Promise<StateCfEventRow[]>;
  /** Optional per-row additional validation (framework validates basics). */
  validateRow?: (row: StateCfEventRow) => string | null;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStateCfAdapter(
  options: StateCfAdapterOptions,
): SourceAdapter<StateCfEventRow> {
  const bucket = options.tokenBucket
    ? createTokenBucket(options.tokenBucket)
    : null;

  const electionYear =
    options.electionYear ?? new Date().getUTCFullYear();
  const expectedMinRows = options.expectedMinRows ?? 0;

  const adapter: SourceAdapter<StateCfEventRow> = {
    name: `cf-${options.sourceName}`,
    stateFips: options.stateFips,
    tokenBucket: options.tokenBucket ?? { rps: 0.5, burst: 2 },
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<StateCfEventRow>> {
      if (bucket) await bucket.acquire();

      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: options.stateFips,
        url: options.sourceUrl,
      });

      const fetchResult = await options.fetch(ctx);
      const contentHash =
        fetchResult.contentHash ??
        createHash('sha256').update(fetchResult.rawBody).digest('hex');

      ctx.logger.info(`${adapter.name}: fetched`, {
        bytes: fetchResult.rawBody.length,
        contentHash: contentHash.slice(0, 12),
      });

      let rows: StateCfEventRow[];
      let parserSignal: 'ok' | 'no_table' | 'table_empty' | 'parse_failed' = 'ok';
      try {
        rows = await options.parse(fetchResult.rawBody, ctx);
      } catch (err) {
        // Parser threw — the body shape was so off the parser couldn't
        // even cope. Treat as parse_failed (zero rows, status will become
        // 'unproductive' in the runner).
        ctx.logger.warn(`${adapter.name}: parser threw`, {
          error: err instanceof Error ? err.message : String(err),
        });
        rows = [];
        parserSignal = 'parse_failed';
      }

      // If we got zero rows AND the body has no <table>, this is almost
      // certainly a landing page or auth-walled portal — not a real empty
      // result. Council 2026-04-25 DE#1: distinguish "URL is wrong" from
      // "this state has no data right now."
      if (rows.length === 0 && parserSignal === 'ok') {
        const trimmed = fetchResult.rawBody.trimStart();
        const isHtml = trimmed.startsWith('<');
        const hasTable = isHtml && /<table[\s>]/i.test(fetchResult.rawBody);
        if (isHtml && !hasTable) {
          parserSignal = 'no_table';
        } else if (isHtml && hasTable) {
          parserSignal = 'table_empty'; // table exists but had no parseable rows
        }
        // Non-HTML bodies (CSV, JSON) with 0 rows stay 'ok' — the parser
        // is the authority for those.
      }

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        parserSignal,
      });

      // Council #7 visibility: surface the adapter-declared floor on the
      // data_sources row so the runner / Adapter Doctor / dashboards can see
      // it without code archaeology. The runner separately reads
      // `data_sources.expected_min_rows_floor` (backfilled from 7d median);
      // when the declared floor is 0 the runner logs a warning and substitutes
      // the historical median.
      return {
        rows,
        expectedMinRows,
        parserSignal,
        source: {
          sourceType: options.sourceType,
          name: options.sourceName,
          url: fetchResult.resolvedUrl ?? options.sourceUrl,
          contentHash,
          license: options.license,
          stateFips: options.stateFips,
          meta: {
            ...(fetchResult.meta ?? {}),
            election_year: electionYear,
            byte_size: fetchResult.rawBody.length,
            expected_min_rows: expectedMinRows,
            source_authority: 'government_authoritative',
            ...(options.reportingPeriod
              ? { reporting_period: options.reportingPeriod }
              : {}),
          },
        },
      };
    },

    validateRow(row) {
      // Fill filer_name from candidate_name or committee_name if missing (F1c convention)
      if (!row.filer_name || row.filer_name.trim().length === 0) {
        row.filer_name = row.candidate_name || row.committee_name || undefined;
      }
      if (!row.filer_name || row.filer_name.trim().length === 0) {
        return 'missing filer_name (and no candidate_name/committee_name fallback)';
      }
      // Fill defaults for optional-but-required fields
      if (!row.reported_at) row.reported_at = new Date().toISOString();
      if (!row.source_url) row.source_url = options.sourceUrl;
      if (!row.raw_data) row.raw_data = {};
      if (!row.event_type) return 'missing event_type';
      if (row.amount !== null && !Number.isFinite(row.amount)) {
        return `non-finite amount: ${String(row.amount)}`;
      }
      if (row.amount !== null && row.amount < 0) {
        // Refunds/voids are represented as negative amounts in several state
        // portals. We don't reject, but we do tag raw_data so reports can
        // filter them out.
        row.raw_data = { ...(row.raw_data ?? {}), is_negative: true };
      }
      return options.validateRow ? options.validateRow(row) : null;
    },

    async insert(
      rows: StateCfEventRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      const stats: InsertStats = {
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        errors: [],
      };

      if (rows.length === 0) return stats;

      // Opportunistic resolution: only runs when the row has both a
      // candidate_name and candidate_office. Committee filings without a
      // candidate match (PACs, IE committees) still flow through.
      const resolved: StateCfEventRow[] = [];
      for (const row of rows) {
        let resolvedCandidacyId: string | null = null;
        let resolvedPersonId: string | null = null;
        if (row.candidate_name && row.candidate_office) {
          try {
            const match = await resolveCandidacy(ctx.pg, {
              reported_name: row.candidate_name,
              state_fips: options.stateFips,
              office_name: row.candidate_office,
              district_identifier: null,
              election_year: electionYear,
            });
            if (match) {
              resolvedCandidacyId = match.candidacy_id;
              resolvedPersonId = match.person_id;
            }
          } catch (err) {
            ctx.logger.warn(`${adapter.name}: resolveCandidacy failed`, {
              error: err instanceof Error ? err.message : String(err),
              name: row.candidate_name,
            });
          }
        }
        resolved.push({
          ...row,
          resolved_candidacy_id: resolvedCandidacyId,
          resolved_person_id: resolvedPersonId,
        });
      }

      // Build the state_cf_events payload. Confidence is 1.0 for direct
      // portal fetches (no AI in the loop) — the retention-engine auto-
      // publish threshold (>=0.75) therefore flips verified=true.
      //
      // row_uid: md5 of canonical (state, event_date, amount, candidate_name,
      // counterparty, committee_name, event_type). MUST match the formula in
      // migration 20260425000012_state_cf_events_dedupe.sql exactly so the
      // backfilled hashes line up with new inserts. We use this as the
      // ON CONFLICT target so retries / overlapping cycles don't re-insert
      // duplicates (council 2026-04-25 fix for the 12.1M-row dupe blow-up).
      //
      // Provenance (council 2026-04-26 data-quality fix): every event row
      // points back to the data_sources row + ingestion_runs row that
      // produced it. Before this fix, 100% of state_cf_events.data_source_id
      // was NULL because the payload didn't include the field even though
      // refs.dataSourceId was already plumbed through. Reconstruction by
      // URL match is brittle (state/abbrev/query-string drift) — the FK
      // is the only reliable join.
      const payload = resolved.map((r) => ({
        state: r.state,
        candidate_name: r.candidate_name ?? null,
        candidate_office: r.candidate_office ?? null,
        committee_name: r.committee_name ?? null,
        event_type: r.event_type,
        amount: r.amount,
        event_date: r.event_date ?? null,
        counterparty: r.counterparty ?? null,
        filing_url: r.source_url,
        confidence_score: 1.0,
        verified: true,
        row_uid: computeRowUid(r),
        data_source_id: refs.dataSourceId,
        ingestion_run_id: refs.ingestionRunId,
        // ingested_at + id defaulted by the table.
      }));

      const BATCH = 500;
      for (let i = 0; i < payload.length; i += BATCH) {
        const chunk = payload.slice(i, i + BATCH);
        // upsert with ignoreDuplicates: row_uid UNIQUE constraint is added by
        // scripts/dedupe-state-cf-events.ts after the historical purge. Once
        // present, this becomes an idempotent insert: dupes silently no-op
        // instead of inflating the table.
        const { data, error } = await ctx.supabase
          .from('state_cf_events')
          .upsert(chunk, { onConflict: 'row_uid', ignoreDuplicates: true })
          .select('id');
        if (error) {
          stats.rowsFailed += chunk.length;
          stats.errors.push({
            type: 'other',
            message: `insert batch ${i}: ${error.message}`,
          });
          ctx.logger.warn(`${adapter.name}: insert batch failed`, {
            offset: i,
            error: error.message,
          });
          continue;
        }
        stats.rowsInserted += data?.length ?? 0;
        stats.rowsSkipped += chunk.length - (data?.length ?? 0);
      }

      // Provenance (data_source_id + ingestion_run_id) is now embedded
      // directly in each inserted row above. The earlier comment claiming
      // it had to ride on extraction_audit was stale: migration
      // 20260425000001_state_cf_events_resolved.sql added the FK columns,
      // and the runner already passes refs.dataSourceId before insert().
      ctx.logger.info(`${adapter.name}: inserted`, {
        rowCount: stats.rowsInserted,
        dataSourceId: refs.dataSourceId,
        ingestionRunId: refs.ingestionRunId,
      });

      return stats;
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Shared fetch helper (simple HTML GET). Per-state adapters that need
// POST bodies / cookies / CSV bulk endpoints write their own fetch impl.
//
// 2026-04-25 — error-cause forwarding + TLS-bypass option. Native Node fetch
// throws an opaque `TypeError: fetch failed` for any low-level failure; the
// real cause (ENOTFOUND, ECONNRESET, UNABLE_TO_VERIFY_LEAF_SIGNATURE, etc.)
// hides on `error.cause.code`. The failure-analyzer needs the cause string
// in the error message to classify accurately, so we extract and prepend it.
//
// `allowSelfSignedCert: true` enables an undici Agent with rejectUnauthorized=
// false. Use ONLY for state .gov sites with stale cert chains — never for
// arbitrary endpoints. Tracked per-adapter, not globally.
// ---------------------------------------------------------------------------

import { Agent } from 'undici';

let _laxCertAgent: Agent | null = null;
function getLaxCertAgent(): Agent {
  if (!_laxCertAgent) {
    _laxCertAgent = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return _laxCertAgent;
}

export type FetchCfHtmlOptions = {
  /** State .gov sites with stale cert chains (e.g. CO TRACER). Default false. */
  allowSelfSignedCert?: boolean;
  /**
   * Hard wall-clock timeout for a single HTTP request, in milliseconds.
   * Defaults to {@link DEFAULT_FETCH_TIMEOUT_MS}. Without this, native fetch
   * waits indefinitely on a half-open TCP connection or a server that accepted
   * but never responds — observed 2026-04-26 with cfb.mn.gov causing
   * `cf-minnesota-cfb-cf` to park the runner for >6 min until the
   * stuck-task-janitor fired SIGKILL. The timeout is per-call (not for the
   * whole adapter run) so retry loops in callers still work.
   */
  fetchTimeoutMs?: number;
};

/**
 * Per-request hard timeout for state-cf HTTP fetches. Two minutes is a long
 * tail for legitimate slow .gov sites (some respond in 60-90s under load) but
 * still well under any sensible adapter-level budget.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

export async function fetchCfHtml(
  url: string,
  options: FetchCfHtmlOptions = {},
): Promise<CfFetchResult> {
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  let res: Response;
  try {
    const fetchInit: Record<string, unknown> = {
      headers: {
        accept:
          'text/html, application/xhtml+xml, application/json, text/csv, */*',
      },
      redirect: 'follow',
      // AbortSignal.timeout() yields a DOMException('TimeoutError') when it
      // fires; we surface that distinctly below so the failure-analyzer can
      // classify "server hung" separately from "DNS failed" or "5xx".
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (options.allowSelfSignedCert) {
      fetchInit.dispatcher = getLaxCertAgent();
    }
    res = await politeFetch(url, fetchInit);
  } catch (e) {
    // Distinguish AbortSignal.timeout firing from other network failures so
    // the failure-analyzer doesn't lump "host hung" into "fetch failed".
    const isTimeout =
      e instanceof DOMException && e.name === 'TimeoutError';
    if (isTimeout) {
      throw new Error(
        `state-cf fetch: timeout after ${timeoutMs}ms (cause=fetch_timeout) for ${url}`,
      );
    }
    // Pull the underlying network-error code from error.cause so the
    // failure-analyzer can classify ENOTFOUND vs ECONNRESET vs
    // UNABLE_TO_VERIFY_LEAF_SIGNATURE. Without this, every network failure
    // becomes the unhelpful string "fetch failed".
    const causeCode =
      (e as { cause?: { code?: string } } | undefined)?.cause?.code ?? null;
    const baseMsg = e instanceof Error ? e.message : String(e);
    if (causeCode) {
      throw new Error(`state-cf fetch: ${baseMsg} (cause=${causeCode}) for ${url}`);
    }
    throw new Error(`state-cf fetch: ${baseMsg} for ${url}`);
  }
  if (!res.ok) {
    throw new Error(`state-cf fetch: HTTP ${res.status} for ${url}`);
  }
  const body = await res.text();
  return {
    rawBody: body,
    resolvedUrl: res.url ?? url,
    meta: {
      lastModified: res.headers.get('last-modified') ?? undefined,
      etag: res.headers.get('etag') ?? undefined,
      contentType: res.headers.get('content-type') ?? undefined,
    },
  };
}

/**
 * Returns a stub StateCfEventRow[] parser that always returns []. Used by
 * TODO-flagged states (login-required, dead portal, or unresolved schema)
 * so the dispatcher still exercises the full runAdapter lifecycle.
 */
export function emptyCfParser(): (body: string) => Promise<StateCfEventRow[]> {
  return async () => [];
}
