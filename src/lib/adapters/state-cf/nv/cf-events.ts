/**
 * Nevada AURORA — CE/FD search adapter.
 *
 * FIPS 32. Seed URL:
 *   https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/Search.aspx
 *
 * AURORA is the NV SoS public CF portal. Results render as
 * ASP.NET-gridview HTML tables; per-filing XLSX downloads are linked
 * from each row. No documented bulk API.
 *
 * TODO: ASP.NET postbacks make a cycle-wide crawl brittle; add a
 * Playwright-driven adapter if we ever need to walk more than the
 * landing page's first page of results.
 */

import {
  createHtmlFilingTableCfAdapter,
  parseFilingTableHtml,
} from '../shared/html-filing-table';
import type { AdapterContext } from '../../types';
import type { StateCfFetchResult, StateCfRow } from '../base';

export const NV_STATE_FIPS = '32';
export const NV_STATE_ABBR = 'NV';

export const NV_AURORA_URL =
  'https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CEFDSearchUU/Search.aspx';

export function parseNevadaAuroraHtml(body: string): StateCfRow[] {
  return parseFilingTableHtml(body, {
    stateFips: NV_STATE_FIPS,
    stateAbbr: NV_STATE_ABBR,
    sourceName: 'nv-aurora',
    sourceUrl: NV_AURORA_URL,
    sourceType: 'sos_campaign_finance',
  });
}

export type NvCfAdapterOptions = {
  sourceUrl?: string;
  cycleYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateCfFetchResult>;
};

export function createNvCfAdapter(opts: NvCfAdapterOptions = {}) {
  return createHtmlFilingTableCfAdapter({
    stateFips: NV_STATE_FIPS,
    stateAbbr: NV_STATE_ABBR,
    sourceName: 'nv-aurora',
    sourceUrl: opts.sourceUrl ?? NV_AURORA_URL,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    cycleYear: opts.cycleYear,
    sourceUrlOverride: opts.sourceUrl,
    fetchImpl: opts.fetchImpl,
  });
}
