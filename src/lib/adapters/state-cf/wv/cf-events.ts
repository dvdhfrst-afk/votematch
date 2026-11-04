/**
 * West Virginia — Secretary of State Campaign Finance adapter.
 *
 * Portal: https://cfrs.wvsos.gov/
 *         https://sos.wv.gov/elections/Pages/Campaign-Finance.aspx
 * Format: HTML portal; CFRS (Campaign Finance Reporting System) per-committee
 *         filings export to PDF/CSV. No documented public JSON bulk API as
 *         of 2026-04-25.
 *
 * Strategy
 *   - Fetch the CFRS landing page.
 *   - Parse any plain HTML tables present.
 *   - WV primary is 2026-05-12; off-cycle empty days marked `unproductive`.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const WV_STATE_FIPS = '54';
export const WV_STATE_ABBR = 'WV';
const DEFAULT_URL = 'https://cfrs.wvsos.gov/';

export type WvCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseWestVirginiaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: WV_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createWvCfAdapter(opts: WvCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: WV_STATE_FIPS,
    stateAbbr: WV_STATE_ABBR,
    sourceName: 'west-virginia-sos-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseWestVirginiaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
