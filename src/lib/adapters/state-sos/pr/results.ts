/**
 * Puerto Rico Comisión Estatal de Elecciones (CEE) — results adapter
 * (FIPS 72).
 *
 * Source (verified 2026-04-23 via scripts/data/state-sos-sources.ts):
 *   https://ww2.ceepur.org/
 *   https://ww2.ceepur.org/home/eventoselectorales
 *
 * TODO — Puerto Rico's statewide elections cycle is on presidential years
 * (next: 2028). There is no PR primary or general on the 2026 calendar
 * (seed file: `primary_date_2026: null`). This adapter ships empty-safe so
 * nightly polls during 2026 will return [] without error; it can be wired
 * up in the 2028 cycle.
 *
 * CEE's site is Spanish-language; the table header heuristics below look
 * for both English ("candidate", "votes") and Spanish ("candidato",
 * "votos", "porcentaje") tokens.
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

const STATE_FIPS = '72';
const DEFAULT_SOURCE_URL = 'https://ww2.ceepur.org/';

export type PrParseOptions = {
  reportingLevel?: StateReportingLevel;
};

export function parsePuertoRicoResults(
  body: string,
  opts: PrParseOptions = {},
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
      (h) =>
        h.includes('candidate') ||
        h.includes('candidato') ||
        h.includes('nombre') ||
        h.includes('name'),
    );
    const votesCol = headerCells.findIndex(
      (h) =>
        h.includes('vote') || h === 'total' || h.includes('voto'),
    );
    const pctCol = headerCells.findIndex(
      (h) =>
        h.includes('percent') || h.includes('%') || h.includes('porcentaje'),
    );
    const partyCol = headerCells.findIndex(
      (h) => h.includes('party') || h.includes('partido'),
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
        party_abbreviation:
          partyCol >= 0 && cells[partyCol] ? cells[partyCol] : null,
        office_name: officeName,
        district_identifier: null,
        vote_count: votesCol >= 0 ? parseIntOrNull(cells[votesCol]) : null,
        vote_percentage: pctCol >= 0 ? parsePctOrNull(cells[pctCol]) : null,
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: /write[-\s]*in|candidato por nominacion directa/i.test(name),
        reporting_level: reportingLevel,
        source_row_id: `pr-t${tableIdx}-r${rowIdx}`,
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

export type CreatePrResultsAdapterOptions = {
  sourceUrl?: string;
  reportingLevel?: StateReportingLevel;
  electionYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createPrResultsAdapter(
  options: CreatePrResultsAdapterOptions = {},
): SourceAdapter<StateResultRow> {
  const url = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'pr-cee-results',
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
          throw new Error(`PR fetch failed: HTTP ${res.status} from ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) =>
      parsePuertoRicoResults(body, {
        reportingLevel: options.reportingLevel,
      }),
  });
  adapter.costService = 'other';
  return adapter;
}
