/**
 * Missouri Secretary of State — results adapter (FIPS 29).
 *
 * Source (verified 2026-04-23):
 *   https://www.sos.mo.gov/elections/
 *
 * MO publishes per-election detail pages linked from the main elections
 * landing. Summary tables appear on-cycle. No NIST/JSON endpoint. HTML
 * table scrape; off-cycle → [].
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

const STATE_FIPS = '29';
const SOURCE_URL = 'https://www.sos.mo.gov/elections/';

export function createMoResultsAdapter(
  options: { reportingLevel?: ReportingLevel; sourceUrl?: string } = {},
): SourceAdapter<StateResultRow> {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  const url = options.sourceUrl ?? SOURCE_URL;

  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'missouri-sos-results',
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
        throw new Error(`MO fetch failed: HTTP ${res.status} from ${url}`);
      }
      return { rawBody: await res.text(), resolvedUrl: res.url };
    },
    parse: async (rawBody) =>
      parseHtmlResultTables(rawBody, reportingLevel, 'mo'),
  });

  adapter.costService = 'other';
  return adapter;
}
