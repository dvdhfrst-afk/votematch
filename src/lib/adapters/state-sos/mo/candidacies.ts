/**
 * Missouri Secretary of State — 2026 candidate-filings adapter (FIPS 29).
 *
 * Primary is 2026-08-04 (open primary; voter chooses party ballot at polls).
 * Filing window for federal/state offices: 2026-02-24 → 2026-03-31 per
 * Missouri Revised Statutes 115.349.
 *
 * Source candidates probed (web-verified 2026-04-25 via politeFetch):
 *   1. https://www.sos.mo.gov/elections/petitions/candidates → 200 (HTML
 *      landing page redirecting to /elections/candidates).
 *   2. https://www.sos.mo.gov/elections/candidates → 200 (HTML, ~26KB).
 *      Page links to:
 *         - Candidate Filing Information PDF
 *         - Candidate Qualifications PDF
 *         - Independent Candidate Information PDF
 *         - 2026 Election Calendar
 *         - 2026 General Assembly Roster PDF (legislators-elect, post-cycle)
 *      No flat candidate list (XLSX/CSV/JSON) and no structured HTML table
 *      with filed-candidate names is published on the public MO SoS site.
 *      Per MO statute § 115.355 the SoS maintains a "list of candidates"
 *      but distributes it as a PDF after each filing-deadline cutoff.
 *   3. https://www.sos.mo.gov/CMSImages/ElectionsVoterRegistration/2026PrimaryCandidates.pdf
 *      → 404 (URL guessed from 2024 cycle pattern; MO has not republished
 *      the document at the same path for 2026 as of 2026-04-25).
 *
 * Status (2026-04-25):
 *   MO does not yet publish a public 2026 statewide primary candidate list
 *   in any structured format. The filing window closed 2026-03-31; the
 *   2024-cycle PDF (2024PrimaryCandidates.pdf) was published mid-April
 *   2024, so a 2026PrimaryCandidates.pdf is plausibly imminent. When it
 *   appears, swap parseMoCandidates() to PDF parsing.
 *
 * Behavior of this adapter today:
 *   - run() fetches the candidates landing page,
 *   - records the candidate-information PDF + General Assembly Roster URLs
 *     in source.meta for downstream PDF ingestion,
 *   - returns [] rows so the run records `partial`.
 *
 * What this adapter writes (per filed candidate, when PDF parsing lands):
 *   1. people row, 2. elections row, 3. candidacies row, 4. party_lines.
 *
 * What's on the 2026 MO primary ballot (federal + state):
 *   - U.S. Senator (Class II seat)
 *   - U.S. House districts 1–8
 *   - State Auditor (only statewide exec on 2026 cycle in MO)
 *   - Missouri Senate: half the chamber (4y staggered, even-numbered districts)
 *   - Missouri House: all 163 seats
 *   - Various judicial retention votes (nonpartisan)
 */

import { createHash } from 'node:crypto';

import { politeFetch } from '../../fetch-polite';
import {
  insertGenericCandidacies,
  type GenericCandidacyRow,
} from '../candidacies-shared';
import type {
  AdapterContext,
  AdapterOutcome,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';
import { extractTextFromPdf, parsePdfTable } from '../shared/pdf-extract';
import * as cheerio from 'cheerio';

const STATE_FIPS = '29';
const PRIMARY_DATE = '2026-08-04';
const DEFAULT_SOURCE_URL = 'https://www.sos.mo.gov/elections/candidates';
const FILING_INFO_PDF_URL =
  'https://www.sos.mo.gov/CMSImages/ElectionCandidates/2026FilingDocuments/2026CandidateFilingInformation.pdf';

export type MoCandidacyRow = GenericCandidacyRow;

export type CreateMoCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => MoCandidacyRow[];
};

export function createMoCandidaciesAdapter(
  options: CreateMoCandidaciesAdapterOptions = {},
): SourceAdapter<MoCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? new Date().getUTCFullYear();
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<MoCandidacyRow> = {
    name: 'sos-missouri-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<MoCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('mo-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      const fetchImpl = options.fetchOverride ?? fetchMoCandidatesPage;
      const { status, body } = await fetchImpl(sourceUrl);

      const contentHash = createHash('sha256').update(body).digest('hex');
      ctx.logger.info('mo-candidacies: fetched', {
        http_status: status,
        bytes: body.length,
        contentHash: contentHash.slice(0, 12),
      });

      const parser = options.parseOverride ?? parseMoCandidates;
      let rows = status >= 400 ? [] : parser(body);

      // Production: discover any 2026 primary candidate list PDF on the
      // landing page (e.g. "2026PrimaryCandidates.pdf"). When MO posts
      // the list, fetch + parse via the shared extractor. Until then no
      // candidate-list PDF is found and rows stay [] with a blocker.
      const candidatePdfUrl = status < 400 ? findMoCandidateListPdf(body) : null;
      let pdfBytes = 0;
      let pdfStatus: number | null = null;
      if (rows.length === 0 && candidatePdfUrl && !options.parseOverride) {
        try {
          const pdfRes = await politeFetch(candidatePdfUrl, {
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
                { name: 'district_identifier', aliases: ['District', 'Dist'] },
                { name: 'reported_name', aliases: ['Candidate', 'Name'], required: true },
                { name: 'party_raw', aliases: ['Party', 'Affiliation'] },
              ],
            });
            rows = tableRows.map((r, i) => ({
              reported_name: String(r.reported_name ?? ''),
              office_name: String(r.office_name ?? ''),
              district_identifier: r.district_identifier ? String(r.district_identifier) : null,
              party_raw: r.party_raw ? String(r.party_raw) : null,
              source_row_id: `mo-pdf-${i + 1}`,
            }));
          }
        } catch (err) {
          ctx.logger.warn('mo-candidacies: PDF parse failed', {
            error: err instanceof Error ? err.message : String(err),
            url: candidatePdfUrl,
          });
        }
      }

      if (rows.length === 0) {
        ctx.logger.warn(
          'mo-candidacies: MO SoS has not yet published a 2026 primary candidate list. PDF parser ready; gate is the URL discovery on /elections/candidates.',
        );
      }

      return {
        rows,
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'missouri-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: status,
            byte_size: body.length,
            filing_info_pdf_url: FILING_INFO_PDF_URL,
            candidate_list_pdf_url: candidatePdfUrl,
            candidate_list_pdf_status: pdfStatus,
            candidate_list_pdf_bytes: pdfBytes,
            blocker: rows.length > 0
              ? null
              : candidatePdfUrl
                ? 'pdf_table_layout_unmatched'
                : 'awaiting_2026_primary_candidates_pdf',
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) return 'missing reported_name';
      if (!row.office_name || !row.office_name.trim()) return 'missing office_name';
      return null;
    },

    async insert(rows, refs, ctx) {
      return insertGenericCandidacies(rows, refs, ctx, {
        stateFips: STATE_FIPS,
        electionYear,
        source: 'sos-missouri-candidacies',
      });
    },
  };

  return adapter;
}

export async function fetchMoCandidatesPage(
  url: string,
): Promise<{ status: number; body: string }> {
  const res = await politeFetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  return { status: res.status, body: await res.text() };
}

/**
 * Parse MO candidate-list HTML. Returns [] — no flat list is published
 * on the landing-page HTML itself (MO posts only PDFs). The production
 * path is in adapter.run(): findMoCandidateListPdf → extractTextFromPdf
 * → parsePdfTable. This helper is preserved for tests that pass HTML.
 */
export function parseMoCandidates(rawBody: string): MoCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  return [];
}

/**
 * Discover the 2026 primary candidate list PDF link on the MO SoS
 * /elections/candidates landing page.
 *
 * URL pattern observed across past cycles:
 *   https://www.sos.mo.gov/CMSImages/ElectionsVoterRegistration/<YEAR>PrimaryCandidates.pdf
 *
 * Returns the absolute URL if a 2026-cycle anchor is found, else null.
 */
export function findMoCandidateListPdf(html: string): string | null {
  if (!html) return null;
  const $ = cheerio.load(html);
  let found: string | null = null;
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const text = ($(el).text() ?? '').trim().toLowerCase();
    if (!href) return;
    if (!/\.pdf(?:[?#]|$)/i.test(href)) return;
    const combined = `${href} ${text}`.toLowerCase();
    if (!/2026/.test(combined)) return;
    if (!/(primary.*candidat|candidat.*list|filed.*candidat)/.test(combined)) return;
    try {
      if (!found) found = new URL(href, 'https://www.sos.mo.gov').toString();
    } catch {
      if (!found) found = href;
    }
  });
  return found;
}
