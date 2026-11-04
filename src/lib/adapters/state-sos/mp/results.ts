/**
 * Commonwealth of the Northern Mariana Islands (CNMI) Commonwealth Election
 * Commission — results adapter (FIPS 69).
 *
 * Source (verified 2026-04-23 via scripts/data/state-sos-sources.ts):
 *   https://www.votecnmi.gov.mp/
 *
 * TODO — CNMI has no electoral event on the 2026 primary calendar (per NCSL
 * + seed file: `primary_date_2026: null`; CNMI's statewide elections run on
 * even-year cycles with gubernatorial contests in 2026 held as general
 * elections in November, no separate primary). Adapter ships empty-safe so
 * a dispatcher poll during the cycle will harmlessly return [].
 */

import * as cheerio from 'cheerio';
import {
  createStateSosAdapter,
  type StateFetchResult,
  type StateReportingLevel,
  type StateResultRow,
} from '../base';
import type { AdapterContext, SourceAdapter } from '../../types';
import { politeFetch } from '../../fetch-polite';

const STATE_FIPS = '69';
const DEFAULT_SOURCE_URL = 'https://www.votecnmi.gov.mp/';

export type MpParseOptions = {
  reportingLevel?: StateReportingLevel;
};

export function parseCnmiResults(
  body: string,
  opts: MpParseOptions = {},
): StateResultRow[] {
  if (!body || body.length < 64) return [];
  const reportingLevel = opts.reportingLevel ?? 'unofficial_partial';
  const $ = cheerio.load(body);
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
      (h) => h.includes('vote') || h === 'total',
    );
    if (!hasCandidate || votesCol < 0) return;

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
      const name = cells[0];
      if (!name) return;
      rows.push({
        reported_name: name,
        party_abbreviation: null,
        office_name: officeName,
        district_identifier: null,
        vote_count: parseIntOrNull(cells[votesCol]),
        vote_percentage: null,
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: /write[-\s]*in/i.test(name),
        reporting_level: reportingLevel,
        source_row_id: `mp-t${tableIdx}-r${rowIdx}`,
      });
    });
  });
  return rows;
}

function parseIntOrNull(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[, ]/g, '');
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

export type CreateMpResultsAdapterOptions = {
  sourceUrl?: string;
  reportingLevel?: StateReportingLevel;
  electionYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createMpResultsAdapter(
  options: CreateMpResultsAdapterOptions = {},
): SourceAdapter<StateResultRow> {
  const url = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'mp-cec-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: options.electionYear,
    fetch:
      options.fetchImpl ??
      (async () => {
        const res = await politeFetch(url, {
          headers: { Accept: 'text/html' },
        });
        if (!res.ok) {
          throw new Error(`MP fetch failed: HTTP ${res.status} from ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) =>
      parseCnmiResults(body, { reportingLevel: options.reportingLevel }),
  });
  adapter.costService = 'other';
  return adapter;
}
