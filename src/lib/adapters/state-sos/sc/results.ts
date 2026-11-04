/**
 * South Carolina State Election Commission (SCVotes) — results adapter.
 *
 * Source (verified 2026-04-23):
 *   https://www.scvotes.gov/
 *
 * Format: HTML landing page with results links during active cycles.
 * SCVotes results pages historically render per-contest tables on
 * www.scvotes.gov/results/ pages; we use the same table-header heuristic
 * used across the Mid-Atlantic scrapers for resilience. Off-cycle pages
 * have no tables and this adapter returns [].
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

const STATE_FIPS = '45';
const SOURCE_URL = 'https://www.scvotes.gov/';

export async function fetchScResultsHtml(
  _ctx: AdapterContext,
): Promise<StateFetchResult> {
  const res = await politeFetch(SOURCE_URL, {
    headers: { Accept: 'text/html' },
  });
  if (!res.ok) {
    throw new Error(
      `SC results fetch failed: HTTP ${res.status} from ${SOURCE_URL}`,
    );
  }
  const rawBody = await res.text();
  return { rawBody, resolvedUrl: res.url };
}

export async function parseScResultsHtml(
  rawBody: string,
  _ctx: AdapterContext,
  reportingLevel: StateReportingLevel = 'unofficial_partial',
): Promise<StateResultRow[]> {
  if (!rawBody || rawBody.length < 64) return [];
  const $ = cheerio.load(rawBody);
  const rows: StateResultRow[] = [];

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
        vote_count:
          votesCol >= 0
            ? Number.parseInt(cells[votesCol].replace(/[, ]/g, ''), 10) || null
            : null,
        vote_percentage:
          pctCol >= 0
            ? Number.parseFloat(cells[pctCol].replace(/[%, ]/g, '')) || null
            : null,
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: /write[-\s]*in/i.test(reportedName),
        reporting_level: reportingLevel,
        source_row_id: `sc-t${tableIdx}-r${rowIdx}`,
      });
    });
  });

  return rows;
}

export function createScResultsAdapter(
  options: { reportingLevel?: StateReportingLevel } = {},
) {
  const reportingLevel = options.reportingLevel ?? 'unofficial_partial';
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'sc-scvotes-results',
    sourceUrl: SOURCE_URL,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    fetch: fetchScResultsHtml,
    parse: (body, ctx) => parseScResultsHtml(body, ctx, reportingLevel),
  });
  adapter.costService = 'other';
  return adapter;
}
