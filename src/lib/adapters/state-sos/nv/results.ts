/**
 * Nevada SoS election-results adapter.
 *
 * Upstream of record: https://www.nvsos.gov/sos/elections (per
 * state-sos-sources.ts, verified live 2026-04-23). Nevada also publishes
 * a cycle-specific dashboard at https://silverstateelection.nv.gov during
 * an election; when present it hosts structured data we'd prefer, but on
 * 2026-04-23 that subdomain was off-season / not the canonical landing.
 *
 * Strategy: parse the SoS Elections page HTML. If the downstream dispatcher
 * wants to target silverstateelection.nv.gov during election night, pass
 * sourceUrl at construction time.
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

export const NV_STATE_FIPS = '32';
const DEFAULT_URL = 'https://www.nvsos.gov/sos/elections';

export type NevadaParseOptions = {
  reportingLevel?: StateReportingLevel;
};

export function parseNevadaResults(
  body: string,
  opts: NevadaParseOptions = {},
): StateResultRow[] {
  return parseGenericSosHtml(body, {
    stateTag: 'nv',
    reportingLevel: opts.reportingLevel,
  });
}

export type NevadaAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingLevel?: StateReportingLevel;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createNevadaResultsAdapter(
  opts: NevadaAdapterOptions = {},
) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  const base = createStateSosAdapter({
    stateFips: NV_STATE_FIPS,
    sourceName: 'nevada-sos-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    electionYear: opts.electionYear,
    fetch: opts.fetchImpl ?? ((ctx) => fetchHtml(url, ctx)),
    parse: async (body) =>
      parseNevadaResults(body, { reportingLevel: opts.reportingLevel }),
  });
  base.costService = 'other';
  return base;
}

/** Alias matching the Northeast convention used by the dispatcher. */
export function createNvResultsAdapter(opts: NevadaAdapterOptions = {}) {
  return createNevadaResultsAdapter(opts);
}
