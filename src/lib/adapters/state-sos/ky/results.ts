/**
 * Kentucky Secretary of State — election results adapter (FIPS 21).
 *
 * Primary feed (per state-sos-sources.ts, verified 2026-04-23):
 *   https://www.sos.ky.gov/Pages/default.aspx
 * Format: HTML tables, one per contest.
 *
 * Note on runoffs: Kentucky does not hold statutory primary runoffs for
 * state/federal offices — nominees are decided by plurality. Default is
 * plurality; the `enableRunoffs` option exists for defensive/future use.
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

const SOURCE_URL = 'https://www.sos.ky.gov/Pages/default.aspx';
const STATE_FIPS = '21';

export type ReportingLevel = StateReportingLevel;

export function createKyResultsAdapter(
  options: { reportingLevel?: ReportingLevel; enableRunoffs?: boolean } = {},
) {
  const reportingLevel = options.reportingLevel ?? 'unofficial_partial';
  const enableRunoffs = options.enableRunoffs ?? false;
  return createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'kentucky-sos-results',
    sourceType: 'sos_results_api',
    sourceUrl: SOURCE_URL,
    license: 'state_open_records',
    expectedMinRows: 0,
    tokenBucket: { rps: 0.5, burst: 2 },
    fetch: async () => {
      const res = await politeFetch(SOURCE_URL, {
        headers: { Accept: 'text/html,*/*' },
      });
      if (!res.ok) throw new Error(`KY fetch failed: ${res.status}`);
      return { rawBody: await res.text() };
    },
    parse: async (rawBody) =>
      parseKentuckyResults(rawBody, { reportingLevel, enableRunoffs }),
  });
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

const H = {
  candidate: ['candidate', 'candidatename', 'name'],
  party: ['party', 'partycode'],
  votes: ['votes', 'votecount', 'totalvotes', 'total'],
  pct: ['percent', 'percentage', 'pct'],
  precinctsReporting: ['precinctsreporting', 'reporting'],
  totalPrecincts: ['totalprecincts', 'precincts'],
};

export function splitKentuckyCaption(
  caption: string,
): { office: string; party: string | null } {
  const clean = caption.replace(/\s+/g, ' ').trim();
  const m =
    /^(.*?)(?:\s[—\-–]\s|\s\()\s*(DEMOCRATIC|REPUBLICAN|LIBERTARIAN|INDEPENDENT|GREEN|CONSTITUTION)\s*(?:PRIMARY)?\)?\s*$/i.exec(
      clean,
    );
  if (m) {
    const p = m[2].toUpperCase();
    return {
      office: m[1].trim(),
      party: p.startsWith('DEM') ? 'DEM' : p.startsWith('REP') ? 'REP' : p,
    };
  }
  return { office: clean, party: null };
}

function rowsFromTable(
  table: HtmlTable,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const caption = table.caption ?? '';
  if (!caption) return [];
  const { office, party: captionParty } = splitKentuckyCaption(caption);
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
      source_row_id: `ky::${office}::${districtFromCaption ?? ''}::${party ?? ''}::${name}`,
    });
  }
  return out;
}

export function parseKentuckyResults(
  body: string,
  opts: { reportingLevel?: ReportingLevel; enableRunoffs?: boolean } = {},
): StateResultRow[] {
  const reportingLevel = opts.reportingLevel ?? 'unofficial_partial';
  const tables = extractTables(body);
  const rows: StateResultRow[] = [];
  for (const t of tables) rows.push(...rowsFromTable(t, reportingLevel));
  applyPrimaryRunoffOutcome(rows, { enableRunoffs: opts.enableRunoffs ?? false });
  return rows;
}
