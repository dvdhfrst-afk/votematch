/**
 * Alaska Division of Elections — results adapter (FIPS 02).
 *
 * Source (verified 2026-04-23 via scripts/data/state-sos-sources.ts):
 *   https://www.elections.alaska.gov/
 *
 * Format: HTML landing page. AK DoE publishes per-election PDFs + HTML
 * summary pages under /results/; there is no NIST XML feed.
 *
 * Top-four primary + RCV general
 * ------------------------------
 * Ballot Measure 2 (2020) changed Alaska to:
 *   - Primary (Aug): nonpartisan top-4 — the top FOUR candidates overall
 *     (not per party) advance to the general.
 *   - General (Nov): ranked-choice voting (instant-runoff) among those 4.
 *
 * For our data model:
 *   - In PRIMARY contests, `is_winner` denotes "advancing to the general"
 *     i.e. top 4 overall. We set it via post-processing the parsed rows.
 *   - In GENERAL contests, `is_winner` denotes the final round winner. RCV
 *     rounds are not modeled here — the adapter consumes whatever the
 *     official portal reports as the final result.
 *   - `is_runoff_advancer` is left false for AK: the top-N advancement is
 *     represented via is_winner=true on primaries. (The CHECK constraint
 *     requires is_winner and is_runoff_advancer to be mutually exclusive.)
 *
 * resolveCandidacy is voting-rule agnostic — reported_name -> candidacy
 * mapping is identical regardless of which phase we're ingesting.
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

const STATE_FIPS = '02';
const DEFAULT_SOURCE_URL = 'https://www.elections.alaska.gov/';

export type AkVotingRule =
  | 'top_four_nonpartisan_primary'
  | 'rcv_general'
  | 'unknown';

export type AkParseOptions = {
  reportingLevel?: StateReportingLevel;
  votingRule?: AkVotingRule;
};

export function parseAlaskaResults(
  body: string,
  opts: AkParseOptions = {},
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
      (h) => h.includes('vote') || h === 'total' || h.includes('final'),
    );
    const pctCol = headerCells.findIndex(
      (h) => h.includes('percent') || h.includes('%'),
    );
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    if (!hasCandidate || (votesCol < 0 && pctCol < 0)) return;

    let officeName = '';
    const $prev = $table.prevAll('h1,h2,h3,h4,caption').first();
    if ($prev.length) officeName = $prev.text().trim();
    const $caption = $table.find('caption').first();
    if (!officeName && $caption.length) officeName = $caption.text().trim();
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
        source_row_id: `ak-t${tableIdx}-r${rowIdx}`,
      });
    });
  });

  // Post-process is_winner per voting rule.
  //   top_four_nonpartisan_primary -> top 4 overall per contest advance
  //   rcv_general                  -> single highest (final-round) wins
  if (votingRule !== 'unknown') {
    const groups = new Map<string, StateResultRow[]>();
    for (const r of rows) {
      const key = `${r.office_name}||${r.district_identifier ?? ''}`;
      const arr = groups.get(key);
      if (arr) arr.push(r);
      else groups.set(key, [r]);
    }
    const topN = votingRule === 'top_four_nonpartisan_primary' ? 4 : 1;
    for (const group of groups.values()) {
      const sorted = [...group].sort(
        (a, b) => (b.vote_count ?? -1) - (a.vote_count ?? -1),
      );
      for (const r of sorted.slice(0, topN)) {
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
function extractDistrictFromOffice(office: string): string | null {
  const m = office.match(/\b(?:district\s+|d\.?\s*)(\d{1,3})\b/i);
  if (m && m[1]) return m[1];
  const m2 = office.match(/\b(\d{1,3})(?:st|nd|rd|th)\s+district\b/i);
  if (m2 && m2[1]) return m2[1];
  const m3 = office.match(/\bhouse\s+district\s+(\d{1,3})\b/i);
  if (m3 && m3[1]) return m3[1];
  return null;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export type CreateAkResultsAdapterOptions = {
  sourceUrl?: string;
  reportingLevel?: StateReportingLevel;
  votingRule?: AkVotingRule;
  electionYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createAkResultsAdapter(
  options: CreateAkResultsAdapterOptions = {},
): SourceAdapter<StateResultRow> {
  const url = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'ak-doe-results',
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
          throw new Error(`AK fetch failed: HTTP ${res.status} from ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) =>
      parseAlaskaResults(body, {
        reportingLevel: options.reportingLevel,
        votingRule: options.votingRule,
      }),
  });
  adapter.costService = 'other';
  return adapter;
}
