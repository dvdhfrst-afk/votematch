/**
 * Alabama Secretary of State — candidate filings adapter (FIPS 01).
 *
 * Source-hunt status (2026-04-25)
 * --------------------------------
 * Alabama does NOT publish a consolidated 2026 candidate-filing list at any
 * stable URL on www.sos.alabama.gov. Probes against the obvious endpoints:
 *   /alabama-votes/candidates                       → HTTP 404
 *   /alabama-votes/candidate-list                   → HTTP 404
 *   /alabama-votes/candidates-2026-elections        → HTTP 404
 *   /alabama-votes/voter                            → HTTP 404
 * The only working path on the SoS site is the ENR (election-night
 * results) page at /alabama-votes/voter/enr-current-list — this is for
 * results, not filings.
 *
 * Alabama's 2026 primary is May 19, 2026; the major-party qualifying
 * deadline was 2026-01-26 (per Title 17, Code of Alabama). Both the
 * Alabama Democratic Party (https://aldemocrats.org) and the Alabama
 * Republican Party (https://algop.org) maintain their own candidate lists
 * — Alabama is one of the handful of states where the parties (not the
 * SoS) hold qualifying paperwork for primary candidates and forward only
 * certified ballot lists to the SoS. The SoS therefore has nothing
 * structured to publish until the certified lists arrive, typically
 * ~30 days before primary day.
 *
 * Until those certified lists land we leave this adapter as a working
 * shape that returns 0 rows and signals 'no_table' so the runner records
 * the fetch as 'unproductive' (not 'success' with 0 rows). Adapter Doctor
 * + the dormant-adapter watcher will probe periodically; when AL begins
 * publishing structured filings (or we wire the party-site scrapers) the
 * parser slots in here. Until then this entry exists in the dispatcher
 * registry so the daily continuous-ingest loop knows to keep trying.
 *
 * Marked dormant — see scripts/mark-dormant-adapters.ts.
 */

import { createHash } from 'node:crypto';
import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

const STATE_FIPS = '01';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-05-19';

/**
 * Landing page that always returns 200 (used for provenance only).
 * Replace with a real candidate-filing endpoint when one becomes available.
 */
const DEFAULT_SOURCE_URL = 'https://www.sos.alabama.gov/';

export type AlCandidacyRow = {
  reported_name: string;
  party_abbreviation: string | null;
  office_name: string;
  district_identifier: string | null;
  is_write_in: boolean;
  source_row_id: string;
};

export type CreateAlCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => AlCandidacyRow[];
};

export function createAlCandidaciesAdapter(
  options: CreateAlCandidaciesAdapterOptions = {},
): SourceAdapter<AlCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<AlCandidacyRow> = {
    name: 'sos-alabama-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<AlCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('al-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      // Plain politeFetch. A blocked response (403/429) is returned as-is
      // and the run records 0 rows.
      const fetchImpl =
        options.fetchOverride ??
        (async (url: string) => {
          const res = await politeFetch(url, {
            headers: { Accept: 'text/html,*/*' },
          });
          return { status: res.status, body: await res.text() };
        });

      let status = 0;
      let rawBody = '';
      try {
        const r = await fetchImpl(sourceUrl);
        status = r.status;
        rawBody = r.body;
      } catch (err) {
        // Network throw — runner records 'failed'.
        throw new Error(
          `al-candidacies: fetch threw for ${sourceUrl}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      ctx.logger.info('al-candidacies: fetched', {
        http_status: status,
        bytes: rawBody.length,
        contentHash: contentHash.slice(0, 12),
      });

      // Parser today returns []. parserSignal='no_table' so the runner
      // records 'unproductive' rather than a misleading 'success' with 0.
      const parser = options.parseOverride ?? parseAlabamaCandidates;
      const rows = parser(rawBody);

      return {
        rows,
        expectedMinRows: 0, // dormant — no structured source yet
        parserSignal: rows.length > 0 ? 'ok' : 'no_table',
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'alabama-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: status,
            byte_size: rawBody.length,
            adapter_status: 'dormant',
            blocker: 'no_consolidated_candidate_list_published_by_sos',
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) {
        return 'missing reported_name';
      }
      if (!row.office_name || !row.office_name.trim()) {
        return 'missing office_name';
      }
      return null;
    },

    async insert(
      rows: AlCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertAlCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

/**
 * Parse Alabama candidate filings from the SoS HTML.
 *
 * Today: returns []. The SoS does not publish a structured filings page;
 * the major parties hold this data and forward certified ballot lists
 * close to election day. See file header for the long-form rationale.
 *
 * When/if a real source is identified, slot a parser implementation
 * here. Tests can drive synthetic HTML through the parseOverride hook.
 */
export function parseAlabamaCandidates(_rawBody: string): AlCandidacyRow[] {
  return [];
}

/**
 * Generic per-state insert helper. Mirrors OH's implementation: resolve
 * office → election → person, upsert candidacy, upsert party line.
 *
 * Kept intact so the moment the parser starts producing rows, persistence
 * works end-to-end with no further code changes.
 */
export async function insertAlCandidacies(
  rows: AlCandidacyRow[],
  refs: InsertRefs,
  ctx: AdapterContext,
  electionYear: number,
): Promise<InsertStats> {
  const stats: InsertStats = {
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    errors: [],
  };
  if (rows.length === 0) return stats;

  for (const row of rows) {
    try {
      const officeInfo = await resolveOfficeElection(ctx.pg, {
        state_fips: STATE_FIPS,
        office_name: row.office_name,
        district_identifier: row.district_identifier,
        election_year: electionYear,
      });
      if (!officeInfo) {
        stats.rowsSkipped += 1;
        await logIngestionError(
          ctx,
          refs.ingestionRunId,
          'validation',
          `office not resolved: state=${STATE_FIPS} office="${row.office_name}" district=${row.district_identifier ?? '-'}`,
          row,
        );
        continue;
      }

      const personId = await findOrCreateStatePerson(ctx.pg, {
        name: row.reported_name,
        state_fips: STATE_FIPS,
        electionYear,
        source: 'al-sos-candidacies',
        dataSourceId: refs.dataSourceId,
      });

      const candidacyRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
        `INSERT INTO candidacies
           (election_id, person_id, party, status, meta)
         VALUES ($1, $2, $3, 'active', $4::jsonb)
         ON CONFLICT (election_id, person_id) DO UPDATE
           SET meta = candidacies.meta
         RETURNING id, (xmax = 0) AS inserted`,
        [
          officeInfo.election_id,
          personId,
          row.party_abbreviation,
          JSON.stringify({
            source: 'al-sos-candidacies',
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
          message: 'candidacy upsert returned no id',
          rawInput: row,
        });
        continue;
      }
      if (wasInserted) stats.rowsInserted += 1;
      else stats.rowsUpdated += 1;

      if (row.party_abbreviation) {
        const partyId = await resolvePartyId(
          ctx.pg,
          row.party_abbreviation,
          STATE_FIPS,
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
                source: 'al-sos-candidacies',
                reported_party: row.party_abbreviation,
              }),
            ],
          );
        } else {
          await logIngestionError(
            ctx,
            refs.ingestionRunId,
            'validation',
            `party not resolved: "${row.party_abbreviation}"`,
            { ...row, candidacy_id: candidacyId },
          );
        }
      }
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({
        type: 'other',
        message: `row: ${msg}`,
        rawInput: row,
      });
      ctx.logger.warn('al-candidacies: row insert failed', {
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
    ctx.logger.warn('al-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
