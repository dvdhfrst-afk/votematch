/**
 * North Carolina — State Board of Elections (CFRS) adapter.
 *
 * Portal: https://www.ncsbe.gov/campaign-finance
 *         https://cf.ncsbe.gov/CFOrgLkup/    (committee lookup)
 * Format: HTML portal; bulk filings export to CSV per-committee. NCSBE also
 *         publishes campaign-finance bulk extracts under
 *         https://www.ncsbe.gov/results-data/campaign-finance-data, but the
 *         per-cycle URL needs discovery; landing-page parse is the safe
 *         default.
 *
 * Strategy
 *   - Fetch the landing page.
 *   - Parse any plain HTML tables present.
 *   - NC primary is 2026-03-03; off-cycle empty days marked `unproductive`.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const NC_STATE_FIPS = '37';
export const NC_STATE_ABBR = 'NC';
const DEFAULT_URL = 'https://www.ncsbe.gov/campaign-finance';

export type NcCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseNorthCarolinaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: NC_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createNcCfAdapter(opts: NcCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: NC_STATE_FIPS,
    stateAbbr: NC_STATE_ABBR,
    sourceName: 'north-carolina-sboe-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseNorthCarolinaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
