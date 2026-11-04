/**
 * Indiana Secretary of State — election results adapter (FIPS 18).
 *
 * Primary feed (per state-sos-sources.ts):
 *   Landing:  https://www.in.gov/sos/elections/
 *   Portal:   https://enr.indianavoters.in.gov/    (dynamic ENR dashboard)
 *
 * Indiana's ENR portal (enr.indianavoters.in.gov) is a React-rendered dashboard
 * backed by JSON endpoints. The crawlable entrypoint is the HTML landing page
 * on in.gov/sos/elections/, which links out to per-election results PDFs +
 * the ENR portal. This adapter fetches the landing HTML, scrapes for any
 * inline results tables + outbound result links, and parses the tables
 * when present. During off-cycle windows the page has no result rows.
 *
 * Future enhancement: sniff the ENR portal's JSON endpoints once they're
 * publicly documented; drop back to HTML table scrape as fallback.
 */

import * as cheerio from 'cheerio';
import {
  createStateSosAdapter,
  type StateResultRow,
  type StateReportingLevel,
} from '../base';
import type { SourceAdapter } from '../../types';
import { politeFetch } from '../../fetch-polite';

export type ReportingLevel = StateReportingLevel;

const STATE_FIPS = '18';
const SOURCE_URL = 'https://enr.indianavoters.in.gov/';

export function createInResultsAdapter(
  options: { reportingLevel?: ReportingLevel; sourceUrl?: string } = {},
): SourceAdapter<StateResultRow> {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  const url = options.sourceUrl ?? SOURCE_URL;

  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'indiana-sos-enr',
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
        throw new Error(`IN fetch failed: HTTP ${res.status} from ${url}`);
      }
      return { rawBody: await res.text(), resolvedUrl: res.url };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (!trimmed) return [];
      if (trimmed.startsWith('<')) {
        const rows = parseIndianaHtml(rawBody, reportingLevel);
        if (rows.length === 0) {
          const links = discoverInResultLinks(rawBody);
          if (links.length > 0) {
            ctx.logger.info(
              'in-results: discovered result links but no inline tables',
              { stateFips: STATE_FIPS, count: links.length, sample: links[0] },
            );
          }
        }
        return rows;
      }
      return [];
    },
  });

  adapter.costService = 'other';
  return adapter;
}

// ---------------------------------------------------------------------------
// Parsers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse Indiana ENR / SoS landing HTML. Looks for <table>s with headers
 * matching 'candidate'/'name' + 'vote'/'percent'. Pairs each table with
 * the nearest preceding <h1|h2|h3|h4> for office name.
 */
export function parseIndianaHtml(
  rawBody: string,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  if (!rawBody || rawBody.length < 64) return [];
  const $ = cheerio.load(rawBody);
  const rows: StateResultRow[] = [];

  $('table').each((tableIdx, tableEl) => {
    const $table = $(tableEl);
    const headerCells = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((_i, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headerCells.length === 0) return;
    const nameCol = headerCells.findIndex(
      (h) => h.includes('candidate') || h === 'name',
    );
    const votesCol = headerCells.findIndex(
      (h) => h.includes('vote') || h === 'total',
    );
    const pctCol = headerCells.findIndex(
      (h) => h.includes('percent') || h.includes('%'),
    );
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    if (nameCol < 0 || (votesCol < 0 && pctCol < 0)) return;

    let officeName = '';
    const $prev = $table.prevAll('h1,h2,h3,h4,caption').first();
    if ($prev.length) officeName = $prev.text().trim();
    const $caption = $table.find('caption').first();
    if (!officeName && $caption.length) officeName = $caption.text().trim();
    if (!officeName) officeName = 'Unknown Office';

    $table.find('tr').each((rowIdx, trEl) => {
      if (rowIdx === 0) return;
      const cells = $(trEl)
        .find('td')
        .map((_i, el) => $(el).text().trim())
        .get();
      if (cells.length === 0) return;
      const reportedName = cells[nameCol] ?? '';
      if (!reportedName) return;
      rows.push({
        reported_name: reportedName,
        party_abbreviation:
          partyCol >= 0 ? cells[partyCol] || null : null,
        office_name: officeName,
        district_identifier: null,
        vote_count: votesCol >= 0 ? parseIntOrNull(cells[votesCol]) : null,
        vote_percentage: pctCol >= 0 ? parsePctOrNull(cells[pctCol]) : null,
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: /write[-\s]*in/i.test(reportedName),
        reporting_level: reportingLevel,
        source_row_id: `in-t${tableIdx}-r${rowIdx}`,
      });
    });
  });
  return rows;
}

/**
 * Anchor-only scan for results links on the in.gov/sos/elections landing
 * page. Used purely for logging / operator follow-up.
 */
export function discoverInResultLinks(rawBody: string): string[] {
  const $ = cheerio.load(rawBody);
  const out: string[] = [];
  $('a').each((_i, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const text = ($(el).text() ?? '').trim().toLowerCase();
    if (!href) return;
    if (
      /results|tabulation|summary|canvass/i.test(text) ||
      /results|tabulation|canvass/i.test(href)
    ) {
      out.push(href);
    }
  });
  return out;
}

function parseIntOrNull(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[, ]/g, '');
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

function parsePctOrNull(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[%, ]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}
