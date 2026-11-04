/**
 * Arizona SoS election-results adapter.
 *
 * Upstream: https://azsos.gov/elections (verified live 2026-04-23).
 * Arizona publishes results through a Laravel-rendered HTML portal. On
 * election night the page redirects into a per-cycle subsection that
 * carries a set of .pdf + .xls files; the live dashboard itself is HTML
 * and aggregates by contest.
 *
 * This adapter parses the HTML dashboard via the generic cheerio parser.
 * When AZ eventually publishes a structured JSON/CSV the parser can be
 * swapped without changing the factory / dispatcher.
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

export const AZ_STATE_FIPS = '04';
const DEFAULT_URL = 'https://azsos.gov/elections';

export type ArizonaParseOptions = {
  reportingLevel?: StateReportingLevel;
};

export function parseArizonaResults(
  body: string,
  opts: ArizonaParseOptions = {},
): StateResultRow[] {
  return parseGenericSosHtml(body, {
    stateTag: 'az',
    reportingLevel: opts.reportingLevel,
  });
}

export type ArizonaAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingLevel?: StateReportingLevel;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createArizonaResultsAdapter(
  opts: ArizonaAdapterOptions = {},
) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  const base = createStateSosAdapter({
    stateFips: AZ_STATE_FIPS,
    sourceName: 'arizona-sos-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    electionYear: opts.electionYear,
    fetch: opts.fetchImpl ?? ((ctx) => fetchHtml(url, ctx)),
    parse: async (body) =>
      parseArizonaResults(body, { reportingLevel: opts.reportingLevel }),
  });
  base.costService = 'other';
  return base;
}

/** Alias matching the Northeast convention used by the dispatcher. */
export function createAzResultsAdapter(opts: ArizonaAdapterOptions = {}) {
  return createArizonaResultsAdapter(opts);
}
