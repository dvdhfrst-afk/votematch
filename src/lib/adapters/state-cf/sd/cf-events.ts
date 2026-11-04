/**
 * South Dakota — SoS Campaign Finance (FIPS 46).
 *
 * Portal: https://sdsos.gov/elections-voting/campaign-finance/default.aspx
 * Format: HTML landing with links to PDF/CSV filings on sdcfr.sdsos.gov.
 *         HTML-table skeleton with CSV passthrough.
 *
 * TODO
 * ----
 * Many filings are PDF-only on sdcfr.sdsos.gov — those need OCR/extractor.
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

export const SD_STATE_FIPS = '46';
export const SD_STATE_ABBR = 'SD';
const DEFAULT_URL =
  'https://sdsos.gov/elections-voting/campaign-finance/default.aspx';

export type SdCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseSouthDakotaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  if (!body) return [];
  const sourceUrl = opts.sourceUrl ?? DEFAULT_URL;
  const first = body.trimStart().split('\n', 1)[0] ?? '';
  if (!first.startsWith('<') && /,/.test(first)) {
    return parseGenericCfCsv(body, {
      state: SD_STATE_ABBR,
      sourceUrl,
      reportingPeriod: opts.reportingPeriod,
    });
  }
  return parseGenericCfHtmlTable(body, {
    state: SD_STATE_ABBR,
    sourceUrl,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createSdCfAdapter(opts: SdCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: SD_STATE_FIPS,
    stateAbbr: SD_STATE_ABBR,
    sourceName: 'south-dakota-sos-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseSouthDakotaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
