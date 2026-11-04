/**
 * Washington Secretary of State — election results adapter (FIPS 53).
 *
 * Sources (verified 2026-04-23 via scripts/data/state-sos-sources.ts):
 *   - Landing:      https://www.sos.wa.gov/elections/
 *   - Live results: https://results.vote.wa.gov/ (per-cycle URLs; election-
 *                   night only). Historical dumps are posted here too.
 *
 * The `data_sources` row for state_fips='53' points at the landing page;
 * during live cycles the dispatcher should call this factory with
 * `sourceUrl: 'https://results.vote.wa.gov/<cycle-slug>/'` or deep-link a
 * specific summary / CSV export.
 *
 * WA publishes results in three machine-friendly shapes depending on the
 * phase of the cycle:
 *   1. HTML summary table (election night through ~72h after polls close).
 *   2. CSV download (daily rebase + final-certified).
 *   3. NIST XML (historically offered for federal contests; ad-hoc).
 *
 * This parser auto-detects format based on the first non-blank byte + the
 * presence of `<ElectionReport>`.
 *
 * Top-two primary
 * ---------------
 * WA's top-two primary (Initiative 872 / 2004) behaves identically to CA's
 * for our purposes: the top-2 overall advance to the general, not the
 * per-party winner. The parser uses the same post-processing step as CA
 * (see `applyTopTwoWinners`). resolveCandidacy is voting-rule agnostic.
 */

import * as cheerio from 'cheerio';
import {
  createStateSosAdapter,
  type StateFetchResult,
  type StateReportingLevel,
  type StateResultRow,
} from '../base';
import { parseNistXml } from '../nist-xml-parser';
import type { AdapterContext, SourceAdapter } from '../../types';
import { politeFetch } from '../../fetch-polite';

const STATE_FIPS = '53';
const DEFAULT_SOURCE_URL = 'https://www.sos.wa.gov/elections/';
export type WaVotingRule =
  | 'top_two_nonpartisan_primary'
  | 'partisan_general'
  | 'unknown';

export type WaParseOptions = {
  reportingLevel?: StateReportingLevel;
  votingRule?: WaVotingRule;
};

export function parseWashingtonResults(
  body: string,
  opts: WaParseOptions = {},
): StateResultRow[] {
  if (!body || body.length < 32) return [];
  const trimmed = body.trimStart();
  const reportingLevel = opts.reportingLevel ?? 'unofficial_partial';

  if (trimmed.startsWith('<') && /<ElectionReport/i.test(body)) {
    const rows = parseNistXml(body, { reportingLevel, strict: false });
    return applyTopTwoWinners(rows, opts.votingRule);
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  if (!trimmed.startsWith('<') && firstLine.includes(',')) {
    return applyTopTwoWinners(parseWaCsv(body, reportingLevel), opts.votingRule);
  }

  // HTML (landing + summary pages).
  return applyTopTwoWinners(parseWaHtml(body, reportingLevel), opts.votingRule);
}

function parseWaHtml(
  body: string,
  reportingLevel: StateReportingLevel,
): StateResultRow[] {
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
      (h) => h.includes('vote') || h === 'total',
    );
    const pctCol = headerCells.findIndex(
      (h) => h.includes('percent') || h.includes('%'),
    );
    const partyCol = headerCells.findIndex(
      (h) => h.includes('party') || h.includes('preference'),
    );
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
        source_row_id: `wa-t${tableIdx}-r${rowIdx}`,
      });
    });
  });
  return rows;
}

function parseWaCsv(
  body: string,
  reportingLevel: StateReportingLevel,
): StateResultRow[] {
  const cleaned = body.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = cleaned.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0]).map((h) => h.toLowerCase().trim());
  const idx = {
    office: findCol(header, ['race', 'raceid', 'office', 'contestname']),
    candidate: findCol(header, ['ballotname', 'candidate', 'name']),
    party: findCol(header, ['party', 'partypreference', 'preference']),
    votes: findCol(header, ['votes', 'votecount', 'total']),
    pct: findCol(header, ['percent', 'percentofvotes', 'percentage']),
    district: findCol(header, ['district', 'districtnumber', 'jurisdictionname']),
  };
  if (idx.office < 0 || idx.candidate < 0) return [];

  const rows: StateResultRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const c = splitCsv(lines[i]);
    if (c.length === 0) continue;
    const office = (c[idx.office] ?? '').trim();
    const name = (c[idx.candidate] ?? '').trim();
    if (!office || !name) continue;
    const districtStr = idx.district >= 0 ? (c[idx.district] ?? '').trim() : '';
    const districtFromCol = districtStr && /\d/.test(districtStr)
      ? districtStr.match(/(\d+)/)?.[1] ?? null
      : null;
    const districtId = districtFromCol ?? extractDistrictFromOffice(office);
    rows.push({
      reported_name: name,
      party_abbreviation:
        idx.party >= 0 && c[idx.party] ? (c[idx.party] ?? '').trim() : null,
      office_name: office,
      district_identifier: districtId,
      vote_count: idx.votes >= 0 ? parseIntOrNull(c[idx.votes]) : null,
      vote_percentage: idx.pct >= 0 ? parsePctOrNull(c[idx.pct]) : null,
      pct_precincts_reporting: null,
      is_winner: false,
      is_runoff_advancer: false,
      is_write_in: /write[-\s]*in/i.test(name),
      reporting_level: reportingLevel,
      source_row_id: `wa-csv-${i}-${office}-${name}`,
    });
  }
  return rows;
}

/**
 * Post-process is_winner based on voting rule. Top-two primary: top-2 rows
 * (by vote_count) per (office, district) are marked winner=true regardless
 * of party. General: only the highest.
 */
function applyTopTwoWinners(
  rows: StateResultRow[],
  rule: WaVotingRule | undefined,
): StateResultRow[] {
  if (!rule || rule === 'unknown') return rows;
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
      rule === 'top_two_nonpartisan_primary' ? sorted.slice(0, 2) : sorted.slice(0, 1);
    for (const r of top) {
      if (r.vote_count !== null) r.is_winner = true;
    }
  }
  return rows;
}

// Tiny CSV splitter (quoted-aware, no escape expansion).
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (ch === ',' && !inQuote) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function findCol(header: string[], aliases: string[]): number {
  for (const a of aliases) {
    const idx = header.findIndex(
      (h) => h.replace(/[^a-z0-9]/g, '') === a.replace(/[^a-z0-9]/g, ''),
    );
    if (idx >= 0) return idx;
  }
  return -1;
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
  // "9th Congressional District", "9th Legislative District", "9th District" — allow
  // an optional adjective between the ordinal and the word "district".
  const m2 = office.match(/\b(\d{1,3})(?:st|nd|rd|th)\s+(?:\w+\s+)?district\b/i);
  if (m2 && m2[1]) return m2[1];
  const m3 = office.match(/\blegislative\s+district\s+(\d{1,3})\b/i);
  if (m3 && m3[1]) return m3[1];
  return null;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export type CreateWaResultsAdapterOptions = {
  sourceUrl?: string;
  reportingLevel?: StateReportingLevel;
  votingRule?: WaVotingRule;
  electionYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createWaResultsAdapter(
  options: CreateWaResultsAdapterOptions = {},
): SourceAdapter<StateResultRow> {
  const url = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'wa-sos-results',
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
          headers: {
            Accept: 'text/html,application/xml,text/csv,*/*',
          },
        });
        if (!res.ok) {
          throw new Error(`WA fetch failed: HTTP ${res.status} from ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) =>
      parseWashingtonResults(body, {
        reportingLevel: options.reportingLevel,
        votingRule: options.votingRule,
      }),
  });
  adapter.costService = 'other';
  return adapter;
}
