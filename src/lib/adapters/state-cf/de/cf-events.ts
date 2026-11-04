/**
 * Delaware — Department of Elections (CFRS) adapter.
 *
 * Portal: https://cfrs.elections.delaware.gov/
 *         https://elections.delaware.gov/
 * Format: HTML portal (CFRS — Campaign Finance Reporting System). Bulk
 *         exports are XLS/CSV on a per-committee basis. No documented public
 *         JSON bulk API as of 2026-04-25.
 *
 * Strategy
 *   - Fetch the CFRS landing page.
 *   - Parse any plain HTML tables present.
 *   - Delaware's primary is 2026-09-15; off-cycle this returns []. The
 *     adapter runner records the run as `unproductive` rather than `failed`.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const DE_STATE_FIPS = '10';
export const DE_STATE_ABBR = 'DE';
const DEFAULT_URL = 'https://cfrs.elections.delaware.gov/';

export type DeCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseDelawareCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: DE_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createDeCfAdapter(opts: DeCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: DE_STATE_FIPS,
    stateAbbr: DE_STATE_ABBR,
    sourceName: 'delaware-cfrs-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseDelawareCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
