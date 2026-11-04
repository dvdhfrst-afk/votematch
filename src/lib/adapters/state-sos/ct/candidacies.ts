/**
 * Connecticut Secretary of the State — candidate filings adapter (FIPS 09).
 *
 * Source-hunt status (2026-04-25)
 * --------------------------------
 * The CT SOTS Candidate Information page is reachable from tier-1
 * politeFetch (200 OK) at:
 *   https://portal.ct.gov/sots/election-services/candidate-information
 * (Title shows "Candidate Information"; ~28 KB HTML.)
 *
 * The deeper /candidate-filings path returns 200 with a "404 Error Page"
 * body — the page exists in the IA but has no content. CT distributes
 * candidate-filing data via two different surfaces:
 *
 *   1. eCRIS (Electronic Campaign Reporting Information System):
 *      https://seec.ct.gov/eCRIS/Default
 *      — campaign-finance disclosures keyed on candidate committees;
 *      not a primary-cycle filings list per se but the only source
 *      that lists who has filed FORM SEEC 11 (statement of organization).
 *
 *   2. Per-cycle "Candidates for State Office" PDFs published by the
 *      SOTS Election Services division. URL pattern:
 *      https://portal.ct.gov/-/media/SOTS/.../candidate-list-YYYY.pdf
 *      Rotates per cycle; not yet published for 2026.
 *
 * Connecticut also has CONVENTION nominations (Aug-Sep) that determine
 * the primary ballot — most candidates DO NOT appear on a primary
 * ballot unless they petition. The SOTS' official filings list is
 * therefore much shorter than the equivalent for OH/IN.
 *
 * CT 2026 primary: August 11, 2026.
 *
 * Phase-1 plan: scan the candidate-information landing page for
 *   "Candidates for ... 2026" PDF anchor; when found, fetch via
 *   pdf-parse and emit CtCandidacyRow[].
 *
 * Today this adapter returns [] with parserSignal='no_table' and
 * captures the candidate_list_url (currently null) into meta.
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

const STATE_FIPS = '09';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-08-11';

const DEFAULT_SOURCE_URL =
  'https://portal.ct.gov/sots/election-services/candidate-information';

export type CtCandidacyRow = {
  reported_name: string;
  party_abbreviation: string | null;
  office_name: string;
  district_identifier: string | null;
  is_write_in: boolean;
  source_row_id: string;
};

export type CreateCtCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => CtCandidacyRow[];
};

export function createCtCandidaciesAdapter(
  options: CreateCtCandidaciesAdapterOptions = {},
): SourceAdapter<CtCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<CtCandidacyRow> = {
    name: 'sos-connecticut-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<CtCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('ct-candidacies: fetching', {
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
      ctx.logger.info('ct-candidacies: fetched', {
        http_status: status,
        bytes: rawBody.length,
        contentHash: contentHash.slice(0, 12),
      });

      const parser = options.parseOverride ?? parseConnecticutCandidates;
      let rows = status >= 200 && status < 400 ? parser(rawBody) : [];
      const candidateListUrl = status >= 200 && status < 400
        ? extractCandidatesPdfLink(rawBody, electionYear)
        : null;

      // CT's portal serves "404 Error Page" with HTTP 200 for missing
      // pages, so we additionally check the title to detect soft 404s.
      const isSoft404 = /<title>\s*404\s*Error\s*Page\s*<\/title>/i.test(rawBody);

      // Production: when CT posts the per-cycle "Candidates for State
      // Office" PDF, fetch + parse via parsePdfTable.
      let pdfBytes = 0;
      let pdfStatus: number | null = null;
      if (rows.length === 0 && candidateListUrl && !options.parseOverride) {
        try {
          const pdfRes = await politeFetch(candidateListUrl, {
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
              source_row_id: `ct-pdf-${i + 1}`,
            }));
          }
        } catch (err) {
          ctx.logger.warn('ct-candidacies: PDF parse failed', {
            error: err instanceof Error ? err.message : String(err),
            url: candidateListUrl,
          });
        }
      }

      return {
        rows,
        expectedMinRows: 0,
        parserSignal: rows.length > 0 ? 'ok' : 'no_table',
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'connecticut-sots-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: status,
            byte_size: rawBody.length,
            soft_404: isSoft404,
            candidate_list_url: candidateListUrl,
            candidate_list_status: pdfStatus,
            candidate_list_bytes: pdfBytes,
            adapter_status: rows.length > 0 ? 'productive' : 'dormant',
            blocker: rows.length > 0
              ? null
              : candidateListUrl
                ? 'pdf_table_layout_unmatched'
                : 'awaiting_2026_candidates_for_state_office_pdf',
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
      rows: CtCandidacyRow[],
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
            source: 'ct-sots-candidacies',
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
                source: 'ct-sots-candidacies',
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
                [candidacyId, partyId, refs.dataSourceId, JSON.stringify({ source: 'ct-sots-candidacies' })],
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
 * Find an anchor whose href ends in .pdf and whose visible text contains
 * "candidate" + the requested election year. CT publishes per-cycle PDFs
 * with the year in the filename (e.g. "Candidates-State-Office-2026.pdf").
 * Exported for tests.
 */
export function extractCandidatesPdfLink(
  html: string,
  electionYear: number,
): string | null {
  if (!html) return null;
  const yearStr = String(electionYear);
  const re = /<a[^>]+href="([^"]+\.pdf)"[^>]*>([^<]+)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const text = m[2];
    const combined = `${href} ${text}`.toLowerCase();
    if (combined.includes('candidate') && combined.includes(yearStr)) {
      let final = href;
      if (final.startsWith('//')) final = 'https:' + final;
      if (final.startsWith('/')) final = 'https://portal.ct.gov' + final;
      return final;
    }
  }
  return null;
}

/**
 * Parser stub — returns []. Phase-1 plan: fetch the per-cycle PDF
 * located via extractCandidatesPdfLink(), parse with pdf-parse, and
 * emit CtCandidacyRow[]. CT's PDF format is consistent across cycles
 * with one section per office and one row per candidate.
 */
export function parseConnecticutCandidates(_rawBody: string): CtCandidacyRow[] {
  return [];
}
