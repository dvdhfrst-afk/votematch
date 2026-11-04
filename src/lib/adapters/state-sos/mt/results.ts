/**
 * Montana SoS election-results adapter.
 *
 * Upstream: https://sosmt.gov/elections/ (verified live 2026-04-23). MT
 * publishes election results through the SoS elections page. Known prior
 * research flagged Telerik RadGrid usage for candidate filings; that grid
 * serves HTML (not JSON) and would require a stateful ASP.NET postback
 * flow to paginate — the results page itself is simpler, a static HTML
 * summary per contest.
 *
 * We target the landing page and parse any embedded results tables via the
 * generic cheerio parser. If a Telerik-style per-contest endpoint is
 * discovered during election night, the dispatcher can override sourceUrl.
 */

import type { AdapterContext } from '../../types';
import {
  createStateSosAdapter,
  type StateFetchResult,
  type StateReportingLevel,
  type StateResultRow,
} from '../base';
import { fetchHtml } from '../shared/fetch';
import { parseGenericSosHtml } from '../shared/generic-html';

export const MT_STATE_FIPS = '30';
const DEFAULT_URL = 'https://sosmt.gov/elections/';

export type MontanaParseOptions = {
  reportingLevel?: StateReportingLevel;
};

export function parseMontanaResults(
  body: string,
  opts: MontanaParseOptions = {},
): StateResultRow[] {
  return parseGenericSosHtml(body, {
    stateTag: 'mt',
    reportingLevel: opts.reportingLevel,
  });
}

export type MontanaAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingLevel?: StateReportingLevel;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createMontanaResultsAdapter(
  opts: MontanaAdapterOptions = {},
) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  const base = createStateSosAdapter({
    stateFips: MT_STATE_FIPS,
    sourceName: 'montana-sos-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    electionYear: opts.electionYear,
    fetch: opts.fetchImpl ?? ((ctx) => fetchHtml(url, ctx)),
    parse: async (body) =>
      parseMontanaResults(body, { reportingLevel: opts.reportingLevel }),
  });
  base.costService = 'other';
  return base;
}

/** Alias matching the Northeast convention used by the dispatcher. */
export function createMtResultsAdapter(opts: MontanaAdapterOptions = {}) {
  return createMontanaResultsAdapter(opts);
}
