/**
 * Shared insert helpers for per-state candidacy adapters.
 *
 * Most adapters share the same shape:
 *   1. resolveOfficeElection(state_fips, office_name, district_identifier)
 *   2. findOrCreatePerson(state_fips-scoped)
 *   3. INSERT ... candidacies ... ON CONFLICT (election_id, person_id) DO UPDATE
 *   4. resolvePartyId() and INSERT ... candidacy_party_lines ON CONFLICT
 *
 * The OH and IN adapters were written before this helper existed — they
 * still own their own insert path because each one carries state-specific
 * meta fields (IN tracks date_filed; OH tracks reported_office). New
 * adapters that don't have such state-specific meta should call
 * insertGenericCandidacies() instead of duplicating the loop.
 *
 * The "walled" adapters (MI, MN, MT, NV) currently always pass rows=[],
 * but still wire up insertGenericCandidacies() so the full pipeline lights
 * up if the source later publishes a plain machine-readable file.
 */

import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
} from './candidate-resolver';
import { resolvePartyId } from './party-resolver';
import type {
  AdapterContext,
  InsertRefs,
  InsertStats,
} from '../types';

/** Minimal row shape every adapter passes into the shared insert. */
export type GenericCandidacyRow = {
  reported_name: string;
  /** Free-form office name fed into resolveOfficeElection(). */
  office_name: string;
  district_identifier: string | null;
  /** Free-form party string ('Democratic'/'Republican'/'D'/'R'/'NPP'/...). */
  party_raw: string | null;
  /** Stable per-row id for provenance. */
  source_row_id: string;
};

export type GenericInsertOptions = {
  /** Two-character state FIPS, e.g. '32' for Nevada. */
  stateFips: string;
  /** Election year used by office/election resolution + people scoring. */
  electionYear: number;
  /** Tag stored on people.meta + candidacies.meta + ingestion_errors. */
  source: string;
  /** Treat row.party_raw as nonpartisan? Override per-row when needed. */
  isNonpartisan?: (row: GenericCandidacyRow) => boolean;
};

/**
 * Insert one batch of generic candidacy rows. Idempotent — re-running
 * updates meta but does not duplicate. Returns aggregated stats.
 */
export async function insertGenericCandidacies(
  rows: GenericCandidacyRow[],
  refs: InsertRefs,
  ctx: AdapterContext,
  options: GenericInsertOptions,
): Promise<InsertStats> {
  const stats: InsertStats = {
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    errors: [],
  };

  if (rows.length === 0) return stats;

  const officeCache = new Map<string, { office_id: string; election_id: string } | null>();

  for (const row of rows) {
    try {
      const cacheKey = `${row.office_name}|${row.district_identifier ?? ''}`;
      let resolved = officeCache.get(cacheKey);
      if (resolved === undefined) {
        resolved = await resolveOfficeElection(ctx.pg, {
          state_fips: options.stateFips,
          office_name: row.office_name,
          district_identifier: row.district_identifier,
          election_year: options.electionYear,
        });
        officeCache.set(cacheKey, resolved);
      }

      if (!resolved) {
        stats.rowsSkipped += 1;
        await logIngestionError(
          ctx,
          refs.ingestionRunId,
          'validation',
          `${options.source}: office not resolved (state=${options.stateFips} office="${row.office_name}" district=${row.district_identifier ?? '-'})`,
          row,
        );
        continue;
      }

      if (ctx.dryRun) {
        stats.rowsInserted += 1;
        continue;
      }

      const personId = await findOrCreateStatePerson(ctx.pg, {
        name: row.reported_name,
        state_fips: options.stateFips,
        electionYear: options.electionYear,
        source: options.source,
        dataSourceId: refs.dataSourceId,
      });

      const candidacyRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
        `INSERT INTO candidacies
           (election_id, person_id, party, status, meta)
         VALUES ($1, $2, $3, 'active', $4::jsonb)
         ON CONFLICT (election_id, person_id) DO UPDATE
           SET party = COALESCE(EXCLUDED.party, candidacies.party),
               meta = candidacies.meta || EXCLUDED.meta
         RETURNING id, (xmax = 0) AS inserted`,
        [
          resolved.election_id,
          personId,
          row.party_raw,
          JSON.stringify({
            source: options.source,
            reported_office: row.office_name,
            reported_district: row.district_identifier,
            data_source_id: refs.dataSourceId,
            ingestion_run_id: refs.ingestionRunId,
            source_row_id: row.source_row_id,
          }),
        ],
      );

      const candidacyId = candidacyRes.rows[0]?.id;
      const wasInserted = candidacyRes.rows[0]?.inserted === true;
      if (!candidacyId) {
        stats.rowsFailed += 1;
        stats.errors.push({
          type: 'other',
          message: `${options.source}: candidacy upsert returned no id`,
          rawInput: row,
        });
        continue;
      }
      if (wasInserted) stats.rowsInserted += 1;
      else stats.rowsUpdated += 1;

      const treatNonpartisan = options.isNonpartisan
        ? options.isNonpartisan(row)
        : false;

      if (row.party_raw && !treatNonpartisan) {
        const partyId = await resolvePartyId(
          ctx.pg,
          row.party_raw,
          options.stateFips,
        );
        if (partyId) {
          await ctx.pg.query(
            `INSERT INTO candidacy_party_lines
               (candidacy_id, party_id, ballot_line_order,
                nomination_method, data_source_id, meta)
             VALUES ($1, $2, 1, 'primary', $3, $4::jsonb)
             ON CONFLICT (candidacy_id, party_id) DO NOTHING`,
            [
              candidacyId,
              partyId,
              refs.dataSourceId,
              JSON.stringify({
                source: options.source,
                reported_party: row.party_raw,
              }),
            ],
          );
        } else {
          await logIngestionError(
            ctx,
            refs.ingestionRunId,
            'validation',
            `${options.source}: party not resolved "${row.party_raw}" for ${row.reported_name}`,
            { ...row, candidacy_id: candidacyId },
          );
        }
      }
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({
        type: 'other',
        message: `${options.source}: row insert: ${msg}`,
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
    ctx.logger.warn('candidacies-shared: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
