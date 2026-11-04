/**
 * Hawaii Campaign Spending Commission (CSC) — CF adapter.
 *
 * FIPS 15. Seed URL: https://ags.hawaii.gov/campaign/
 *
 * CSC publishes CF at ags.hawaii.gov/campaign (umbrella) and the
 * searchable DB at https://staff.hawaii.gov/cscsearch. Results are
 * HTML tables; no documented bulk API.
 *
 * TODO: CSC occasionally publishes year-end CSV "extracts" that aren't
 * linked from the public portal; wire a dedicated adapter once the
 * stable URL is found.
 */

import {
  createHtmlFilingTableCfAdapter,
  parseFilingTableHtml,
} from '../shared/html-filing-table';
import type { AdapterContext } from '../../types';
import type { StateCfFetchResult, StateCfRow } from '../base';

export const HI_STATE_FIPS = '15';
export const HI_STATE_ABBR = 'HI';

export const HI_CSC_URL = 'https://ags.hawaii.gov/campaign/';
// 2026-04-25: staff.hawaii.gov/cscsearch/ went DNS-dead (ENOTFOUND) at some
// point — possibly retired when CSC migrated to the standalone csc.hawaii.gov
// host. Replaced with the Candidate Filing System public portal which
// returns an HTML table of active filers. The legacy const is kept for
// reference but no longer used as the default URL.
export const HI_CSC_SEARCH_URL = 'https://csc.hawaii.gov/CFSPublic/menu/';
export const HI_CSC_SEARCH_URL_LEGACY = 'https://staff.hawaii.gov/cscsearch/';

export function parseHawaiiCscHtml(body: string): StateCfRow[] {
  return parseFilingTableHtml(body, {
    stateFips: HI_STATE_FIPS,
    stateAbbr: HI_STATE_ABBR,
    sourceName: 'hi-csc',
    sourceUrl: HI_CSC_URL,
    sourceType: 'ethics_commission',
  });
}

export type HiCfAdapterOptions = {
  sourceUrl?: string;
  cycleYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateCfFetchResult>;
};

export function createHiCfAdapter(opts: HiCfAdapterOptions = {}) {
  return createHtmlFilingTableCfAdapter({
    stateFips: HI_STATE_FIPS,
    stateAbbr: HI_STATE_ABBR,
    sourceName: 'hi-csc',
    sourceUrl: opts.sourceUrl ?? HI_CSC_SEARCH_URL,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    cycleYear: opts.cycleYear,
    sourceUrlOverride: opts.sourceUrl,
    fetchImpl: opts.fetchImpl,
  });
}
