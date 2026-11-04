/**
 * Georgia Secretary of State — results adapter (PDF-deferred).
 *
 * Source (verified 2026-04-23):
 *   https://sos.ga.gov/index.php/elections
 *
 * Format note: Georgia official results are published primarily as PDFs
 * (per-county and state-summary). Live election-night dashboards exist at
 * results.enr.clarityelections.com/GA/... but those are delivered via an
 * encoded JSON embedded in HTML with per-race detail pages, which we
 * treat as out-of-scope for the initial adapter pass per the task brief
 * ("GA: results are often PDF-only; flag as PDF-deferred").
 *
 * Behaviour: fetch the landing page so provenance (data_sources row +
 * content_hash) is captured, but return [] from parse(). This intentionally
 * produces 'partial' runs — surfaced as a clear signal that GA results
 * ingestion is waiting on a PDF or Clarity-JSON parser.
 *
 * TODO: when we ship a Clarity-JSON or PDF extractor, replace parseGaResults
 * with the real implementation.
 */

import {
  createStateSosAdapter,
  type StateResultRow,
  type StateFetchResult,
  type StateReportingLevel,
} from '../base';
import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';

const STATE_FIPS = '13';
const SOURCE_URL = 'https://sos.ga.gov/index.php/elections';

export async function fetchGaResults(
  _ctx: AdapterContext,
): Promise<StateFetchResult> {
  const res = await politeFetch(SOURCE_URL, {
    headers: { Accept: 'text/html' },
  });
  if (!res.ok) {
    throw new Error(
      `GA results fetch failed: HTTP ${res.status} from ${SOURCE_URL}`,
    );
  }
  const rawBody = await res.text();
  return {
    rawBody,
    resolvedUrl: res.url,
    meta: { note: 'pdf_deferred' },
  };
}

/**
 * PDF-deferred placeholder. Returns [].
 *
 * When a concrete extractor lands, this function should accept the raw
 * HTML from the landing page, discover links to per-cycle PDFs (or the
 * Clarity election-night JSON), fetch + parse those, and emit rows.
 */
export async function parseGaResults(
  _rawBody: string,
  _ctx: AdapterContext,
): Promise<StateResultRow[]> {
  return [];
}

export function createGaResultsAdapter(
  _options: { reportingLevel?: StateReportingLevel } = {},
) {
  // reportingLevel is accepted for dispatcher-signature compatibility but
  // unused because parseGaResults is a PDF-deferred placeholder.
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'ga-sos-results',
    sourceUrl: SOURCE_URL,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    // expectedMinRows=0 reflects the PDF-deferred status; re-setting to 1
    // once the real parser lands will surface 'partial' runs correctly.
    expectedMinRows: 0,
    fetch: fetchGaResults,
    parse: parseGaResults,
  });
  adapter.costService = 'other';
  return adapter;
}
