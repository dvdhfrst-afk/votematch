/**
 * North Carolina State Board of Elections — results adapter.
 *
 * Source (verified 2026-04-23):
 *   Landing: https://www.ncsbe.gov/
 *   Results portal: https://er.ncsbe.gov/
 *
 * NCSBE historically publishes per-election CSVs under er.ncsbe.gov (e.g.
 * https://er.ncsbe.gov/downloads.html?election_dt=...&access=...&rpt_name=...);
 * the landing page at ncsbe.gov links to those and during election season
 * surfaces a summary. We treat CSV as the primary path — fetch the
 * published CSV when a per-cycle URL is provided (via env) and fall back
 * to the landing page HTML scraper otherwise.
 *
 * CSV schema (typical NCSBE "results_pct_<YYYYMMDD>.csv"):
 *   County,Election Date,Precinct,Contest Group ID,Contest Type,Contest Name,
 *   Choice,Choice Party,Vote For,Election Day,One Stop,Absentee by Mail,
 *   Provisional,Total Votes,Real Precinct
 *
 * We aggregate per (Contest Name, Choice, Choice Party) summing Total Votes.
 */

import { parse as parseCsv } from 'csv-parse/sync';
import * as cheerio from 'cheerio';
import {
  createStateSosAdapter,
  type StateResultRow,
  type StateFetchResult,
  type StateReportingLevel,
} from '../base';
import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';

const STATE_FIPS = '37';
const LANDING_URL = 'https://www.ncsbe.gov/';

/**
 * Per-cycle CSV URL can be injected via env (e.g. NCSBE_RESULTS_CSV_URL).
 * When absent we fetch the landing HTML so the adapter still produces a
 * DataSourceDescriptor (even if parse returns zero rows).
 */
function resolveCycleUrl(): string {
  return process.env.NCSBE_RESULTS_CSV_URL ?? LANDING_URL;
}

export async function fetchNcResults(
  _ctx: AdapterContext,
): Promise<StateFetchResult> {
  const url = resolveCycleUrl();
  const res = await politeFetch(url, {
    headers: { Accept: 'text/csv, text/html' },
  });
  if (!res.ok) {
    throw new Error(`NC results fetch failed: HTTP ${res.status} from ${url}`);
  }
  const rawBody = await res.text();
  return { rawBody, resolvedUrl: res.url };
}

export async function parseNcResults(
  rawBody: string,
  _ctx: AdapterContext,
  reportingLevel: StateReportingLevel = 'unofficial_partial',
): Promise<StateResultRow[]> {
  if (!rawBody || rawBody.length < 2) return [];
  const trimmed = rawBody.trim();

  // Heuristic: if it starts with '<' we got HTML; otherwise CSV.
  if (trimmed.startsWith('<')) {
    return parseNcHtml(rawBody, reportingLevel);
  }
  return parseNcCsv(rawBody, reportingLevel);
}

/**
 * Parse NCSBE-style CSV. Groups by (Contest Name, Choice, Choice Party)
 * and sums Total Votes. This collapses the per-precinct cross-tab into a
 * contest-level result set.
 */
export function parseNcCsv(
  rawCsv: string,
  reportingLevel: StateReportingLevel = 'unofficial_partial',
): StateResultRow[] {
  let records: Record<string, string>[] = [];
  try {
    records = parseCsv(rawCsv, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];
  } catch {
    return [];
  }

  type Agg = {
    reported_name: string;
    party: string | null;
    office: string;
    votes: number;
    is_write_in: boolean;
  };
  const agg = new Map<string, Agg>();

  for (const r of records) {
    // NCSBE column names are mixed-case — normalize lookups.
    const lc = Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k.toLowerCase().replace(/\s+/g, ' ').trim(), v]),
    );
    const office = (lc['contest name'] ?? '').trim();
    const name = (lc['choice'] ?? '').trim();
    if (!office || !name) continue;
    const party = (lc['choice party'] ?? '').trim() || null;
    const totalRaw = (lc['total votes'] ?? '').trim();
    const votes = Number.parseInt(totalRaw.replace(/[, ]/g, ''), 10);
    const key = `${office}||${name}||${party ?? ''}`;
    const prev = agg.get(key);
    const inc = Number.isFinite(votes) ? votes : 0;
    if (prev) {
      prev.votes += inc;
    } else {
      agg.set(key, {
        reported_name: name,
        party,
        office,
        votes: inc,
        is_write_in: /write[-\s]*in/i.test(name),
      });
    }
  }

  const out: StateResultRow[] = [];
  let i = 0;
  for (const a of agg.values()) {
    out.push({
      reported_name: a.reported_name,
      party_abbreviation: a.party,
      office_name: a.office,
      district_identifier: null,
      vote_count: a.votes,
      vote_percentage: null,
      pct_precincts_reporting: null,
      is_winner: false,
      is_runoff_advancer: false,
      is_write_in: a.is_write_in,
      reporting_level: reportingLevel,
      source_row_id: `nc-csv-${i++}`,
    });
  }
  return out;
}

function parseNcHtml(
  rawBody: string,
  reportingLevel: StateReportingLevel = 'unofficial_partial',
): StateResultRow[] {
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
      (h) => h.includes('candidate') || h.includes('choice') || h.includes('name'),
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
        vote_count:
          votesCol >= 0
            ? Number.parseInt(cells[votesCol].replace(/[, ]/g, ''), 10) || null
            : null,
        vote_percentage:
          pctCol >= 0
            ? Number.parseFloat(cells[pctCol].replace(/[%, ]/g, '')) || null
            : null,
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: /write[-\s]*in/i.test(reportedName),
        reporting_level: reportingLevel,
        source_row_id: `nc-t${tableIdx}-r${rowIdx}`,
      });
    });
  });
  return rows;
}

export function createNcResultsAdapter(
  options: { reportingLevel?: StateReportingLevel } = {},
) {
  const reportingLevel = options.reportingLevel ?? 'unofficial_partial';
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'nc-ncsbe-results',
    sourceUrl: resolveCycleUrl(),
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    fetch: fetchNcResults,
    parse: (body, ctx) => parseNcResults(body, ctx, reportingLevel),
  });
  adapter.costService = 'other';
  return adapter;
}
