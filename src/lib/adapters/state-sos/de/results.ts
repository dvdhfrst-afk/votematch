/**
 * Delaware Department of Elections — results adapter.
 *
 * Source (verified 2026-04-23 via scripts/data/state-sos-sources.ts):
 *   https://elections.delaware.gov/
 *
 * Format: HTML landing page. DE does not expose a machine-readable results
 * endpoint as of 2026-04-23; during cycles the "Election Results" link
 * publishes per-election PDFs + an HTML summary table. During off-cycle
 * windows (now) the page has no result rows at all.
 *
 * Strategy: fetch the landing page with cheerio and look for any
 * results-summary table (<table class="results-table"> or similar).
 * Off-cycle / malformed: parser returns [] — the run is classified as
 * 'partial' since expectedMinRows=1. Parser is exercised against synthetic
 * fixtures in __tests__/results.test.ts.
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

const STATE_FIPS = '10';
const SOURCE_URL = 'https://elections.delaware.gov/';

export async function fetchDeResultsHtml(
  _ctx: AdapterContext,
): Promise<StateFetchResult> {
  // Respect robots.txt + UA. No live fetches during implementation — this
  // body is consulted at runtime only.
  const res = await politeFetch(SOURCE_URL, {
    headers: { Accept: 'text/html' },
  });
  if (!res.ok) {
    throw new Error(
      `DE results fetch failed: HTTP ${res.status} from ${SOURCE_URL}`,
    );
  }
  const rawBody = await res.text();
  return { rawBody, resolvedUrl: res.url };
}

/**
 * Parse the DE results HTML. Accepts the landing page body.
 *
 * Heuristic: look for tables whose caption/first row contains "Candidate"
 * and any of "Votes", "Percent", "%". Each data row becomes one
 * StateResultRow. Off-cycle pages have no matching table — returns [].
 */
export async function parseDeResultsHtml(
  rawBody: string,
  _ctx: AdapterContext,
  reportingLevel: StateReportingLevel = 'unofficial_partial',
): Promise<StateResultRow[]> {
  if (!rawBody || rawBody.length < 64) return [];
  const $ = cheerio.load(rawBody);
  const rows: StateResultRow[] = [];

  // Delaware's legacy results layouts use <table> inside a section whose
  // <h2>/<h3> names the office. Walk each <table> and pair it with the
  // nearest preceding heading.
  $('table').each((tableIdx, tableEl) => {
    const $table = $(tableEl);
    const headerCells = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((_i, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headerCells.length === 0) return;
    const hasCandidate = headerCells.some((h) => h.includes('candidate'));
    const votesCol = headerCells.findIndex(
      (h) => h.includes('vote') || h === 'total',
    );
    const pctCol = headerCells.findIndex(
      (h) => h.includes('percent') || h.includes('%'),
    );
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    if (!hasCandidate || (votesCol < 0 && pctCol < 0)) return;

    // Office name = nearest preceding <h1>/<h2>/<h3> text.
    let officeName = '';
    const $prev = $table.prevAll('h1,h2,h3').first();
    if ($prev.length) officeName = $prev.text().trim();
    if (!officeName) officeName = 'Unknown Office';

    $table.find('tr').each((rowIdx, trEl) => {
      if (rowIdx === 0) return; // skip header
      const cells = $(trEl)
        .find('td')
        .map((_i, el) => $(el).text().trim())
        .get();
      if (cells.length === 0) return;
      // Candidate name assumed to be in the first cell.
      const reportedName = cells[0];
      if (!reportedName) return;
      const voteStr = votesCol >= 0 ? cells[votesCol] : '';
      const pctStr = pctCol >= 0 ? cells[pctCol] : '';
      const partyStr = partyCol >= 0 ? cells[partyCol] : null;
      rows.push({
        reported_name: reportedName,
        party_abbreviation: partyStr ? partyStr : null,
        office_name: officeName,
        district_identifier: null,
        vote_count: parseIntOrNull(voteStr),
        vote_percentage: parsePctOrNull(pctStr),
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: /write[-\s]*in/i.test(reportedName),
        reporting_level: reportingLevel,
        source_row_id: `de-t${tableIdx}-r${rowIdx}`,
      });
    });
  });

  return rows;
}

function parseIntOrNull(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[, ]/g, '');
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

function parsePctOrNull(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[%, ]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function createDeResultsAdapter(
  options: { reportingLevel?: StateReportingLevel } = {},
) {
  const reportingLevel = options.reportingLevel ?? 'unofficial_partial';
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'de-doe-results',
    sourceUrl: SOURCE_URL,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    fetch: fetchDeResultsHtml,
    parse: (body, ctx) => parseDeResultsHtml(body, ctx, reportingLevel),
  });
  adapter.costService = 'other';
  return adapter;
}
