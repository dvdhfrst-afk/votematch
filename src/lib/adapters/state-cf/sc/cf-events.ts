/**
 * South Carolina — State Ethics Commission adapter.
 *
 * Portal: https://ethics.sc.gov/
 *         https://apps.sc.gov/PublicReporting/Index.aspx (public reporting)
 * Format: HTML portal; per-committee filings export to PDF/CSV. No documented
 *         public JSON bulk API as of 2026-04-25.
 *
 * Strategy
 *   - Fetch the landing page.
 *   - Parse any plain HTML tables present.
 *   - SC primary is 2026-06-09; off-cycle empty days marked `unproductive`.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const SC_STATE_FIPS = '45';
export const SC_STATE_ABBR = 'SC';
const DEFAULT_URL = 'https://ethics.sc.gov/';

export type ScCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseSouthCarolinaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: SC_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createScCfAdapter(opts: ScCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: SC_STATE_FIPS,
    stateAbbr: SC_STATE_ABBR,
    sourceName: 'south-carolina-ethics-cf',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseSouthCarolinaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
