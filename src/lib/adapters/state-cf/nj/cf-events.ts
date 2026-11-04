/**
 * New Jersey — Election Law Enforcement Commission (ELEC) adapter.
 *
 * Portal: https://www.elec.nj.gov/
 *         https://www.elec.nj.gov/publicinformation/searchdatabase.htm
 * Format: HTML portal; bulk filings export to text/CSV. ELEC publishes
 *         downloadable bulk data at https://www.elec.nj.gov/publicinformation/
 *         but the per-cycle URL convention requires per-cycle discovery.
 *
 * Strategy
 *   - Fetch the ELEC landing page.
 *   - Parse any plain HTML tables present.
 *   - NJ primary is 2026-06-02; off-cycle empty days marked `unproductive`.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const NJ_STATE_FIPS = '34';
export const NJ_STATE_ABBR = 'NJ';
const DEFAULT_URL = 'https://www.elec.nj.gov/';

export type NjCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseNewJerseyCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: NJ_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createNjCfAdapter(opts: NjCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: NJ_STATE_FIPS,
    stateAbbr: NJ_STATE_ABBR,
    sourceName: 'new-jersey-elec-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseNewJerseyCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
