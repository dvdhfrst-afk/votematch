/**
 * Missouri — Ethics Commission Campaign Finance Search (FIPS 29).
 *
 * Portal: https://www.mec.mo.gov/MEC/Campaign_Finance/CFSearch.aspx
 * Format: ASP.NET search portal with per-report detail pages. MEC also
 *         publishes contribution/expenditure bulk exports under
 *         mec.mo.gov/MEC/Campaign_Finance/CF_DataDownload.aspx;
 *         HTML-table skeleton with CSV passthrough.
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

export const MO_STATE_FIPS = '29';
export const MO_STATE_ABBR = 'MO';
const DEFAULT_URL =
  'https://www.mec.mo.gov/MEC/Campaign_Finance/CFSearch.aspx';

export type MoCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseMissouriCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  if (!body) return [];
  const sourceUrl = opts.sourceUrl ?? DEFAULT_URL;
  const first = body.trimStart().split('\n', 1)[0] ?? '';
  if (!first.startsWith('<') && /,/.test(first)) {
    return parseGenericCfCsv(body, {
      state: MO_STATE_ABBR,
      sourceUrl,
      reportingPeriod: opts.reportingPeriod,
    });
  }
  return parseGenericCfHtmlTable(body, {
    state: MO_STATE_ABBR,
    sourceUrl,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createMoCfAdapter(opts: MoCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: MO_STATE_FIPS,
    stateAbbr: MO_STATE_ABBR,
    sourceName: 'missouri-mec-cf',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseMissouriCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
