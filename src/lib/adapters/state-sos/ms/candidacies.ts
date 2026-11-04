/**
 * Mississippi Secretary of State — 2026 candidate-filings adapter (FIPS 28).
 *
 * Mississippi has NO statewide partisan primary in 2026. The state has odd-
 * year statewide elections (Governor, AG, SoS, Treasurer all elected in
 * 2027); 2026 is the federal mid-term cycle, so what voters see is:
 *   - U.S. Senator (Class II seat)
 *   - U.S. House districts 1–4
 *   - State Supreme Court seats whose 8y terms end in 2026 (nonpartisan)
 *   - State Court of Appeals seats (nonpartisan)
 * Federal primary is 2026-03-10 (Tue after first Mon in March, MS Code 23-15-191).
 *
 * Source candidates probed (web-verified 2026-04-25 via politeFetch):
 *   1. https://www.sos.ms.gov/elections-voting → 200 (HTML, Drupal "Frontier"
 *      site). Contains a link to:
 *         - "2026 Candidate Qualifying List" → https://www.sos.ms.gov/node/1825
 *         - "Democratic Primary Sample Ballot" PDF (3-10-2026)
 *         - "Republican Primary Sample Ballot" PDF (3-10-2026)
 *         - "2026 Elections Calendar" PDF
 *   2. https://www.sos.ms.gov/node/1825 → 200, but the page body is empty
 *      ("Visit Election & Voting Home"). MS publishes the qualifying list
 *      as PDFs after qualifying closes; no flat structured list.
 *   3. https://www.sos.ms.gov/elections-voting/candidate-referenda-information
 *      → 200, links to 2025/2026 Candidate Qualifying Guide (PDF) and to
 *      `/elections-voting/candidate-qualifying-forms` (form templates only).
 *
 * Status (2026-04-25):
 *   MS does not publish a flat candidate list (XLSX/CSV/JSON/structured
 *   HTML table) for 2026 federal candidates. The closest authoritative
 *   source is the Sample Ballot PDFs, which list candidates by party for
 *   each statewide / district contest but are PDF-only. PDF parsing is
 *   tier-3 work (pdf.js / pdfplumber) deferred to a future ticket.
 *
 *   Until then this adapter:
 *     - Fetches the elections-voting landing page,
 *     - Records the qualifying-list node URL + sample-ballot URLs in
 *       source.meta so a downstream PDF ingest pipeline can consume them,
 *     - Returns [] rows so the run records `partial`.
 *
 * What this adapter writes (per filed candidate, when PDF parsing lands):
 *   1. people row — find-or-create keyed on canonical_key + state scope
 *   2. elections row — find-or-create for (office_id, 2026-03-10, 'primary')
 *   3. candidacies row — upsert on (election_id, person_id)
 *   4. candidacy_party_lines — upsert primary line
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

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

const STATE_FIPS = '28';
const PRIMARY_DATE = '2026-03-10';
const DEFAULT_SOURCE_URL = 'https://www.sos.ms.gov/elections-voting';
const QUALIFYING_LIST_URL = 'https://www.sos.ms.gov/node/1825';

export type MsCandidacyRow = GenericCandidacyRow;

export type CreateMsCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => MsCandidacyRow[];
};

export function createMsCandidaciesAdapter(
  options: CreateMsCandidaciesAdapterOptions = {},
): SourceAdapter<MsCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? new Date().getUTCFullYear();
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<MsCandidacyRow> = {
    name: 'sos-mississippi-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<MsCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('ms-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      const fetchImpl = options.fetchOverride ?? fetchMsCandidatesPage;
      const { status, body } = await fetchImpl(sourceUrl);

      const contentHash = createHash('sha256').update(body).digest('hex');
      ctx.logger.info('ms-candidacies: fetched', {
        http_status: status,
        bytes: body.length,
        contentHash: contentHash.slice(0, 12),
      });

      const parser = options.parseOverride ?? parseMsCandidates;
      let rows = status >= 400 ? [] : parser(body);

      // Production: scan the elections-voting page for PDFs that look
      // like the qualifying list or sample ballots. Each PDF goes
      // through parsePdfTable; sample ballots are organized by office,
      // so the table parser is a best-effort first pass.
      const candidatePdfs = status < 400 ? findMsCandidatePdfs(body) : [];
      const fetchedPdfs: Array<{ url: string; bytes: number; rows: number }> = [];
      if (rows.length === 0 && candidatePdfs.length > 0 && !options.parseOverride) {
        for (const url of candidatePdfs) {
          try {
            const pdfRes = await politeFetch(url, {
              headers: { Accept: 'application/pdf,*/*' },
            });
            if (!pdfRes.ok) continue;
            const ab = await pdfRes.arrayBuffer();
            const bytes = new Uint8Array(ab);
            const { pages } = await extractTextFromPdf(bytes);
            const text = pages.join('\n\n');
            const tableRows = parsePdfTable(text, {
              columns: [
                { name: 'office_name', aliases: ['Office', 'Position', 'Contest'], required: true },
                { name: 'reported_name', aliases: ['Candidate', 'Name'], required: true },
                { name: 'party_raw', aliases: ['Party', 'Affiliation'] },
                { name: 'district_identifier', aliases: ['District', 'Dist'] },
              ],
            });
            const msRows: MsCandidacyRow[] = tableRows.map((r, i) => ({
              reported_name: String(r.reported_name ?? ''),
              office_name: String(r.office_name ?? ''),
              district_identifier: r.district_identifier ? String(r.district_identifier) : null,
              party_raw: r.party_raw ? String(r.party_raw) : null,
              source_row_id: `ms-pdf-${i + 1}`,
            }));
            rows = rows.concat(msRows);
            fetchedPdfs.push({ url, bytes: bytes.byteLength, rows: msRows.length });
          } catch (err) {
            ctx.logger.warn('ms-candidacies: PDF parse failed', {
              error: err instanceof Error ? err.message : String(err),
              url,
            });
          }
        }
      }

      if (rows.length === 0) {
        ctx.logger.warn(
          'ms-candidacies: no structured rows. MS publishes only PDFs (sample ballots + qualifying-list PDFs). Parser is wired and ready; will pick up rows when a list-style PDF is detected on the landing page.',
        );
      }

      return {
        rows,
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'mississippi-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: status,
            byte_size: body.length,
            qualifying_list_url: QUALIFYING_LIST_URL,
            candidate_pdfs: candidatePdfs,
            fetched_pdfs: fetchedPdfs,
            blocker: rows.length > 0
              ? null
              : candidatePdfs.length === 0
                ? 'awaiting_2026_qualifying_list_pdf'
                : 'pdf_table_layout_unmatched',
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
        source: 'sos-mississippi-candidacies',
      });
    },
  };

  return adapter;
}

export async function fetchMsCandidatesPage(
  url: string,
): Promise<{ status: number; body: string }> {
  const res = await politeFetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  return { status: res.status, body: await res.text() };
}

/**
 * Parse MS candidate-list HTML. Returns []. Production path is in
 * adapter.run(): findMsCandidatePdfs → extractTextFromPdf → parsePdfTable.
 */
export function parseMsCandidates(rawBody: string): MsCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  return [];
}

/**
 * Discover MS candidate-related PDFs (qualifying list, sample ballot,
 * filed candidates) from the elections-voting landing-page HTML.
 */
export function findMsCandidatePdfs(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const text = ($(el).text() ?? '').trim().toLowerCase();
    if (!href) return;
    if (!/\.pdf(?:[?#]|$)/i.test(href)) return;
    const combined = `${href} ${text}`.toLowerCase();
    if (!/2026/.test(combined)) return;
    if (!/(qualif|candidat|sample.?ballot|primary.?ballot)/.test(combined)) return;
    try {
      out.add(new URL(href, 'https://www.sos.ms.gov').toString());
    } catch {
      out.add(href);
    }
  });
  return [...out];
}
