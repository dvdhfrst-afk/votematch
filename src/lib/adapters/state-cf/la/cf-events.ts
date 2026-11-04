/**
 * Louisiana — Ethics Administration Campaign Finance (FIPS 22).
 *
 * Portal: https://ethics.la.gov/campfinanhome.aspx
 * Format: ASP.NET landing with per-filer downloadable reports (PDF + some
 *         tabular HTML). No documented bulk export API.
 *         HTML-table skeleton.
 *
 * Parser-time garbage filter (council 2026-04-25)
 * -----------------------------------------------
 * The shared HTML table parser walks every <table> in the response body.
 * The LA portal is an ASP.NET application that emits inline <script> blocks
 * containing `var theForm = document.forms['aspnetForm']; ... __doPostBack`
 * and other JavaScript bootstrap. Cheerio doesn't strip <script> contents
 * before calling .text() on neighbouring cells, so on certain LA pages the
 * scraper produced rows whose `candidate_name` was a chunk of JavaScript
 * source ("var theForm = ..."). 3,144 such rows accumulated in production
 * before the council caught it.
 *
 * Defence: this adapter rejects any row whose candidate_name OR counterparty
 * contains aspnetForm / __doPostBack / theForm / <![CDATA[, OR whose
 * candidate_name length exceeds 200 characters (real LA candidate names cap
 * around 80 chars; anything longer is a parser fall-through). Rejected rows
 * are dropped silently — they don't even count as 'unproductive', because
 * they were never legitimate signal in the first place.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const LA_STATE_FIPS = '22';
export const LA_STATE_ABBR = 'LA';
const DEFAULT_URL = 'https://ethics.la.gov/campfinanhome.aspx';

/** Substrings that identify ASP.NET / JavaScript fall-through into a CF cell. */
const LA_JS_GARBAGE_PATTERNS = [
  'aspnetForm',
  '__doPostBack',
  'theForm',
  '<![CDATA[',
] as const;

/** Max plausible candidate_name length on LA filings — anything longer is parser noise. */
const LA_MAX_CANDIDATE_NAME_LEN = 200;

/**
 * Returns true if the row contains JavaScript / ASP.NET viewstate fragments
 * that leaked through the HTML scraper. Such rows MUST be dropped.
 *
 * Exported for testing — also reused by the dedupe script's purge phase to
 * keep the JS gate consistent across parser-time and post-hoc cleanup.
 */
export function isLouisianaParserGarbage(row: {
  candidate_name?: string | null;
  counterparty?: string | null;
}): boolean {
  const name = row.candidate_name ?? '';
  const cp = row.counterparty ?? '';
  if (name.length > LA_MAX_CANDIDATE_NAME_LEN) return true;
  for (const needle of LA_JS_GARBAGE_PATTERNS) {
    if (name.includes(needle) || cp.includes(needle)) return true;
  }
  return false;
}

export type LaCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseLouisianaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  const rows = parseGenericCfHtmlTable(body, {
    state: LA_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
  // Filter out parser garbage at the source. These rows are dropped — they
  // don't count toward 'unproductive' status because they were never
  // legitimate data, just scraper fall-through.
  return rows.filter((r) => !isLouisianaParserGarbage(r));
}

export function createLaCfAdapter(opts: LaCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: LA_STATE_FIPS,
    stateAbbr: LA_STATE_ABBR,
    sourceName: 'louisiana-ethics-cf',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parseLouisianaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
