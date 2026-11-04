/**
 * Alabama — FCPA Campaign Finance System (FIPS 01).
 *
 * Portal: https://fcpa.alabamavotes.gov/
 * Format: HTML portal (Alabama Fair Campaign Practices Act). No documented
 *         bulk API. Searchable by candidate/committee; JSON may be exposed
 *         by internal endpoints but is not documented for public use.
 *
 * Skeleton HTML-table scrape. `sourceUrl` override lets the caller point
 * at a specific filing detail page.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const AL_STATE_FIPS = '01';
export const AL_STATE_ABBR = 'AL';
const DEFAULT_URL = 'https://fcpa.alabamavotes.gov/';

export type AlCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseAlabamaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: AL_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createAlCfAdapter(opts: AlCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: AL_STATE_FIPS,
    stateAbbr: AL_STATE_ABBR,
    sourceName: 'alabama-fcpa-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseAlabamaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
