/**
 * Guam Election Commission — results adapter (FIPS 66).
 *
 * Source (verified 2026-04-23 via scripts/data/state-sos-sources.ts):
 *   https://gec.guam.gov/
 *
 * Guam's 2026 primary is scheduled for 2026-08-01 per GEC. GEC publishes
 * election-night results to the /results/ subpath as HTML and PDF; no NIST
 * XML feed exists. This adapter parses any well-formed results table it
 * finds and otherwise returns [].
 *
 * TODO: validate per-cycle URL once 2026 primary is live. The landing page
 * is expected to surface deep links to per-race result pages; caller can
 * pass `sourceUrl` to short-circuit discovery.
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

const STATE_FIPS = '66';
const DEFAULT_SOURCE_URL = 'https://gec.guam.gov/';

export type GuParseOptions = {
  reportingLevel?: StateReportingLevel;
};

export function parseGuamResults(
  body: string,
  opts: GuParseOptions = {},
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
    const pctCol = headerCells.findIndex(
      (h) => h.includes('percent') || h.includes('%'),
    );
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
      const name = cells[0];
      if (!name) return;
      rows.push({
        reported_name: name,
        party_abbreviation: null,
        office_name: officeName,
        district_identifier: null,
        vote_count: votesCol >= 0 ? parseIntOrNull(cells[votesCol]) : null,
        vote_percentage: pctCol >= 0 ? parsePctOrNull(cells[pctCol]) : null,
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: /write[-\s]*in/i.test(name),
        reporting_level: reportingLevel,
        source_row_id: `gu-t${tableIdx}-r${rowIdx}`,
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
function parsePctOrNull(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[%, ]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

export type CreateGuResultsAdapterOptions = {
  sourceUrl?: string;
  reportingLevel?: StateReportingLevel;
  electionYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createGuResultsAdapter(
  options: CreateGuResultsAdapterOptions = {},
): SourceAdapter<StateResultRow> {
  const url = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'gu-gec-results',
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
          throw new Error(`GU fetch failed: HTTP ${res.status} from ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) =>
      parseGuamResults(body, { reportingLevel: options.reportingLevel }),
  });
  adapter.costService = 'other';
  return adapter;
}
