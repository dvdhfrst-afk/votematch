/**
 * Wyoming SoS election-results adapter.
 *
 * Upstream: https://sos.wyo.gov/Elections/Default.aspx (verified live
 * 2026-04-23). Wyoming's portal is ASP.NET-rendered; the landing page
 * embeds links to per-cycle PDF + HTML canvass reports but the live
 * results table during election night is served as HTML by the same
 * endpoint. We parse whatever tables the landing page exposes via the
 * shared cheerio parser.
 *
 * If WY's PDF canvasses turn out to be the only reliable source we'll
 * add a PDF-text extraction pass in a follow-up; for now HTML covers the
 * live election-night path.
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

export const WY_STATE_FIPS = '56';
const DEFAULT_URL = 'https://sos.wyo.gov/Elections/Default.aspx';

export type WyomingParseOptions = {
  reportingLevel?: StateReportingLevel;
};

export function parseWyomingResults(
  body: string,
  opts: WyomingParseOptions = {},
): StateResultRow[] {
  return parseGenericSosHtml(body, {
    stateTag: 'wy',
    reportingLevel: opts.reportingLevel,
  });
}

export type WyomingAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingLevel?: StateReportingLevel;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createWyomingResultsAdapter(
  opts: WyomingAdapterOptions = {},
) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  const base = createStateSosAdapter({
    stateFips: WY_STATE_FIPS,
    sourceName: 'wyoming-sos-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    electionYear: opts.electionYear,
    fetch: opts.fetchImpl ?? ((ctx) => fetchHtml(url, ctx)),
    parse: async (body) =>
      parseWyomingResults(body, { reportingLevel: opts.reportingLevel }),
  });
  base.costService = 'other';
  return base;
}

/** Alias matching the Northeast convention used by the dispatcher. */
export function createWyResultsAdapter(opts: WyomingAdapterOptions = {}) {
  return createWyomingResultsAdapter(opts);
}
