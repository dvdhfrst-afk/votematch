/**
 * Kentucky — Registry of Election Finance (KREF) (FIPS 21).
 *
 * Portal: https://kref.ky.gov/Pages/default.aspx
 * Format: SharePoint-hosted HTML landing. KREF publishes report PDFs + a
 *         simple search portal. HTML-table skeleton.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const KY_STATE_FIPS = '21';
export const KY_STATE_ABBR = 'KY';
const DEFAULT_URL = 'https://kref.ky.gov/Pages/default.aspx';

export type KyCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseKentuckyCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: KY_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createKyCfAdapter(opts: KyCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: KY_STATE_FIPS,
    stateAbbr: KY_STATE_ABBR,
    sourceName: 'kentucky-kref-cf',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseKentuckyCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
