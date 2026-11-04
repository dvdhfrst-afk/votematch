/**
 * North Dakota Secretary of State — results adapter (FIPS 38).
 *
 * Source (verified 2026-04-23):
 *   https://sos.nd.gov/elections
 *
 * Notes
 * -----
 * - ND's dominant liberal-leaning party is the Dem-NPL (Democratic-
 *   Nonpartisan League); it's state-scoped in the parties table. The
 *   party resolver prefers state-scoped rows so 'NPL' and 'Dem-NPL'
 *   resolve to the ND row (no adapter-side handling needed).
 * - HTML landing with inline result tables on-cycle. Off-cycle → [].
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

const STATE_FIPS = '38';
const SOURCE_URL = 'https://sos.nd.gov/elections';

export function createNdResultsAdapter(
  options: { reportingLevel?: ReportingLevel; sourceUrl?: string } = {},
): SourceAdapter<StateResultRow> {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  const url = options.sourceUrl ?? SOURCE_URL;

  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'north-dakota-sos-results',
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
        throw new Error(`ND fetch failed: HTTP ${res.status} from ${url}`);
      }
      return { rawBody: await res.text(), resolvedUrl: res.url };
    },
    parse: async (rawBody) =>
      parseHtmlResultTables(rawBody, reportingLevel, 'nd'),
  });

  adapter.costService = 'other';
  return adapter;
}
