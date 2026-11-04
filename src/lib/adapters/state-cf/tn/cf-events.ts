/**
 * Tennessee — Registry of Election Finance (FIPS 47).
 *
 * Portal: https://www.tn.gov/tref.html
 * Format: HTML landing pointing at the TREF Public Portal. No documented
 *         bulk API. HTML-table skeleton.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const TN_STATE_FIPS = '47';
export const TN_STATE_ABBR = 'TN';
// 2026-04-26: tn.gov/tref.html and tn.gov/tref/tref-candidates.html both
// ECONNRESET from Node fetch (WAF/UA filter on the static-content host;
// 77x failures over 6h on 2026-04-25). The actual data lives on the
// Tennessee Online Campaign Finance app (apps.tn.gov/tncamp/) — that host
// uses a different stack and serves Node fetch reliably. Switching the
// adapter to point at the app: it's the canonical search/download portal
// for candidates, PACs, reports, contributions, and expenditures, and was
// always the underlying data source the tn.gov/tref pages just linked to.
// Verified 200 / 6KB by team-url-rot 2026-04-26.
const DEFAULT_URL = 'https://apps.tn.gov/tncamp/';
export const TN_TREF_LANDING_LEGACY = 'https://www.tn.gov/tref.html';

export type TnCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseTennesseeCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: TN_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createTnCfAdapter(opts: TnCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: TN_STATE_FIPS,
    stateAbbr: TN_STATE_ABBR,
    sourceName: 'tennessee-tref-cf',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseTennesseeCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
