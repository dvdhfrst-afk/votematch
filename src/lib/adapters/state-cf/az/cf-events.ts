/**
 * Arizona See-The-Money — campaign finance adapter.
 *
 * FIPS 04. Seed URL: https://seethemoney.az.gov/
 *
 * "See The Money" is AZ's public-search CF portal (run by the SoS). It
 * ships filing and transaction searches, both rendered as HTML tables.
 * Documented bulk export exists under /Reporting/BulkDownload but
 * requires deliberate per-cycle configuration.
 *
 * TODO: wire a dedicated bulk-CSV adapter instance for
 * seethemoney.az.gov/Reporting/BulkDownload once the required session
 * cookies are reverse-engineered. Today this adapter scrapes the
 * landing page's filing table.
 */

import {
  createHtmlFilingTableCfAdapter,
  parseFilingTableHtml,
} from '../shared/html-filing-table';
import type { AdapterContext } from '../../types';
import type { StateCfFetchResult, StateCfRow } from '../base';

export const AZ_STATE_FIPS = '04';
export const AZ_STATE_ABBR = 'AZ';

export const AZ_SEETHEMONEY_URL = 'https://seethemoney.az.gov/';
export const AZ_SEETHEMONEY_REPORTS_URL =
  'https://seethemoney.az.gov/Reporting/Explore';

export function parseArizonaSeeTheMoneyHtml(body: string): StateCfRow[] {
  return parseFilingTableHtml(body, {
    stateFips: AZ_STATE_FIPS,
    stateAbbr: AZ_STATE_ABBR,
    sourceName: 'az-seethemoney',
    sourceUrl: AZ_SEETHEMONEY_URL,
    sourceType: 'sos_campaign_finance',
  });
}

export type AzCfAdapterOptions = {
  sourceUrl?: string;
  cycleYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateCfFetchResult>;
};

export function createAzCfAdapter(opts: AzCfAdapterOptions = {}) {
  return createHtmlFilingTableCfAdapter({
    stateFips: AZ_STATE_FIPS,
    stateAbbr: AZ_STATE_ABBR,
    sourceName: 'az-seethemoney',
    sourceUrl: opts.sourceUrl ?? AZ_SEETHEMONEY_REPORTS_URL,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    cycleYear: opts.cycleYear,
    sourceUrlOverride: opts.sourceUrl,
    fetchImpl: opts.fetchImpl,
  });
}
