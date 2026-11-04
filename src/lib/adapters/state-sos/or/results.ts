/**
 * Oregon Secretary of State — election results adapter (FIPS 41).
 *
 * Source (verified 2026-04-23 via scripts/data/state-sos-sources.ts):
 *   https://sos.oregon.gov/voting-elections/Pages/default.aspx
 *
 * Live election-night results appear at results.oregonvotes.gov (per-cycle)
 * and historical certified results are posted under
 * https://sos.oregon.gov/elections/Pages/electionsstatistics.aspx as PDFs,
 * Excel workbooks, and HTML summary tables. There is no NIST XML feed.
 *
 * Strategy: fetch the landing HTML and parse any summary tables present.
 * Off-cycle / purely navigational pages yield []. The dispatcher may pass
 * a deep-linked `sourceUrl` during a hot window.
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

const STATE_FIPS = '41';
const DEFAULT_SOURCE_URL =
  'https://sos.oregon.gov/voting-elections/Pages/default.aspx';

export type OrParseOptions = {
  reportingLevel?: StateReportingLevel;
};

export function parseOregonResults(
  body: string,
  opts: OrParseOptions = {},
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
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    if (!hasCandidate || (votesCol < 0 && pctCol < 0)) return;

    let officeName = '';
    const $prev = $table.prevAll('h1,h2,h3,h4,caption').first();
    if ($prev.length) officeName = $prev.text().trim();
    const $caption = $table.find('caption').first();
    if (!officeName && $caption.length) officeName = $caption.text().trim();
    if (!officeName) officeName = 'Unknown Office';
    const districtId = extractDistrictFromOffice(officeName);

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
        district_identifier: districtId,
        vote_count: votesCol >= 0 ? parseIntOrNull(cells[votesCol]) : null,
        vote_percentage: pctCol >= 0 ? parsePctOrNull(cells[pctCol]) : null,
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: /write[-\s]*in/i.test(reportedName),
        reporting_level: reportingLevel,
        source_row_id: `or-t${tableIdx}-r${rowIdx}`,
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
function extractDistrictFromOffice(office: string): string | null {
  const m = office.match(/\b(?:district\s+|d\.?\s*)(\d{1,3})\b/i);
  if (m && m[1]) return m[1];
  const m2 = office.match(/\b(\d{1,3})(?:st|nd|rd|th)\s+district\b/i);
  if (m2 && m2[1]) return m2[1];
  return null;
}

export type CreateOrResultsAdapterOptions = {
  sourceUrl?: string;
  reportingLevel?: StateReportingLevel;
  electionYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createOrResultsAdapter(
  options: CreateOrResultsAdapterOptions = {},
): SourceAdapter<StateResultRow> {
  const url = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'or-sos-results',
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
          throw new Error(`OR fetch failed: HTTP ${res.status} from ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) =>
      parseOregonResults(body, { reportingLevel: options.reportingLevel }),
  });
  adapter.costService = 'other';
  return adapter;
}
