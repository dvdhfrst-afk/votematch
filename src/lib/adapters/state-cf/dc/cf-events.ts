/**
 * District of Columbia — Office of Campaign Finance (OCF) adapter.
 *
 * Portal: https://efiling.ocf.dc.gov/         (eFiling search)
 *         https://ocf.dc.gov/                  (program landing)
 * Format: HTML portal; some downloadable XLS/CSV per cycle. No documented
 *         public JSON bulk API as of 2026-04-25.
 *
 * Strategy
 *   - Fetch the OCF landing page.
 *   - Parse any plain HTML tables present via the generic parser.
 *   - DC is small + off-cycle this far out from the 2026 general; expect
 *     rows=0 most days; runner marks as `unproductive`.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const DC_STATE_FIPS = '11';
export const DC_STATE_ABBR = 'DC';
const DEFAULT_URL = 'https://ocf.dc.gov/';

export type DcCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseDcCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: DC_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createDcCfAdapter(opts: DcCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: DC_STATE_FIPS,
    stateAbbr: DC_STATE_ABBR,
    sourceName: 'dc-ocf-cf',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseDcCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
