/**
 * Wyoming — WYCFIS (Wyoming Campaign Finance Information System) (FIPS 56).
 *
 * Portal: https://www.wycampaignfinance.gov/
 * Format: Small-state HTML public search. No documented bulk API.
 *
 * Skeleton HTML-table scrape via parseGenericCfHtmlTable. Override
 * `sourceUrl` to point at a concrete committee detail page when one is
 * known.
 *
 * TODO: WY SoS historically publishes certified post-cycle XLSX files
 * via email / FOIA only; no public URL today.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const WY_STATE_FIPS = '56';
export const WY_STATE_ABBR = 'WY';
export const WY_WYCFIS_URL = 'https://www.wycampaignfinance.gov/';

export type WyCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseWyomingCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: WY_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? WY_WYCFIS_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createWyCfAdapter(opts: WyCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? WY_WYCFIS_URL;
  return createStateCfAdapter({
    stateFips: WY_STATE_FIPS,
    stateAbbr: WY_STATE_ABBR,
    sourceName: 'wyoming-wycfis',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseWyomingCf(body, { sourceUrl: url, reportingPeriod: opts.reportingPeriod }),
  });
}
