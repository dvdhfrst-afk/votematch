/**
 * DC Board of Elections — results adapter.
 *
 * Source (verified 2026-04-23):
 *   https://electionresults.dcboe.org/
 *
 * Format: HTML summary page with results tables per contest. DCBOE is the
 * authoritative source for DC election results. On election night the page
 * renders a set of per-office result cards; each card has the office name
 * in a header and candidate rows beneath.
 *
 * Off-cycle: the page is mostly navigation — parser returns [].
 */

import * as cheerio from 'cheerio';
import {
  createStateSosAdapter,
  type StateResultRow,
  type StateFetchResult,
  type StateReportingLevel,
} from '../base';
import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';

const STATE_FIPS = '11';
const SOURCE_URL = 'https://electionresults.dcboe.org/';

export async function fetchDcResultsHtml(
  _ctx: AdapterContext,
): Promise<StateFetchResult> {
  const res = await politeFetch(SOURCE_URL, {
    headers: { Accept: 'text/html' },
  });
  if (!res.ok) {
    throw new Error(
      `DC results fetch failed: HTTP ${res.status} from ${SOURCE_URL}`,
    );
  }
  const rawBody = await res.text();
  return { rawBody, resolvedUrl: res.url };
}

export async function parseDcResultsHtml(
  rawBody: string,
  _ctx: AdapterContext,
  reportingLevel: StateReportingLevel = 'unofficial_partial',
): Promise<StateResultRow[]> {
  if (!rawBody || rawBody.length < 64) return [];
  const $ = cheerio.load(rawBody);
  const rows: StateResultRow[] = [];

  // DCBOE historically renders each contest as a section with class
  // 'contest' / 'race' / just a table inside a div. We use the same
  // table-header heuristic as the other state scrapers for resilience.
  $('table').each((tableIdx, tableEl) => {
    const $table = $(tableEl);
    const headerCells = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((_i, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headerCells.length === 0) return;
    const hasCandidate = headerCells.some(
      (h) => h.includes('candidate') || h.includes('name'),
    );
    const votesCol = headerCells.findIndex(
      (h) => h.includes('vote') || h.includes('total'),
    );
    const pctCol = headerCells.findIndex(
      (h) => h.includes('percent') || h.includes('%'),
    );
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    if (!hasCandidate || (votesCol < 0 && pctCol < 0)) return;

    let officeName = '';
    const $prev = $table.prevAll('h1,h2,h3,h4,caption').first();
    if ($prev.length) officeName = $prev.text().trim();
    const $caption = $table.find('caption').first();
    if (!officeName && $caption.length) officeName = $caption.text().trim();
    if (!officeName) officeName = 'Unknown Office';

    $table.find('tr').each((rowIdx, trEl) => {
      if (rowIdx === 0) return;
      const cells = $(trEl)
        .find('td')
        .map((_i, el) => $(el).text().trim())
        .get();
      if (cells.length === 0) return;
      const reportedName = cells[0];
      if (!reportedName) return;
      rows.push({
        reported_name: reportedName,
        party_abbreviation:
          partyCol >= 0 && cells[partyCol] ? cells[partyCol] : null,
        office_name: officeName,
        district_identifier: null,
        vote_count: votesCol >= 0 ? parseIntOrNull(cells[votesCol]) : null,
        vote_percentage: pctCol >= 0 ? parsePctOrNull(cells[pctCol]) : null,
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: /write[-\s]*in/i.test(reportedName),
        reporting_level: reportingLevel,
        source_row_id: `dc-t${tableIdx}-r${rowIdx}`,
      });
    });
  });

  return rows;
}

function parseIntOrNull(s: string): number | null {
  if (!s) return null;
  const n = parseInt(s.replace(/[, ]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function parsePctOrNull(s: string): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace(/[%, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function createDcResultsAdapter(
  options: { reportingLevel?: StateReportingLevel } = {},
) {
  const reportingLevel = options.reportingLevel ?? 'unofficial_partial';
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'dc-dcboe-results',
    sourceUrl: SOURCE_URL,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    fetch: fetchDcResultsHtml,
    parse: (body, ctx) => parseDcResultsHtml(body, ctx, reportingLevel),
  });
  adapter.costService = 'other';
  return adapter;
}
