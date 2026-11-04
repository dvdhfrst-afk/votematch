/**
 * Shared base for every per-state legislator-voting-records adapter.
 *
 * Problem this solves
 * -------------------
 * OpenStates bulk CSVs (historically the "easy path" for multi-state roll-call
 * data) now require login as of 2026-04-19, removing them as a universal
 * source. Each state's legislature publishes roll calls in its own format:
 *   - UT: JSON via le.utah.gov/data/ (developer tools)
 *   - OH: per-bill HTML pages at ohiohouse.gov/legislation/{ga}/{bill}/votes
 *   - PA: XML via legis.state.pa.us/Data (hourly refresh, M-F)
 *   - FL: per-bill HTML/XML on flsenate.gov and flhouse.gov
 *   - NC: HTML vote transcripts at ncleg.gov/Legislation/Votes/RollCallVoteTranscript
 *   - TX: XML/CSV on FTP at ftp.legis.state.tx.us
 *
 * createStateVotesAdapter() is a factory that accepts the state-specific fetch
 * + parse functions and returns a SourceAdapter<StateLegVoteRow> that plugs
 * into runAdapter() from ../run.ts with no per-state wiring needed for
 * legislator resolution + the DB upsert into state_legislator_votes.
 *
 * Design notes
 * ------------
 * - The factory is deliberately pure: fetch/parse are injected so unit tests
 *   can drive synthetic XML/HTML through the full pipeline without hitting
 *   live URLs.
 * - Resolution failures (name -> person_id) are logged to ingestion_errors
 *   but do NOT drop the row — state_legislator_votes stores legislator_name
 *   as a first-class column so aggregate queries still work even when the
 *   person hasn't been resolved yet.
 * - The state_legislator_votes table uses
 *   `source IN ('openstates', 'direct_scrape')`. These adapters all write
 *   `source='direct_scrape'`; an OpenStates-backed path would bypass this
 *   factory entirely.
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

// ---------------------------------------------------------------------------
// Row shape — what every state-votes adapter produces
// ---------------------------------------------------------------------------

/** Matches state_legislator_votes.position — not CHECK-constrained in the DB,
 *  but we standardize on this vocabulary for downstream aggregation. */
export type VotePosition = 'yea' | 'nay' | 'abstain' | 'absent' | 'other';

/** Matches state_legislator_votes.chamber — lowercase by convention. */
export type LegislativeChamber = 'upper' | 'lower' | 'joint';

/**
 * One reported roll-call vote position BEFORE resolution. The factory's
 * insert() pass fills `resolved_person_id` before writing to
 * state_legislator_votes (if resolution succeeded).
 */
export type StateLegVoteRow = {
  // -------- Raw (as reported by source) --------
  /** Legislator's name as printed in the source. Required; used as a key. */
  legislator_name: string;
  /** Optional district string from source ('1', 'HD-12', etc.); aids resolution. */
  legislator_district: string | null;
  /** Optional party abbreviation; kept for provenance. */
  legislator_party: string | null;
  /** Bill identifier, e.g. 'HB0123', 'SB45', 'HF1'. */
  bill_identifier: string;
  /** Short bill title — free-form, stored for display. */
  bill_title: string | null;
  /** ISO date YYYY-MM-DD. */
  vote_date: string | null;
  /** Normalized position — see VotePosition. */
  position: VotePosition;
  chamber: LegislativeChamber;
  /**
   * 4-digit session year. For biennial sessions like UT's 2025 General
   * Session spanning 2025-Jan through 2025-Mar, use 2025.
   */
  session_year: number;
  /** Deep-link to the source page / XML — optional but strongly recommended. */
  source_url: string | null;

  // -------- Resolved (filled by base adapter before DB write) --------
  /** People.id; null when resolution failed. */
  resolved_person_id?: string | null;
  /** OCD division id if known (used as a stable external key). */
  resolved_ocd_id?: string | null;

  // -------- Provenance --------
  /** Stable identifier from the source for idempotency. Used in meta. */
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Raw body returned by the state-specific fetch implementation. */
export type StateVotesFetchResult = {
  rawBody: string;
  contentHash?: string;
  resolvedUrl?: string;
  meta?: Record<string, unknown>;
};

/**
 * Input to the built-in resolver. State adapters usually don't need to
 * override this — it does a (state, chamber, district, name) lookup against
 * people × office_tenures.
 */
export type LegislatorResolveInput = {
  state_fips: string;
  chamber: LegislativeChamber;
  district: string | null;
  name: string;
};

export type LegislatorResolveResult = {
  person_id: string;
  ocd_id: string | null;
} | null;

export type LegislatorResolver = (
  pg: Pool,
  input: LegislatorResolveInput,
) => Promise<LegislatorResolveResult>;

export type StateVotesAdapterOptions = {
  /** Two-character state FIPS, e.g. '49' for Utah. */
  stateFips: string;
  /** Two-letter USPS abbrev; used in name-only queries + written into rows. */
  stateAbbrev: string;
  /** Kebab-case identifier appended to 'leg-votes-' in the adapter name. */
  sourceName: string;
  sourceUrl: string;
  license: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /**
   * Below this row count the run is marked 'partial'. Default 0 — many state
   * legislatures recess for long stretches and a single-day fetch legitimately
   * produces zero rows.
   */
  expectedMinRows: number;
  /**
   * Fetch implementation. Called exactly once per run().
   */
  fetch: (ctx: AdapterContext) => Promise<StateVotesFetchResult>;
  /**
   * Parse raw bytes into vote rows. Resolution is performed centrally.
   */
  parse: (
    rawBody: string,
    ctx: AdapterContext,
  ) => Promise<StateLegVoteRow[]>;
  /** Optional override for legislator resolution (tests / state-specific logic). */
  resolveLegislator?: LegislatorResolver;
  /** Optional per-row validator (returns null when valid). */
  validateRow?: (row: StateLegVoteRow) => string | null;
};

// ---------------------------------------------------------------------------
// Default legislator resolver
// ---------------------------------------------------------------------------

/**
 * Normalize a free-form legislator name into the same key the people table
 * trigger derives:
 *   lower(regexp_replace(unaccent(canonical_name), '[^a-zA-Z0-9]', '', 'g'))
 * Mirror of state-sos/base#canonicalKey so both adapter families stay in sync.
 * Diacritic folding via NFD + combining-mark strip (council finding #8) so
 * "Vázquez" and "Vazquez" canonicalize identically — required for PR +
 * bilingual states.
 */
export function canonicalKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Default legislator resolver.
 *
 * Strategy:
 *   1. canonical_key lookup on people (strict name match).
 *   2. Intersect with office_tenures where the tenure is for a state-legislature
 *      office in this state, in the right chamber, and (when district is
 *      present) matching the district number.
 *   3. If exactly one match, return it. Ambiguous (>1) → null.
 *
 * Tolerant of office_type naming: we match both generic state_senate /
 * state_house slugs AND the state-specific variants that exist in offices.meta.
 */
export const defaultResolveLegislator: LegislatorResolver = async (pg, input) => {
  const key = canonicalKey(input.name);
  if (!key) return null;

  const chamberOfficeTypes = input.chamber === 'upper'
    ? ['state_senate', 'state_senator']
    : input.chamber === 'lower'
      ? ['state_house', 'state_representative', 'state_assembly']
      : ['state_senate', 'state_house', 'state_assembly'];

  // Single SQL over people × office_tenures × offices × jurisdictions.
  // We allow the district filter to be skipped when null (some sources don't
  // carry it in the vote row itself but list a separate member roster).
  const sql = `
    SELECT DISTINCT p.id AS person_id,
           o.meta->>'ocd_id' AS ocd_id
      FROM people p
      JOIN office_tenures t ON t.person_id = p.id
      JOIN offices o        ON o.id = t.office_id
      JOIN office_types ot  ON ot.id = o.office_type_id
      JOIN jurisdictions j  ON j.id = o.jurisdiction_id
     WHERE p.canonical_key = $1
       AND j.state_fips = $2
       AND ot.slug = ANY($3::text[])
       AND ($4::text IS NULL OR o.meta->>'district_identifier' = $4)
       AND t.ended_on IS NULL
     LIMIT 2
  `;
  const res = await pg.query<{ person_id: string; ocd_id: string | null }>(
    sql,
    [key, input.state_fips, chamberOfficeTypes, input.district],
  );
  if (res.rows.length !== 1) return null;
  return { person_id: res.rows[0].person_id, ocd_id: res.rows[0].ocd_id };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Compose a full SourceAdapter for one state's legislator-votes feed.
 *
 * @example
 *   const utAdapter = createStateVotesAdapter({
 *     stateFips: '49',
 *     stateAbbrev: 'UT',
 *     sourceName: 'utah-leg-votes',
 *     sourceUrl: 'https://le.utah.gov/data/...',
 *     license: 'state_open_records',
 *     expectedMinRows: 0,
 *     fetch: async () => ({ rawBody: await (await fetch(URL)).text() }),
 *     parse: async (body) => parseUtahLegVotes(body),
 *   });
 */
export function createStateVotesAdapter(
  options: StateVotesAdapterOptions,
): SourceAdapter<StateLegVoteRow> {
  const bucket = options.tokenBucket
    ? createTokenBucket(options.tokenBucket)
    : null;

  const resolveLegislator = options.resolveLegislator ?? defaultResolveLegislator;

  const adapter: SourceAdapter<StateLegVoteRow> = {
    name: `leg-votes-${options.sourceName}`,
    stateFips: options.stateFips,
    tokenBucket: options.tokenBucket,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<StateLegVoteRow>> {
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
          // Not a declared source_type in state-sos but the data_sources
          // CHECK constraint is enforced in the migration; 'legislator_votes'
          // is the type added in 20260418000002_retention_engine.sql
          // (alternately falls back to 'state_leg_scrape'). Use the broad
          // 'legislator_votes' string so CHECK doesn't trip.
          sourceType: 'legislator_votes',
          name: options.sourceName,
          url: fetchResult.resolvedUrl ?? options.sourceUrl,
          contentHash,
          license: options.license,
          stateFips: options.stateFips,
          meta: {
            ...(fetchResult.meta ?? {}),
            byte_size: fetchResult.rawBody.length,
            state_abbrev: options.stateAbbrev,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.legislator_name || row.legislator_name.trim().length === 0) {
        return 'missing legislator_name';
      }
      if (!row.bill_identifier || row.bill_identifier.trim().length === 0) {
        return 'missing bill_identifier';
      }
      if (
        row.position !== 'yea' && row.position !== 'nay' &&
        row.position !== 'abstain' && row.position !== 'absent' &&
        row.position !== 'other'
      ) {
        return `invalid position: ${row.position}`;
      }
      if (
        row.chamber !== 'upper' && row.chamber !== 'lower' &&
        row.chamber !== 'joint'
      ) {
        return `invalid chamber: ${row.chamber}`;
      }
      if (!Number.isInteger(row.session_year) || row.session_year < 1900) {
        return `invalid session_year: ${row.session_year}`;
      }
      if (row.vote_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(row.vote_date)) {
        return `invalid vote_date (want YYYY-MM-DD): ${row.vote_date}`;
      }
      return options.validateRow ? options.validateRow(row) : null;
    },

    async insert(
      rows: StateLegVoteRow[],
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

      // Resolve each row — single round-trip per row. state legislatures
      // emit tens to low-thousands of vote rows per session, not enough to
      // justify batched resolution.
      const resolvedRows: StateLegVoteRow[] = [];
      for (const row of rows) {
        try {
          const resolved = await resolveLegislator(ctx.pg, {
            state_fips: options.stateFips,
            chamber: row.chamber,
            district: row.legislator_district,
            name: row.legislator_name,
          });
          resolvedRows.push({
            ...row,
            resolved_person_id: resolved?.person_id ?? null,
            resolved_ocd_id: resolved?.ocd_id ?? null,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(`${adapter.name}: resolve failed`, {
            error: msg,
            row: { name: row.legislator_name, bill: row.bill_identifier },
          });
          // Keep the row — we still want to store it without a person_id.
          resolvedRows.push({
            ...row,
            resolved_person_id: null,
            resolved_ocd_id: null,
          });
        }
      }

      // Build state_legislator_votes payload.
      const payload = resolvedRows.map((r) => ({
        state: options.stateAbbrev,
        chamber: r.chamber,
        session_year: r.session_year,
        legislator_name: r.legislator_name,
        legislator_ocd_id: r.resolved_ocd_id ?? null,
        bill_identifier: r.bill_identifier,
        bill_title: r.bill_title ?? null,
        vote_date: r.vote_date,
        position: r.position,
        source: 'direct_scrape' as const,
        source_url: r.source_url,
        confidence_score: r.resolved_person_id ? 0.95 : 0.7,
        extraction_audit_id: null,
        ingested_at: new Date().toISOString(),
      }));

      const BATCH = 500;
      for (let i = 0; i < payload.length; i += BATCH) {
        const chunk = payload.slice(i, i + BATCH);
        const { data, error } = await ctx.supabase
          .from('state_legislator_votes')
          .upsert(chunk, {
            // Matches UNIQUE (state, chamber, session_year, bill_identifier, legislator_name)
            onConflict:
              'state,chamber,session_year,bill_identifier,legislator_name',
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

      // Log unresolved-legislator notes to ingestion_errors (non-fatal).
      const unresolved = resolvedRows.filter((r) => !r.resolved_person_id);
      if (unresolved.length > 0) {
        ctx.logger.info(`${adapter.name}: unresolved legislators`, {
          count: unresolved.length,
          sample: unresolved.slice(0, 3).map((r) => r.legislator_name),
        });
        const errorRows = unresolved.slice(0, 50).map((r) => ({
          ingestion_run_id: refs.ingestionRunId,
          error_type: 'validation' as const,
          error_message: `legislator "${r.legislator_name}" not resolved (state=${options.stateAbbrev} chamber=${r.chamber} district=${r.legislator_district ?? '-'})`.slice(0, 2000),
          raw_input: r as unknown,
        }));
        const { error: ieErr } = await ctx.supabase
          .from('ingestion_errors')
          .insert(errorRows);
        if (ieErr) {
          ctx.logger.warn(`${adapter.name}: ingestion_errors insert failed`, {
            error: ieErr.message,
          });
        }
      }

      return stats;
    },
  };

  adapter.costService = 'other';
  return adapter;
}

// ---------------------------------------------------------------------------
// Helpers — reusable parsing primitives for state adapters
// ---------------------------------------------------------------------------

/**
 * Normalize a raw vote-position string into our vocabulary.
 * Handles the long list of variations every state uses:
 *   yea, yes, y, aye, for, passed          -> 'yea'
 *   nay, no, n, against, opposed           -> 'nay'
 *   abstain, pass, present (not voting)    -> 'abstain'
 *   absent, excused, not voting            -> 'absent'
 *   anything else                          -> 'other'
 */
export function normalizePosition(raw: string | null | undefined): VotePosition {
  if (!raw) return 'other';
  const t = raw.trim().toLowerCase();
  if (!t) return 'other';
  if (/^(yea|yes|y|aye|aa|for|pass(ed)?)$/i.test(t)) return 'yea';
  if (/^(nay|no|n|against|opposed)$/i.test(t)) return 'nay';
  if (/^(abstain|present|present\s*not\s*voting|pnv|pass)$/i.test(t)) return 'abstain';
  if (/^(absent|excused|not\s*voting|nv|e)$/i.test(t)) return 'absent';
  // Long-form fallbacks.
  if (t.includes('yea') || t.includes('aye')) return 'yea';
  if (t.includes('nay')) return 'nay';
  if (t.includes('abstain') || t.includes('present')) return 'abstain';
  if (t.includes('absent') || t.includes('excused')) return 'absent';
  return 'other';
}

/** Normalize ISO / US date strings into YYYY-MM-DD or null. */
export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  // YYYY-MM-DD already.
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  // MM/DD/YYYY
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const [, m, d, y] = us;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // ISO datetime — take date part.
  const isoMatch = t.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoMatch) return isoMatch[1];
  // Fallback: try Date.parse and reformat.
  const d = new Date(t);
  if (!isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return null;
}

/** Chamber normalization: accepts 'H', 'House', 'senate', etc. */
export function normalizeChamber(raw: string | null | undefined): LegislativeChamber {
  if (!raw) return 'lower';
  const t = raw.trim().toLowerCase();
  if (/^(s|senate|upper)/.test(t)) return 'upper';
  if (/^(h|house|assembly|lower|representative)/.test(t)) return 'lower';
  if (/joint/.test(t)) return 'joint';
  return 'lower';
}

// Re-exports for adapter authors who want one import path.
export type { Pool } from 'pg';
