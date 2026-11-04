/**
 * Arizona Secretary of State — candidate filings adapter (FIPS 04).
 *
 * Source-hunt status (2026-04-25)
 * --------------------------------
 * Every URL on https://azsos.gov returns HTTP 403 with the Cloudflare
 * "Just a moment..." JS challenge body — even the root and known-good
 * subpages like /elections/2026 fail through tier-1 politeFetch:
 *   /                                                       → 403 cf-chl
 *   /elections/2026                                         → 403 cf-chl
 *   /elections/election-information/candidates-running-office → 403 cf-chl
 *
 * Arizona's filing-list landing page (when fetched manually) is:
 *   https://azsos.gov/elections/election-information/candidates-running-office
 * which links to per-election candidate PDFs and a CSV export. Neither
 * the landing page nor the data files are reachable from this environment
 * without solving the CF challenge.
 *
 * Behavior: plain politeFetch. When the response is a CF challenge, this
 * adapter records a CF-walled run and returns []. parserSignal='no_table'
 * so runner classifies as 'unproductive' rather than 'success' with 0.
 *
 * AZ 2026 primary: August 4. Filing window opened January 2026; filing
 * deadline April 6, 2026 for partisan candidates per A.R.S. §16-311.
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
import { isCloudflareChallenge } from '../oh/candidacies';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

const STATE_FIPS = '04';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-08-04';

const DEFAULT_SOURCE_URL =
  'https://azsos.gov/elections/election-information/candidates-running-office';

export type AzCandidacyRow = {
  reported_name: string;
  party_abbreviation: string | null;
  office_name: string;
  district_identifier: string | null;
  is_write_in: boolean;
  source_row_id: string;
};

export type CreateAzCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => AzCandidacyRow[];
};

export function createAzCandidaciesAdapter(
  options: CreateAzCandidaciesAdapterOptions = {},
): SourceAdapter<AzCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<AzCandidacyRow> = {
    name: 'sos-arizona-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<AzCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('az-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      const fetchImpl = options.fetchOverride ?? fetchAzCandidatesPage;
      let status = 0;
      let rawBody = '';
      try {
        const r = await fetchImpl(sourceUrl);
        status = r.status;
        rawBody = r.body;
      } catch (err) {
        throw new Error(
          `az-candidacies: fetch threw for ${sourceUrl}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      ctx.logger.info('az-candidacies: fetched', {
        http_status: status,
        bytes: rawBody.length,
        contentHash: contentHash.slice(0, 12),
      });

      const cfWalled = isCloudflareChallenge(status, rawBody);
      const parser = options.parseOverride ?? parseArizonaCandidates;
      const rows = cfWalled || status >= 400 ? [] : parser(rawBody);

      return {
        rows,
        expectedMinRows: 0,
        parserSignal: rows.length > 0 ? 'ok' : 'no_table',
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'arizona-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: status,
            byte_size: rawBody.length,
            cloudflare_walled: cfWalled,
            adapter_status: 'dormant',
            blocker: cfWalled
              ? 'cloudflare_challenge'
              : 'parser_not_yet_implemented',
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) return 'missing reported_name';
      if (!row.office_name || !row.office_name.trim()) return 'missing office_name';
      return null;
    },

    async insert(
      rows: AzCandidacyRow[],
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

      for (const row of rows) {
        try {
          const officeInfo = await resolveOfficeElection(ctx.pg, {
            state_fips: STATE_FIPS,
            office_name: row.office_name,
            district_identifier: row.district_identifier,
            election_year: ELECTION_YEAR,
          });
          if (!officeInfo) {
            stats.rowsSkipped += 1;
            continue;
          }
          const personId = await findOrCreateStatePerson(ctx.pg, {
            name: row.reported_name,
            state_fips: STATE_FIPS,
            electionYear: ELECTION_YEAR,
            source: 'az-sos-candidacies',
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
                source: 'az-sos-candidacies',
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
                [candidacyId, partyId, refs.dataSourceId, JSON.stringify({ source: 'az-sos-candidacies' })],
              );
            }
          }
        } catch (err) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: err instanceof Error ? err.message : String(err),
            rawInput: row,
          });
        }
      }
      return stats;
    },
  };

  return adapter;
}

/**
 * Plain politeFetch. A Cloudflare challenge response is returned to the
 * caller as-is; the adapter then records rows=[] with
 * cloudflare_walled=true in the run meta.
 */
export async function fetchAzCandidatesPage(
  url: string,
): Promise<{ status: number; body: string }> {
  const res = await politeFetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  return { status: res.status, body: await res.text() };
}

/**
 * Parser stub — returns []. Cloudflare-walled; awaiting a permitted data
 * path. When available, the AZ filings page renders an HTML table per office with name + party +
 * district + filed date columns; existing html-table.ts utilities can
 * extract them.
 */
export function parseArizonaCandidates(_rawBody: string): AzCandidacyRow[] {
  return [];
}
