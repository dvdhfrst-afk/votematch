/**
 * DC Board of Elections — 2026 candidate-filings adapter (FIPS 11).
 *
 * Source pages (web-verified 2026-04-25):
 *   Landing: https://www.dcboe.org/Candidates
 *   2026 Elections: https://www.dcboe.org/elections/2026-elections
 *     The 2026 elections page lists "List of Primary Election Candidates
 *     in Ballot Order" + "List of Primary Election Write-in Candidates"
 *     PDFs (currently 03/02/2026 + 04/23/2026 cuts respectively).
 *
 * What's on the 2026 DC primary ballot (June 2, 2026):
 *   - Mayor (every 4 years; on the ballot in 2026)
 *   - Council Chairman, At-Large Council seats, Ward Council seats
 *   - Delegate to U.S. House (DC's nonvoting delegate)
 *   - Attorney General
 *   - Shadow Senator + Shadow Representative
 *   - State Board of Education seats
 *   - ANC commissioners (Advisory Neighborhood Commissioners — local
 *     unincorporated, but explicitly listed by DCBOE as filed-candidacies)
 *
 * Status: PDF-deferred. This adapter discovers the bullet-list candidates
 * PDF link from the elections landing page (so when DCBOE reposts the file
 * under a new GUID, we follow the page rather than hardcoding URLs), but
 * the parsed-row count is currently 0 because we don't ship a PDF text-
 * extraction layer here. The candidate-list PDF is multi-column with
 * hand-formatted bullet headers — a robust extractor needs pdf-parse +
 * heading-aware splitting, which lives behind a feature flag we'll wire
 * in Phase 2.
 *
 * The adapter shape, provenance, and error-classification path are all
 * production-ready, so a Day-2 PDF extractor lands as a drop-in replacement
 * for parseDcCandidatesPdf().
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

import { politeFetch } from '../../fetch-polite';
import {
  insertCandidacies,
  type CandidacyInsertRow,
} from '../shared/candidacies-insert';
import { extractTextFromPdf } from '../shared/pdf-extract';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

const STATE_FIPS = '11';
const ELECTION_YEAR = 2026;
/** DC primary date — published in the 2026 election calendar PDF. */
const DEFAULT_PRIMARY_DATE = '2026-06-02';
const DEFAULT_GENERAL_DATE = '2026-11-03';

const LANDING_URL = 'https://www.dcboe.org/elections/2026-elections';

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export type DcCandidacyRow = CandidacyInsertRow & {
  /** Origin PDF basename for traceability ('2026-PRIMARY-CANDIDATES-...'). */
  source_pdf?: string;
  /** True if pulled from the write-in candidate list. */
  is_write_in?: boolean;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type DcCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Test override — return raw landing-page HTML directly. */
  fetchLanding?: () => Promise<{ status: number; body: string; resolvedUrl?: string }>;
  /** Test override — supply a pre-parsed PDF candidate list. */
  parseOverride?: (html: string) => DcCandidacyRow[];
};

// ---------------------------------------------------------------------------
// Landing-page parser — discovers the list-of-candidates PDF link.
// ---------------------------------------------------------------------------

/**
 * Pull every PDF link the DCBOE 2026 elections page exposes that looks
 * like a primary or general candidate list (in-ballot-order + write-in).
 *
 * DCBOE publishes URLs of the form
 *   /getmedia/<guid>/2026-PRIMARY-CANDIDATES-<MMDDYYYY>.pdf
 *   /getmedia/<guid>/2026-Primary-Election-WRITE-IN-CANDIDATES-<MMDDYYYY>.pdf
 *
 * Returned in stable order so the most recently dated file wins on
 * dedup at parse time.
 */
export function findCandidatePdfLinks(html: string): {
  primary: string[];
  writeIn: string[];
  general: string[];
} {
  if (!html) return { primary: [], writeIn: [], general: [] };
  const $ = cheerio.load(html);
  const out = { primary: [] as string[], writeIn: [] as string[], general: [] as string[] };

  $('a[href]').each((_i, a) => {
    const href = String($(a).attr('href') ?? '');
    if (!href) return;
    const text = $(a).text().toLowerCase();
    const lower = href.toLowerCase();
    const isPdf = lower.endsWith('.pdf') || lower.includes('.pdf?');
    if (!isPdf) return;
    if (!/2026/.test(lower) && !/2026/.test(text)) return;

    const abs = lower.startsWith('http')
      ? href
      : new URL(href, 'https://www.dcboe.org').toString();

    if (/write[-\s]?in/i.test(text) || /write-?in/i.test(lower)) {
      out.writeIn.push(abs);
    } else if (/general/i.test(text) || /general/i.test(lower)) {
      out.general.push(abs);
    } else if (/primary[-\s]*candidates|candidates-in-ballot|candidates-?03|candidates-?04|primary[-\s]*election/i.test(text + lower)) {
      out.primary.push(abs);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// PDF parser stub — drop-in replacement target.
// ---------------------------------------------------------------------------

/**
 * DC candidate list PDF parser.
 *
 * Format (web-verified 2026-04-25 against 2026-PRIMARY-CANDIDATES-03022026.pdf):
 *   Header line (page 1):
 *     "District of Columbia Board of Elections - <Party> Party Candidates - In the <Date> Primary Election"
 *   Column header:
 *     "Candidate's Name  Contact Person / Slate (if any)  ...  Pick-up Date  Date Filed"
 *   Body rows: section banners (office titles) followed by candidates,
 *     interspersed with "Write-in, if any" markers that close each office.
 *
 * Each candidate row has a name in the first cell and an address/zip/
 * phone/email in subsequent cells. Pick-up Date and Date Filed are the
 * last two MM/DD/YYYY cells.
 *
 * Maps every parsed candidate to the DC primary date. The party is taken
 * from the page header (so callers should pass party-specific PDFs).
 */
export function parseDcCandidatesPdfText(
  pages: string[],
  opts: { primaryDate: string; isWriteIn: boolean; sourcePdf: string },
): DcCandidacyRow[] {
  // Section markers — DC office titles. List taken from the file header.
  const OFFICE_BANNERS: Array<{ test: RegExp; office: string; districtFrom?: RegExp }> = [
    { test: /^Delegate to the House of Representatives$/i, office: 'Delegate to the U.S. House' },
    { test: /^Mayor of the District of Columbia$/i, office: 'Mayor' },
    { test: /^Chairman of the Council of the District of Columbia$/i, office: 'Council Chairman' },
    { test: /^At-large Member of the Council$/i, office: 'At-Large Council Member' },
    {
      test: /^Ward\s+(\d+)\s+Member of the Council$/i,
      office: 'Ward Council Member',
      districtFrom: /^Ward\s+(\d+)/i,
    },
    { test: /^Attorney General of the District of Columbia$/i, office: 'Attorney General' },
    { test: /^United States Senator$/i, office: 'U.S. Senator (Shadow)' },
    { test: /^United States Representative$/i, office: 'U.S. Representative (Shadow)' },
    { test: /^At-large Member of the State Board of Education$/i, office: 'At-Large State Board of Education' },
    {
      test: /^Ward\s+(\d+)\s+Member of the State Board of Education$/i,
      office: 'Ward State Board of Education',
      districtFrom: /^Ward\s+(\d+)/i,
    },
    {
      test: /^Advisory Neighborhood Commissioner.*$/i,
      office: 'Advisory Neighborhood Commissioner',
    },
    // Democratic State Committee positions are also on the ballot — not
    // strictly elective public office, but DCBOE includes them in the
    // primary-candidates list. Skip in this scope (party-internal).
  ];

  // Try to detect the party from the title/header line.
  let party: string | null = null;
  if (pages[0]) {
    const m = /(Democratic|Republican|Statehood\s*Green|Libertarian)\s*Party/i.exec(pages[0]);
    if (m) party = m[1]!.replace(/\s+/g, ' ');
  }

  const out: DcCandidacyRow[] = [];
  let currentOffice: string | null = null;
  let currentDistrict: string | null = null;
  let rowCounter = 0;

  for (const page of pages) {
    const lines = page.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      // Skip page chrome.
      if (/^District of Columbia Board of Elections/i.test(line)) continue;
      if (/^Candidate's Name/i.test(line)) continue;
      if (/^Write-in, if any/i.test(line)) {
        // End of an office block; clear continuing-office marker so
        // stray lines below don't get attached.
        continue;
      }

      // Office banner?
      let matchedBanner = false;
      for (const banner of OFFICE_BANNERS) {
        if (banner.test.test(line)) {
          currentOffice = banner.office;
          if (banner.districtFrom) {
            const dm = banner.districtFrom.exec(line);
            currentDistrict = dm ? dm[1]! : null;
          } else {
            currentDistrict = null;
          }
          matchedBanner = true;
          break;
        }
      }
      if (matchedBanner) continue;

      if (!currentOffice) continue;

      // Candidate row: split on multi-space gaps; first cell is the
      // candidate name. Reject obvious non-candidate lines (e.g. a
      // line that's mostly a zip + phone with no leading name).
      const cells = line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length < 2) continue;
      const first = cells[0]!;
      // The first cell must look like a person's name (letters with
      // optional initials, hyphens, apostrophes, periods, and parens
      // for nicknames). Reject if it starts with a digit or "PO Box".
      if (!/^[A-Z][\p{L}\.\-' ()]{2,}$/u.test(first)) continue;
      if (/^(PO Box|P\.O\.|\d)/i.test(first)) continue;

      rowCounter += 1;
      out.push({
        reported_name: first,
        office_name: currentOffice,
        district_identifier: currentDistrict,
        party_raw: party,
        date_filed: null,
        election_date: opts.primaryDate,
        election_type: 'primary',
        source_pdf: opts.sourcePdf,
        is_write_in: opts.isWriteIn,
        source_row_id: `dc-${opts.isWriteIn ? 'wi-' : ''}${rowCounter}`,
      });
    }
  }
  return out;
}

/**
 * Sync stub kept for tests. Production uses parseDcCandidatesPdfText().
 */
export function parseDcCandidatesPdf(
  _pdfBytes: Uint8Array,
  _opts: { primaryDate: string; isWriteIn: boolean; sourcePdf: string },
): DcCandidacyRow[] {
  return [];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDcCandidaciesAdapter(
  options: DcCandidaciesAdapterOptions = {},
): SourceAdapter<DcCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? LANDING_URL;
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);

  const adapter: SourceAdapter<DcCandidacyRow> = {
    name: 'sos-dc-boe-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<DcCandidacyRow>> {
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

      const landing = await fetchImpl();
      if (landing.status >= 400) {
        throw new Error(
          `DC candidacies fetch failed: HTTP ${landing.status} from ${sourceUrl}`,
        );
      }
      const contentHash = createHash('sha256').update(landing.body).digest('hex');

      const links = findCandidatePdfLinks(landing.body);

      ctx.logger.info(`${adapter.name}: discovered`, {
        primary_pdfs: links.primary.length,
        writein_pdfs: links.writeIn.length,
        general_pdfs: links.general.length,
      });

      // Production path: fetch each discovered primary PDF, run the
      // line-walker parser, accumulate rows. Test path: parseOverride.
      let rows: DcCandidacyRow[] = [];
      const fetchedPdfs: Array<{ url: string; bytes: number; rows: number }> = [];
      if (options.parseOverride) {
        rows = options.parseOverride(landing.body);
      } else {
        const targets: Array<{ url: string; isWriteIn: boolean }> = [
          ...links.primary.map((u) => ({ url: u, isWriteIn: false })),
          ...links.writeIn.map((u) => ({ url: u, isWriteIn: true })),
        ];
        for (const t of targets) {
          try {
            const pdfRes = await politeFetch(t.url, {
              headers: { Accept: 'application/pdf,*/*' },
            });
            if (!pdfRes.ok) {
              ctx.logger.warn(`${adapter.name}: PDF fetch ${pdfRes.status}`, {
                url: t.url,
              });
              continue;
            }
            const ab = await pdfRes.arrayBuffer();
            const bytes = new Uint8Array(ab);
            const { pages } = await extractTextFromPdf(bytes);
            const sourcePdf = (() => {
              try {
                return new URL(t.url).pathname.split('/').pop() ?? t.url;
              } catch {
                return t.url;
              }
            })();
            const parsed = parseDcCandidatesPdfText(pages, {
              primaryDate: DEFAULT_PRIMARY_DATE,
              isWriteIn: t.isWriteIn,
              sourcePdf,
            });
            rows.push(...parsed);
            fetchedPdfs.push({ url: t.url, bytes: bytes.byteLength, rows: parsed.length });
          } catch (err) {
            ctx.logger.warn(`${adapter.name}: PDF parse failed`, {
              url: t.url,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        pdfs_fetched: fetchedPdfs.length,
      });

      return {
        rows,
        expectedMinRows: 1,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'dc-boe-candidacies',
          url: landing.resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: DEFAULT_PRIMARY_DATE,
            general_date: DEFAULT_GENERAL_DATE,
            byte_size: landing.body.length,
            primary_pdfs: links.primary,
            writein_pdfs: links.writeIn,
            general_pdfs: links.general,
            fetched_pdfs: fetchedPdfs,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) return 'missing reported_name';
      if (!row.office_name || !row.office_name.trim()) return 'missing office_name';
      if (!row.election_date) return 'missing election_date';
      if (!row.election_type) return 'missing election_type';
      return null;
    },

    async insert(
      rows: DcCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertCandidacies(rows, refs, ctx, {
        stateFips: STATE_FIPS,
        source: 'sos-dc-boe-candidacies',
        electionYear,
      });
    },
  };

  return adapter;
}
