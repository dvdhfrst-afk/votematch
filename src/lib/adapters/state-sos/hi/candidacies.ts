/**
 * Hawaii Office of Elections — 2026 candidate-filings adapter (FIPS 15).
 *
 * Source pages (web-verified 2026-04-25):
 *   Landing: https://elections.hawaii.gov/candidates/
 *   Filing:  https://elections.hawaii.gov/candidates/candidate-filing/
 *   Manual:  https://elections.hawaii.gov/wp-content/uploads/2026-Candidates-Manual.pdf
 *
 * State of play
 * -------------
 * Hawaii's filing window for the 2026 elections doesn't close until
 * June 2026 (per HRS §12-6 and the 2026 Candidate's Manual). As of
 * 2026-04-25 there is no published list-of-filed-candidates URL on
 * elections.hawaii.gov — historic precedent (2024 cycle) is that HI
 * publishes a single PDF "List of Candidates" within a week of the
 * filing deadline, then updates it once after challenge cure.
 *
 * Public web-search probe (2026-04-25): no archive of historical lists
 * is exposed under /candidates/, /resources/archives-2/, or via WP
 * search; the 2024 list was a one-off `wp-content/uploads/...pdf` link
 * referenced from a since-removed 2024 elections page. Trying common
 * 2026 path variants (e.g. `/candidates/2026-list-of-candidates/`,
 * `/2026-candidates/`, `/wp-content/uploads/2026-General-Election-Candidate-List.pdf`)
 * all 404.
 *
 * Behaviour
 * ---------
 * Day 0: fetch the landing page so provenance + content_hash are recorded,
 * scan for any 2026-list-of-candidates PDF link (matching common HI
 * filename patterns) and record the candidate URLs in source.meta. Return
 * [] from parse — the adapter run lands as 'partial' with an explicit
 * 'awaiting_filing_deadline' note in the source meta.
 *
 * Day-of (June 2026 once filing closes): a small follow-up patch swaps
 * the empty parser for a PDF text-extraction step that lifts office /
 * district / candidate / party rows from the published list. Filing
 * deadlines occasionally slip; the parser-swap commit will also wire
 * a /candidates/ probe loop into the dispatcher.
 *
 * Hawaii ballot scope (2026 primary 2026-08-08, general 2026-11-03):
 *   - Governor + Lt. Governor (Green/Luke seek re-election)
 *   - U.S. House (2 districts)
 *   - State Senate (half the chamber on the 2026 cycle)
 *   - State House (all 51 districts)
 *   - State Board of Education + OHA Trustees (nonpartisan statewide)
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

import { politeFetch } from '../../fetch-polite';
import {
  insertCandidacies,
  type CandidacyInsertRow,
} from '../shared/candidacies-insert';
import { extractTextFromPdf, parsePdfTable } from '../shared/pdf-extract';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

const STATE_FIPS = '15';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-08-08';
const GENERAL_DATE = '2026-11-03';

const DEFAULT_SOURCE_URL = 'https://elections.hawaii.gov/candidates/';

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export type HiCandidacyRow = CandidacyInsertRow;

// ---------------------------------------------------------------------------
// Discovery — find any link that LOOKS like a 2026 list-of-candidates PDF.
// ---------------------------------------------------------------------------

/**
 * Pull all candidate-list-ish PDF URLs from the HI elections candidates
 * page. Patterns we accept:
 *   - href contains "2026" AND any of "candidate", "list", "filed", "manual"
 *   - href ends in .pdf
 * Returns absolute URLs, deduplicated.
 */
export function findHiCandidatePdfs(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $('a[href]').each((_i, a) => {
    const href = String($(a).attr('href') ?? '');
    if (!href) return;
    const text = $(a).text().toLowerCase();
    const lower = href.toLowerCase();
    if (!lower.endsWith('.pdf') && !lower.includes('.pdf?')) return;
    if (!/2026/.test(lower) && !/2026/.test(text)) return;
    if (!/(candidate|list|filed|manual)/.test(lower + text)) return;
    const abs = lower.startsWith('http')
      ? href
      : new URL(href, 'https://elections.hawaii.gov').toString();
    out.add(abs);
  });
  return Array.from(out);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type HiCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetchLanding?: () => Promise<{ status: number; body: string; resolvedUrl?: string }>;
  parseOverride?: (html: string) => HiCandidacyRow[];
};

export function createHiCandidaciesAdapter(
  options: HiCandidaciesAdapterOptions = {},
): SourceAdapter<HiCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);

  const adapter: SourceAdapter<HiCandidacyRow> = {
    name: 'sos-hawaii-oe-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<HiCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching landing`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      const fetchImpl =
        options.fetchLanding ??
        (async () => {
          const res = await politeFetch(sourceUrl, {
            headers: { Accept: 'text/html,*/*' },
          });
          return {
            status: res.status,
            body: await res.text(),
            resolvedUrl: res.url,
          };
        });

      const { status, body, resolvedUrl } = await fetchImpl();
      if (status >= 400) {
        throw new Error(
          `HI candidacies fetch failed: HTTP ${status} from ${sourceUrl}`,
        );
      }
      const contentHash = createHash('sha256').update(body).digest('hex');
      const candidatePdfs = findHiCandidatePdfs(body);

      let rows: HiCandidacyRow[] = options.parseOverride
        ? options.parseOverride(body)
        : [];

      // Production: HI's filing window closes June 2026. Once the
      // Office of Elections posts the consolidated list PDF, the URL
      // shows up in `findHiCandidatePdfs(body)`. Fetch + parse via the
      // shared table extractor. Until then, candidatePdfs is typically
      // [] and rows stays [].
      const fetchedPdfs: Array<{ url: string; bytes: number; rows: number }> = [];
      if (rows.length === 0 && candidatePdfs.length > 0 && !options.parseOverride) {
        for (const url of candidatePdfs) {
          // Skip the candidates manual (it's a guidebook, not a roster).
          if (/manual/i.test(url)) continue;
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
            const hiRows: HiCandidacyRow[] = tableRows.map((r, i) => ({
              reported_name: String(r.reported_name ?? ''),
              office_name: String(r.office_name ?? ''),
              district_identifier: r.district_identifier ? String(r.district_identifier) : null,
              party_raw: r.party_raw ? String(r.party_raw) : null,
              date_filed: null,
              election_date: PRIMARY_DATE,
              election_type: 'primary',
              source_row_id: `hi-pdf-${i + 1}`,
            }));
            rows = rows.concat(hiRows);
            fetchedPdfs.push({ url, bytes: bytes.byteLength, rows: hiRows.length });
          } catch (err) {
            ctx.logger.warn(`${adapter.name}: PDF parse failed`, {
              error: err instanceof Error ? err.message : String(err),
              url,
            });
          }
        }
      }

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        candidate_pdfs: candidatePdfs.length,
        pdfs_fetched: fetchedPdfs.length,
      });

      return {
        rows,
        expectedMinRows: 1,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'hawaii-oe-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            general_date: GENERAL_DATE,
            byte_size: body.length,
            candidate_pdfs: candidatePdfs,
            fetched_pdfs: fetchedPdfs,
            note:
              rows.length === 0
                ? 'HI 2026 filing window closes June 2026; no candidate-list PDF detected on landing page yet. PDF parser is wired and ready.'
                : 'HI candidate list parsed from PDF',
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
      rows: HiCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertCandidacies(rows, refs, ctx, {
        stateFips: STATE_FIPS,
        source: 'sos-hawaii-oe-candidacies',
        electionYear,
      });
    },
  };

  return adapter;
}
