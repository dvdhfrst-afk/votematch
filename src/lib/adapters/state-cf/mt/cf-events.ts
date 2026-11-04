/**
 * Montana — Commissioner of Political Practices (COPP) CampaignTracker / CERS
 * (FIPS 30).
 *
 * Portal: https://cers-ext.mt.gov/CampaignTracker/public/search
 *         Umbrella: https://cers-ext.mt.gov/
 * Format: HTML search + per-filing detail pages. No documented JSON/CSV
 *         bulk API; transaction-level detail lives on per-filing pages
 *         (TODO — requires a per-filing follower pass).
 *
 * Seed row lives under source_type='ethics_commission' (COPP is an ethics
 * commission, not the SoS).
 *
 * Skeleton HTML-table scrape via parseGenericCfHtmlTable. `sourceUrl`
 * override lets the caller target a specific search-result page.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const MT_STATE_FIPS = '30';
export const MT_STATE_ABBR = 'MT';
export const MT_CERS_URL =
  'https://cers-ext.mt.gov/CampaignTracker/public/search';

export type MtCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseMontanaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: MT_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? MT_CERS_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createMtCfAdapter(opts: MtCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? MT_CERS_URL;
  return createStateCfAdapter({
    stateFips: MT_STATE_FIPS,
    stateAbbr: MT_STATE_ABBR,
    sourceName: 'montana-copp-cers',
    sourceUrl: url,
    // COPP is an ethics commission, not the SoS.
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseMontanaCf(body, { sourceUrl: url, reportingPeriod: opts.reportingPeriod }),
  });
}
