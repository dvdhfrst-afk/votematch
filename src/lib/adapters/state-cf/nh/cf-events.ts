/**
 * New Hampshire — Secretary of State Campaign Finance adapter.
 *
 * Portal: https://www.sos.nh.gov/elections/campaign-finance
 *         https://cfs.sos.nh.gov/Public/Default.aspx
 * Format: HTML portal; ASP.NET-rendered. Per-committee filings export to
 *         PDF/HTML. No documented public JSON/CSV bulk API as of 2026-04-25.
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

export const NH_STATE_FIPS = '33';
export const NH_STATE_ABBR = 'NH';
const DEFAULT_URL = 'https://www.sos.nh.gov/elections/campaign-finance';

export type NhCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseNewHampshireCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: NH_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createNhCfAdapter(opts: NhCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: NH_STATE_FIPS,
    stateAbbr: NH_STATE_ABBR,
    sourceName: 'new-hampshire-sos-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseNewHampshireCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
