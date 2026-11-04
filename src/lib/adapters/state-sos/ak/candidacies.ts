/**
 * Alaska Division of Elections — candidate filings adapter (FIPS 02).
 *
 * Source-hunt status (2026-04-25)
 * --------------------------------
 * politeFetch against https://www.elections.alaska.gov/* fails at the
 * TCP/DNS layer on the build machine ("fetch failed"). The Alaska
 * Division of Elections runs on a state-government CDN that intermittently
 * blocks non-allowlisted egress IPs and/or requires TLS-fingerprint
 * matching that node fetch doesn't expose. We've recorded the same
 * failure on multiple occasions; the canonical filings page lives at:
 *   https://www.elections.alaska.gov/Core/candidates.php
 * but is not reachable via tier-1 politeFetch from this environment.
 *
 * Alaska is also unique nationally:
 *   - Single open primary (top-4) replaced party-specific primaries in
 *     2022 — there is no "D primary" / "R primary"; all candidates
 *     appear on one ballot regardless of party.
 *   - Ranked-choice general (top 4 → RCV).
 *   - Statewide candidates AND state legislators all file with the
 *     Division of Elections; municipal candidates file with the
 *     municipality (Anchorage, Juneau, Fairbanks, Wasilla).
 *   - 2026 primary is August 19; filing deadline June 1.
 *
 * Until a permitted fetch path exists (for example a published bulk
 * export or an official mirror), this adapter leaves a
 * structurally-correct shell:
 *   - Returns [] with parserSignal='no_table' → run marked 'unproductive'
 *   - Adapter Doctor + dormant-adapter watcher continue probing
 *   - When a fetch path is available, swap fetchOverride and the parser
 *     slots in unchanged
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

const STATE_FIPS = '02';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-08-18'; // Alaska open-primary "Pick 1" of 4

const DEFAULT_SOURCE_URL =
  'https://www.elections.alaska.gov/Core/candidates.php';

export type AkCandidacyRow = {
  reported_name: string;
  /** AK reports party as "Republican / Democrat / Alaskan Independence /
   *  Nonpartisan / Undeclared" — pass through as-is, resolver handles it. */
  party_abbreviation: string | null;
  office_name: string;
  district_identifier: string | null;
  is_write_in: boolean;
  source_row_id: string;
};

export type CreateAkCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => AkCandidacyRow[];
};

export function createAkCandidaciesAdapter(
  options: CreateAkCandidaciesAdapterOptions = {},
): SourceAdapter<AkCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<AkCandidacyRow> = {
    name: 'sos-alaska-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<AkCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('ak-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      // Plain politeFetch. A blocked response (403/429) is returned as-is
      // and the run records 0 rows.
      const fetchImpl =
        options.fetchOverride ??
        (async (url: string) => {
          try {
            const res = await politeFetch(url, {
              headers: { Accept: 'text/html,*/*' },
            });
            return { status: res.status, body: await res.text() };
          } catch (err) {
            // Network-level failure (DNS / TCP) — record as a soft 0 with
            // status=0 so the runner classifies the run as 'unproductive'
            // rather than 'failed'. Alaska's CDN flakes; we don't want
            // every probe to page on-call.
            ctx.logger.warn('ak-candidacies: fetch failed at network layer', {
              error: err instanceof Error ? err.message : String(err),
              url,
            });
            return { status: 0, body: '' };
          }
        });

      const { status, body: rawBody } = await fetchImpl(sourceUrl);
      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      ctx.logger.info('ak-candidacies: fetched', {
        http_status: status,
        bytes: rawBody.length,
        contentHash: contentHash.slice(0, 12),
      });

      const parser = options.parseOverride ?? parseAlaskaCandidates;
      const rows = status >= 200 && status < 400 ? parser(rawBody) : [];

      return {
        rows,
        expectedMinRows: 0, // dormant
        parserSignal: rows.length > 0 ? 'ok' : 'no_table',
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'alaska-doe-candidacies',
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
            blocker: status === 0
              ? 'fetch_failed_network_layer'
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
      rows: AkCandidacyRow[],
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
            source: 'ak-doe-candidacies',
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
                source: 'ak-doe-candidacies',
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
                [
                  candidacyId,
                  partyId,
                  refs.dataSourceId,
                  JSON.stringify({
                    source: 'ak-doe-candidacies',
                    reported_party: row.party_abbreviation,
                  }),
                ],
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
 * Parser stub — returns []. See file header for blocker. When AK fetch
 * comes online, implement an HTML or CSV parser here that maps each
 * filed row to an AkCandidacyRow.
 */
export function parseAlaskaCandidates(_rawBody: string): AkCandidacyRow[] {
  return [];
}
