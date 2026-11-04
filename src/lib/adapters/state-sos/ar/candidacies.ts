/**
 * Arkansas Secretary of State — candidate filings adapter (FIPS 05).
 *
 * Source-hunt status (2026-04-25)
 * --------------------------------
 * The Arkansas SoS site at https://www.sos.arkansas.gov is reachable from
 * tier-1 politeFetch (200 OK). Probes against common candidate-list
 * paths returned 404:
 *   /elections/candidate-list                       → 404
 *   /elections/running-for-office                   → 404
 *   /elections/2026-elections                       → 404
 *
 * Arkansas does NOT publish its 2026 candidate filings as a single
 * structured page or CSV. Instead the SoS hosts a per-cycle PDF
 * roster of "Filed Candidates" linked from the main /elections page
 * (https://www.sos.arkansas.gov/elections, 200 OK). The PDF link
 * is updated as candidates file (rolling deadline through November 11,
 * 2025 for 2026 March 3 primary candidates) and is re-published as a
 * "Notice of Withdrawal" addendum after the deadline.
 *
 * Strategy:
 *   1. Fetch /elections page HTML.
 *   2. Scan anchors for href patterns like .../candidate-filing(s)*.pdf
 *      — the PDF URL changes per cycle but is the only authoritative
 *      filings list AR publishes.
 *   3. If found, fetch the PDF and (future) extract via pdf-parse.
 *   4. For now we capture the PDF URL into meta but do not parse —
 *      pdf-parse + pdf-text extraction lives in the Phase-2 plan, not
 *      yet wired here. parser returns [].
 *
 * AR 2026 primary: March 3, 2026 (preferential primary). Already past;
 * the May 19 runoff filing is open. The early March primary makes AR
 * one of the highest-priority adapters for full parser implementation
 * once tier-2 PDF extraction lands.
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
import { extractTextFromPdf, parsePdfTable } from '../shared/pdf-extract';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

const STATE_FIPS = '05';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-03-03';

const DEFAULT_SOURCE_URL = 'https://www.sos.arkansas.gov/elections';

export type ArCandidacyRow = {
  reported_name: string;
  party_abbreviation: string | null;
  office_name: string;
  district_identifier: string | null;
  is_write_in: boolean;
  source_row_id: string;
};

export type CreateArCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => ArCandidacyRow[];
};

export function createArCandidaciesAdapter(
  options: CreateArCandidaciesAdapterOptions = {},
): SourceAdapter<ArCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<ArCandidacyRow> = {
    name: 'sos-arkansas-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<ArCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('ar-candidacies: fetching', {
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
      ctx.logger.info('ar-candidacies: fetched', {
        http_status: status,
        bytes: rawBody.length,
        contentHash: contentHash.slice(0, 12),
      });

      const parser = options.parseOverride ?? parseArkansasCandidates;
      let rows = status >= 200 && status < 400 ? parser(rawBody) : [];
      const filingsPdfUrl = status >= 200 && status < 400
        ? extractFilingsPdfLink(rawBody)
        : null;

      // Production: fetch the discovered "Filed Candidates" PDF and run
      // the generic parsePdfTable extractor (columns: Office, Name, Party,
      // optional District). AR rotates the PDF URL each cycle, so we
      // gate the fetch on a successful discovery — when the SoS hasn't
      // yet published the 2026 list, this remains 0 rows with a
      // documented blocker, exactly per the file-header contract.
      let pdfBytes = 0;
      let pdfStatus: number | null = null;
      if (rows.length === 0 && filingsPdfUrl && !options.parseOverride) {
        try {
          const pdfRes = await politeFetch(filingsPdfUrl, {
            headers: { Accept: 'application/pdf,*/*' },
          });
          pdfStatus = pdfRes.status;
          if (pdfRes.ok) {
            const ab = await pdfRes.arrayBuffer();
            const bytes = new Uint8Array(ab);
            pdfBytes = bytes.byteLength;
            const { pages } = await extractTextFromPdf(bytes);
            const text = pages.join('\n\n');
            const tableRows = parsePdfTable(text, {
              columns: [
                { name: 'office_name', aliases: ['Office', 'Position', 'Contest'], required: true },
                { name: 'reported_name', aliases: ['Candidate', 'Name'], required: true },
                { name: 'party_abbreviation', aliases: ['Party', 'Affiliation'] },
                { name: 'district_identifier', aliases: ['District', 'Dist'] },
              ],
            });
            rows = tableRows.map((r, i) => ({
              reported_name: String(r.reported_name ?? ''),
              office_name: String(r.office_name ?? ''),
              district_identifier: r.district_identifier ? String(r.district_identifier) : null,
              party_abbreviation: r.party_abbreviation ? String(r.party_abbreviation) : null,
              is_write_in: false,
              source_row_id: `ar-pdf-${i + 1}`,
            }));
          }
        } catch (err) {
          ctx.logger.warn('ar-candidacies: PDF parse failed', {
            error: err instanceof Error ? err.message : String(err),
            url: filingsPdfUrl,
          });
        }
      }

      return {
        rows,
        expectedMinRows: 0,
        parserSignal: rows.length > 0 ? 'ok' : 'no_table',
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'arkansas-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: status,
            byte_size: rawBody.length,
            filings_pdf_url: filingsPdfUrl,
            filings_pdf_status: pdfStatus,
            filings_pdf_bytes: pdfBytes,
            adapter_status: rows.length > 0 ? 'productive' : 'dormant',
            blocker: rows.length > 0
              ? null
              : filingsPdfUrl
                ? 'pdf_table_layout_unmatched'
                : 'awaiting_2026_filed_candidates_pdf_link',
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
      rows: ArCandidacyRow[],
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
            source: 'ar-sos-candidacies',
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
                source: 'ar-sos-candidacies',
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
                [candidacyId, partyId, refs.dataSourceId, JSON.stringify({ source: 'ar-sos-candidacies' })],
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
 * Find the most-likely "filed candidates" PDF link in the AR /elections
 * landing-page HTML. AR rotates the PDF URL each cycle but always uses
 * a path containing "candidate" + ".pdf". Returns the first such link or
 * null. Exported for tests.
 */
export function extractFilingsPdfLink(html: string): string | null {
  if (!html) return null;
  const re = /href="([^"]+\.pdf)"[^>]*>([^<]*candidat[^<]*)</gi;
  const m = re.exec(html);
  if (!m) return null;
  let href = m[1];
  if (href.startsWith('//')) href = 'https:' + href;
  if (href.startsWith('/')) href = 'https://www.sos.arkansas.gov' + href;
  return href;
}

/**
 * Parser stub — returns []. Plan: fetch the filings PDF discovered by
 * extractFilingsPdfLink(), pass through pdf-parse, and pattern-match
 * "Office | Candidate | Party | District" rows. PDF extraction wiring
 * tracked separately.
 */
export function parseArkansasCandidates(_rawBody: string): ArCandidacyRow[] {
  return [];
}
