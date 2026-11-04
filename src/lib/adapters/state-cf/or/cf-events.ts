/**
 * Oregon ORESTAR — campaign finance adapter.
 *
 * FIPS 41. Seed URL: https://secure.sos.state.or.us/orestar/GotoSearchByName.do
 *
 * ORESTAR publishes:
 *   - Name search: /orestar/GotoSearchByName.do (HTML)
 *   - Transaction search: /orestar/gotoPublicTransactionSearch.do (HTML)
 *   - XLS bulk export: /orestar/XcelCFSearch (all filings 2012+, one file)
 *
 * This adapter prefers the XLS-export path (far richer than the HTML
 * search page) via an injected fetcher. The parser accepts both CSV
 * (if the XLS has been pre-converted to CSV) and the HTML name-search
 * page as a low-resolution fallback.
 *
 * Related existing script: scripts/enrich-pass3b-orestar-xls.ts —
 * reuses ORESTAR column names. We keep the same normalization here so
 * state_cf_events rows join cleanly with the candidate-email enrichment
 * pass downstream.
 */

import { load as loadHtml } from 'cheerio';
import { parse as parseCsv } from 'csv-parse/sync';
import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';
import {
  createStateCfAdapter,
  normalizeEventType,
  parseIsoDateOrNull,
  parseMoneyOrNull,
  type StateCfFetchResult,
  type StateCfRow,
} from '../base';

export const OR_STATE_FIPS = '41';
export const OR_STATE_ABBR = 'OR';

export const OR_ORESTAR_SEARCH_URL =
  'https://secure.sos.state.or.us/orestar/GotoSearchByName.do';
export const OR_ORESTAR_XLS_URL =
  'https://secure.sos.state.or.us/orestar/XcelCFSearch';
export const OR_ORESTAR_TRANSACTION_URL =
  'https://secure.sos.state.or.us/orestar/gotoPublicTransactionSearch.do';

// ---------------------------------------------------------------------------
// Dispatch parser
// ---------------------------------------------------------------------------

export type OrParseOptions = {
  cycleYear?: number;
};

export function parseOregonOrestarResults(
  body: string,
  opts: OrParseOptions = {},
): StateCfRow[] {
  if (!body || body.length < 8) return [];
  const trimmed = body.trimStart();
  if (trimmed.startsWith('<')) return parseOrestarHtml(body);
  return parseOrestarCsv(body, opts);
}

// ---------------------------------------------------------------------------
// CSV path (ORESTAR XLS converted to CSV)
// ---------------------------------------------------------------------------

/**
 * Parse an ORESTAR CSV export (converted from the XLS download).
 *
 * Columns (from the XLS header, ref enrich-pass3b-orestar-xls.ts):
 *   Election Year | Cand Ballot Name Txt | First Name | Last Name |
 *   Office Group | Candidate Office | Transaction Date |
 *   Transaction Amount | Contributor/Payee | Transaction Sub Type |
 *   Filer | Filer ID | Party Descr | Email | Web Address
 */
export function parseOrestarCsv(
  body: string,
  opts: OrParseOptions = {},
): StateCfRow[] {
  let parsed: Record<string, string>[];
  try {
    parsed = parseCsv(body, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
    }) as Record<string, string>[];
  } catch {
    return [];
  }
  const rows: StateCfRow[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const r = parsed[i]!;
    const cycleYear = opts.cycleYear;
    if (cycleYear !== undefined) {
      const ey = r['Election Year'];
      if (ey && /^\d{4}$/.test(ey) && parseInt(ey, 10) !== cycleYear) continue;
    }

    const candidate =
      r['Cand Ballot Name Txt'] ||
      [r['First Name'], r['Last Name']].filter(Boolean).join(' ').trim() ||
      null;

    const subtype = r['Transaction Sub Type'] ?? r['Transaction Type'] ?? '';
    const event_type = normalizeEventType(subtype);

    const filer_id = r['Filer ID'] ?? r['FilerId'] ?? '';
    const filing_url = filer_id
      ? `${OR_ORESTAR_SEARCH_URL}?filerId=${encodeURIComponent(filer_id)}`
      : OR_ORESTAR_XLS_URL;

    rows.push({
      state: OR_STATE_ABBR,
      candidate_name: candidate,
      candidate_office:
        r['Candidate Office'] || r['Office Group'] || null,
      committee_name: r['Filer'] || r['Committee Name'] || candidate,
      event_type,
      amount: parseMoneyOrNull(r['Transaction Amount'] ?? r['Amount'] ?? null),
      event_date: parseIsoDateOrNull(
        r['Transaction Date'] ?? r['Date'] ?? null,
      ),
      counterparty:
        r['Contributor/Payee'] || r['Payee'] || r['Contributor'] || null,
      filing_url,
      confidence_score: 0.85,
      source_row_id: r['Tran Id'] ?? r['Transaction Id'] ?? `or-${filer_id}-${i}`,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// HTML path (ORESTAR name-search landing — coarse)
// ---------------------------------------------------------------------------

// Tokens that indicate the body is an ASP.NET landing / session-timeout / WAF
// block rather than a real ORESTAR results page. Treat any hit as garbage and
// refuse to publish — these have historically smuggled JS blobs into
// candidate_name (severity=critical cf_parser_garbage flags).
const ORESTAR_GARBAGE_TOKENS = [
  '__doPostBack',
  '__VIEWSTATE',
  'aspnetForm',
  'var dolink',
  '<![CDATA[',
] as const;

function looksLikeOrestarGarbage(value: string): boolean {
  for (const tok of ORESTAR_GARBAGE_TOKENS) {
    if (value.includes(tok)) return true;
  }
  return false;
}

function isCellGarbage(value: string): boolean {
  if (value.length > 200) return true;
  if (looksLikeOrestarGarbage(value)) return true;
  if (
    value.startsWith('var ') ||
    value.startsWith('function ') ||
    value.startsWith('jQuery')
  ) {
    return true;
  }
  return false;
}

function parseOrestarHtml(body: string): StateCfRow[] {
  // Early guard: if the body smells like an ASP.NET landing/timeout/WAF page,
  // bail out entirely rather than risk inserting JS blobs as candidate names.
  if (looksLikeOrestarGarbage(body)) {
    console.warn(
      `[or-orestar] aborting parse: landing/timeout markers detected (excerpt: ${body.slice(0, 80).replace(/\s+/g, ' ')})`,
    );
    return [];
  }

  const $ = loadHtml(body);
  const rows: StateCfRow[] = [];
  $('table').each((ti, tableEl) => {
    const $table = $(tableEl);
    const headers = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((_i, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headers.length === 0) return;
    const filerCol = headers.findIndex(
      (h) => h.includes('filer') || h.includes('committee') || h.includes('candidate'),
    );
    if (filerCol < 0) return;
    $table.find('tr').each((ri, trEl) => {
      if (ri === 0) return;
      const cells = $(trEl)
        .find('td')
        .map((_i, el) => $(el).text().trim())
        .get();
      const filer = cells[filerCol];
      if (!filer) return;
      // Per-cell guard: never publish a row whose name field carries JS,
      // ASP.NET tokens, or absurd length. Skip + warn so the dispatcher
      // produces zero rows instead of garbage.
      if (isCellGarbage(filer)) {
        console.warn(
          `[or-orestar] skipping row t${ti}-r${ri}: filer cell looks like garbage (excerpt: ${filer.slice(0, 80).replace(/\s+/g, ' ')})`,
        );
        return;
      }
      const href = $(trEl).find('a[href]').first().attr('href') ?? '';
      const filing_url = href
        ? new URL(href, OR_ORESTAR_SEARCH_URL).toString()
        : OR_ORESTAR_SEARCH_URL;
      rows.push({
        state: OR_STATE_ABBR,
        candidate_name: filer,
        candidate_office: null,
        committee_name: filer,
        event_type: 'filing',
        amount: null,
        event_date: null,
        counterparty: null,
        filing_url,
        confidence_score: 0.6,
        source_row_id: `or-html-t${ti}-r${ri}`,
      });
    });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export type OrCfAdapterOptions = {
  sourceUrl?: string;
  cycleYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateCfFetchResult>;
};

export function createOrCfAdapter(opts: OrCfAdapterOptions = {}) {
  // Default to the XLS endpoint — caller is expected to fetch + convert
  // to CSV before handing to the parser. When that's not possible, the
  // fallback fetch returns the HTML search landing.
  const url = opts.sourceUrl ?? OR_ORESTAR_SEARCH_URL;
  const adapter = createStateCfAdapter({
    stateFips: OR_STATE_FIPS,
    stateAbbr: OR_STATE_ABBR,
    sourceName: 'or-orestar-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    cycleYear: opts.cycleYear,
    fetch:
      opts.fetchImpl ??
      (async () => {
        const res = await politeFetch(url, {
          headers: {
            Accept: 'text/html, text/csv, application/vnd.ms-excel, */*',
          },
        });
        if (!res.ok) {
          throw new Error(`or-orestar: HTTP ${res.status} for ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) =>
      parseOregonOrestarResults(body, { cycleYear: opts.cycleYear }),
  });
  adapter.costService = 'other';
  return adapter;
}
