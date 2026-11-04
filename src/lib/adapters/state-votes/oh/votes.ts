/**
 * Ohio legislator-votes adapter (FIPS 39).
 *
 * Source: ohiohouse.gov + ohiosenate.gov
 *   Per-bill votes page: https://ohiohouse.gov/legislation/{ga}/{bill}/votes
 *   e.g.                https://ohiohouse.gov/legislation/136/hb42/votes
 *
 * Ohio does NOT publish a bulk XML data feed for roll calls. The per-bill
 * votes page renders HTML with a heading per vote (committee / floor) and a
 * table of member positions. We parse that HTML with cheerio.
 *
 * Page structure (136th GA, verified 2026-04-23 via search-result snippets):
 *   <h2>YEAS: 62</h2>
 *   <ul>
 *     <li>Representative Last, First</li>
 *     ...
 *   </ul>
 *   <h2>NAYS: 31</h2>
 *   <ul>...</ul>
 *   <h2>PRESENT / NOT VOTING: ...</h2>
 *
 * The caller supplies the bill identifier + GA + chamber on the URL; the
 * parser extracts member rows.
 */

import { load as loadHtml, type CheerioAPI } from 'cheerio';
import {
  createStateVotesAdapter,
  normalizeDate,
  type StateLegVoteRow,
  type StateVotesFetchResult,
  type LegislativeChamber,
  type VotePosition,
} from '../base';
import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';

export const OH_STATE_FIPS = '39';
export const OH_STATE_ABBR = 'OH';


// ---------------------------------------------------------------------------
// Parser — public for unit tests
// ---------------------------------------------------------------------------

export type OhioParseOptions = {
  /** Bill identifier, e.g. 'HB42'. Injected when known; parser also tries to sniff it. */
  billIdentifier?: string;
  /** Bill title, optional; used only for display. */
  billTitle?: string | null;
  /** Vote date (ISO), optional. */
  voteDate?: string | null;
  /** Chamber of the vote. Defaults to 'lower' (House page). */
  chamber?: LegislativeChamber;
  /** Session year, e.g. 2025 or 2026. */
  sessionYear: number;
  /** Source URL to stamp on each row. */
  sourceUrl?: string;
};

/**
 * Parse an ohiohouse.gov / ohiosenate.gov bill-votes HTML page.
 *
 * Heuristic: each YEAS / NAYS / NOT VOTING section is an <h*> followed by
 * a <ul> whose <li>s are member names prefixed with "Representative "
 * or "Senator ". We collect all of them, tagging by the section label.
 */
export function parseOhioLegVotes(
  html: string,
  opts: OhioParseOptions,
): StateLegVoteRow[] {
  const $ = loadHtml(html);
  const billId = (opts.billIdentifier ?? sniffBillIdentifier($) ?? '').trim();
  if (!billId) return [];

  const chamber: LegislativeChamber = opts.chamber ?? 'lower';
  const date = normalizeDate(opts.voteDate);
  const sourceUrl = opts.sourceUrl ?? null;
  const sessionYear = opts.sessionYear;

  const out: StateLegVoteRow[] = [];
  let idx = 0;

  // Walk every heading element, matching section labels.
  $('h1, h2, h3, h4').each((_i, el) => {
    const headingText = $(el).text().trim();
    const position = headingToPosition(headingText);
    if (!position) return;

    // Find the next <ul> after this heading.
    const list = $(el).nextAll('ul').first();
    if (!list.length) return;

    list.find('li').each((__, li) => {
      const raw = $(li).text().trim();
      if (!raw) return;
      const name = stripHonorific(raw);
      if (!name) return;
      out.push({
        legislator_name: name,
        legislator_district: null,
        legislator_party: null,
        bill_identifier: billId,
        bill_title: opts.billTitle ?? null,
        vote_date: date,
        position,
        chamber,
        session_year: sessionYear,
        source_url: sourceUrl,
        source_row_id: `oh-html:${billId}:${position}:${idx++}`,
      });
    });
  });

  return out;
}

function sniffBillIdentifier($: CheerioAPI): string | null {
  // Look for "HB 42", "SB 68", "House Bill 42", "Senate Bill 68" in <title> / h1.
  const title = $('title').text();
  const h1 = $('h1').first().text();
  for (const src of [title, h1]) {
    const compact = src.match(/\b([HS][BR])\s*0*(\d{1,4})\b/i);
    if (compact) return `${compact[1].toUpperCase()}${compact[2]}`;
    const longForm = src.match(/\b(House|Senate)\s+(Bill|Resolution)\s+0*(\d{1,4})\b/i);
    if (longForm) {
      const chamberLetter = longForm[1][0].toUpperCase();
      const typeLetter = longForm[2][0].toUpperCase();
      return `${chamberLetter}${typeLetter}${longForm[3]}`;
    }
  }
  return null;
}

function headingToPosition(h: string): VotePosition | null {
  const t = h.toLowerCase();
  if (/yea/.test(t)) return 'yea';
  if (/nay/.test(t)) return 'nay';
  if (/present.*not.*voting|not\s*voting|abstain/.test(t)) return 'abstain';
  if (/absent/.test(t)) return 'absent';
  return null;
}

function stripHonorific(raw: string): string {
  return raw
    .replace(/^\s*(representative|senator|rep\.?|sen\.?|mr\.?|mrs\.?|ms\.?)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type OhVotesAdapterOptions = {
  /** Full URL of one bill's votes page. If omitted, adapter returns [] until wired. */
  billVotesUrl?: string;
  billIdentifier?: string;
  billTitle?: string;
  voteDate?: string;
  chamber?: LegislativeChamber;
  sessionYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateVotesFetchResult>;
};

export function createOhVotesAdapter(opts: OhVotesAdapterOptions = {}) {
  const url = opts.billVotesUrl ?? 'https://ohiohouse.gov/legislation';
  const sessionYear = opts.sessionYear ?? new Date().getUTCFullYear();
  return createStateVotesAdapter({
    stateFips: OH_STATE_FIPS,
    stateAbbrev: OH_STATE_ABBR,
    sourceName: 'ohio-leg-votes',
    sourceUrl: url,
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    fetch:
      opts.fetchImpl ??
      (async () => {
        const res = await politeFetch(url, {
          headers: { Accept: 'text/html' },
        });
        if (!res.ok) {
          throw new Error(`oh-leg-votes: HTTP ${res.status} for ${url}`);
        }
        return {
          rawBody: await res.text(),
          resolvedUrl: res.url ?? url,
        };
      }),
    parse: async (body) =>
      parseOhioLegVotes(body, {
        billIdentifier: opts.billIdentifier,
        billTitle: opts.billTitle ?? null,
        voteDate: opts.voteDate ?? null,
        chamber: opts.chamber ?? 'lower',
        sessionYear,
        sourceUrl: url,
      }),
  });
}
