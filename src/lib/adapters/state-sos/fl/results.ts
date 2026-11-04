/**
 * Florida Division of Elections — election results adapter (FIPS 12).
 *
 * Primary feed (per state-sos-sources.ts, verified 2026-04-23):
 *   https://dos.myflorida.com/elections/
 *
 * Shape Florida publishes
 * -----------------------
 * Historically the FL Division of Elections has published one-line-per-
 * contestant TAB-delimited text files under
 *   https://dos.fl.gov/elections/data-statistics/elections-data/election-results/
 * (e.g. `20240820ElecResultsFL.txt`). The CLAUDE.md brief flags this as a
 * complex parser; we handle it here.
 *
 * Wire format (from FL DoS published specs):
 *   Col   Field
 *   ---   ---------------------------------------------------------------
 *     0   ElectionDate    (YYYYMMDD)
 *     1   TypeOfElection  (PRI / GEN / ...)
 *     2   CountyCode      (blank on statewide aggregate rows)
 *     3   CountyName
 *     4   RaceCode
 *     5   OfficeDesc      ("Governor", "U.S. Representative", ...)
 *     6   District        ("001", "" when statewide)
 *     7   ContestName
 *     8   FullContestName
 *     9   CandidateFirstName
 *    10   CandidateLastName
 *    11   CandidateFullName
 *    12   CandidateParty  (REP / DEM / NPA / ...)
 *    13   CandidateFloridaPartyCode
 *    14   CandidateVoteTotal
 *    15   CandidatePercentageOfVotes
 *    16   PrecinctsReporting
 *    17   TotalPrecincts
 *    18   IsWinner        ("1" winner, "0" otherwise; sometimes blank)
 *
 * Older dumps sometimes omit columns or present a header row. We support
 * both: if a header row is detected we build a name→index map, otherwise
 * we fall back to the historical positional layout.
 *
 * A landing-page HTML body (no tabulation yet) yields an empty row set.
 */

import { load as loadHtml } from 'cheerio';
import { politeFetch } from '../../fetch-polite';
import {
  createStateSosAdapter,
  type StateResultRow,
  type StateReportingLevel,
} from '../base';

const SOURCE_URL = 'https://dos.myflorida.com/elections/';
const STATE_FIPS = '12';

export type ReportingLevel = StateReportingLevel;

export function createFlResultsAdapter(
  options: { reportingLevel?: ReportingLevel } = {},
) {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  return createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'florida-dos-results',
    sourceType: 'sos_results_api',
    sourceUrl: SOURCE_URL,
    license: 'state_open_records',
    expectedMinRows: 0,
    tokenBucket: { rps: 0.5, burst: 2 },
    fetch: async () => {
      const res = await politeFetch(SOURCE_URL, {
        headers: { Accept: 'text/plain,text/html,*/*' },
      });
      if (!res.ok) throw new Error(`FL fetch failed: ${res.status}`);
      return { rawBody: await res.text() };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (trimmed.startsWith('<')) {
        const links = discoverFloridaResultLinks(rawBody);
        if (links.length === 0) {
          ctx.logger.info(
            'fl-results: HTML landing page — no tabulation link found',
            { stateFips: STATE_FIPS },
          );
          return [];
        }
        ctx.logger.info(
          'fl-results: HTML landing page — tabulation link(s) discovered but not auto-followed',
          { stateFips: STATE_FIPS, count: links.length, sample: links[0] },
        );
        return [];
      }
      return parseFloridaTabulationTxt(rawBody, reportingLevel);
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Pull any anchor pointing at a .txt / .csv tabulation under the FL DoS
 * elections path. Returned verbatim so callers can decide whether to
 * follow (we don't cross-site-fetch here — policy is explicit URLs only).
 */
export function discoverFloridaResultLinks(html: string): string[] {
  const $ = loadHtml(html);
  const out: string[] = [];
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href) return;
    if (/\.(txt|csv)(?:[?#]|$)/i.test(href) && /election|result/i.test(href)) {
      out.push(href);
    }
  });
  return out;
}

const FL_HEADER_ALIASES: Record<string, string[]> = {
  county: ['countycode', 'county', 'countyname'],
  office: ['officedesc', 'office', 'racename', 'contestname'],
  district: ['district', 'districtnumber', 'dist'],
  candidateName: ['candidatefullname', 'candidatename', 'fullname'],
  candidateFirst: ['candidatefirstname', 'firstname'],
  candidateLast: ['candidatelastname', 'lastname'],
  party: ['candidateparty', 'partycode', 'party'],
  voteTotal: ['candidatevotetotal', 'votetotal', 'votes', 'totalvotes'],
  votePct: ['candidatepercentageofvotes', 'percentageofvotes', 'percentage'],
  precinctsReporting: ['precinctsreporting'],
  totalPrecincts: ['totalprecincts'],
  isWinner: ['iswinner', 'winner'],
  writeIn: ['iswritein', 'writein'],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (ch === delim && !inQuote) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function detectDelim(firstLine: string): string {
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs >= commas ? '\t' : ',';
}

function buildIndex(headerCols: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  const normed = headerCols.map(normalizeHeader);
  for (const [field, aliases] of Object.entries(FL_HEADER_ALIASES)) {
    for (const a of aliases) {
      const pos = normed.indexOf(a);
      if (pos >= 0) {
        idx[field] = pos;
        break;
      }
    }
  }
  return idx;
}

function get(row: string[], idx: Record<string, number>, field: string): string | null {
  const p = idx[field];
  if (p === undefined || p < 0 || p >= row.length) return null;
  const v = row[p];
  return v && v.length > 0 ? v : null;
}

function toNum(s: string | null): number | null {
  if (s === null) return null;
  const cleaned = s.replace(/[,%\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function truthyFlag(s: string | null): boolean {
  if (s === null) return false;
  const v = s.toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'y' || v === 'yes' || v === 'w';
}

export function parseFloridaTabulationTxt(
  body: string,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  if (!body || body.trim().length === 0) return [];
  const cleaned = body.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = cleaned.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const delim = detectDelim(lines[0]);
  const header = splitDelimited(lines[0], delim);
  const idx = buildIndex(header);

  const hasHeader =
    idx.office !== undefined &&
    (idx.candidateName !== undefined || idx.candidateLast !== undefined);
  const rowStart = hasHeader ? 1 : 0;

  if (!hasHeader) {
    idx.county = 3;
    idx.office = 5;
    idx.district = 6;
    idx.candidateFirst = 9;
    idx.candidateLast = 10;
    idx.candidateName = 11;
    idx.party = 12;
    idx.voteTotal = 14;
    idx.votePct = 15;
    idx.precinctsReporting = 16;
    idx.totalPrecincts = 17;
    idx.isWinner = 18;
  }

  const rows: StateResultRow[] = [];
  for (let i = rowStart; i < lines.length; i += 1) {
    const cols = splitDelimited(lines[i], delim);
    if (cols.length < 3) continue;

    const county = get(cols, idx, 'county');
    // Keep only statewide aggregate rows (blank/zero county code).
    if (county && county.trim().length > 0 && county.trim() !== '0') continue;

    const office = get(cols, idx, 'office');
    if (!office) continue;
    const name =
      get(cols, idx, 'candidateName') ??
      [get(cols, idx, 'candidateFirst'), get(cols, idx, 'candidateLast')]
        .filter((s): s is string => !!s)
        .join(' ')
        .trim();
    if (!name) continue;

    const district = get(cols, idx, 'district');
    const districtId =
      district && district.replace(/^0+/, '') !== '' ? district.replace(/^0+/, '') : null;

    const voteCount = toNum(get(cols, idx, 'voteTotal'));
    let votePct = toNum(get(cols, idx, 'votePct'));
    if (votePct !== null && votePct > 0 && votePct <= 1) votePct *= 100;

    const pr = toNum(get(cols, idx, 'precinctsReporting'));
    const tp = toNum(get(cols, idx, 'totalPrecincts'));
    const pctPrecincts =
      pr !== null && tp !== null && tp > 0
        ? Math.round((pr / tp) * 1000) / 10
        : null;

    rows.push({
      reported_name: name,
      party_abbreviation: get(cols, idx, 'party'),
      office_name: office,
      district_identifier: districtId,
      vote_count: voteCount,
      vote_percentage: votePct,
      pct_precincts_reporting: pctPrecincts,
      is_winner: truthyFlag(get(cols, idx, 'isWinner')),
      is_runoff_advancer: false,
      is_write_in: truthyFlag(get(cols, idx, 'writeIn')) || /write[-\s]?in/i.test(name),
      reporting_level: reportingLevel,
      source_row_id: `fl::${office}::${districtId ?? ''}::${name}`,
    });
  }
  return rows;
}
