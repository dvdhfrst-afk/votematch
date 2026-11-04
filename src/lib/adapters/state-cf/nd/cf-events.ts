/**
 * North Dakota — SoS Campaign Finance Disclosure Search (FIPS 38).
 *
 * Portal: https://vip.sos.nd.gov/PortalListDetails.aspx?ptlhPKID=116&ptlPKID=2
 * Format: ASP.NET SoS portal with per-filer detail pages, mostly PDF.
 *         HTML-table skeleton.
 *
 * TODO
 * ----
 * ND publishes many filings as PDF only; the HTML landing does not render
 * machine-readable contribution rows. A longer-term extractor pass via
 * Regulations-style PDF OCR is the robust path — skeletal today.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const ND_STATE_FIPS = '38';
export const ND_STATE_ABBR = 'ND';
const DEFAULT_URL =
  'https://vip.sos.nd.gov/PortalListDetails.aspx?ptlhPKID=116&ptlPKID=2';

export type NdCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseNorthDakotaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: ND_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createNdCfAdapter(opts: NdCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: ND_STATE_FIPS,
    stateAbbr: ND_STATE_ABBR,
    sourceName: 'north-dakota-sos-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseNorthDakotaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
