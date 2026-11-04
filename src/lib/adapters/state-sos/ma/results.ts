/**
 * Massachusetts Secretary of the Commonwealth — election results adapter (FIPS 25).
 *
 * Primary feed (verified 2026-04-23 per state-sos-sources.ts):
 *   https://www.sec.state.ma.us/ele/eleidx.htm
 *
 * Shape MA publishes:
 *   - HTML landing page with anchors to per-election subpages.
 *   - Individual elections publish HTML result tables (town-by-town)
 *     and some have downloadable Excel files.
 *   - Primary date: 2026-09-01.
 *
 * No NIST XML or JSON API as of 2026.
 *
 * Strategy
 * --------
 * 1. Fetch index HTML.
 * 2. Surface result links if present; defer XLS/PDF parsing.
 * 3. If body is a current per-contest page with an embedded summary table,
 *    parse via {@link parseMaSummaryTable}. That parser is the election-night
 *    hot path once the real URL is known.
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

const SOURCE_URL = 'https://www.sec.state.ma.us/ele/eleidx.htm';
const STATE_FIPS = '25';

export function createMaResultsAdapter(
  options: { reportingLevel?: ReportingLevel } = {},
) {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  return createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'massachusetts-sec-results',
    sourceType: 'sos_results_api',
    sourceUrl: SOURCE_URL,
    license: 'state_open_records',
    expectedMinRows: 0,
    tokenBucket: { rps: 0.5, burst: 2 },
    fetch: async () => {
      const res = await politeFetch(SOURCE_URL, {
        headers: { Accept: 'text/html,*/*' },
      });
      if (!res.ok) throw new Error(`MA fetch failed: ${res.status}`);
      return { rawBody: await res.text() };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (trimmed.startsWith('<') && /<ElectionReport/i.test(rawBody)) {
        return parseNistXml(rawBody, { reportingLevel });
      }
      if (trimmed.startsWith('<')) {
        // Try summary table first (real-time pages); fall through to index
        // link discovery when no table present.
        const tableRows = parseMaSummaryTable(rawBody, reportingLevel);
        if (tableRows.length > 0) return tableRows;
        const links = discoverMaResultLinks(rawBody);
        if (links.length === 0) {
          ctx.logger.info('ma-results: no result links (off-cycle)', {
            stateFips: STATE_FIPS,
          });
        } else {
          ctx.logger.info('ma-results: subpages discovered, deferred parse', {
            stateFips: STATE_FIPS,
            count: links.length,
            sample: links[0],
          });
        }
        return [];
      }
      return [];
    },
  });
}

export function discoverMaResultLinks(html: string): string[] {
  const $ = loadHtml(html);
  const out: string[] = [];
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const text = ($(el).text() ?? '').trim().toLowerCase();
    if (!href) return;
    if (
      /result|election|primary|general/i.test(text) &&
      /\.(htm|html|xlsx?|pdf)(?:[?#]|$)/i.test(href)
    ) {
      out.push(href);
    }
  });
  return out;
}

/**
 * Massachusetts summary-page tables: each contest gets its own <table>
 * with a caption/h2 holding the office name; rows list candidate + party +
 * total votes. Uses a light fuzzy match so minor layout changes don't
 * break ingestion.
 */
export function parseMaSummaryTable(
  html: string,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const $ = loadHtml(html);
  const rows: StateResultRow[] = [];

  $('table').each((_, table) => {
    // Office name from preceding heading or caption.
    const caption = $(table).find('caption').first().text().trim();
    const prevHeading = $(table)
      .prevAll('h1,h2,h3,h4')
      .first()
      .text()
      .trim();
    const office = caption || prevHeading;

    const headers = $(table)
      .find('thead th, tr:first-child th, tr:first-child td')
      .map((__, th) => $(th).text().toLowerCase().trim())
      .get();
    if (headers.length < 2) return;
    const colName = headers.findIndex((h) => /candidate|name/.test(h));
    const colVotes = headers.findIndex((h) => /votes?|total/.test(h));
    const colParty = headers.findIndex((h) => /party/.test(h));
    if (colName < 0 || colVotes < 0 || !office) return;

    $(table)
      .find('tbody tr')
      .each((__, tr) => {
        const cells = $(tr)
          .find('td')
          .map((___, td) => $(td).text().trim())
          .get();
        if (cells.length === 0) return;
        const name = cells[colName] ?? '';
        const votesStr = (cells[colVotes] ?? '').replace(/[,\s]/g, '');
        if (!name) return;
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
          source_row_id: `ma::${office}::${name}`,
        });
      });
  });

  return rows;
}
