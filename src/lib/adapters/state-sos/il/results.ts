/**
 * Illinois State Board of Elections — results adapter (FIPS 17).
 *
 * Source (verified 2026-04-23 per state-sos-sources.ts):
 *   https://www.elections.il.gov/electionoperations/ElectionResults.aspx
 *
 * IL publishes per-election summary HTML via the SBE "Election Results"
 * ASPX page. No NIST XML / JSON endpoint is documented. Per-election
 * details (county breakdowns) live behind separate ASPX queries that
 * require a session cookie — out of scope for this adapter; we scrape
 * the summary page only.
 *
 * Off-cycle: page shows a generic "select an election" form with no
 * result rows — parser returns [].
 */

import * as cheerio from 'cheerio';
import {
  createStateSosAdapter,
  type StateResultRow,
  type StateReportingLevel,
} from '../base';
import type { SourceAdapter } from '../../types';
import { politeFetch } from '../../fetch-polite';

export type ReportingLevel = StateReportingLevel;

const STATE_FIPS = '17';
const SOURCE_URL =
  'https://www.elections.il.gov/electionoperations/ElectionResults.aspx';

export function createIlResultsAdapter(
  options: { reportingLevel?: ReportingLevel; sourceUrl?: string } = {},
): SourceAdapter<StateResultRow> {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  const url = options.sourceUrl ?? SOURCE_URL;

  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'illinois-sbe-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    fetch: async () => {
      const res = await politeFetch(url, {
        headers: { Accept: 'text/html,*/*' },
      });
      if (!res.ok) {
        throw new Error(`IL fetch failed: HTTP ${res.status} from ${url}`);
      }
      return { rawBody: await res.text(), resolvedUrl: res.url };
    },
    parse: async (rawBody) => parseIlHtml(rawBody, reportingLevel),
  });

  adapter.costService = 'other';
  return adapter;
}

export function parseIlHtml(
  rawBody: string,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
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
    const nameCol = headerCells.findIndex(
      (h) => h.includes('candidate') || h === 'name',
    );
    const votesCol = headerCells.findIndex(
      (h) => h.includes('vote') || h === 'total',
    );
    const pctCol = headerCells.findIndex(
      (h) => h.includes('percent') || h.includes('%'),
    );
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    if (nameCol < 0 || (votesCol < 0 && pctCol < 0)) return;

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
      const reportedName = cells[nameCol] ?? '';
      if (!reportedName) return;
      rows.push({
        reported_name: reportedName,
        party_abbreviation:
          partyCol >= 0 ? cells[partyCol] || null : null,
        office_name: officeName,
        district_identifier: null,
        vote_count:
          votesCol >= 0 ? parseIntOrNull(cells[votesCol]) : null,
        vote_percentage:
          pctCol >= 0 ? parsePctOrNull(cells[pctCol]) : null,
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: /write[-\s]*in/i.test(reportedName),
        reporting_level: reportingLevel,
        source_row_id: `il-t${tableIdx}-r${rowIdx}`,
      });
    });
  });
  return rows;
}

function parseIntOrNull(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s.replace(/[, ]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function parsePctOrNull(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace(/[%, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}
