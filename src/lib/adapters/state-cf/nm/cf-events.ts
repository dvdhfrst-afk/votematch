/**
 * New Mexico CFIS — campaign finance adapter.
 *
 * FIPS 35. Seed URL: https://login.cfis.sos.state.nm.us/
 *
 * NM's Campaign Finance Information System is login-walled for filers
 * but exposes a public search at /Home/Search. Public results are
 * rendered in an HTML table; no documented CSV export.
 *
 * TODO: NM SoS historically publishes quarterly XLSX bulk files via a
 * public FTP; wire a separate adapter once the URL is pinned.
 */

import {
  createHtmlFilingTableCfAdapter,
  parseFilingTableHtml,
} from '../shared/html-filing-table';
import type { AdapterContext } from '../../types';
import type { StateCfFetchResult, StateCfRow } from '../base';

export const NM_STATE_FIPS = '35';
export const NM_STATE_ABBR = 'NM';

export const NM_CFIS_URL = 'https://login.cfis.sos.state.nm.us/';
export const NM_CFIS_PUBLIC_URL =
  'https://login.cfis.sos.state.nm.us/#/exploreCampaignFinance';

export function parseNewMexicoCfisHtml(body: string): StateCfRow[] {
  return parseFilingTableHtml(body, {
    stateFips: NM_STATE_FIPS,
    stateAbbr: NM_STATE_ABBR,
    sourceName: 'nm-cfis',
    sourceUrl: NM_CFIS_URL,
    sourceType: 'sos_campaign_finance',
  });
}

export type NmCfAdapterOptions = {
  sourceUrl?: string;
  cycleYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateCfFetchResult>;
};

export function createNmCfAdapter(opts: NmCfAdapterOptions = {}) {
  return createHtmlFilingTableCfAdapter({
    stateFips: NM_STATE_FIPS,
    stateAbbr: NM_STATE_ABBR,
    sourceName: 'nm-cfis',
    sourceUrl: opts.sourceUrl ?? NM_CFIS_PUBLIC_URL,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    cycleYear: opts.cycleYear,
    sourceUrlOverride: opts.sourceUrl,
    fetchImpl: opts.fetchImpl,
  });
}
