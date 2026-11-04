/**
 * West Virginia Secretary of State — results adapter.
 *
 * Source (verified 2026-04-23):
 *   Landing: https://sos.wv.gov/elections/Pages/default.aspx
 *   Candidate API (known-good filings endpoint, memory-noted 93% email
 *     hit-rate): https://candidates.wvsos.gov/candidate-web-api/candidates
 *
 * Strategy: WV's filings API returns JSON; the *results* portal during
 * election season has historically exposed a similar JSON shape at
 * /results-web-api/... but that endpoint is not live off-cycle and the
 * canonical URL pattern has not been confirmed. Defensive plan:
 *   1. Try the landing HTML at sos.wv.gov/elections/Pages/default.aspx
 *      and look for summary tables (same scraper heuristic as other
 *      states).
 *   2. If the parser sees a JSON body (starts with '{' or '['), fall
 *      through to a lightweight JSON walk that accepts the filings-API
 *      shape (array of objects) as a template.
 *
 * This keeps the adapter useful if/when WVSOS publishes a results JSON
 * endpoint under a similar path, without hard-coding the URL now.
 */

import * as cheerio from 'cheerio';
import {
  createStateSosAdapter,
  type StateResultRow,
  type StateFetchResult,
  type StateReportingLevel,
} from '../base';
import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';

const STATE_FIPS = '54';
const SOURCE_URL = 'https://sos.wv.gov/elections/Pages/default.aspx';

export async function fetchWvResults(
  _ctx: AdapterContext,
): Promise<StateFetchResult> {
  const res = await politeFetch(SOURCE_URL, {
    headers: { Accept: 'text/html, application/json' },
  });
  if (!res.ok) {
    throw new Error(
      `WV results fetch failed: HTTP ${res.status} from ${SOURCE_URL}`,
    );
  }
  const rawBody = await res.text();
  return { rawBody, resolvedUrl: res.url };
}

export async function parseWvResults(
  rawBody: string,
  _ctx: AdapterContext,
  reportingLevel: StateReportingLevel = 'unofficial_partial',
): Promise<StateResultRow[]> {
  if (!rawBody || rawBody.length < 2) return [];

  const trimmed = rawBody.trim();
  // JSON path — if we get redirected to an API shape.
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed) as unknown;
      return parseWvJson(json, reportingLevel);
    } catch {
      return [];
    }
  }

  // HTML path.
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
    const hasCandidate = headerCells.some(
      (h) => h.includes('candidate') || h.includes('name'),
    );
    const votesCol = headerCells.findIndex(
      (h) => h.includes('vote') || h.includes('total'),
    );
    const pctCol = headerCells.findIndex(
      (h) => h.includes('percent') || h.includes('%'),
    );
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    if (!hasCandidate || (votesCol < 0 && pctCol < 0)) return;

    let officeName = '';
    const $prev = $table.prevAll('h1,h2,h3,h4,caption').first();
    if ($prev.length) officeName = $prev.text().trim();
    if (!officeName) officeName = 'Unknown Office';

    $table.find('tr').each((rowIdx, trEl) => {
      if (rowIdx === 0) return;
      const cells = $(trEl)
        .find('td')
        .map((_i, el) => $(el).text().trim())
        .get();
      if (cells.length === 0) return;
      const reportedName = cells[0];
      if (!reportedName) return;
      rows.push({
        reported_name: reportedName,
        party_abbreviation:
          partyCol >= 0 && cells[partyCol] ? cells[partyCol] : null,
        office_name: officeName,
        district_identifier: null,
        vote_count: votesCol >= 0 ? parseIntOrNull(cells[votesCol]) : null,
        vote_percentage: pctCol >= 0 ? parsePctOrNull(cells[pctCol]) : null,
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: /write[-\s]*in/i.test(reportedName),
        reporting_level: reportingLevel,
        source_row_id: `wv-t${tableIdx}-r${rowIdx}`,
      });
    });
  });
  return rows;
}

/**
 * Permissive JSON walker. Accepts shapes like:
 *   [ { officeName, candidateName, party, votes, percent } ... ]
 *   { contests: [ { office, selections: [ { name, party, votes, pct } ] } ] }
 *
 * Returns [] for shapes we can't interpret. We prefer "no rows" over
 * "attach vote totals to the wrong person".
 */
function parseWvJson(
  raw: unknown,
  reportingLevel: StateReportingLevel = 'unofficial_partial',
): StateResultRow[] {
  const rows: StateResultRow[] = [];

  // Flat array of candidate-row objects.
  if (Array.isArray(raw)) {
    raw.forEach((item, idx) => {
      if (!item || typeof item !== 'object') return;
      const row = coerceFlatRow(
        item as Record<string, unknown>,
        `wv-json-${idx}`,
        reportingLevel,
      );
      if (row) rows.push(row);
    });
    return rows;
  }

  // Nested "contests" wrapper.
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const contests = Array.isArray(obj.contests)
      ? (obj.contests as unknown[])
      : [];
    contests.forEach((c, ci) => {
      if (!c || typeof c !== 'object') return;
      const contest = c as Record<string, unknown>;
      const officeName = String(contest.office ?? contest.officeName ?? '').trim();
      const selections = Array.isArray(contest.selections)
        ? (contest.selections as unknown[])
        : [];
      selections.forEach((s, si) => {
        if (!s || typeof s !== 'object') return;
        const sel = s as Record<string, unknown>;
        const name = String(sel.name ?? sel.candidateName ?? '').trim();
        if (!name || !officeName) return;
        rows.push({
          reported_name: name,
          party_abbreviation: toStrOrNull(sel.party ?? sel.partyAbbreviation),
          office_name: officeName,
          district_identifier: toStrOrNull(sel.district ?? contest.district),
          vote_count: toNumOrNull(sel.votes ?? sel.voteCount),
          vote_percentage: toNumOrNull(sel.percent ?? sel.pct),
          pct_precincts_reporting: null,
          is_winner: sel.isWinner === true,
          is_runoff_advancer: false,
          is_write_in: sel.isWriteIn === true || /write[-\s]*in/i.test(name),
          reporting_level: reportingLevel,
          source_row_id: `wv-json-c${ci}-s${si}`,
        });
      });
    });
  }
  return rows;
}

function coerceFlatRow(
  item: Record<string, unknown>,
  id: string,
  reportingLevel: StateReportingLevel = 'unofficial_partial',
): StateResultRow | null {
  const officeName = String(
    item.officeName ?? item.office ?? '',
  ).trim();
  const reportedName = String(
    item.candidateName ?? item.name ?? '',
  ).trim();
  if (!officeName || !reportedName) return null;
  return {
    reported_name: reportedName,
    party_abbreviation: toStrOrNull(item.party ?? item.partyAbbreviation),
    office_name: officeName,
    district_identifier: toStrOrNull(item.district),
    vote_count: toNumOrNull(item.votes ?? item.voteCount),
    vote_percentage: toNumOrNull(item.percent ?? item.pct),
    pct_precincts_reporting: null,
    is_winner: item.isWinner === true,
    is_runoff_advancer: false,
    is_write_in:
      item.isWriteIn === true || /write[-\s]*in/i.test(reportedName),
    reporting_level: reportingLevel,
    source_row_id: id,
  };
}

function toStrOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[, %]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function parseIntOrNull(s: string): number | null {
  if (!s) return null;
  const n = parseInt(s.replace(/[, ]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function parsePctOrNull(s: string): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace(/[%, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function createWvResultsAdapter(
  options: { reportingLevel?: StateReportingLevel } = {},
) {
  const reportingLevel = options.reportingLevel ?? 'unofficial_partial';
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'wv-sos-results',
    sourceUrl: SOURCE_URL,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    fetch: fetchWvResults,
    parse: (body, ctx) => parseWvResults(body, ctx, reportingLevel),
  });
  adapter.costService = 'other';
  return adapter;
}
