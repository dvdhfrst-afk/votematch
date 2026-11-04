/**
 * Colorado — TRACER (FIPS 08).
 *
 * Portal: https://tracer.sos.colorado.gov/
 * Publications: https://tracer.sos.colorado.gov/PublicSite/Publications.aspx
 * Format: Rich public portal; the Publications landing exposes per-cycle
 *         CSV downloads behind ASP.NET postbacks, and the SearchPages
 *         route hosts live filing tables. Default URL is the Publications
 *         landing; drive a per-cycle CSV through `--source-url`.
 *
 * Skeleton HTML-table scrape via parseGenericCfHtmlTable. When `sourceUrl`
 * points at a CSV body, the parser falls through to rows=[] (HTML detect
 * branch in the adapter).
 *
 * TODO: wire a dedicated CSV adapter when postback params stabilize.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import {
  parseGenericCfCsv,
  parseGenericCfHtmlTable,
} from '../shared/html-parsers';

export const CO_STATE_FIPS = '08';
export const CO_STATE_ABBR = 'CO';
export const CO_TRACER_URL = 'https://tracer.sos.colorado.gov/';
export const CO_TRACER_PUBLICATIONS_URL =
  'https://tracer.sos.colorado.gov/PublicSite/Publications.aspx';

export type CoCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseColoradoCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  const trimmed = body.trimStart();
  if (trimmed.startsWith('<')) {
    return parseGenericCfHtmlTable(body, {
      state: CO_STATE_ABBR,
      sourceUrl: opts.sourceUrl ?? CO_TRACER_PUBLICATIONS_URL,
      reportingPeriod: opts.reportingPeriod,
    });
  }
  // Publications hands back CSV when the user follows a download link.
  return parseGenericCfCsv(body, {
    state: CO_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? CO_TRACER_PUBLICATIONS_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createCoCfAdapter(opts: CoCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? CO_TRACER_PUBLICATIONS_URL;
  return createStateCfAdapter({
    stateFips: CO_STATE_FIPS,
    stateAbbr: CO_STATE_ABBR,
    sourceName: 'colorado-tracer-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    // 2026-04-25: tracer.sos.colorado.gov returns
    // UNABLE_TO_VERIFY_LEAF_SIGNATURE on Node fetch — the cert chain is
    // missing an intermediate that browsers patch around but Node won't.
    // Bypass for this state .gov endpoint only.
    fetch:
      opts.fetchImpl ?? (async () => fetchCfHtml(url, { allowSelfSignedCert: true })),
    parse: async (body) =>
      parseColoradoCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
