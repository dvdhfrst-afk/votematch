/**
 * California Secretary of State — election results adapter (FIPS 06).
 *
 * Source (verified 2026-04-23 via scripts/data/state-sos-sources.ts):
 *   https://www.sos.ca.gov/elections
 *
 * Format note
 * -----------
 * California does not publish a single state-wide NIST XML feed. Live
 * election-night results are served from two different surfaces:
 *
 *   - electionresults.sos.ca.gov   — historical + certified statewide results
 *                                    as HTML summary pages + downloadable TXT
 *                                    / XLS files (one per contest).
 *   - www.sos.ca.gov/elections      — landing page + per-election portal links.
 *
 * The canonical `data_sources` row for state_fips='06' points at the landing
 * page because that is what the seeds file declares as `live_today`. The
 * adapter therefore pulls the landing HTML, looks for a live results-summary
 * table (during election windows), and falls back to [] when the page is
 * off-cycle. The dispatcher may override `sourceUrl` with a deep-linked
 * contest page when a cycle is hot.
 *
 * Top-two-primary semantics
 * -------------------------
 * CA uses a top-two nonpartisan primary (Proposition 14 / 2010). For PRIMARY
 * contests the parser's is_winner flag denotes "advancing to the general" —
 * i.e. the top-two candidates overall, regardless of party. For GENERAL
 * contests is_winner denotes the seat winner in the usual sense. Because the
 * parser does not always know which phase a given page is, we rely on a
 * best-effort signal: the caller passes `votingRule='top_two_nonpartisan_primary'`
 * (or omits it for general) and we mark the top-two rows. resolveCandidacy
 * does not care about voting rule — the reported_name -> candidacy mapping
 * is identical — but downstream consumers that look at is_winner should
 * honor the top-two-overall convention for CA primaries.
 *
 * No live fetches during adapter construction; fetch closure is invoked by
 * runAdapter() at dispatch time.
 */

import * as cheerio from 'cheerio';
import {
  createStateSosAdapter,
  type StateFetchResult,
  type StateReportingLevel,
  type StateResultRow,
} from '../base';
import type { AdapterContext, SourceAdapter } from '../../types';
import { politeFetch } from '../../fetch-polite';

const STATE_FIPS = '06';
const DEFAULT_SOURCE_URL = 'https://www.sos.ca.gov/elections';

export type CaVotingRule =
  | 'top_two_nonpartisan_primary'
  | 'partisan_general'
  | 'unknown';

export type CaParseOptions = {
  reportingLevel?: StateReportingLevel;
  votingRule?: CaVotingRule;
};

/**
 * Parse a CA SoS results HTML page. Works against both the landing page
 * (returns [] off-cycle) and per-contest summary pages.
 *
 * For top-two primaries we post-process the rows: within each
 * (office_name, district_identifier) group, the two highest vote_count rows
 * get is_winner=true (top-two advance). For general contests only the
 * single highest gets is_winner=true.
 */
export function parseCaliforniaResults(
  body: string,
  opts: CaParseOptions = {},
): StateResultRow[] {
  if (!body || body.length < 64) return [];
  const reportingLevel = opts.reportingLevel ?? 'unofficial_partial';
  const votingRule = opts.votingRule ?? 'unknown';

  const $ = cheerio.load(body);
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
      (h) => h.includes('vote') || h === 'total' || h === 'totals',
    );
    const pctCol = headerCells.findIndex(
      (h) => h.includes('percent') || h.includes('%'),
    );
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    if (!hasCandidate || (votesCol < 0 && pctCol < 0)) return;

    // Office = nearest preceding heading or caption.
    let officeName = '';
    const $caption = $table.find('caption').first();
    if ($caption.length) officeName = $caption.text().trim();
    if (!officeName) {
      const $prev = $table.prevAll('h1,h2,h3,h4').first();
      if ($prev.length) officeName = $prev.text().trim();
    }
    if (!officeName) officeName = 'Unknown Office';

    const districtId = extractDistrictFromOffice(officeName);

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
        district_identifier: districtId,
        vote_count: votesCol >= 0 ? parseIntOrNull(cells[votesCol]) : null,
        vote_percentage: pctCol >= 0 ? parsePctOrNull(cells[pctCol]) : null,
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: /write[-\s]*in/i.test(reportedName),
        reporting_level: reportingLevel,
        source_row_id: `ca-t${tableIdx}-r${rowIdx}`,
      });
    });
  });

  // Apply is_winner semantics:
  //   - top_two_nonpartisan_primary: top-2 overall advance (NOT per-party).
  //   - partisan_general: single highest wins.
  //   - unknown: leave is_winner=false (safer than guessing).
  if (votingRule !== 'unknown') {
    const groups = new Map<string, StateResultRow[]>();
    for (const r of rows) {
      const key = `${r.office_name}||${r.district_identifier ?? ''}`;
      const arr = groups.get(key);
      if (arr) arr.push(r);
      else groups.set(key, [r]);
    }
    for (const group of groups.values()) {
      const sorted = [...group].sort(
        (a, b) => (b.vote_count ?? -1) - (a.vote_count ?? -1),
      );
      const top =
        votingRule === 'top_two_nonpartisan_primary'
          ? sorted.slice(0, 2)
          : sorted.slice(0, 1);
      for (const r of top) {
        if (r.vote_count !== null) r.is_winner = true;
      }
    }
  }

  return rows;
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

/**
 * Pull a district number out of an office name.
 *   "U.S. House of Representatives, District 12"  -> "12"
 *   "State Assembly, 47th District"               -> "47"
 *   "Governor"                                    -> null
 */
function extractDistrictFromOffice(office: string): string | null {
  const m = office.match(/\b(?:district\s+|d\.?\s*)(\d{1,3})\b/i);
  if (m && m[1]) return m[1];
  const m2 = office.match(/\b(\d{1,3})(?:st|nd|rd|th)\s+(?:\w+\s+)?district\b/i);
  if (m2 && m2[1]) return m2[1];
  return null;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export type CreateCaResultsAdapterOptions = {
  sourceUrl?: string;
  reportingLevel?: StateReportingLevel;
  votingRule?: CaVotingRule;
  electionYear?: number;
  /** Injectable fetch for tests / dispatcher URL overrides. */
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createCaResultsAdapter(
  options: CreateCaResultsAdapterOptions = {},
): SourceAdapter<StateResultRow> {
  const url = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'ca-sos-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: options.electionYear,
    fetch:
      options.fetchImpl ??
      (async () => {
        const res = await politeFetch(url, {
          headers: { Accept: 'text/html' },
        });
        if (!res.ok) {
          throw new Error(`CA fetch failed: HTTP ${res.status} from ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (rawBody) =>
      parseCaliforniaResults(rawBody, {
        reportingLevel: options.reportingLevel,
        votingRule: options.votingRule,
      }),
  });
  adapter.costService = 'other';
  return adapter;
}
