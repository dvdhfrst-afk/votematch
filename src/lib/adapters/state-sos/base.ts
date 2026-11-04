/**
 * Shared base for every per-state Secretary-of-State results adapter.
 *
 * Problem this solves
 * -------------------
 * Havesay is national on day one — all 51 SoS portals (50 states + DC)
 * need an adapter. Each portal ships a different schema (HTML, CSV, XML-JSON
 * hybrid, per-state NIST XML, etc.) but they all boil down to:
 *
 *   1. Fetch (URL -> raw bytes + content hash)
 *   2. Parse (raw bytes -> StateResultRow[] in reported form)
 *   3. Resolve (reported name + office + party -> our candidacy/person/party ids)
 *   4. Upsert into election_results keyed on
 *      (election_id, reported_name, party_abbreviation) NULLS NOT DISTINCT.
 *
 * createStateSosAdapter() is a factory that accepts the state-specific fetch +
 * parse functions and returns a SourceAdapter<StateResultRow> that plugs into
 * runAdapter() from ../run.ts with no per-state wiring needed for steps 3 + 4.
 *
 * See:
 *   - candidate-resolver.ts  (reported name -> candidacy_id, person_id)
 *   - party-resolver.ts      (party string -> parties.id)
 *   - nist-xml-parser.ts     (Ohio + any state that adopts NIST 1500-100 v2)
 *
 * Design notes
 * ------------
 * - The factory is deliberately pure: fetch/parse are injected so unit tests
 *   can drive synthetic bodies through the full pipeline without hitting live
 *   URLs.
 * - Resolution failures are logged to ingestion_errors with error_type in
 *   {'validation','parse','other'} — they do NOT crash the run. The goal is
 *   "eventually complete" over "fail fast", because SoS portals regularly
 *   publish garbled / partial updates on election night.
 * - election_id resolution is intentionally left to resolveOfficeId() +
 *   a small helper in this file so a single adapter can straddle multiple
 *   offices (e.g., a state-wide XML dump that contains Governor + AG + US
 *   Senator in one file).
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../types';
import { createTokenBucket } from '../rate-limit';
import { resolveCandidacy, resolveOfficeElection } from './candidate-resolver';
import { resolvePartyId } from './party-resolver';

// ---------------------------------------------------------------------------
// Row shape — what every state adapter produces
// ---------------------------------------------------------------------------

/** Reporting-level lifecycle; maps 1:1 to election_results.reporting_level. */
export type StateReportingLevel =
  | 'unofficial_partial'
  | 'unofficial_complete'
  | 'state_certified';

/**
 * One reported row from a SoS feed BEFORE resolution. The factory's
 * insert() pass fills the `resolved_*` fields before writing to election_results.
 */
export type StateResultRow = {
  // -------- Raw (as reported by source) --------
  reported_name: string;
  party_abbreviation: string | null;
  office_name: string;
  /** e.g. '1' for US House district 1, or '7' for State Senate district 7. */
  district_identifier: string | null;
  vote_count: number | null;
  /** 0-100, matches election_results.vote_percentage CHECK. */
  vote_percentage: number | null;
  /** 0-100, matches election_results.pct_precincts_reporting CHECK. */
  pct_precincts_reporting: number | null;
  is_winner: boolean;
  is_runoff_advancer: boolean;
  is_write_in: boolean;
  reporting_level: StateReportingLevel;

  // -------- Resolved (filled by base adapter before DB write) --------
  resolved_election_id?: string;
  resolved_candidacy_id?: string;
  resolved_person_id?: string;
  resolved_party_id?: string;

  // -------- Provenance --------
  /** Stable identifier from the source for idempotency. Used in meta. */
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Raw body returned by the state-specific fetch implementation. */
export type StateFetchResult = {
  rawBody: string;
  /** Caller may precompute (recommended); helper falls back to sha256(rawBody). */
  contentHash?: string;
  /** Optional override when the fetch URL differs from sourceUrl (redirect, etc.). */
  resolvedUrl?: string;
  /** If the SoS sends Last-Modified / ETag, stash here for provenance. */
  meta?: Record<string, unknown>;
};

export type StateSosAdapterOptions = {
  /** Two-character state FIPS, e.g. '49' for Utah. DC = '11'. */
  stateFips: string;
  /** Kebab-case identifier appended to 'sos-' in the adapter name. */
  sourceName: string;
  sourceUrl: string;
  /**
   * Restricted vocabulary — matches data_sources.source_type CHECK constraint.
   * Most SoS results pages use 'sos_results_api'; candidate filings use
   * 'sos_candidate_filing'.
   */
  sourceType: 'sos_results_api' | 'sos_candidate_filing';
  license: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /**
   * Below this row count the run is marked 'partial'. Default 1 — any SoS
   * feed that returned zero rows is either a hard failure or end-of-season.
   */
  expectedMinRows: number;
  /** Election year used by candidacy resolution. Defaults to current UTC year. */
  electionYear?: number;
  /**
   * Fetch implementation. Called exactly once per run(). Responsible for its
   * own retries / rate limiting ABOVE the tokenBucket layer.
   */
  fetch: (ctx: AdapterContext) => Promise<StateFetchResult>;
  /**
   * Parse raw bytes into reported rows. All resolution (candidacy, party,
   * office) is performed centrally; the parser just pulls fields out of the
   * source schema and names them.
   */
  parse: (
    rawBody: string,
    ctx: AdapterContext,
  ) => Promise<StateResultRow[]>;
  /**
   * Optional per-row additional validation. Return null when valid, a
   * string (error message) otherwise. Framework-level validation (vote
   * ranges, null-name, etc.) runs before this.
   */
  validateRow?: (row: StateResultRow) => string | null;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Compose a full SourceAdapter for one state's SoS results feed.
 *
 * @example
 *   // Trivial adapter assembled from five parts:
 *   const ohAdapter = createStateSosAdapter({
 *     stateFips: '39',
 *     sourceName: 'ohio-sos-results',
 *     sourceUrl: 'https://www.ohiosos.gov/.../results.xml',
 *     sourceType: 'sos_results_api',
 *     license: 'state_open_records',
 *     expectedMinRows: 100,
 *     fetch: async () => ({ rawBody: await (await fetch(URL)).text() }),
 *     parse: async (xml) => parseNistXml(xml, '39'),
 *   });
 */
export function createStateSosAdapter(
  options: StateSosAdapterOptions,
): SourceAdapter<StateResultRow> {
  const bucket = options.tokenBucket
    ? createTokenBucket(options.tokenBucket)
    : null;

  const electionYear =
    options.electionYear ?? new Date().getUTCFullYear();

  const adapter: SourceAdapter<StateResultRow> = {
    name: `sos-${options.sourceName}`,
    stateFips: options.stateFips,
    tokenBucket: options.tokenBucket,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<StateResultRow>> {
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

      const rows = await options.parse(fetchResult.rawBody, ctx);

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
      });

      return {
        rows,
        expectedMinRows: options.expectedMinRows,
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
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || row.reported_name.trim().length === 0) {
        return 'missing reported_name';
      }
      if (!row.office_name || row.office_name.trim().length === 0) {
        return 'missing office_name';
      }
      if (row.vote_count !== null && row.vote_count < 0) {
        return `negative vote_count: ${row.vote_count}`;
      }
      if (
        row.vote_percentage !== null &&
        (row.vote_percentage < 0 || row.vote_percentage > 100)
      ) {
        return `vote_percentage out of [0,100]: ${row.vote_percentage}`;
      }
      if (
        row.pct_precincts_reporting !== null &&
        (row.pct_precincts_reporting < 0 || row.pct_precincts_reporting > 100)
      ) {
        return `pct_precincts_reporting out of [0,100]: ${row.pct_precincts_reporting}`;
      }
      if (row.is_winner && row.is_runoff_advancer) {
        // Matches election_results_outcome_mutex CHECK.
        return 'is_winner and is_runoff_advancer are mutually exclusive';
      }
      return options.validateRow ? options.validateRow(row) : null;
    },

    async insert(
      rows: StateResultRow[],
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

      // Resolve each row in turn. We don't batch at the DB layer here — the
      // resolvers are cheap queries backed by indexes (canonical_key,
      // aliases, office_name trigram) and election-night runs are typically
      // <5K rows. If a given state's pipeline needs batched resolution
      // later, it can subclass this factory.
      const resolvedRows: Array<StateResultRow & {
        resolved_election_id: string | null;
      }> = [];

      for (const row of rows) {
        try {
          const electionInfo = await resolveOfficeElection(ctx.pg, {
            state_fips: options.stateFips,
            office_name: row.office_name,
            district_identifier: row.district_identifier,
            election_year: electionYear,
          });

          if (!electionInfo) {
            stats.rowsSkipped += 1;
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `office not resolved for state=${options.stateFips} office="${row.office_name}" district=${row.district_identifier ?? '-'}`,
              row,
            );
            continue;
          }

          const candidacy = await resolveCandidacy(ctx.pg, {
            reported_name: row.reported_name,
            state_fips: options.stateFips,
            office_name: row.office_name,
            district_identifier: row.district_identifier,
            election_year: electionYear,
          });

          const partyId = await resolvePartyId(
            ctx.pg,
            row.party_abbreviation,
            options.stateFips,
          );

          resolvedRows.push({
            ...row,
            resolved_election_id: electionInfo.election_id,
            resolved_candidacy_id: candidacy?.candidacy_id,
            resolved_person_id: candidacy?.person_id,
            resolved_party_id: partyId ?? undefined,
          });
        } catch (err) {
          stats.rowsFailed += 1;
          const msg = err instanceof Error ? err.message : String(err);
          stats.errors.push({
            type: 'other',
            message: `resolve: ${msg}`,
            rawInput: row,
          });
          ctx.logger.warn(`${adapter.name}: resolve failed`, {
            error: msg,
            row: { name: row.reported_name, office: row.office_name },
          });
        }
      }

      // Build election_results payload rows. reporting_level is pinned to
      // the three values we promised in the public type; downstream
      // lifecycle transitions (ap_called, certified) are authored by other
      // adapters (AP results feed, canvassing-board scripts) and are not
      // the SoS adapter's job.
      const payload = resolvedRows
        .filter((r) => r.resolved_election_id !== null)
        .map((r) => ({
          election_id: r.resolved_election_id,
          candidacy_id: r.resolved_candidacy_id ?? null,
          person_id: r.resolved_person_id ?? null,
          party_id: r.resolved_party_id ?? null,
          reported_name: r.reported_name,
          party_abbreviation: r.party_abbreviation,
          vote_count: r.vote_count,
          vote_percentage: r.vote_percentage,
          pct_precincts_reporting: r.pct_precincts_reporting,
          is_winner: r.is_winner,
          is_runoff_advancer: r.is_runoff_advancer,
          is_write_in: r.is_write_in,
          is_certified_write_in: false,
          reporting_level: r.reporting_level,
          first_reported_at: new Date().toISOString(),
          data_source_id: refs.dataSourceId,
          ingestion_run_id: refs.ingestionRunId,
          meta: { source_row_id: r.source_row_id },
        }));

      if (payload.length === 0) return stats;

      const BATCH = 500;
      for (let i = 0; i < payload.length; i += BATCH) {
        const chunk = payload.slice(i, i + BATCH);
        const { data, error } = await ctx.supabase
          .from('election_results')
          .upsert(chunk, {
            // Matches uniq_election_results_ident (NULLS NOT DISTINCT).
            onConflict: 'election_id,reported_name,party_abbreviation',
          })
          .select('id');
        if (error) {
          stats.rowsFailed += chunk.length;
          stats.errors.push({
            type: 'other',
            message: `upsert batch ${i}: ${error.message}`,
          });
          ctx.logger.warn(`${adapter.name}: upsert batch failed`, {
            offset: i,
            error: error.message,
          });
          continue;
        }
        stats.rowsInserted += data?.length ?? chunk.length;
      }

      return stats;
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Log a per-row ingestion error via supabase. Swallows its own errors so the
 * resolution loop can keep moving on election night.
 */
async function logIngestionError(
  ctx: AdapterContext,
  ingestionRunId: string,
  errorType: 'parse' | 'validation' | 'fk_violation' | 'other',
  message: string,
  rawInput: unknown,
): Promise<void> {
  try {
    await ctx.supabase.from('ingestion_errors').insert({
      ingestion_run_id: ingestionRunId,
      error_type: errorType,
      error_message: message.slice(0, 2000),
      raw_input: rawInput,
    });
  } catch (err) {
    ctx.logger.warn('state-sos: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Normalize a free-form name into the same key the trigger on people derives:
 *   lower(regexp_replace(unaccent(canonical_name), '[^a-zA-Z0-9]', '', 'g'))
 *
 * Exported so resolvers + tests can reuse. Must stay in lockstep with the DB
 * trigger `people_set_canonical_key()`. Diacritic folding (council finding #8)
 * matches DB unaccent() — see migration 20260425000006_territory_office_types.sql.
 */
export function canonicalKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Re-exports for adapter authors who want one import path.
export {
  resolveCandidacy,
  resolveOfficeElection,
  findOrCreatePerson,
} from './candidate-resolver';
export { resolvePartyId } from './party-resolver';
export { parseNistXml, parseNistXmlOrThrow } from './nist-xml-parser';
export type { Pool } from 'pg';
export type {
  ResolveCandidacyInput,
  FindOrCreatePersonInput,
} from './candidate-resolver';
