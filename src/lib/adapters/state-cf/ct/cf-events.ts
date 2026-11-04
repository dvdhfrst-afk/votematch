/**
 * Connecticut — State Elections Enforcement Commission (SEEC) adapter.
 *
 * Portal: https://seec.ct.gov/
 *         https://www.seec.ct.gov/eCRIS/   (eCRIS bulk filing browser)
 * Format: HTML portal; ASP.NET-rendered tables. No documented public
 *         JSON/CSV bulk API as of 2026-04-25.
 *
 * Strategy
 *   - Fetch the SEEC landing page.
 *   - Parse any plain HTML tables present via the generic parser.
 *   - Off-cycle (and on a portal that requires the eCRIS deep links anyway),
 *     this lands at rows=0 / expectedMinRows=0 and is treated as
 *     `unproductive` rather than `failed` by the adapter runner.
 *
 * TODO: implement an eCRIS-aware parser that walks the bulk-filing tree.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const CT_STATE_FIPS = '09';
export const CT_STATE_ABBR = 'CT';
const DEFAULT_URL = 'https://seec.ct.gov/';

export type CtCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseConnecticutCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: CT_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createCtCfAdapter(opts: CtCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: CT_STATE_FIPS,
    stateAbbr: CT_STATE_ABBR,
    sourceName: 'connecticut-seec-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseConnecticutCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
