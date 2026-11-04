/**
 * Nebraska Secretary of State — results adapter (FIPS 31).
 *
 * Source (verified 2026-04-23):
 *   https://sos.nebraska.gov/index
 *
 * Notes
 * -----
 * - Nebraska is unicameral: only state_senate offices exist in the DB;
 *   there is no state_house. The office resolver already handles this —
 *   no adapter-side filtering needed. Rows reporting "State Senator,
 *   District N" resolve correctly; rows that somehow report a State
 *   House office will fail resolution and land in ingestion_errors.
 * - NE publishes per-election summary pages linked from the SoS landing.
 *   HTML table scrape; off-cycle → [].
 */

import {
  createStateSosAdapter,
  type StateResultRow,
  type StateReportingLevel,
} from '../base';
import { parseHtmlResultTables } from '../wi/results';
import type { SourceAdapter } from '../../types';
import { politeFetch } from '../../fetch-polite';

export type ReportingLevel = StateReportingLevel;

const STATE_FIPS = '31';
const SOURCE_URL = 'https://sos.nebraska.gov/index';

export function createNeResultsAdapter(
  options: { reportingLevel?: ReportingLevel; sourceUrl?: string } = {},
): SourceAdapter<StateResultRow> {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  const url = options.sourceUrl ?? SOURCE_URL;

  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'nebraska-sos-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    fetch: async () => {
      const res = await politeFetch(url, {
        headers: { Accept: 'text/html,*/*' },
      });
      if (!res.ok) {
        throw new Error(`NE fetch failed: HTTP ${res.status} from ${url}`);
      }
      return { rawBody: await res.text(), resolvedUrl: res.url };
    },
    parse: async (rawBody) =>
      parseHtmlResultTables(rawBody, reportingLevel, 'ne'),
  });

  adapter.costService = 'other';
  return adapter;
}
