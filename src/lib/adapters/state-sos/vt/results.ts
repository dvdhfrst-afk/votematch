/**
 * Vermont Secretary of State — election results adapter (FIPS 50).
 *
 * Primary feed (verified 2026-04-23 per state-sos-sources.ts):
 *   https://sos.vermont.gov/elections/
 *
 * Shape VT publishes:
 *   - HTML landing page linking to per-election "Election Results" pages.
 *   - Current election-night portal has historically published a JSON
 *     endpoint via electionresults.vermont.gov; however the SoS keeps
 *     the canonical archive at sos.vermont.gov/elections/.
 *   - Primary date: 2026-08-11.
 *
 * Strategy
 * --------
 * 1. Fetch the index HTML.
 * 2. If body looks like JSON (starts with '[' or '{'), parse via
 *    {@link parseVtJson}.
 * 3. If HTML, try to locate embedded result table rows and parse them.
 *    When no current election, return [].
 */

import { load as loadHtml } from 'cheerio';
import {
  createStateSosAdapter,
  type StateResultRow,
  type StateReportingLevel,
} from '../base';
import { parseNistXml } from '../nist-xml-parser';
import { politeFetch } from '../../fetch-polite';

export type ReportingLevel = StateReportingLevel;

const SOURCE_URL = 'https://sos.vermont.gov/elections/';
const STATE_FIPS = '50';

export function createVtResultsAdapter(
  options: { reportingLevel?: ReportingLevel } = {},
) {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  return createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'vermont-sos-results',
    sourceType: 'sos_results_api',
    sourceUrl: SOURCE_URL,
    license: 'state_open_records',
    expectedMinRows: 0,
    tokenBucket: { rps: 0.5, burst: 2 },
    fetch: async () => {
      const res = await politeFetch(SOURCE_URL, {
        headers: { Accept: 'text/html,application/json,*/*' },
      });
      if (!res.ok) throw new Error(`VT fetch failed: ${res.status}`);
      return { rawBody: await res.text() };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return parseVtJson(JSON.parse(rawBody), reportingLevel);
        } catch (err) {
          ctx.logger.warn('vt-results: JSON parse failed', {
            err: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      }
      if (trimmed.startsWith('<') && /<ElectionReport/i.test(rawBody)) {
        return parseNistXml(rawBody, { reportingLevel });
      }
      if (trimmed.startsWith('<')) {
        return parseVtHtmlTable(rawBody, reportingLevel);
      }
      return [];
    },
  });
}

type VtJsonContest = {
  office?: string;
  district?: string | number | null;
  candidates?: Array<{
    name?: string;
    party?: string | null;
    votes?: number | null;
    winner?: boolean;
    write_in?: boolean;
  }>;
  pct_reporting?: number | null;
};

export function parseVtJson(
  data: unknown,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const contests: VtJsonContest[] = Array.isArray(data)
    ? (data as VtJsonContest[])
    : Array.isArray((data as { contests?: unknown })?.contests)
      ? ((data as { contests: VtJsonContest[] }).contests)
      : [];
  const rows: StateResultRow[] = [];
  for (const c of contests) {
    const office = (c.office ?? '').toString().trim();
    if (!office) continue;
    const district =
      c.district === null || c.district === undefined
        ? null
        : String(c.district).trim() || null;
    for (const cand of c.candidates ?? []) {
      const name = (cand.name ?? '').toString().trim();
      if (!name) continue;
      const votes =
        typeof cand.votes === 'number' && Number.isFinite(cand.votes)
          ? cand.votes
          : null;
      rows.push({
        reported_name: name,
        party_abbreviation: cand.party ?? null,
        office_name: office,
        district_identifier: district,
        vote_count: votes,
        vote_percentage: null,
        pct_precincts_reporting:
          typeof c.pct_reporting === 'number' ? c.pct_reporting : null,
        is_winner: Boolean(cand.winner),
        is_runoff_advancer: false,
        is_write_in: Boolean(cand.write_in) || /write[\s-]?in/i.test(name),
        reporting_level: reportingLevel,
        source_row_id: `vt::${office}::${district ?? '-'}::${name}`,
      });
    }
  }
  return rows;
}

/**
 * Vermont's SoS page occasionally embeds result tables. We look for any
 * <table> whose header contains "Office"/"Candidate" columns.
 */
export function parseVtHtmlTable(
  html: string,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const $ = loadHtml(html);
  const rows: StateResultRow[] = [];
  $('table').each((_, table) => {
    const headers = $(table)
      .find('thead th, tr:first-child th, tr:first-child td')
      .map((__, th) => $(th).text().toLowerCase().trim())
      .get();
    if (headers.length === 0) return;
    const colOffice = headers.findIndex((h) => /office|contest/.test(h));
    const colName = headers.findIndex((h) => /candidate|name/.test(h));
    const colVotes = headers.findIndex((h) => /votes?|total/.test(h));
    const colParty = headers.findIndex((h) => /party/.test(h));
    if (colOffice < 0 || colName < 0 || colVotes < 0) return;
    $(table)
      .find('tbody tr, tr')
      .each((__, tr) => {
        const cells = $(tr)
          .find('td')
          .map((___, td) => $(td).text().trim())
          .get();
        if (cells.length === 0) return;
        const office = cells[colOffice] ?? '';
        const name = cells[colName] ?? '';
        const votesStr = (cells[colVotes] ?? '').replace(/[,\s]/g, '');
        if (!office || !name) return;
        const vc = Number(votesStr);
        rows.push({
          reported_name: name,
          party_abbreviation:
            colParty >= 0 ? cells[colParty] || null : null,
          office_name: office,
          district_identifier: null,
          vote_count: Number.isFinite(vc) ? vc : null,
          vote_percentage: null,
          pct_precincts_reporting: null,
          is_winner: false,
          is_runoff_advancer: false,
          is_write_in: /write[\s-]?in/i.test(name),
          reporting_level: reportingLevel,
          source_row_id: `vt::${office}::${name}`,
        });
      });
  });
  return rows;
}
