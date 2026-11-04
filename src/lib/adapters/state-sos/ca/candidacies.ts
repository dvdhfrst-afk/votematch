/**
 * California Secretary of State — candidate filings adapter (FIPS 06).
 *
 * Source-hunt status (2026-04-25)
 * --------------------------------
 * California is unusual: county elections officials handle the bulk of
 * candidate filings (state assembly, state senate, county offices, local
 * offices); the SoS publishes a Certified List of Candidates only AFTER
 * the filing deadline closes ~88 days before the election (per Cal. Elec.
 * Code §13105). For the 2026 cycle:
 *   - Statewide direct primary: June 2, 2026
 *   - Filing deadline (incumbents): March 6, 2026
 *   - Filing deadline (non-incumbents): March 11, 2026
 *   - SoS Certified List: published ~March 26, 2026 as a PDF
 *
 * Probe results (today):
 *   https://www.sos.ca.gov/elections                 → 200 OK (root index)
 *   https://www.sos.ca.gov/elections/candidates      → 404
 *   https://www.sos.ca.gov/elections/upcoming-elections/2026
 *                                                    → 404 (page not yet
 *                                                      published)
 *   https://cal-access.sos.ca.gov/Campaign/Candidates/
 *                                                    → 200 (3-iframe shell)
 *
 * Cal-Access also publishes a nightly bulk export at:
 *   https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip   (1.5 GB)
 * which contains FULL relational dumps of every CA campaign-finance
 * disclosure (FILER_FILINGS, CAND_CAND_TBL, etc.). Cal-Access is the
 * authoritative ID source but uses code-numbered filer IDs — joining
 * to office/election requires CAL-ACCESS code-to-office crosswalks
 * we haven't built yet, AND the dump is a 1.5GB single-shot that
 * dwarfs the rest of our polling infrastructure.
 *
 * Phase-1 plan (pending Certified List PDF):
 *   - Continuous-ingest probe: GET /elections looking for the certified-
 *     list link to publish.
 *   - Once published, follow the link, extract via pdf-parse, map to
 *     candidacies.
 *
 * Phase-2 plan (Cal-Access bulk):
 *   - Separate adapter that downloads dbwebexport.zip weekly, parses
 *     CAND_CAND_TBL + FILER_TYPES + FILER_FILINGS, and reconciles to
 *     SoS-certified offices via FIPS+ballot-designation crosswalk.
 *
 * Today this adapter returns [] with parserSignal='no_table' and records
 * the certified-list PDF URL in meta (null until found).
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

const STATE_FIPS = '06';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-06-02';

const DEFAULT_SOURCE_URL = 'https://www.sos.ca.gov/elections';

export type CaCandidacyRow = {
  reported_name: string;
  party_abbreviation: string | null;
  office_name: string;
  district_identifier: string | null;
  is_write_in: boolean;
  source_row_id: string;
};

export type CreateCaCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => CaCandidacyRow[];
};

export function createCaCandidaciesAdapter(
  options: CreateCaCandidaciesAdapterOptions = {},
): SourceAdapter<CaCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<CaCandidacyRow> = {
    name: 'sos-california-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<CaCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('ca-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      const fetchImpl =
        options.fetchOverride ??
        (async (url: string) => {
          const res = await politeFetch(url, {
            headers: { Accept: 'text/html,*/*' },
          });
          return { status: res.status, body: await res.text() };
        });

      const { status, body: rawBody } = await fetchImpl(sourceUrl);
      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      ctx.logger.info('ca-candidacies: fetched', {
        http_status: status,
        bytes: rawBody.length,
        contentHash: contentHash.slice(0, 12),
      });

      const parser = options.parseOverride ?? parseCaliforniaCandidates;
      const rows = status >= 200 && status < 400 ? parser(rawBody) : [];
      const certifiedListUrl = status >= 200 && status < 400
        ? extractCertifiedListLink(rawBody)
        : null;

      return {
        rows,
        expectedMinRows: 0,
        parserSignal: rows.length > 0 ? 'ok' : 'no_table',
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'california-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: status,
            byte_size: rawBody.length,
            certified_list_url: certifiedListUrl,
            adapter_status: 'dormant',
            blocker: 'awaiting_sos_certified_candidate_list_publication',
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
      rows: CaCandidacyRow[],
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
            source: 'ca-sos-candidacies',
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
                source: 'ca-sos-candidacies',
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
                [candidacyId, partyId, refs.dataSourceId, JSON.stringify({ source: 'ca-sos-candidacies' })],
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
 * Find the SoS Certified List of Candidates link in the /elections
 * index HTML. CA naming convention: "Certified List of Candidates" PDF
 * with a date. Returns first match or null. Exported for tests.
 */
export function extractCertifiedListLink(html: string): string | null {
  if (!html) return null;
  // Loose match — any anchor whose visible text contains
  // "certified list of candidates" or "candidate list" + .pdf href.
  const re =
    /<a[^>]+href="([^"]+\.pdf)"[^>]*>([^<]*?(certified[^<]*candidate[^<]*|candidate[^<]*list[^<]*))<\/a>/gi;
  const m = re.exec(html);
  if (!m) return null;
  let href = m[1];
  if (href.startsWith('//')) href = 'https:' + href;
  if (href.startsWith('/')) href = 'https://www.sos.ca.gov' + href;
  return href;
}

/**
 * Parser stub — returns []. Phase-1 work: fetch the certified-list PDF
 * via extractCertifiedListLink(), pdf-parse, and pattern-match
 * "Contest | Candidate | Party | County" rows. Phase-2 work: switch to
 * Cal-Access bulk dump for richer cross-cycle history.
 */
export function parseCaliforniaCandidates(_rawBody: string): CaCandidacyRow[] {
  return [];
}
