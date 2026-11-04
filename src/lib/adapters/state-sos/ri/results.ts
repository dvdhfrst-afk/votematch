/**
 * Rhode Island Secretary of State — election results adapter (FIPS 44).
 *
 * Primary feed (verified 2026-04-23 per state-sos-sources.ts):
 *   https://vote.sos.ri.gov/
 *
 * Shape RI publishes:
 *   - vote.sos.ri.gov is a React app backed by an internal JSON API at
 *     /api/Elections, /api/ElectionResults, etc. URLs are subject to change;
 *     we treat the landing page as the canonical entrypoint.
 *   - Primary date: 2026-09-09.
 *
 * Strategy
 * --------
 * 1. Fetch the landing page.
 * 2. If JSON API response comes back instead, route through {@link parseRiJson}.
 * 3. Otherwise return [] (off-cycle) and log the HTML fetch for visibility.
 */

import {
  createStateSosAdapter,
  type StateResultRow,
  type StateReportingLevel,
} from '../base';
import { parseNistXml } from '../nist-xml-parser';
import { politeFetch } from '../../fetch-polite';

export type ReportingLevel = StateReportingLevel;

const SOURCE_URL = 'https://vote.sos.ri.gov/';
const STATE_FIPS = '44';

export function createRiResultsAdapter(
  options: { reportingLevel?: ReportingLevel } = {},
) {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  return createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'rhode-island-sos-results',
    sourceType: 'sos_results_api',
    sourceUrl: SOURCE_URL,
    license: 'state_open_records',
    expectedMinRows: 0,
    tokenBucket: { rps: 0.5, burst: 2 },
    fetch: async () => {
      const res = await politeFetch(SOURCE_URL, {
        headers: { Accept: 'application/json,text/html,*/*' },
      });
      if (!res.ok) throw new Error(`RI fetch failed: ${res.status}`);
      return { rawBody: await res.text() };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return parseRiJson(JSON.parse(rawBody), reportingLevel);
        } catch (err) {
          ctx.logger.warn('ri-results: JSON parse failed', {
            err: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      }
      if (trimmed.startsWith('<') && /<ElectionReport/i.test(rawBody)) {
        return parseNistXml(rawBody, { reportingLevel });
      }
      // HTML landing page: React app shell — no server-rendered data.
      ctx.logger.info('ri-results: HTML shell; API URL needed for election-night', {
        stateFips: STATE_FIPS,
      });
      return [];
    },
  });
}

/**
 * RI's internal JSON shape (reverse-engineered from vote.sos.ri.gov 2024 cycle):
 *   {
 *     "election": { "id": ..., "date": "2024-11-05", ... },
 *     "contests": [
 *       {
 *         "office": "Governor",
 *         "district": "STATEWIDE",
 *         "candidates": [
 *           { "name":"...", "party":"DEM", "votes":12345, "pct":45.2, "isWinner":true }
 *         ],
 *         "pctReporting": 99.0
 *       },
 *       ...
 *     ]
 *   }
 */
type RiContest = {
  office?: string;
  district?: string | null;
  pctReporting?: number | null;
  candidates?: Array<{
    name?: string;
    party?: string | null;
    votes?: number | null;
    pct?: number | null;
    isWinner?: boolean;
    isWriteIn?: boolean;
  }>;
};

export function parseRiJson(
  data: unknown,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const contests: RiContest[] = Array.isArray(data)
    ? (data as RiContest[])
    : Array.isArray((data as { contests?: unknown })?.contests)
      ? ((data as { contests: RiContest[] }).contests)
      : [];
  const rows: StateResultRow[] = [];
  for (const c of contests) {
    const office = (c.office ?? '').toString().trim();
    if (!office) continue;
    const districtRaw =
      c.district === null || c.district === undefined
        ? null
        : String(c.district).trim();
    const district =
      districtRaw && !/^STATEWIDE$/i.test(districtRaw) ? districtRaw : null;
    for (const cand of c.candidates ?? []) {
      const name = (cand.name ?? '').toString().trim();
      if (!name) continue;
      rows.push({
        reported_name: name,
        party_abbreviation: cand.party ?? null,
        office_name: office,
        district_identifier: district,
        vote_count:
          typeof cand.votes === 'number' && Number.isFinite(cand.votes)
            ? cand.votes
            : null,
        vote_percentage:
          typeof cand.pct === 'number' && Number.isFinite(cand.pct)
            ? cand.pct
            : null,
        pct_precincts_reporting:
          typeof c.pctReporting === 'number' ? c.pctReporting : null,
        is_winner: Boolean(cand.isWinner),
        is_runoff_advancer: false,
        is_write_in: Boolean(cand.isWriteIn) || /write[\s-]?in/i.test(name),
        reporting_level: reportingLevel,
        source_row_id: `ri::${office}::${district ?? '-'}::${name}`,
      });
    }
  }
  return rows;
}
