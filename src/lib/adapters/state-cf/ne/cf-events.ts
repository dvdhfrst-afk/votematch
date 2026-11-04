/**
 * Nebraska — Accountability & Disclosure Commission (NADC) (FIPS 31).
 *
 * Portal: https://nadc-e.nebraska.gov/PublicSite/SearchPages/Search.aspx
 * Format: ASP.NET search portal. HTML-table skeleton.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const NE_STATE_FIPS = '31';
export const NE_STATE_ABBR = 'NE';
const DEFAULT_URL =
  'https://nadc-e.nebraska.gov/PublicSite/SearchPages/Search.aspx';

export type NeCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseNebraskaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: NE_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createNeCfAdapter(opts: NeCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: NE_STATE_FIPS,
    stateAbbr: NE_STATE_ABBR,
    sourceName: 'nebraska-nadc-cf',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseNebraskaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
