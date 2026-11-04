/**
 * Colorado SoS election-results adapter.
 *
 * Two upstreams exist in production:
 *   1. https://www.sos.state.co.us/pubs/elections/resultsData.html — the
 *      landing page that links to per-election result files.
 *   2. https://results.enr.clarityelections.com/CO/ — the Clarity Elections
 *      portal CO uses during/after election nights. Clarity hosts per-county
 *      and state-aggregate XML summary files alongside the HTML dashboard.
 *
 * This adapter defaults to the SoS landing page (verified live 2026-04-23)
 * and supports an override to point at a specific Clarity URL. The Clarity
 * XML schema is a distinct task and deferred until we have a real election
 * night to observe; for now we parse the landing page's HTML summary so
 * the pipeline produces rows without special-casing Clarity.
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

export const CO_STATE_FIPS = '08';
const DEFAULT_URL = 'https://www.sos.state.co.us/pubs/elections/resultsData.html';

export type ColoradoParseOptions = {
  reportingLevel?: StateReportingLevel;
};

export function parseColoradoResults(
  body: string,
  opts: ColoradoParseOptions = {},
): StateResultRow[] {
  return parseGenericSosHtml(body, {
    stateTag: 'co',
    reportingLevel: opts.reportingLevel,
  });
}

export type ColoradoAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingLevel?: StateReportingLevel;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createColoradoResultsAdapter(
  opts: ColoradoAdapterOptions = {},
) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  const base = createStateSosAdapter({
    stateFips: CO_STATE_FIPS,
    sourceName: 'colorado-sos-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    electionYear: opts.electionYear,
    fetch: opts.fetchImpl ?? ((ctx) => fetchHtml(url, ctx)),
    parse: async (body) =>
      parseColoradoResults(body, { reportingLevel: opts.reportingLevel }),
  });
  base.costService = 'other';
  return base;
}

/** Alias matching the Northeast convention used by the dispatcher. */
export function createCoResultsAdapter(opts: ColoradoAdapterOptions = {}) {
  return createColoradoResultsAdapter(opts);
}
