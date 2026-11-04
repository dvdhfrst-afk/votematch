/**
 * Oklahoma State Election Board — 2026 candidate-filings adapter (FIPS 40).
 *
 * Sources (web-verified 2026-04-25):
 *   https://oklahoma.gov/elections/candidates/2026-candidate-filing-information.html
 *     — Authoritative landing page for 2026 filing-cycle artifacts.
 *       Contains filing-fee tables and links to the consolidated PDF
 *       candidate list-book.
 *
 *   https://oklahoma.gov/content/dam/ok/en/elections/candidate-filing-archives/
 *       2026-candidate-filing-archives/2026-candidate-list-book.pdf
 *     — Authoritative PDF (~4.3 MB, verified 2026-04-25 returns
 *       application/pdf, 200 OK). One row per candidate across federal,
 *       state, county, judicial offices; also encodes filing-period
 *       window per office category.
 *
 *   https://oklahoma.gov/elections/candidates/2026-candidate-filing-information/2026-candidate-withdrawals.html
 *     — Companion withdrawals page (smaller; updated as candidates pull).
 *
 *   https://oklahoma.gov/elections/candidate-info.html
 *     — Originally referenced URL — returns HTTP 404 (legacy slug).
 *
 * PDF blocker
 * -----------
 * The OK SoS publishes the 2026 candidate list as a PDF list-book ONLY.
 * `pdf-parse` is NOT a workspace dep as of this commit (verified
 * 2026-04-25 in app/package.json). Adding it requires either:
 *   - npm install pdf-parse + a pdf-extraction unit test, or
 *   - swap to pdfjs-dist (already a peer-of-peer dep tree concern).
 *
 * Until that lands, this adapter:
 *   1. Fetches the LANDING HTML to collect the latest list-book PDF URL
 *      from the page (via discoverOkListBookUrl).
 *   2. Records both the landing page content_hash AND the list-book
 *      URL in data_sources.meta. The runner will mark subsequent runs
 *      `unchanged` until OSEB updates the page (= new candidates filed).
 *   3. Returns [] rows. Once pdf-parse is added, parseOkListBookPdf()
 *      is the seam to wire in.
 *
 * 2026 OK primary date: 2026-06-30 (closed primary; runoff 2026-08-25).
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';
import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import { extractTextFromPdf } from '../shared/pdf-extract';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '40';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-06-30';

const DEFAULT_SOURCE_URL =
  'https://oklahoma.gov/elections/candidates/2026-candidate-filing-information.html';

/** Default direct PDF URL (fallback if the landing page no longer links it). */
const DEFAULT_LIST_BOOK_URL =
  'https://oklahoma.gov/content/dam/ok/en/elections/candidate-filing-archives/2026-candidate-filing-archives/2026-candidate-list-book.pdf';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type OkCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string | null;
  date_filed: string | null;
  source_row_id: string;
};

export type OkCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetch?: (
    ctx: AdapterContext,
  ) => Promise<{ status: number; rawBody: string; resolvedUrl?: string }>;
  expectedMinRows?: number;
  electionYear?: number;
};

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/**
 * Discover the URL of the 2026 candidate list-book PDF on the landing
 * page. Returns the absolute URL if found, else the DEFAULT_LIST_BOOK_URL
 * fallback. We always return a URL so meta.list_book_url is populated
 * for operator/ops follow-up.
 */
export function discoverOkListBookUrl(
  html: string,
  baseUrl = DEFAULT_SOURCE_URL,
): string {
  const $ = cheerio.load(html);
  let found: string | null = null;
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const text = ($(el).text() ?? '').trim().toLowerCase();
    if (!href) return;
    const looksLikeListBook =
      /candidate.*list.*book|list[-_]book|filed.*candidates/i.test(text)
      || /candidate-list-book/i.test(href);
    if (looksLikeListBook && /\.pdf(?:[?#]|$)/i.test(href)) {
      try {
        const abs = new URL(href, baseUrl).toString();
        if (!found) found = abs;
      } catch {
        if (!found) found = href;
      }
    }
  });
  return found ?? DEFAULT_LIST_BOOK_URL;
}

/**
 * If OSEB publishes an inline HTML candidate table (rare; today the page
 * only contains filing-fee tables), parse it. Today returns []. Symmetric
 * with sibling adapters.
 */
export function parseOkCandidatesList(rawBody: string): OkCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  const trimmed = rawBody.trimStart();
  if (!trimmed.startsWith('<')) return [];
  const $ = cheerio.load(rawBody);
  const rows: OkCandidacyRow[] = [];
  $('table').each((tIdx, tableEl) => {
    const $tbl = $(tableEl);
    const headers = $tbl
      .find('tr').first()
      .find('th,td')
      .map((_, el) => $(el).text().trim().toLowerCase())
      .get();
    // Heuristic: a candidate table must include a 'candidate' OR 'name'
    // column AND an 'office' column. Filing-fee tables that the OK page
    // currently exposes have headers like 'office | filing fee' — those
    // are correctly skipped (no candidate column).
    const colName = headers.findIndex(
      (h) => /candidate/.test(h) || (/\bname\b/.test(h) && !/office|party/.test(h)),
    );
    const colParty = headers.findIndex((h) => /party/.test(h));
    const colOffice = headers.findIndex((h) => /office|contest/.test(h));
    const colDistrict = headers.findIndex((h) => /district/.test(h));
    if (colName < 0 || colOffice < 0) return;
    $tbl.find('tr').each((rIdx, trEl) => {
      if (rIdx === 0) return;
      const cells = $(trEl).find('td').map((_, el) => $(el).text().trim()).get();
      const name = cells[colName] ?? '';
      const office = cells[colOffice] ?? '';
      if (!name || !office) return;
      rows.push({
        reported_name: name,
        office_name: office,
        district_identifier:
          colDistrict >= 0 ? extractDistrict(cells[colDistrict] ?? '') : extractDistrict(office),
        party_raw: colParty >= 0 ? (cells[colParty] || null) : null,
        date_filed: null,
        source_row_id: `ok-t${tIdx}-r${rIdx}`,
      });
    });
  });
  return rows;
}

/**
 * Parse the OK candidate list-book PDF.
 *
 * Format (web-verified 2026-04-25 against the 2026-04-06 build, 66 pages):
 *   - Office banners are ALL-CAPS lines on their own (e.g. "GOVERNOR",
 *     "LIEUTENANT GOVERNOR", "STATE SENATOR DISTRICT 02"). District
 *     suffix uses "DISTRICT NN" (zero-padded).
 *   - Below the office: party banners (capitalized, single word like
 *     "Republican", "Democrat", "Independent", "Libertarian").
 *   - Each candidate is a row: "NNNNN FIRST [MIDDLE] LAST  City, OK"
 *     where NNNNN is a 5-digit candidate filing number.
 *
 * Returns one OkCandidacyRow per (office, party, name).
 *
 * Note: STATE SENATOR / STATE REPRESENTATIVE pages also list a per-district
 * "District NN" sub-banner; we treat that as the district. The page also
 * has Asterisk-prefixed county lists ("*COUNTY NAME"); those are skipped
 * because they're geographic context, not candidates.
 */
export function parseOkListBookPdfText(pages: string[]): OkCandidacyRow[] {
  const PARTY_RE = /^(Republican|Democrat|Democratic|Independent|Libertarian|Green|No Party)$/i;
  // Office banner: ALL-CAPS line, optionally with "DISTRICT NN" suffix.
  // Excludes lines like "* COUNTY NAME" and "DISTRICT NN" (sub-banner).
  const OFFICE_RE =
    /^(UNITED STATES (?:SENATOR|REPRESENTATIVE)|GOVERNOR|LIEUTENANT GOVERNOR|SECRETARY OF STATE|ATTORNEY GENERAL|STATE TREASURER|STATE AUDITOR(?: AND INSPECTOR)?|STATE SUPERINTENDENT OF PUBLIC INSTRUCTION|LABOR COMMISSIONER|INSURANCE COMMISSIONER|CORPORATION COMMISSIONER|JUSTICE OF THE SUPREME COURT|JUDGE OF THE COURT OF (?:CRIMINAL APPEALS|CIVIL APPEALS)|DISTRICT JUDGE|DISTRICT ATTORNEY|STATE SENATOR|STATE REPRESENTATIVE|JUDGE)(?:\s+DISTRICT\s+0*\d+)?$/;
  const DISTRICT_SUB_RE = /^DISTRICT\s+0*(\d{1,3})$/;
  const CANDIDATE_RE = /^(\d{5})\s+(.+?)\s{2,}(.+,\s*OK)$/;

  const out: OkCandidacyRow[] = [];
  let currentOffice: string | null = null;
  let currentDistrict: string | null = null;
  let currentParty: string | null = null;
  let rowCounter = 0;

  for (const page of pages) {
    const lines = page.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      // Skip page chrome / asterisk county prefixes.
      if (line.startsWith('*')) continue;
      if (/^Page\s+\d+/i.test(line)) continue;
      if (/NOTICE TO CANDIDATES/i.test(line)) continue;

      // Office banner?
      const officeMatch = OFFICE_RE.exec(line);
      if (officeMatch) {
        currentOffice = officeMatch[1]!;
        // If the banner already includes a district suffix, capture it.
        const distM = /DISTRICT\s+0*(\d{1,3})$/.exec(line);
        currentDistrict = distM ? distM[1]! : null;
        currentParty = null;
        continue;
      }

      // District-only sub-banner under STATE SENATOR / STATE REPRESENTATIVE.
      const subDistM = DISTRICT_SUB_RE.exec(line);
      if (subDistM) {
        currentDistrict = subDistM[1]!;
        currentParty = null;
        continue;
      }

      // Party banner?
      if (PARTY_RE.test(line)) {
        currentParty = line;
        continue;
      }

      // Candidate row.
      const candM = CANDIDATE_RE.exec(line);
      if (candM && currentOffice && currentParty) {
        const filingNum = candM[1]!;
        const name = candM[2]!.trim();
        rowCounter += 1;
        // Normalize "STATE SENATOR" → "State Senator" etc.
        const officeName = titleCaseOffice(currentOffice);
        out.push({
          reported_name: name,
          office_name: officeName,
          district_identifier: currentDistrict,
          party_raw: currentParty,
          date_filed: null,
          source_row_id: `ok-${filingNum}`,
        });
      }
    }
  }
  return out;
}

function titleCaseOffice(s: string): string {
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => (w === 'of' || w === 'the' || w === 'and' ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/\bU\.s\./gi, 'U.S.')
    .replace(/\bUnited States\b/i, 'United States');
}

/**
 * Backwards-compat sync stub. The live parse path is async (PDF
 * extraction happens inside `run()`). Tests that pass raw bytes still
 * see [] here.
 */
export function parseOkListBookPdf(_pdfBytes: Uint8Array): OkCandidacyRow[] {
  return [];
}

function extractDistrict(raw: string): string | null {
  if (!raw) return null;
  const m = /district\s+0*(\d{1,3})\b/i.exec(raw);
  if (m && m[1]) return m[1];
  const trailing = /\b0*(\d{1,3})\s*$/.exec(raw);
  if (trailing && trailing[1]) return trailing[1];
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOkCandidaciesAdapter(
  options: OkCandidaciesAdapterOptions = {},
): SourceAdapter<OkCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 0;
  const electionYear = options.electionYear ?? ELECTION_YEAR;

  const fetchImpl =
    options.fetch ??
    (async () => {
      const res = await politeFetch(sourceUrl, {
        headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
      });
      const body = await res.text();
      return { status: res.status, rawBody: body, resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<OkCandidacyRow> = {
    name: 'sos-oklahoma-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<OkCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching landing page`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      const { status, rawBody, resolvedUrl } = await fetchImpl(ctx);
      if (status >= 400) {
        throw new Error(`${adapter.name}: HTTP ${status} from ${sourceUrl}`);
      }
      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      const listBookUrl = discoverOkListBookUrl(rawBody, sourceUrl);

      // Inline HTML table fallback (rare). Production path: fetch the
      // list-book PDF and run the line-walker parser.
      let rows: OkCandidacyRow[] = parseOkCandidatesList(rawBody);
      let pdfBytes = 0;
      let pdfStatus: number | null = null;
      if (rows.length === 0 && listBookUrl) {
        try {
          const pdfRes = await politeFetch(listBookUrl, {
            headers: { Accept: 'application/pdf,*/*' },
          });
          pdfStatus = pdfRes.status;
          if (pdfRes.ok) {
            const ab = await pdfRes.arrayBuffer();
            const bytes = new Uint8Array(ab);
            pdfBytes = bytes.byteLength;
            const { pages } = await extractTextFromPdf(bytes);
            rows = parseOkListBookPdfText(pages);
          }
        } catch (err) {
          ctx.logger.warn(`${adapter.name}: list-book PDF extraction failed`, {
            error: err instanceof Error ? err.message : String(err),
            list_book_url: listBookUrl,
          });
        }
      }

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        bytes: rawBody.length,
        list_book_url: listBookUrl,
        pdf_bytes: pdfBytes,
        pdf_status: pdfStatus,
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'oklahoma-seb-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            byte_size: rawBody.length,
            http_status: status,
            list_book_url: listBookUrl,
            list_book_bytes: pdfBytes,
            list_book_http_status: pdfStatus,
            row_count: rows.length,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name?.trim()) return 'missing reported_name';
      if (!row.office_name?.trim()) return 'missing office_name';
      return null;
    },

    async insert(rows, refs, ctx): Promise<InsertStats> {
      return insertOkCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

async function insertOkCandidacies(
  rows: OkCandidacyRow[],
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
        continue;
      }
      if (ctx.dryRun) {
        stats.rowsInserted += 1;
        continue;
      }
      const personId = await findOrCreateStatePerson(ctx.pg, {
        name: row.reported_name,
        state_fips: STATE_FIPS,
        electionYear,
        source: 'ok-seb-candidacies',
        dataSourceId: refs.dataSourceId,
      });
      const candRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
        `INSERT INTO candidacies
           (election_id, person_id, party, status, filed_on, meta)
         VALUES ($1, $2, $3, 'active', $4::date, $5::jsonb)
         ON CONFLICT (election_id, person_id) DO UPDATE
           SET party = COALESCE(EXCLUDED.party, candidacies.party),
               filed_on = COALESCE(candidacies.filed_on, EXCLUDED.filed_on),
               status = CASE WHEN candidacies.status IN ('withdrew','disqualified')
                             THEN candidacies.status ELSE 'active' END
         RETURNING id, (xmax = 0) AS inserted`,
        [
          officeInfo.election_id,
          personId,
          row.party_raw,
          row.date_filed,
          JSON.stringify({
            source: 'ok-seb-candidacies',
            reported_office: row.office_name,
            data_source_id: refs.dataSourceId,
            ingestion_run_id: refs.ingestionRunId,
            source_row_id: row.source_row_id,
          }),
        ],
      );
      const candidacyId = candRes.rows[0]?.id;
      if (!candidacyId) {
        stats.rowsFailed += 1;
        continue;
      }
      if (candRes.rows[0]?.inserted) stats.rowsInserted += 1;
      else stats.rowsUpdated += 1;

      if (row.party_raw) {
        const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);
        if (partyId) {
          await ctx.pg.query(
            `INSERT INTO candidacy_party_lines
               (candidacy_id, party_id, ballot_line_order, nomination_method, qualified_on, data_source_id, meta)
             VALUES ($1, $2, 1, 'primary', $3::date, $4::uuid, $5::jsonb)
             ON CONFLICT (candidacy_id, party_id) DO UPDATE
               SET qualified_on = COALESCE(candidacy_party_lines.qualified_on, EXCLUDED.qualified_on),
                   data_source_id = COALESCE(EXCLUDED.data_source_id, candidacy_party_lines.data_source_id)`,
            [
              candidacyId,
              partyId,
              row.date_filed,
              refs.dataSourceId ?? null,
              JSON.stringify({ source: 'ok-seb-candidacies', reported_party: row.party_raw }),
            ],
          );
        }
      }
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({ type: 'other', message: `OK row: ${msg}`, rawInput: row });
    }
  }

  return stats;
}
