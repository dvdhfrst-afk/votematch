/**
 * Idaho SoS election-results adapter.
 *
 * Upstream of record: https://canvass.sos.idaho.gov/eng/ — the Idaho
 * "canvass" portal (verified live 2026-04-23) is Idaho's canonical
 * historical results index. It exposes per-election pages via query
 * params. A secondary / newer landing exists at
 * https://sos.idaho.gov/elections-division/ but that page doesn't itself
 * carry result tables; it links out.
 *
 * We target canvass.sos.idaho.gov and parse per-contest tables via the
 * generic cheerio parser. During election night the correct cycle URL
 * will be appended by the dispatcher (sourceUrl override).
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

export const ID_STATE_FIPS = '16';
const DEFAULT_URL = 'https://canvass.sos.idaho.gov/eng/';

export type IdahoParseOptions = {
  reportingLevel?: StateReportingLevel;
};

export function parseIdahoResults(
  body: string,
  opts: IdahoParseOptions = {},
): StateResultRow[] {
  return parseGenericSosHtml(body, {
    stateTag: 'id',
    reportingLevel: opts.reportingLevel,
  });
}

export type IdahoAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingLevel?: StateReportingLevel;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createIdahoResultsAdapter(
  opts: IdahoAdapterOptions = {},
) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  const base = createStateSosAdapter({
    stateFips: ID_STATE_FIPS,
    sourceName: 'idaho-sos-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    electionYear: opts.electionYear,
    fetch: opts.fetchImpl ?? ((ctx) => fetchHtml(url, ctx)),
    parse: async (body) =>
      parseIdahoResults(body, { reportingLevel: opts.reportingLevel }),
  });
  base.costService = 'other';
  return base;
}

/** Alias matching the Northeast convention used by the dispatcher. */
export function createIdResultsAdapter(opts: IdahoAdapterOptions = {}) {
  return createIdahoResultsAdapter(opts);
}
