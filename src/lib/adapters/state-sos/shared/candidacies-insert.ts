/**
 * Shared insert helper for per-state candidate-filing adapters.
 *
 * Every state-candidacies adapter ends up doing the same six DB writes:
 *
 *   1. Resolve the office_id (shared resolveOfficeElection or a state-
 *      specific slug-direct lookup the caller provides).
 *   2. find-or-create the elections row for the (office_id, election_date,
 *      election_type) tuple.
 *   3. find-or-create the people row, state-disambiguated via
 *      findOrCreatePerson (council 2026-04-25 finding DE#3).
 *   4. Upsert the candidacies row keyed on (election_id, person_id).
 *   5. Resolve the party string to parties.id and upsert
 *      candidacy_party_lines on (candidacy_id, party_id).
 *   6. Log unresolved offices / parties to ingestion_errors with
 *      error_type='validation' so the dispatcher can surface them but
 *      the run keeps moving.
 *
 * Pulling that out into a single helper means each new state adapter can
 * focus exclusively on its source-specific parse + office-name → office_id
 * logic. The helper is intentionally schema-aligned with the IN and OH
 * adapters: same idempotency keys, same meta provenance, same dry-run
 * semantics (returns InsertStats with rowsInserted incremented but skips
 * Supabase-side audit writes).
 *
 * The helper is NOT plugged into the base.ts factory because that factory
 * targets election_results. Per-state adapters that ingest candidacies
 * call this from their own SourceAdapter.insert() instead.
 */

import type { Pool } from 'pg';
import type {
  AdapterContext,
  InsertRefs,
  InsertStats,
} from '../../types';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import { resolveLocalOffice } from '../local-office-resolver';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Source-agnostic shape for a single filed candidacy. State adapters
 * normalize their parser output to this shape and hand the array to
 * insertCandidacies().
 */
export type CandidacyInsertRow = {
  /** As published by the SoS — written verbatim into people.canonical_name. */
  reported_name: string;
  /** Free-form office string used by resolveOfficeElection's substring matcher. */
  office_name: string;
  /** Bare integer (not "District 7") if known, else null. */
  district_identifier: string | null;
  /** Raw party string ('Democratic', 'REP', 'NPA', ...). null = nonpartisan. */
  party_raw: string | null;
  /** ISO yyyy-mm-dd if parseable from source, else null. */
  date_filed: string | null;
  /** Election date for this filing. ISO yyyy-mm-dd. */
  election_date: string;
  /**
   * elections.election_type. Matches the elections_election_type_check
   * CHECK constraint defined in migration 20260423000001 (expanded 2026-04-23
   * to add jungle_primary / top_two_primary / top_four_primary / convention).
   */
  election_type:
    | 'general'
    | 'primary'
    | 'primary_runoff'
    | 'special_general'
    | 'special_primary'
    | 'runoff'
    | 'retention'
    | 'recall'
    | 'nonpartisan_general'
    | 'jungle_primary'
    | 'top_two_primary'
    | 'top_four_primary'
    | 'convention';
  /** Stable per-row id for provenance / dedup logging. */
  source_row_id: string;
  /**
   * Optional locality / jurisdiction hint emitted by the source as a
   * separate column (e.g. VA's "Locality" column = "ROANOKE CITY"). When
   * supplied, the local-office resolver tries this first to pick the right
   * jurisdiction before falling back to extracting candidates from
   * `office_name`. Keep it raw — the resolver normalizes case and suffixes.
   */
  locality_hint?: string | null;
};

/** Optional pre-resolution callback — lets state adapters short-circuit
 *  with their own slug-direct office lookup before falling back to the
 *  shared free-form resolver. Returns office_id or null. */
export type ResolveOfficeFn = (
  pg: Pool,
  row: CandidacyInsertRow,
) => Promise<string | null>;

export type InsertCandidaciesOptions = {
  /** Two-character state FIPS, e.g. '11' for DC, '12' for FL. */
  stateFips: string;
  /** Source tag stored on candidacies.meta.source / people.meta.source. */
  source: string;
  /** Election year used for findOrCreatePerson tie-breaks. */
  electionYear: number;
  /** Optional faster path for office resolution. */
  resolveOffice?: ResolveOfficeFn;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Idempotent multi-row writer for a state's candidacy filings.
 *
 * Each input row is processed independently — a single failure logs to
 * ingestion_errors and increments rowsFailed without aborting the run.
 * Office cache survives the call so 12 candidates for the same district
 * resolve once.
 *
 * Honors `ctx.dryRun`: increments rowsInserted but bypasses people /
 * candidacies / party-line writes so the caller's outer transaction is
 * still rolled back cleanly by the runner.
 */
export async function insertCandidacies(
  rows: CandidacyInsertRow[],
  refs: InsertRefs,
  ctx: AdapterContext,
  options: InsertCandidaciesOptions,
): Promise<InsertStats> {
  const stats: InsertStats = {
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    errors: [],
  };
  if (rows.length === 0) return stats;

  const officeCache = new Map<string, string | null>();

  for (const row of rows) {
    const cacheKey = `${row.office_name}|${row.locality_hint ?? ''}|${row.district_identifier ?? ''}|${row.election_type}|${row.election_date}`;
    let officeId = officeCache.get(cacheKey) ?? null;

    if (!officeCache.has(cacheKey)) {
      // 1) State adapter's own resolver (fast path).
      if (options.resolveOffice) {
        try {
          officeId = await options.resolveOffice(ctx.pg, row);
        } catch {
          officeId = null;
        }
      }
      // 2) Shared free-form fallback (federal + state-leg path).
      if (!officeId) {
        const fb = await resolveOfficeElection(ctx.pg, {
          state_fips: options.stateFips,
          office_name: row.office_name,
          district_identifier: row.district_identifier,
          election_year: options.electionYear,
        });
        officeId = fb?.office_id ?? null;
      }
      // 3) Local-races fallback (school board / mayor / city council /
      //    county commissioner / sheriff / DA / ...). The free-form
      //    resolver above requires an existing election in the target year;
      //    local races usually don't have pre-seeded elections, and the
      //    name patterns are different enough that ILIKE-on-canonical_name
      //    misses them. resolveLocalOffice() classifies + extracts the
      //    jurisdiction explicitly. findOrCreateElection() below then
      //    creates the election row when this path resolves.
      if (!officeId) {
        const local = await resolveLocalOffice(ctx.pg, {
          state_fips: options.stateFips,
          office_name: row.office_name,
          district_identifier: row.district_identifier,
          locality_hint: row.locality_hint ?? null,
        });
        officeId = local?.office_id ?? null;
      }
      officeCache.set(cacheKey, officeId);
    }

    if (!officeId) {
      stats.rowsSkipped += 1;
      await logIngestionError(
        ctx,
        refs.ingestionRunId,
        'validation',
        `${options.source}: office not resolved: state=${options.stateFips} office="${row.office_name}" district=${row.district_identifier ?? '-'}`,
        row,
      );
      continue;
    }

    if (ctx.dryRun) {
      stats.rowsInserted += 1;
      continue;
    }

    try {
      const electionId = await findOrCreateElection(
        ctx,
        officeId,
        row.election_date,
        row.election_type,
        options.source,
        refs.dataSourceId,
      );
      const personId = await findOrCreateStatePerson(ctx.pg, {
        name: row.reported_name,
        state_fips: options.stateFips,
        electionYear: options.electionYear,
        source: options.source,
        dataSourceId: refs.dataSourceId,
      });
      const { candidacyId, created } = await upsertCandidacy(
        ctx,
        electionId,
        personId,
        row.party_raw,
        row.date_filed,
        options.source,
        refs.dataSourceId,
      );

      if (row.party_raw) {
        const partyId = await resolvePartyId(
          ctx.pg,
          row.party_raw,
          options.stateFips,
        );
        if (partyId) {
          await upsertPartyLine(
            ctx,
            candidacyId,
            partyId,
            row.election_type,
            row.date_filed,
            options.source,
            refs.dataSourceId,
          );
        } else {
          await logIngestionError(
            ctx,
            refs.ingestionRunId,
            'validation',
            `${options.source}: party not resolved: "${row.party_raw}" for ${row.reported_name}`,
            row,
          );
        }
      }

      if (created) stats.rowsInserted += 1;
      else stats.rowsUpdated += 1;
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({
        type: 'other',
        message: `${options.source} insert: ${msg}`,
        rawInput: row,
      });
      ctx.logger.warn(`${options.source}: row insert failed`, {
        error: msg,
        row: { name: row.reported_name, office: row.office_name },
      });
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// DB helpers — kept private to this module; per-state adapters compose
// insertCandidacies() rather than re-implementing this logic.
// ---------------------------------------------------------------------------

async function findOrCreateElection(
  ctx: AdapterContext,
  officeId: string,
  electionDate: string,
  electionType: CandidacyInsertRow['election_type'],
  source: string,
  dataSourceId: string | undefined,
): Promise<string> {
  const sel = await ctx.pg.query<{ id: string }>(
    `SELECT id FROM elections
       WHERE office_id = $1 AND election_date = $2::date AND election_type = $3
       LIMIT 1`,
    [officeId, electionDate, electionType],
  );
  if (sel.rows[0]) return sel.rows[0].id;

  const ins = await ctx.pg.query<{ id: string }>(
    `INSERT INTO elections (office_id, election_date, election_type, meta)
     VALUES ($1, $2::date, $3, $4::jsonb)
     RETURNING id`,
    [
      officeId,
      electionDate,
      electionType,
      JSON.stringify({ source, data_source_id: dataSourceId ?? null }),
    ],
  );
  return ins.rows[0]!.id;
}

async function upsertCandidacy(
  ctx: AdapterContext,
  electionId: string,
  personId: string,
  partyRaw: string | null,
  dateFiled: string | null,
  source: string,
  dataSourceId: string | undefined,
): Promise<{ candidacyId: string; created: boolean }> {
  const sel = await ctx.pg.query<{ id: string }>(
    `SELECT id FROM candidacies
       WHERE election_id = $1 AND person_id = $2
       LIMIT 1`,
    [electionId, personId],
  );
  if (sel.rows[0]) {
    // BUG FIX 2026-05-22: never clobber a terminal status on re-ingest.
    // The previous policy reset status to 'active' on every adapter run
    // unless the row was already 'withdrew'/'disqualified' — which would
    // wipe out any won_primary/lost_primary written by the results→status
    // pipeline (lib/elections/update-statuses-from-results.ts). Preserve
    // all post-results statuses too.
    await ctx.pg.query(
      `UPDATE candidacies
          SET party = COALESCE($1, party),
              status = CASE
                WHEN status IN (
                  'withdrew','disqualified',
                  'won_primary','lost_primary','advanced_to_runoff',
                  'won_general','lost_general'
                ) THEN status
                ELSE 'active'
              END,
              filed_on = COALESCE(filed_on, $2::date)
        WHERE id = $3`,
      [partyRaw, dateFiled, sel.rows[0].id],
    );
    return { candidacyId: sel.rows[0].id, created: false };
  }
  const ins = await ctx.pg.query<{ id: string }>(
    `INSERT INTO candidacies
       (election_id, person_id, party, status, filed_on, meta)
     VALUES ($1, $2, $3, 'active', $4::date, $5::jsonb)
     RETURNING id`,
    [
      electionId,
      personId,
      partyRaw,
      dateFiled,
      JSON.stringify({ source, data_source_id: dataSourceId ?? null }),
    ],
  );
  return { candidacyId: ins.rows[0]!.id, created: true };
}

async function upsertPartyLine(
  ctx: AdapterContext,
  candidacyId: string,
  partyId: string,
  electionType: CandidacyInsertRow['election_type'],
  qualifiedOn: string | null,
  source: string,
  dataSourceId: string | undefined,
): Promise<void> {
  // candidacy_party_lines.nomination_method enum (per migration
  // 20260423000002_parties_and_fusion.sql). Most filing adapters map
  // primary-bound candidacies to 'primary' and general-bound (no primary
  // intervening) to 'petition' or 'self_nomination'. Without source-side
  // signal we conservatively use 'primary' for primary feeds and 'unknown'
  // for general/special feeds — adapter authors can override by post-
  // processing the row before calling insertCandidacies().
  const nominationMethod =
    electionType === 'primary' || electionType === 'special_primary' || electionType === 'top_two_primary' || electionType === 'top_four_primary' || electionType === 'jungle_primary'
      ? 'primary'
      : electionType === 'convention'
        ? 'convention'
        : electionType === 'nonpartisan_general'
          ? 'automatic_nonpartisan'
          : 'unknown';

  await ctx.pg.query(
    `INSERT INTO candidacy_party_lines
       (candidacy_id, party_id, ballot_line_order, nomination_method,
        qualified_on, data_source_id, meta)
     VALUES ($1, $2, 1, $3, $4::date, $5::uuid, $6::jsonb)
     ON CONFLICT (candidacy_id, party_id) DO UPDATE
       SET ballot_line_order = 1,
           nomination_method = EXCLUDED.nomination_method,
           qualified_on = COALESCE(candidacy_party_lines.qualified_on, EXCLUDED.qualified_on),
           data_source_id = COALESCE(EXCLUDED.data_source_id, candidacy_party_lines.data_source_id)`,
    [
      candidacyId,
      partyId,
      nominationMethod,
      qualifiedOn,
      dataSourceId ?? null,
      JSON.stringify({ source }),
    ],
  );
}

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
    ctx.logger.warn('shared candidacies insert: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
