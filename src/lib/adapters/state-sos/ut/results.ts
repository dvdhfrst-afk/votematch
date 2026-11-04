/**
 * Utah SoS election-results adapter.
 *
 * Home state / demo state — prioritize fidelity over all other states in this
 * batch. Utah is run by the Lt. Governor's office (not SoS — Utah abolished
 * that office in 1895). Results are published on vote.utah.gov.
 *
 * Formats observed (not all live simultaneously):
 *   1. CSV exports — historically posted during/after election night. The
 *      2024 general cycle posted a CSV with columns:
 *        Race, Candidate, Party, District, Votes, Percentage, Winner,
 *        Precincts Reported %
 *   2. HTML results tables — the default live view on vote.utah.gov during
 *      election night. Each office is a <table> with class ~ "results-table".
 *   3. XLSX for certified canvass (not handled here; see ingest-utah-2026-xlsx).
 *
 * This adapter tries CSV first (content-type text/csv or body begins with a
 * recognizable header). Otherwise it falls back to HTML parsing via cheerio.
 *
 * Source: sos-sources row state_fips='49' — vote.utah.gov (sos_results_html,
 * verified_status='live_today' on 2026-04-23). Rate-limited to 0.5 rps with
 * burst 2 because election night is the only time this URL sees real traffic
 * and we don't want to get IP-blocked.
 */

import { load as loadHtml } from 'cheerio';
import { parse as parseCsv } from 'csv-parse/sync';
import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';
import {
  createStateSosAdapter,
  type StateFetchResult,
  type StateResultRow,
  type StateReportingLevel,
} from '../base';

export const UT_STATE_FIPS = '49';
const DEFAULT_URL = 'https://vote.utah.gov/';

// ---------------------------------------------------------------------------
// Parser — public for unit tests
// ---------------------------------------------------------------------------

export type UtahParseOptions = {
  reportingLevel?: StateReportingLevel;
};

/**
 * Dispatch CSV vs HTML parsing based on a cheap content sniff. The CSV path
 * is preferred because Utah publishes normalized columns; HTML is the
 * fallback when only the live portal is available.
 */
export function parseUtahResults(
  body: string,
  opts: UtahParseOptions = {},
): StateResultRow[] {
  if (looksLikeCsv(body)) return parseUtahCsv(body, opts);
  return parseUtahHtml(body, opts);
}

function looksLikeCsv(body: string): boolean {
  // First non-empty line contains a "Race" or "Candidate" header AND commas,
  // and no leading '<' which would indicate HTML / XML.
  const trimmed = body.trimStart();
  if (trimmed.startsWith('<')) return false;
  const firstLine = trimmed.split(/\r?\n/)[0] ?? '';
  if (!firstLine.includes(',')) return false;
  const lower = firstLine.toLowerCase();
  return (
    (lower.includes('race') || lower.includes('contest') ||
      lower.includes('office')) &&
    (lower.includes('candidate') || lower.includes('name')) &&
    (lower.includes('vote') || lower.includes('count') ||
      lower.includes('total'))
  );
}

// ---------------------------------------------------------------------------
// CSV path
// ---------------------------------------------------------------------------

type UtahCsvRow = Record<string, string>;

export function parseUtahCsv(
  body: string,
  opts: UtahParseOptions = {},
): StateResultRow[] {
  const reportingLevel = opts.reportingLevel ?? 'unofficial_partial';
  const rows = parseCsv(body, {
    columns: (h: string[]) => h.map((c) => c.trim().toLowerCase()),
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as UtahCsvRow[];

  const out: StateResultRow[] = [];
  let idx = 0;
  for (const r of rows) {
    const raceCell =
      firstDefined(r, ['race', 'contest', 'office', 'race name', 'office name']);
    const candidateCell =
      firstDefined(r, ['candidate', 'name', 'candidate name']);
    if (!raceCell || !candidateCell) continue;

    const { office_name, district_identifier } = splitOfficeDistrict(raceCell);
    const party = firstDefined(r, ['party', 'party abbreviation', 'affiliation']);
    const voteCount = toIntOrNull(
      firstDefined(r, ['votes', 'vote count', 'total votes', 'total']),
    );
    const percent = toPercentOrNull(
      firstDefined(r, ['percentage', 'percent', 'vote %', '%']),
    );
    const pct = toPercentOrNull(
      firstDefined(r, [
        'precincts reported %',
        'precincts reporting',
        '% precincts reporting',
        'precincts %',
      ]),
    );
    const winner = toBool(firstDefined(r, ['winner', 'is winner', 'elected']));
    const writeIn = toBool(firstDefined(r, ['write-in', 'write in', 'is write-in']));

    out.push({
      reported_name: candidateCell,
      party_abbreviation: normalizeParty(party),
      office_name,
      district_identifier,
      vote_count: voteCount,
      vote_percentage: percent,
      pct_precincts_reporting: pct,
      is_winner: winner,
      is_runoff_advancer: false,
      is_write_in: writeIn || /write[\s-]?in/i.test(candidateCell),
      reporting_level: reportingLevel,
      source_row_id: `ut-csv:${idx++}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML path (cheerio)
// ---------------------------------------------------------------------------

export function parseUtahHtml(
  body: string,
  opts: UtahParseOptions = {},
): StateResultRow[] {
  const reportingLevel = opts.reportingLevel ?? 'unofficial_partial';
  const $ = loadHtml(body);
  const out: StateResultRow[] = [];
  let idx = 0;

  // Heuristic: each result block has a heading (h2/h3) with the race name
  // followed by a table whose rows carry candidate/party/votes/%.
  $('h1, h2, h3, h4').each((_i, el) => {
    const headingText = $(el).text().trim();
    if (!headingText) return;
    // Consider this a race heading only if it mentions words we expect.
    if (!/(governor|senator|representative|attorney|treasur|auditor|mayor|council|board|president|judge|justice|district|commission|sheriff|assessor|recorder)/i.test(headingText)) {
      return;
    }
    const table = $(el).nextAll('table').first();
    if (!table.length) return;

    const headers = table
      .find('thead th, tr').first()
      .find('th, td')
      .map((__, th) => $(th).text().trim().toLowerCase())
      .get();
    if (headers.length === 0) return;

    const colIx = (matchers: string[]): number => {
      for (let i = 0; i < headers.length; i++) {
        for (const m of matchers) {
          if (headers[i].includes(m)) return i;
        }
      }
      return -1;
    };
    const iName = colIx(['candidate', 'name']);
    const iParty = colIx(['party']);
    const iVotes = colIx(['vote', 'total']);
    const iPct = colIx(['%', 'percent']);

    if (iName < 0 || iVotes < 0) return;

    const { office_name, district_identifier } =
      splitOfficeDistrict(headingText);

    table.find('tbody tr, tr').each((__, tr) => {
      const cells = $(tr).find('td').map((___, td) => $(td).text().trim()).get();
      if (cells.length === 0) return; // skip header row(s)
      const name = cells[iName];
      if (!name) return;

      const voteCount = toIntOrNull(cells[iVotes]);
      const percent = iPct >= 0 ? toPercentOrNull(cells[iPct]) : null;
      const party = iParty >= 0 ? cells[iParty] : null;
      const isWriteIn = /write[\s-]?in/i.test(name);
      const isWinner = $(tr).hasClass('winner') ||
        $(tr).find('.winner, [data-winner="true"]').length > 0;

      out.push({
        reported_name: name,
        party_abbreviation: normalizeParty(party),
        office_name,
        district_identifier,
        vote_count: voteCount,
        vote_percentage: percent,
        pct_precincts_reporting: null,
        is_winner: isWinner,
        is_runoff_advancer: false,
        is_write_in: isWriteIn,
        reporting_level: reportingLevel,
        source_row_id: `ut-html:${idx++}`,
      });
    });
  });

  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function firstDefined(r: UtahCsvRow, keys: string[]): string | null {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function toIntOrNull(v: string | null | undefined): number | null {
  if (v == null) return null;
  const cleaned = v.replace(/[,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Parse a percentage value. Accepts '12.3', '12.3%', '12,345' (European),
 * and the literal word 'N/A'. Returns null when not parseable.
 */
export function toPercentOrNull(v: string | null | undefined): number | null {
  if (v == null) return null;
  const cleaned = v.replace(/%/g, '').replace(/\s/g, '').replace(/,(\d{1,2})$/, '.$1');
  if (!cleaned || /^n\/?a$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return n;
}

function toBool(v: string | null | undefined): boolean {
  if (v == null) return false;
  return /^(true|yes|y|1|winner|elected)$/i.test(v.trim());
}

function normalizeParty(p: string | null | undefined): string | null {
  if (!p) return null;
  const t = p.trim();
  if (!t) return null;
  // Collapse common long forms the Utah feed sometimes emits.
  const map: Record<string, string> = {
    'democrat': 'DEM',
    'democratic': 'DEM',
    'republican': 'REP',
    'libertarian': 'LIB',
    'constitution': 'CON',
    'independent american': 'IAP',
    'independent': 'IND',
    'unaffiliated': 'UNA',
    'united utah': 'UUP',
  };
  const normalized = map[t.toLowerCase()];
  return normalized ?? t.toUpperCase();
}

/**
 * Split 'U.S. House District 1' into {office_name:'U.S. House', district:'1'}.
 * Keeps the office_name in its reported form; the resolver normalizes further.
 */
export function splitOfficeDistrict(raw: string): {
  office_name: string;
  district_identifier: string | null;
} {
  const m = raw.match(/district\s*(\d+)/i);
  if (!m) return { office_name: raw.trim(), district_identifier: null };
  const district = m[1];
  const office = raw.replace(/,?\s*district\s*\d+/i, '').trim() || raw.trim();
  return { office_name: office, district_identifier: district };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type UtahAdapterOptions = {
  /** Override for tests / nightly-archive runs. */
  sourceUrl?: string;
  electionYear?: number;
  reportingLevel?: StateReportingLevel;
  /** Injected so tests can supply a body without a live fetch. */
  fetchImpl?: (ctx: AdapterContext) => Promise<StateFetchResult>;
};

export function createUtahResultsAdapter(opts: UtahAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  const base = createStateSosAdapter({
    stateFips: UT_STATE_FIPS,
    sourceName: 'utah-vote-results',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 1,
    electionYear: opts.electionYear,
    fetch:
      opts.fetchImpl ??
      (async () => {
        const res = await politeFetch(url, {
          headers: { accept: 'text/csv, text/html, */*' },
        });
        if (!res.ok) {
          throw new Error(`ut-results: HTTP ${res.status} for ${url}`);
        }
        const body = await res.text();
        const lastModified = res.headers.get('last-modified') ?? undefined;
        const etag = res.headers.get('etag') ?? undefined;
        return {
          rawBody: body,
          resolvedUrl: res.url ?? url,
          meta: { lastModified, etag, contentType: res.headers.get('content-type') },
        };
      }),
    parse: async (body) =>
      parseUtahResults(body, { reportingLevel: opts.reportingLevel }),
  });
  // cost service is tracked on the SourceAdapter so cost_cap_check_and_consume
  // reserves against the right budget.
  base.costService = 'other';
  return base;
}

/** Alias matching the Northeast convention used by the dispatcher. */
export function createUtResultsAdapter(opts: UtahAdapterOptions = {}) {
  return createUtahResultsAdapter(opts);
}
