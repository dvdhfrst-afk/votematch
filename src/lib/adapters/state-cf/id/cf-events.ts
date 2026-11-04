/**
 * Idaho Sunshine — campaign finance adapter.
 *
 * FIPS 16. Seed URL: https://sunshine.sos.idaho.gov/
 *
 * Small state; Sunshine is the SoS's public CF portal. Search results
 * render as HTML tables; a per-filing CSV download exists but requires
 * a concrete filing ID. No documented bulk export.
 *
 * TODO: chase SoS for bulk certified CSV (post-cycle). Skeleton today.
 */

import {
  createHtmlFilingTableCfAdapter,
  parseFilingTableHtml,
} from '../shared/html-filing-table';
import type { AdapterContext } from '../../types';
import type { StateCfFetchResult, StateCfRow } from '../base';

export const ID_STATE_FIPS = '16';
export const ID_STATE_ABBR = 'ID';

export const ID_SUNSHINE_URL = 'https://sunshine.sos.idaho.gov/';

export function parseIdahoSunshineHtml(body: string): StateCfRow[] {
  return parseFilingTableHtml(body, {
    stateFips: ID_STATE_FIPS,
    stateAbbr: ID_STATE_ABBR,
    sourceName: 'id-sunshine',
    sourceUrl: ID_SUNSHINE_URL,
    sourceType: 'sos_campaign_finance',
  });
}

export type IdCfAdapterOptions = {
  sourceUrl?: string;
  cycleYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateCfFetchResult>;
};

export function createIdCfAdapter(opts: IdCfAdapterOptions = {}) {
  return createHtmlFilingTableCfAdapter({
    stateFips: ID_STATE_FIPS,
    stateAbbr: ID_STATE_ABBR,
    sourceName: 'id-sunshine',
    sourceUrl: opts.sourceUrl ?? ID_SUNSHINE_URL,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    cycleYear: opts.cycleYear,
    sourceUrlOverride: opts.sourceUrl,
    fetchImpl: opts.fetchImpl,
  });
}
