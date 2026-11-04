/**
 * Minnesota — Campaign Finance & Public Disclosure Board (FIPS 27).
 *
 * Portal: https://cfb.mn.gov/
 * Format: Landing page with rich bulk-download archive (contribution +
 *         expenditure CSVs published per cycle). Detect CSV vs HTML from
 *         first-line delimiters.
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

export const MN_STATE_FIPS = '27';
export const MN_STATE_ABBR = 'MN';
const DEFAULT_URL = 'https://cfb.mn.gov/';

export type MnCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseMinnesotaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  if (!body) return [];
  const sourceUrl = opts.sourceUrl ?? DEFAULT_URL;
  const first = body.trimStart().split('\n', 1)[0] ?? '';
  if (!first.startsWith('<') && /,/.test(first)) {
    return parseGenericCfCsv(body, {
      state: MN_STATE_ABBR,
      sourceUrl,
      reportingPeriod: opts.reportingPeriod,
    });
  }
  return parseGenericCfHtmlTable(body, {
    state: MN_STATE_ABBR,
    sourceUrl,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createMnCfAdapter(opts: MnCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: MN_STATE_FIPS,
    stateAbbr: MN_STATE_ABBR,
    sourceName: 'minnesota-cfb-cf',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseMinnesotaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
