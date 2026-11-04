/**
 * New Mexico SoS election-results adapter.
 *
 * Upstream: https://www.sos.state.nm.us/ (verified live 2026-04-23). NM
 * has historically also exposed an ENR subdomain during election nights
 * (e.g. enr.nmsos.gov / electionresults.sos.nm.gov) but those subdomains
 * lifecycle per cycle and aren't reliably available off-season.
 *
 * We target the main SoS page and parse result tables via the generic
 * cheerio parser. The dispatcher can override sourceUrl to point at an
 * ENR endpoint on election night once verified.
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

export const NM_STATE_FIPS = '35';
const DEFAULT_URL = 'https://www.sos.state.nm.us/';

export type NewMexicoParseOptions = {
  reportingLevel?: StateReportingLevel;
};

export function parseNewMexicoResults(
  body: string,
  opts: NewMexicoParseOptions = {},
): StateResultRow[] {
  return parseGenericSosHtml(body, {
    stateTag: 'nm',
    reportingLevel: opts.reportingLevel,
  });
}

export type NewMexicoAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingLevel?: StateReportingLevel;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createNewMexicoResultsAdapter(
  opts: NewMexicoAdapterOptions = {},
) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  const base = createStateSosAdapter({
    stateFips: NM_STATE_FIPS,
    sourceName: 'new-mexico-sos-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    electionYear: opts.electionYear,
    fetch: opts.fetchImpl ?? ((ctx) => fetchHtml(url, ctx)),
    parse: async (body) =>
      parseNewMexicoResults(body, { reportingLevel: opts.reportingLevel }),
  });
  base.costService = 'other';
  return base;
}

/** Alias matching the Northeast convention used by the dispatcher. */
export function createNmResultsAdapter(opts: NewMexicoAdapterOptions = {}) {
  return createNewMexicoResultsAdapter(opts);
}
