/**
 * New Jersey Division of Elections — results adapter (FIPS 34).
 *
 * Primary feed (verified 2026-04-23 per state-sos-sources.ts):
 *   https://www.state.nj.us/state/elections/index.shtml
 *
 * Shape NJ publishes:
 *   - NJ publishes a per-election "Official Results" page with embedded
 *     HTML tables; in recent cycles a downloadable XLSX / PDF has been
 *     provided. No JSON/XML feed as of 2026.
 *   - Primary date: 2026-06-02.
 *
 * Strategy
 * --------
 * 1. Fetch index HTML.
 * 2. Try embedded summary tables first; fall back to link discovery.
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

const SOURCE_URL = 'https://www.state.nj.us/state/elections/index.shtml';
const STATE_FIPS = '34';

export function createNjResultsAdapter(
  options: { reportingLevel?: ReportingLevel } = {},
) {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  return createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'new-jersey-elections-results',
    sourceType: 'sos_results_api',
    sourceUrl: SOURCE_URL,
    license: 'state_open_records',
    expectedMinRows: 0,
    tokenBucket: { rps: 0.5, burst: 2 },
    fetch: async () => {
      const res = await politeFetch(SOURCE_URL, {
        headers: { Accept: 'text/html,*/*' },
      });
      if (!res.ok) throw new Error(`NJ fetch failed: ${res.status}`);
      return { rawBody: await res.text() };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (trimmed.startsWith('<') && /<ElectionReport/i.test(rawBody)) {
        return parseNistXml(rawBody, { reportingLevel });
      }
      if (!trimmed.startsWith('<')) return [];
      const tableRows = parseNjResultTables(rawBody, reportingLevel);
      if (tableRows.length > 0) return tableRows;
      const links = discoverNjResultLinks(rawBody);
      if (links.length === 0) {
        ctx.logger.info('nj-results: no result links (off-cycle)', {
          stateFips: STATE_FIPS,
        });
      } else {
        ctx.logger.info('nj-results: subpages discovered (parse deferred)', {
          stateFips: STATE_FIPS,
          count: links.length,
          sample: links[0],
        });
      }
      return [];
    },
  });
}

export function discoverNjResultLinks(html: string): string[] {
  const $ = loadHtml(html);
  const out: string[] = [];
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const text = ($(el).text() ?? '').trim().toLowerCase();
    if (!href) return;
    if (
      /result|primary|general|official/i.test(text) ||
      /\.(pdf|xlsx?|csv|htm|html)(?:[?#]|$)/i.test(href)
    ) {
      out.push(href);
    }
  });
  return out;
}

export function parseNjResultTables(
  html: string,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const $ = loadHtml(html);
  const rows: StateResultRow[] = [];
  $('table').each((_, table) => {
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
          source_row_id: `nj::${office}::${name}`,
        });
      });
  });
  return rows;
}
