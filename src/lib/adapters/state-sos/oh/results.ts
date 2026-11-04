/**
 * Ohio Secretary of State — election results adapter (FIPS 39).
 *
 * Primary feed (per blueprint + verified historically):
 *   https://liveresults.ohiosos.gov/
 *
 * Ohio is the canonical "easy" SoS: the election-night portal at
 * liveresults.ohiosos.gov publishes a NIST 1500-100 v2 XML feed that
 * parseNistXml() already consumes in full. The HTML landing at
 * www.sos.state.oh.us/elections/ is kept as a secondary sourceUrl in the
 * data_sources table (see scripts/data/state-sos-sources.ts) but this
 * adapter points directly at the XML endpoint.
 *
 * Strategy
 * --------
 * 1. Fetch the liveresults XML.
 * 2. Pass the body through parseNistXml().
 * 3. If the body is empty or the page is off-cycle (no <ElectionReport>),
 *    return []. The framework flags the run 'partial' since expectedMinRows=0.
 *
 * Defensive fallback: if for any reason the endpoint returns HTML (e.g.
 * a WAF wall), log and return [] rather than crashing. Upstream audit
 * picks these up.
 */

import {
  createStateSosAdapter,
  type StateResultRow,
  type StateReportingLevel,
} from '../base';
import { parseNistXml } from '../nist-xml-parser';
import type { SourceAdapter } from '../../types';
import { politeFetch } from '../../fetch-polite';

export type ReportingLevel = StateReportingLevel;

const STATE_FIPS = '39';
const SOURCE_URL = 'https://liveresults.ohiosos.gov/';
export function createOhResultsAdapter(
  options: { reportingLevel?: ReportingLevel; sourceUrl?: string } = {},
): SourceAdapter<StateResultRow> {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  const url = options.sourceUrl ?? SOURCE_URL;

  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'ohio-sos-liveresults',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    fetch: async () => {
      const res = await politeFetch(url, {
        headers: {
          Accept: 'application/xml,text/xml,*/*',
        },
      });
      if (!res.ok) {
        throw new Error(`OH fetch failed: HTTP ${res.status} from ${url}`);
      }
      return { rawBody: await res.text(), resolvedUrl: res.url };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (!trimmed) return [];
      if (trimmed.startsWith('<') && /<ElectionReport/i.test(rawBody)) {
        return parseNistXml(rawBody, { reportingLevel, strict: false });
      }
      ctx.logger.info(
        'oh-results: non-NIST body received (off-cycle or HTML wall)',
        { stateFips: STATE_FIPS, byteSize: rawBody.length },
      );
      return [];
    },
  });

  adapter.costService = 'other';
  return adapter;
}
