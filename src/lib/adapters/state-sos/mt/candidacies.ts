/**
 * Montana Secretary of State — 2026 candidate-filings adapter (FIPS 30).
 *
 * Primary is 2026-06-02 (open primary; voter chooses ballot at polls per
 * Mont. Code Ann. § 13-10-301). Filing window for federal/state offices:
 * 2026-01-08 → 2026-03-09.
 *
 * Source (live-verified 2026-04-25):
 *   https://candidatefiling.mt.gov/candidatefiling/CandidateList.aspx?e=450002928
 *
 * Page is the official MT candidate-filing portal driven by a Telerik
 * RadGrid (id `ctl00_ContentPlaceHolder1_grdCandidates_ctl00`) in an
 * ASP.NET WebForms shell. The election dropdown ("FEDERAL PRIMARY 2026")
 * is the single 2026 election registered on this portal at the time of
 * writing — eid=450002928. The URL above is the canonical landing.
 *
 * Server reports 380 candidates across 143 offices (federal + state +
 * judicial) as of fetch time. Page size is fixed to 100 rows by the
 * portal — paging is driven by Telerik __doPostBack with NextPage /
 * direct page number commands. Without a browser only the initial
 * server response (one page) is fetched; cheerio extracts rows from it.
 * Rows that are only populated client-side are not reachable, so a run
 * may yield 0 rows.
 *
 * Race-name shape (from the "Race" column):
 *   - "UNITED STATES SENATOR"                 (statewide)
 *   - "UNITED STATES REPRESENTATIVE"           (district 1 or 2 — see
 *                                               "District" col, e.g.
 *                                               "1ST CONGRESSIONAL")
 *   - "STATE SENATOR DISTRICT N"               (district embedded in name)
 *   - "PUBLIC SERVICE COMMISSIONER, DISTRICT N"
 *   - "SUPREME COURT JUSTICE #N"               (statewide; nonpartisan)
 *   - "DISTRICT COURT JUDGE DISTRICT N, DEPT M" (judicial district;
 *                                                nonpartisan)
 *
 * Status filter:
 *   Only "FILED" rows are ingested. "Withdrawn", "REMOVED", "PENDING
 *   PETITION" are skipped at parse time so the candidacy table reflects
 *   the live ballot only. Future: a withdrawn-row handler can flip the
 *   candidacies.status to 'withdrew' if a row was previously ingested
 *   as 'active' and now appears withdrawn.
 *
 * Party legend (per the page footer):
 *   DEM = Democratic, REP = Republican, LIB = Libertarian,
 *   IND = Independent, MP = Minor Party, NON = Non-Partisan
 *
 * "* = Incumbent" prefix is stripped from the Name cell at parse time.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

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
import { politeFetch } from '../../fetch-polite';

const STATE_FIPS = '30';
const PRIMARY_DATE = '2026-06-02';
const DEFAULT_SOURCE_URL =
  'https://candidatefiling.mt.gov/candidatefiling/CandidateList.aspx?e=450002928';

export type MtCandidacyRow = GenericCandidacyRow & {
  /** The free-form office text from the "Race" column (pre-normalization). */
  office_raw: string;
  /** District type from the page (e.g. 'Senate', 'Congressional', 'Statewide'). */
  district_type_raw: string;
  /** District text from the page (e.g. 'SENATE DISTRICT 11', '1ST CONGRESSIONAL'). */
  district_raw: string;
  /** Filing date (ISO yyyy-mm-dd) if parseable, else null. */
  date_filed: string | null;
  /** Was the row tagged with the "* = Incumbent" marker? */
  is_incumbent: boolean;
};

export type CreateMtCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  /** Test-only override: supply pre-fetched HTML pages directly. */
  fetchOverride?: () => Promise<{
    pages: string[];
    contentHash: string;
    resolvedUrl?: string;
    meta?: Record<string, unknown>;
  }>;
  /** Test-only parser override (consumes one page of HTML). */
  parseOverride?: (rawBody: string) => MtCandidacyRow[];
  /** Cap on how many pages to fetch (defaults to 10 — the portal currently has 4). */
  maxPages?: number;
  /** Floor for run-status classification; defaults to 50. */
  expectedMinRows?: number;
};

// ---------------------------------------------------------------------------
// Pure parser (one page of HTML)
// ---------------------------------------------------------------------------

const ORDINAL_TO_INT: Record<string, string> = {
  '1ST': '1', FIRST: '1',
  '2ND': '2', SECOND: '2',
  '3RD': '3', THIRD: '3',
  '4TH': '4', FOURTH: '4',
  '5TH': '5', FIFTH: '5',
  '6TH': '6', SIXTH: '6',
  '7TH': '7', SEVENTH: '7',
  '8TH': '8', EIGHTH: '8',
  '9TH': '9', NINTH: '9',
  '10TH': '10', TENTH: '10',
};

/**
 * Parse one rendered page of the MT Telerik RadGrid into MtCandidacyRow[].
 * Skips withdrawn/removed/pending-petition rows; strips the "*" incumbent
 * prefix from the Name cell.
 *
 * Visible cell order (14 columns):
 *   0  Status              ('FILED' | 'Withdrawn' | 'PENDING PETITION' | 'REMOVED')
 *   1  District Type       ('Senate' | 'Congressional' | 'Judicial' | 'Statewide' | …)
 *   2  District            ('SENATE DISTRICT 11', '1ST CONGRESSIONAL', 'STATE', …)
 *   3  Race                ('UNITED STATES SENATOR', 'STATE SENATOR DISTRICT 11', …)
 *   4  Term Type           ('REGULAR' | 'PARTIAL')
 *   5  Term Length         ('6', '4', '2', …)
 *   6  Name                ('ALEX EXAMPLE' or '*SAM SAMPLETON' for incumbent)
 *   7  Mailing Address
 *   8  Email/Web Address
 *   9  Phone
 *   10 Filing Date         ('2/17/2026 9:08:45 AM')
 *   11 Party Preference    ('DEM' | 'REP' | 'LIB' | 'IND' | 'NON' | 'MP')
 *   12 Ballot Order
 *   13 Status (duplicate)
 *
 * Exported for tests.
 */
export function parseMtCandidates(rawBody: string): MtCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  const $ = cheerio.load(rawBody);
  const out: MtCandidacyRow[] = [];

  $('tr.rgRow, tr.rgAltRow').each((_idx, tr) => {
    const cells = $(tr)
      .children('td')
      .map((_i, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get();
    if (cells.length < 12) return;

    const status = cells[0] ?? '';
    const districtType = cells[1] ?? '';
    const districtRaw = cells[2] ?? '';
    const raceRaw = cells[3] ?? '';
    let nameRaw = cells[6] ?? '';
    const dateRaw = cells[10] ?? '';
    const partyRaw = cells[11] ?? '';

    if (!nameRaw || !raceRaw || !partyRaw) return;

    // Only ingest active filings.
    if (!/^FILED$/i.test(status)) return;

    // "* = Incumbent" prefix.
    let isIncumbent = false;
    if (nameRaw.startsWith('*')) {
      isIncumbent = true;
      nameRaw = nameRaw.slice(1).trim();
    }
    if (!nameRaw) return;

    const officeName = normalizeMtOfficeName(raceRaw);
    const district = extractMtDistrictId(raceRaw, districtRaw, districtType);
    const dateFiled = normalizeMtFilingDate(dateRaw);

    const sourceRowId = [
      'mt',
      officeName.toLowerCase().replace(/\s+/g, '-'),
      district ?? '-',
      partyRaw.toLowerCase(),
      nameRaw.toLowerCase().replace(/\s+/g, '-'),
    ].join('|');

    out.push({
      reported_name: nameRaw,
      office_name: officeName,
      district_identifier: district,
      party_raw: partyRaw,
      source_row_id: sourceRowId,
      // MT-specific extras (kept on the row for provenance, ignored by
      // insertGenericCandidacies but useful for tests + downstream analytics):
      office_raw: raceRaw,
      district_type_raw: districtType,
      district_raw: districtRaw,
      date_filed: dateFiled,
      is_incumbent: isIncumbent,
    });
  });

  return out;
}

/**
 * Map the MT "Race" column to a canonical office name our resolver can
 * place against the offices table. Kept conservative — strips the
 * district suffix from STATE SENATOR / PUBLIC SERVICE COMMISSIONER / etc.
 * so resolveOfficeElection() can match against office_types.canonical_name
 * and we hand the district off via district_identifier.
 *
 * Examples:
 *   'UNITED STATES SENATOR'                       → 'United States Senator'
 *   'UNITED STATES REPRESENTATIVE'                → 'United States Representative'
 *   'STATE SENATOR DISTRICT 11'                   → 'State Senator'
 *   'STATE REPRESENTATIVE DISTRICT 42'            → 'State Representative'
 *   'PUBLIC SERVICE COMMISSIONER, DISTRICT 1'     → 'Public Service Commissioner'
 *   'SUPREME COURT JUSTICE #4'                    → 'Supreme Court Justice'
 *   'DISTRICT COURT JUDGE DISTRICT 7, DEPT 2'     → 'District Court Judge'
 *
 * Exported for tests.
 */
export function normalizeMtOfficeName(raceRaw: string): string {
  if (!raceRaw) return '';
  let s = raceRaw.trim();
  // Drop any trailing district / department clauses.
  s = s.replace(/\s*,?\s*DISTRICT\s+\d+.*$/i, '');
  s = s.replace(/\s+DISTRICT\s+\d+.*$/i, '');
  s = s.replace(/\s*#\s*\d+\s*$/, '');
  s = s.replace(/,?\s*DEPT\.?\s*\d+\s*$/i, '');
  s = s.trim();
  // Title-case the words; keep "of" lowercase.
  return s
    .split(/\s+/)
    .map((w, i) => {
      const lo = w.toLowerCase();
      if (i > 0 && lo === 'of') return 'of';
      return lo.charAt(0).toUpperCase() + lo.slice(1);
    })
    .join(' ');
}

/**
 * Extract the district identifier as a bare integer string. Looks first at
 * the Race column (where most district info lives) and falls back to the
 * District column for U.S. House (where the Race column is just
 * "UNITED STATES REPRESENTATIVE" and the district lives in "1ST CONGRESSIONAL").
 *
 * Returns null for true statewide / nonpartisan-statewide races.
 *
 * Exported for tests.
 */
export function extractMtDistrictId(
  raceRaw: string,
  districtRaw: string,
  districtType: string,
): string | null {
  const haystacks = [raceRaw, districtRaw];

  // 1. "DISTRICT N" or "DISTRICT NN" (Senate, Public Service Commissioner,
  //    State Representative, Judicial District N).
  for (const h of haystacks) {
    const m = /\bDISTRICT\s+0*(\d{1,3})\b/i.exec(h ?? '');
    if (m && m[1]) return m[1];
  }

  // 2. "Nth CONGRESSIONAL" (in the District column for U.S. House).
  for (const h of haystacks) {
    const mOrd = /\b(\d+(?:ST|ND|RD|TH)|FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH)\s+CONGRESSIONAL\b/i.exec(
      h ?? '',
    );
    if (mOrd && mOrd[1]) {
      const tok = mOrd[1].toUpperCase();
      if (ORDINAL_TO_INT[tok]) return ORDINAL_TO_INT[tok];
      const mDigit = /^(\d+)/.exec(tok);
      if (mDigit) return mDigit[1] ?? null;
    }
  }

  // 3. "JUDICIAL DISTRICT N" — same shape as DISTRICT N above, already handled.

  // 4. Statewide / Supreme Court — no district. The "Statewide" district
  //    type label is the strongest signal here, but a missing match above
  //    is sufficient.
  if (/^statewide$/i.test(districtType ?? '')) return null;

  return null;
}

/**
 * Convert "M/D/YYYY HH:MM:SS AM" → 'YYYY-MM-DD'. Returns null on any
 * unrecognized shape.
 */
function normalizeMtFilingDate(raw: string): string | null {
  if (!raw) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(raw.trim());
  if (!m) return null;
  const mm = m[1]!.padStart(2, '0');
  const dd = m[2]!.padStart(2, '0');
  const yRaw = m[3]!;
  const yyyy = yRaw.length === 2 ? `20${yRaw}` : yRaw;
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Single-page fetcher
// ---------------------------------------------------------------------------

type FetchPagesResult = {
  pages: string[];
  contentHash: string;
  resolvedUrl: string;
  meta: Record<string, unknown>;
};

/**
 * Fetch the MT candidate-filing portal once with politeFetch and return
 * the HTML as served. The grid is a Telerik RadGrid that is populated by
 * a client-side AJAX postback and paged by __doPostBack; without a
 * browser only the initial server response is available, so this
 * typically yields 0 rows (or the first page when the server renders it).
 * No browser automation is used.
 */
async function fetchMtFirstPage(url: string): Promise<FetchPagesResult> {
  const startedAt = Date.now();
  const res = await politeFetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  const body = await res.text();
  if (res.status >= 400) {
    throw new Error(`mt-candidacies: HTTP ${res.status} from ${url}`);
  }
  const contentHash = createHash('sha256').update(body).digest('hex');
  return {
    pages: [body],
    contentHash,
    resolvedUrl: res.url || url,
    meta: {
      fetcher: 'polite-fetch-single-page',
      pages_fetched: 1,
      http_status: res.status,
      elapsed_ms: Date.now() - startedAt,
    },
  };
}


// ---------------------------------------------------------------------------

export function createMtCandidaciesAdapter(
  options: CreateMtCandidaciesAdapterOptions = {},
): SourceAdapter<MtCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? new Date().getUTCFullYear();
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);
  const maxPages = Math.max(1, Math.min(20, options.maxPages ?? 10));
  const expectedMinRows = options.expectedMinRows ?? 50;

  const adapter: SourceAdapter<MtCandidacyRow> = {
    name: 'sos-montana-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<MtCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('mt-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
        maxPages,
      });

      let outcome: FetchPagesResult;
      try {
        if (options.fetchOverride) {
          const overrideOut = await options.fetchOverride();
          outcome = {
            pages: overrideOut.pages,
            contentHash: overrideOut.contentHash,
            resolvedUrl: overrideOut.resolvedUrl ?? sourceUrl,
            meta: overrideOut.meta ?? {},
          };
        } else {
          // Single plain fetch. Paging needs a browser, so only the first
          // server-rendered page is read; rows that need client-side
          // rendering are skipped.
          outcome = await fetchMtFirstPage(sourceUrl);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn('mt-candidacies: fetch failed — returning empty', {
          error: msg,
        });
        return {
          rows: [],
          expectedMinRows,
          source: {
            sourceType: 'sos_candidate_filing',
            name: 'montana-sos-candidacies',
            url: sourceUrl,
            contentHash: createHash('sha256').update('').digest('hex'),
            license: 'state_open_records',
            stateFips: STATE_FIPS,
            meta: {
              election_year: electionYear,
              primary_date: PRIMARY_DATE,
              fetch_error: msg.slice(0, 500),
            },
          },
          parserSignal: 'parse_failed',
        };
      }

      const parser = options.parseOverride ?? parseMtCandidates;
      const rows: MtCandidacyRow[] = [];
      const seen = new Set<string>();
      let parseFailures = 0;

      for (const html of outcome.pages) {
        try {
          const pageRows = parser(html);
          for (const row of pageRows) {
            if (seen.has(row.source_row_id)) continue;
            seen.add(row.source_row_id);
            rows.push(row);
          }
        } catch (err) {
          parseFailures += 1;
          ctx.logger.warn('mt-candidacies: parse error on a page', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      ctx.logger.info('mt-candidacies: parsed', {
        pages: outcome.pages.length,
        rowCount: rows.length,
        parseFailures,
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'montana-sos-candidacies',
          url: outcome.resolvedUrl ?? sourceUrl,
          contentHash: outcome.contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            page_count: outcome.pages.length,
            parse_failures: parseFailures,
            ...(outcome.meta ?? {}),
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) return 'missing reported_name';
      if (!row.office_name || !row.office_name.trim()) return 'missing office_name';
      if (!row.party_raw || !row.party_raw.trim()) return 'missing party_raw';
      return null;
    },

    async insert(rows, refs, ctx) {
      return insertGenericCandidacies(rows, refs, ctx, {
        stateFips: STATE_FIPS,
        electionYear,
        source: 'sos-montana-candidacies',
        // 'NON' = nonpartisan (judicial races); skip party-line insert.
        isNonpartisan: (row) =>
          /^NON$/i.test(row.party_raw ?? '') ||
          /^NONPARTISAN$/i.test(row.party_raw ?? ''),
      });
    },
  };

  return adapter;
}
