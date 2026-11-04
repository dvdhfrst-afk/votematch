/**
 * Maine — Commission on Governmental Ethics & Election Practices adapter.
 *
 * Portal: https://www.maine.gov/ethics/
 * Format: HTML portal; filings exported via downloadable reports. No
 *         documented public JSON/CSV bulk API as of 2026-04-23.
 *
 * Strategy
 *   - Fetch the landing page.
 *   - Parse any table rows present via the generic HTML parser.
 *   - On an empty landing (common off-cycle), return [] and let the run
 *     land with rowsInserted=0 and expectedMinRows=0.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const ME_STATE_FIPS = '23';
export const ME_STATE_ABBR = 'ME';
const DEFAULT_URL = 'https://www.maine.gov/ethics/';

export type MeCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseMaineCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: ME_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createMeCfAdapter(opts: MeCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: ME_STATE_FIPS,
    stateAbbr: ME_STATE_ABBR,
    sourceName: 'maine-ethics-cf',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseMaineCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
