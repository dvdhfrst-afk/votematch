/**
 * Maryland — State Board of Elections / Campaign Reporting Information
 * System (MDCRIS) adapter.
 *
 * Portal: https://campaignfinancemd.us/
 *         https://campaignfinance.maryland.gov/
 * Format: HTML portal; bulk filings export to CSV per-committee. No
 *         documented public JSON bulk API as of 2026-04-25.
 *
 * Strategy
 *   - Fetch the landing page.
 *   - Parse any plain HTML tables present.
 *   - Off-cycle: 0 rows expected; runner marks `unproductive`.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const MD_STATE_FIPS = '24';
export const MD_STATE_ABBR = 'MD';
const DEFAULT_URL = 'https://campaignfinance.maryland.gov/';

export type MdCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseMarylandCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: MD_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createMdCfAdapter(opts: MdCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: MD_STATE_FIPS,
    stateAbbr: MD_STATE_ABBR,
    sourceName: 'maryland-mdcris-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseMarylandCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
