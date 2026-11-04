/**
 * Georgia — Government Transparency & Campaign Finance Commission adapter.
 *
 * Portal: https://efile.ethics.ga.gov/  (redirects to peachfile.ethics.ga.gov)
 *         https://ethics.ga.gov/
 * Format: Angular SPA. The eFile/PeachFile portal serves a single-page-app
 *         shell that fetches data via an XHR backend at runtime; the seed
 *         HTML contains zero `<table>` elements before JS execution. Bulk
 *         filings export to CSV / Excel per-committee but URLs are session-
 *         scoped and not deep-linkable.
 *
 * Strategy
 *   - Plain politeFetch of the portal URL. The seed HTML has no `<table>`
 *     until Angular hydrates, so without a browser the parser typically
 *     reports `no_table`; the run is recorded as `unproductive`.
 *   - If a table is present (or a caller supplies rendered HTML or a CSV
 *     export), `parseGenericCfHtmlTable` picks it up.
 *   - GA primary is 2026-05-19; runner marks off-cycle empty days as
 *     `unproductive` rather than `failed`.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';
import { politeFetch } from '../../fetch-polite';

export const GA_STATE_FIPS = '13';
export const GA_STATE_ABBR = 'GA';
// 2026-04-26: efile.ethics.ga.gov 301-redirects to peachfile.ethics.ga.gov;
// both URLs serve the same Angular SPA shell. We keep the canonical eFile
// URL as the source-of-record so historical content_hash diffs stay aligned.
const DEFAULT_URL = 'https://efile.ethics.ga.gov/';

export type GaCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseGeorgiaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: GA_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createGaCfAdapter(opts: GaCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: GA_STATE_FIPS,
    stateAbbr: GA_STATE_ABBR,
    sourceName: 'georgia-ethics-cf',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch:
      opts.fetchImpl ??
      (async () => {
        // PeachFile is an Angular SPA: the seed HTML has no `<table>`
        // until JS hydrates, and this adapter does not run a browser.
        // A non-table or blocked response yields 0 rows (no_table).
        const res = await politeFetch(url, {
          redirect: 'follow',
          headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        });
        return { rawBody: await res.text(), resolvedUrl: res.url || url };
      }),
    parse: async (body) =>
      parseGeorgiaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
