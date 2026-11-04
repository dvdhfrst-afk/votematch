/**
 * Minnesota Secretary of State — results adapter (FIPS 27).
 *
 * Source (verified 2026-04-23):
 *   https://www.sos.state.mn.us/elections-voting/
 *
 * MN publishes results via the MNVotes "Election Results" portal
 * (electionresults.sos.state.mn.us) as txt/csv + HTML summaries. This
 * adapter points at the main SoS elections-voting landing; on-cycle the
 * page includes inline result tables. Off-cycle → [].
 *
 * Party note: MN's Democratic-Farmer-Labor (DFL) party is state-scoped in
 * the parties table and resolves to the MN DFL row via the DFL alias on
 * the national Democratic row plus the state-scoped DFL row (party
 * resolver prefers state-scoped). See party-resolver.ts.
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

const STATE_FIPS = '27';
const SOURCE_URL = 'https://www.sos.state.mn.us/elections-voting/';

export function createMnResultsAdapter(
  options: { reportingLevel?: ReportingLevel; sourceUrl?: string } = {},
): SourceAdapter<StateResultRow> {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  const url = options.sourceUrl ?? SOURCE_URL;

  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'minnesota-sos-results',
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
        throw new Error(`MN fetch failed: HTTP ${res.status} from ${url}`);
      }
      return { rawBody: await res.text(), resolvedUrl: res.url };
    },
    parse: async (rawBody) =>
      parseHtmlResultTables(rawBody, reportingLevel, 'mn'),
  });

  adapter.costService = 'other';
  return adapter;
}
