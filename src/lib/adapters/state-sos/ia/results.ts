/**
 * Iowa Secretary of State — results adapter (FIPS 19).
 *
 * Source (verified 2026-04-23):
 *   https://sos.iowa.gov/
 *
 * Iowa publishes per-election summaries at sos.iowa.gov/elections/results/;
 * no NIST / JSON endpoint documented. HTML table scrape. Off-cycle → [].
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

const STATE_FIPS = '19';
const SOURCE_URL = 'https://sos.iowa.gov/';

export function createIaResultsAdapter(
  options: { reportingLevel?: ReportingLevel; sourceUrl?: string } = {},
): SourceAdapter<StateResultRow> {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  const url = options.sourceUrl ?? SOURCE_URL;

  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'iowa-sos-results',
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
        throw new Error(`IA fetch failed: HTTP ${res.status} from ${url}`);
      }
      return { rawBody: await res.text(), resolvedUrl: res.url };
    },
    parse: async (rawBody) =>
      parseHtmlResultTables(rawBody, reportingLevel, 'ia'),
  });

  adapter.costService = 'other';
  return adapter;
}
