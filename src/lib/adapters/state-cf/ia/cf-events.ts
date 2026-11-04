/**
 * Iowa — Ethics & Campaign Disclosure Board (IECDB) (FIPS 19).
 *
 * Portal: https://webapp.iecdb.iowa.gov/publicReports
 * Format: ASP.NET public-reports portal. HTML-table skeleton with CSV
 *         passthrough when pointed at a bulk export URL.
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

export const IA_STATE_FIPS = '19';
export const IA_STATE_ABBR = 'IA';
const DEFAULT_URL = 'https://webapp.iecdb.iowa.gov/publicReports';

export type IaCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseIowaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  if (!body) return [];
  const sourceUrl = opts.sourceUrl ?? DEFAULT_URL;
  const first = body.trimStart().split('\n', 1)[0] ?? '';
  if (!first.startsWith('<') && /,/.test(first)) {
    return parseGenericCfCsv(body, {
      state: IA_STATE_ABBR,
      sourceUrl,
      reportingPeriod: opts.reportingPeriod,
    });
  }
  return parseGenericCfHtmlTable(body, {
    state: IA_STATE_ABBR,
    sourceUrl,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createIaCfAdapter(opts: IaCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: IA_STATE_FIPS,
    stateAbbr: IA_STATE_ABBR,
    sourceName: 'iowa-iecdb-cf',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseIowaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
