/**
 * Wisconsin — Ethics Commission CFIS / "Sunshine" (FIPS 55).
 *
 * Portal: https://cfis.wi.gov/
 * Format: Sunshine (CFIS) is a web portal with search-driven filings +
 *         CSV exports reachable from individual filer pages. The landing
 *         page is JS-light; HTML-table skeleton captures any results
 *         tables, CSV path captures downloaded exports.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import {
  parseGenericCfCsv,
  parseGenericCfHtmlTable,
} from '../shared/html-parsers';

export const WI_STATE_FIPS = '55';
export const WI_STATE_ABBR = 'WI';
const DEFAULT_URL = 'https://cfis.wi.gov/';

export type WiCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseWisconsinCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  if (!body) return [];
  const sourceUrl = opts.sourceUrl ?? DEFAULT_URL;
  const first = body.trimStart().split('\n', 1)[0] ?? '';
  if (!first.startsWith('<') && /,/.test(first)) {
    return parseGenericCfCsv(body, {
      state: WI_STATE_ABBR,
      sourceUrl,
      reportingPeriod: opts.reportingPeriod,
    });
  }
  return parseGenericCfHtmlTable(body, {
    state: WI_STATE_ABBR,
    sourceUrl,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createWiCfAdapter(opts: WiCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: WI_STATE_FIPS,
    stateAbbr: WI_STATE_ABBR,
    sourceName: 'wisconsin-cfis-cf',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseWisconsinCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
