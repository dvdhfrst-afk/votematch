/**
 * Massachusetts — Office of Campaign and Political Finance (OCPF) adapter.
 *
 * Portal: https://www.ocpf.us/
 *         https://www.ocpf.us/Reports/SearchItems
 * Format: HTML portal + downloadable CSV/text per cycle. OCPF publishes a
 *         daily-refreshed bulk-data zip at https://www.ocpf.us/Data, but URL
 *         conventions vary; landing page parse is the safe default.
 *
 * Strategy
 *   - Fetch the OCPF landing page.
 *   - Parse any plain HTML tables present via the generic parser.
 *   - Off-cycle pulls land at 0 rows; runner marks `unproductive`.
 *
 * TODO: extend to walk https://www.ocpf.us/Data once we encode the per-year
 *       URL convention; OCPF's bulk data is large and well-structured.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const MA_STATE_FIPS = '25';
export const MA_STATE_ABBR = 'MA';
const DEFAULT_URL = 'https://www.ocpf.us/';

export type MaCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseMassachusettsCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: MA_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createMaCfAdapter(opts: MaCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: MA_STATE_FIPS,
    stateAbbr: MA_STATE_ABBR,
    sourceName: 'massachusetts-ocpf-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseMassachusettsCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
