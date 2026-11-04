/**
 * Virginia — Department of Elections (ELECT) Campaign Finance adapter.
 *
 * Portal: https://www.elections.virginia.gov/candidatepac-info/campaign-finance-reports/
 *         https://cfreports.elections.virginia.gov/
 * Format: HTML portal; bulk filings export via the SBE bulk-data downloads
 *         page. ELECT publishes annual zips of all campaign finance data; URL
 *         convention: https://apps.elections.virginia.gov/SBE_CSV/CF/<year>/.
 *
 * Strategy
 *   - Fetch the landing page.
 *   - Parse any plain HTML tables present.
 *   - VA primary is 2026-06-16; off-cycle empty days marked `unproductive`.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const VA_STATE_FIPS = '51';
export const VA_STATE_ABBR = 'VA';
const DEFAULT_URL = 'https://cfreports.elections.virginia.gov/';

export type VaCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseVirginiaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: VA_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createVaCfAdapter(opts: VaCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: VA_STATE_FIPS,
    stateAbbr: VA_STATE_ABBR,
    sourceName: 'virginia-elect-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseVirginiaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
