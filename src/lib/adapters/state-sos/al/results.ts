/**
 * Alabama Secretary of State — election results adapter (FIPS 01).
 *
 * Primary feed (per state-sos-sources.ts, verified 2026-04-23):
 *   https://www2.alabamavotes.gov/electionNight/statewideResultsByContest.aspx
 * Secondary:
 *   https://www.sos.alabama.gov/alabama-votes/voter/enr-current-list
 *
 * Format: HTML. The statewide-results-by-contest page renders one table
 * per contest; the <caption> or a preceding <h2> carries the office
 * title (e.g. "U.S. SENATE — REPUBLICAN PRIMARY").
 *
 * Primary-runoff semantics: AL holds a runoff ~6 weeks after the primary
 * when no candidate clears 50% within a party. See `primary-runoff.ts`.
 */

import {
  createStateSosAdapter,
  type StateResultRow,
  type StateReportingLevel,
} from '../base';
import {
  extractTables,
  findColumn,
  toNum,
  extractDistrict,
  type HtmlTable,
} from '../html-table';
import { applyPrimaryRunoffOutcome } from '../primary-runoff';
import { politeFetch } from '../../fetch-polite';

const SOURCE_URL =
  'https://www2.alabamavotes.gov/electionNight/statewideResultsByContest.aspx';
const STATE_FIPS = '01';

export type ReportingLevel = StateReportingLevel;

export function createAlResultsAdapter(
  options: { reportingLevel?: ReportingLevel; isRunoffStage?: boolean } = {},
) {
  const reportingLevel = options.reportingLevel ?? 'unofficial_partial';
  const isRunoffStage = options.isRunoffStage ?? false;
  return createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'alabama-sos-results',
    sourceType: 'sos_results_api',
    sourceUrl: SOURCE_URL,
    license: 'state_open_records',
    expectedMinRows: 0,
    tokenBucket: { rps: 0.5, burst: 2 },
    fetch: async () => {
      const res = await politeFetch(SOURCE_URL, {
        headers: { Accept: 'text/html,*/*' },
      });
      if (!res.ok) throw new Error(`AL fetch failed: ${res.status}`);
      return { rawBody: await res.text() };
    },
    parse: async (rawBody) =>
      parseAlabamaResults(rawBody, { reportingLevel, isRunoffStage }),
  });
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

const H = {
  candidate: ['candidate', 'candidatename', 'name'],
  party: ['party', 'partycode'],
  votes: ['votes', 'votecount', 'totalvotes', 'total'],
  pct: ['percent', 'percentage', 'pct', 'ofvotes'],
  precinctsReporting: ['precinctsreporting', 'reporting'],
  totalPrecincts: ['totalprecincts', 'precincts'],
};

export function splitAlabamaCaption(
  caption: string,
): { office: string; party: string | null } {
  const clean = caption.replace(/\s+/g, ' ').trim();
  const m =
    /^(.*?)(?:\s[—\-–]\s|\s\()\s*(DEMOCRATIC|REPUBLICAN|LIBERTARIAN|INDEPENDENT|GREEN|CONSTITUTION|REFORM)\s*(?:PRIMARY)?\)?\s*$/i.exec(
      clean,
    );
  if (m) {
    const pFull = m[2].toUpperCase();
    const p = pFull.startsWith('DEM') ? 'DEM' : pFull.startsWith('REP') ? 'REP' : pFull;
    return { office: m[1].trim(), party: p };
  }
  return { office: clean, party: null };
}

function rowsFromTable(
  table: HtmlTable,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const caption = table.caption ?? '';
  if (!caption) return [];
  const { office, party: captionParty } = splitAlabamaCaption(caption);
  const districtFromCaption = extractDistrict(caption);

  const candIdx = findColumn(table.headers, H.candidate);
  const partyIdx = findColumn(table.headers, H.party);
  const votesIdx = findColumn(table.headers, H.votes);
  const pctIdx = findColumn(table.headers, H.pct);
  const prIdx = findColumn(table.headers, H.precinctsReporting);
  const tpIdx = findColumn(table.headers, H.totalPrecincts);
  if (candIdx < 0 || votesIdx < 0) return [];

  const out: StateResultRow[] = [];
  for (const row of table.rows) {
    const name = row[candIdx];
    if (!name) continue;
    const partyCell = partyIdx >= 0 ? row[partyIdx] : null;
    const party = (partyCell && partyCell.trim()) || captionParty || null;
    const votes = toNum(row[votesIdx]);
    let pct = pctIdx >= 0 ? toNum(row[pctIdx]) : null;
    if (pct !== null && pct > 0 && pct <= 1) pct *= 100;
    const pr = prIdx >= 0 ? toNum(row[prIdx]) : null;
    const tp = tpIdx >= 0 ? toNum(row[tpIdx]) : null;
    const pctReporting =
      pr !== null && tp !== null && tp > 0 ? Math.round((pr / tp) * 1000) / 10 : null;

    out.push({
      reported_name: name,
      party_abbreviation: party,
      office_name: office,
      district_identifier: districtFromCaption,
      vote_count: votes,
      vote_percentage: pct,
      pct_precincts_reporting: pctReporting,
      is_winner: false,
      is_runoff_advancer: false,
      is_write_in: /write[-\s]?in/i.test(name),
      reporting_level: reportingLevel,
      source_row_id: `al::${office}::${districtFromCaption ?? ''}::${party ?? ''}::${name}`,
    });
  }
  return out;
}

export function parseAlabamaResults(
  body: string,
  opts: { reportingLevel?: ReportingLevel; isRunoffStage?: boolean } = {},
): StateResultRow[] {
  const reportingLevel = opts.reportingLevel ?? 'unofficial_partial';
  const tables = extractTables(body);
  const rows: StateResultRow[] = [];
  for (const t of tables) rows.push(...rowsFromTable(t, reportingLevel));
  applyPrimaryRunoffOutcome(rows, { enableRunoffs: !opts.isRunoffStage });
  return rows;
}
