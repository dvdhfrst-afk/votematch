/**
 * Michigan Bureau of Elections — results adapter (FIPS 26).
 *
 * MI swapped MERTS (the old unofficial results portal) for MiTN (Michigan
 * Transparency Network) recently. Old MERTS URLs now 404 or redirect; this
 * adapter points at the canonical MiTN-era SoS elections landing and will
 * discover per-election JSON or HTML links from there.
 *
 * Source (verified 2026-04-23 per state-sos-sources.ts):
 *   https://www.michigan.gov/sos/elections
 *
 * Formats observed:
 *   - Landing page is HTML; links to per-election dashboards.
 *   - Per-election dashboards sometimes expose a JSON endpoint (MiTN
 *     React app), sometimes only HTML table rows.
 *   - During off-cycle windows there are no result rows.
 *
 * Strategy
 * --------
 * 1. Fetch the SoS elections landing page.
 * 2. If the body is JSON (Content-Type may mis-declare), try to parse
 *    a flat { contests: [...] } shape emitted by MiTN dashboards.
 * 3. If the body is HTML, scan for <table> tags with result rows
 *    (same shape as DE adapter); also discover outbound links to
 *    per-election pages so the operator can register follow-up runs.
 * 4. Off-cycle / empty → return [].
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

const STATE_FIPS = '26';
const SOURCE_URL = 'https://www.michigan.gov/sos/elections';
export function createMiResultsAdapter(
  options: { reportingLevel?: ReportingLevel; sourceUrl?: string } = {},
): SourceAdapter<StateResultRow> {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  const url = options.sourceUrl ?? SOURCE_URL;

  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'michigan-sos-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    fetch: async () => {
      const res = await politeFetch(url, {
        headers: {
          Accept: 'application/json,text/html;q=0.9,*/*;q=0.5',
        },
      });
      if (!res.ok) {
        throw new Error(`MI fetch failed: HTTP ${res.status} from ${url}`);
      }
      return { rawBody: await res.text(), resolvedUrl: res.url };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (!trimmed) return [];
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(rawBody);
          return parseMiJson(parsed, reportingLevel);
        } catch (err) {
          ctx.logger.warn('mi-results: JSON parse failed, falling through', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (trimmed.startsWith('<')) {
        return parseMiHtml(rawBody, reportingLevel);
      }
      return [];
    },
  });

  adapter.costService = 'other';
  return adapter;
}

// ---------------------------------------------------------------------------
// Parsers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Parse a MiTN-style JSON body. Accepts two shapes:
 *   1. { contests: [ { name, district, candidates: [ { name, party,
 *      votes, percent, winner? } ] } ] }
 *   2. A flat array of the same contest objects (older dashboard variant).
 *
 * Unknown shapes return []. We intentionally do not coerce / guess — the
 * operator sees an empty-row run and investigates.
 */
export function parseMiJson(
  json: unknown,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const rows: StateResultRow[] = [];
  const contests = asContestArray(json);
  if (contests.length === 0) return rows;

  for (let cIdx = 0; cIdx < contests.length; cIdx++) {
    const contest = contests[cIdx] as Record<string, unknown>;
    const officeName =
      asString(contest.name) ??
      asString(contest.office) ??
      asString(contest.contest_name) ??
      '';
    if (!officeName) continue;
    const districtId =
      asString(contest.district) ??
      asString(contest.district_id) ??
      asString(contest.district_identifier) ??
      null;
    const pctReporting =
      asNumber(contest.percent_reporting) ??
      asNumber(contest.pct_precincts_reporting) ??
      null;
    const candidates = Array.isArray(contest.candidates)
      ? (contest.candidates as unknown[])
      : [];
    for (let idx = 0; idx < candidates.length; idx++) {
      const cand = candidates[idx] as Record<string, unknown>;
      const reportedName =
        asString(cand.name) ??
        asString(cand.candidate_name) ??
        asString(cand.ballot_name) ??
        '';
      if (!reportedName) continue;
      rows.push({
        reported_name: reportedName,
        party_abbreviation:
          asString(cand.party) ??
          asString(cand.party_abbreviation) ??
          null,
        office_name: officeName,
        district_identifier: districtId,
        vote_count: asNumber(cand.votes) ?? asNumber(cand.vote_count) ?? null,
        vote_percentage:
          asNumber(cand.percent) ??
          asNumber(cand.vote_percentage) ??
          null,
        pct_precincts_reporting: pctReporting,
        is_winner: asBool(cand.winner) || asBool(cand.is_winner),
        is_runoff_advancer: false,
        is_write_in:
          asBool(cand.write_in) ||
          asBool(cand.is_write_in) ||
          /write[-\s]*in/i.test(reportedName),
        reporting_level: reportingLevel,
        source_row_id: `mi::c${cIdx}::${reportedName}`,
      });
    }
  }
  return rows;
}

/**
 * Parse a Michigan HTML dashboard. Heuristic: find each <table> whose
 * header contains 'candidate' + one of 'vote'/'percent'. Office name is
 * the nearest preceding <h1|h2|h3|h4>.
 */
export function parseMiHtml(
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
    const hasCandidate = headerCells.some((h) => h.includes('candidate'));
    const votesCol = headerCells.findIndex(
      (h) => h.includes('vote') || h === 'total',
    );
    const pctCol = headerCells.findIndex(
      (h) => h.includes('percent') || h.includes('%'),
    );
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    if (!hasCandidate || (votesCol < 0 && pctCol < 0)) return;

    let officeName = '';
    const $prev = $table.prevAll('h1,h2,h3,h4').first();
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
        source_row_id: `mi-t${tableIdx}-r${rowIdx}`,
      });
    });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function asContestArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const contests = (v as Record<string, unknown>).contests;
    if (Array.isArray(contests)) return contests;
  }
  return [];
}

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[,%\s]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['true', 'yes', '1'].includes(v.toLowerCase());
  return false;
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
