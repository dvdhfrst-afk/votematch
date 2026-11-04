/**
 * North Carolina legislator-votes adapter (FIPS 37).
 *
 * Source: ncleg.gov — Roll Call Vote Transcript pages
 *   URL pattern: https://www.ncleg.gov/Legislation/Votes/RollCallVoteTranscript/{session}/{chamber}/{rollcall}
 *   Example:     https://www.ncleg.gov/Legislation/Votes/RollCallVoteTranscript/2025/H/418
 *
 * Session is a pair of years joined with a dash in ncleg's URL segments
 * ("2025-2026" renders as "2025" on the transcript URL). Chamber is 'H'
 * for House, 'S' for Senate. Roll-call numbers are per-chamber, per-session.
 *
 * The transcript HTML lists vote sections as headings followed by member
 * tables. We follow the same header-then-list heuristic as Ohio, then tag
 * each member with the section's position label. Bill identifier is lifted
 * from the page <title> which reads e.g. "H 418 | Roll Call Transcript".
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

export const NC_STATE_FIPS = '37';
export const NC_STATE_ABBR = 'NC';


// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export type NcParseOptions = {
  billIdentifier?: string;
  billTitle?: string | null;
  voteDate?: string | null;
  chamber?: LegislativeChamber;
  sessionYear: number;
  sourceUrl?: string;
};

export function parseNcLegVotes(
  html: string,
  opts: NcParseOptions,
): StateLegVoteRow[] {
  const $ = loadHtml(html);
  const billId = (opts.billIdentifier ?? sniffNcBill($) ?? '').trim();
  if (!billId) return [];
  const chamber: LegislativeChamber = opts.chamber ?? 'lower';
  const voteDate = normalizeDate(opts.voteDate ?? sniffNcDate($));
  const sessionYear = opts.sessionYear;
  const sourceUrl = opts.sourceUrl ?? null;

  const out: StateLegVoteRow[] = [];
  let idx = 0;

  $('h1, h2, h3, h4').each((_i, el) => {
    const headingText = $(el).text().trim();
    const position = ncHeadingToPosition(headingText);
    if (!position) return;

    // Try sibling <ul> first; fall back to <table> with member rows.
    const list = $(el).nextAll('ul').first();
    if (list.length) {
      list.find('li').each((__, li) => {
        const name = stripNcHonorific($(li).text());
        if (!name) return;
        out.push(makeNcRow(name, position, billId, opts.billTitle ?? null, voteDate, chamber, sessionYear, sourceUrl, idx++));
      });
      return;
    }
    const table = $(el).nextAll('table').first();
    if (table.length) {
      table.find('tbody tr, tr').each((__, tr) => {
        const cells = $(tr).find('td').map((___, td) => $(td).text().trim()).get();
        if (cells.length === 0) return;
        const name = stripNcHonorific(cells[0]);
        if (!name) return;
        out.push(makeNcRow(name, position, billId, opts.billTitle ?? null, voteDate, chamber, sessionYear, sourceUrl, idx++));
      });
    }
  });

  return out;
}

function sniffNcBill($: CheerioAPI): string | null {
  const title = $('title').text();
  const h1 = $('h1').first().text();
  for (const src of [title, h1]) {
    const m = src.match(/\b([HS])\s*(\d{1,4})\b/);
    if (m) return `${m[1]}${m[2]}`;
  }
  return null;
}

function sniffNcDate($: CheerioAPI): string | null {
  // NC transcript pages often include a "Vote Date" label.
  const text = $('body').text();
  const m = text.match(/vote\s*date[:\s]*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i)
    ?? text.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function ncHeadingToPosition(h: string): VotePosition | null {
  const t = h.toLowerCase();
  if (/ayes?|yeas?/.test(t)) return 'yea';
  if (/noes?|nays?/.test(t)) return 'nay';
  if (/not\s*voting|abstain|excused/.test(t)) return 'absent';
  return null;
}

function stripNcHonorific(raw: string): string {
  return raw
    .replace(/^\s*(rep\.?|sen\.?|representative|senator|mr\.?|ms\.?|mrs\.?)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeNcRow(
  name: string,
  position: VotePosition,
  billId: string,
  billTitle: string | null,
  voteDate: string | null,
  chamber: LegislativeChamber,
  sessionYear: number,
  sourceUrl: string | null,
  idx: number,
): StateLegVoteRow {
  return {
    legislator_name: name,
    legislator_district: null,
    legislator_party: null,
    bill_identifier: billId,
    bill_title: billTitle,
    vote_date: voteDate,
    position,
    chamber,
    session_year: sessionYear,
    source_url: sourceUrl,
    source_row_id: `nc-html:${billId}:${position}:${idx}`,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type NcVotesAdapterOptions = {
  rollCallUrl?: string;
  billIdentifier?: string;
  billTitle?: string;
  voteDate?: string;
  chamber?: LegislativeChamber;
  sessionYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateVotesFetchResult>;
};

export function createNcVotesAdapter(opts: NcVotesAdapterOptions = {}) {
  const url = opts.rollCallUrl ?? 'https://www.ncleg.gov/Legislation/Votes';
  const sessionYear = opts.sessionYear ?? new Date().getUTCFullYear();
  return createStateVotesAdapter({
    stateFips: NC_STATE_FIPS,
    stateAbbrev: NC_STATE_ABBR,
    sourceName: 'nc-leg-votes',
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
          throw new Error(`nc-leg-votes: HTTP ${res.status} for ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) =>
      parseNcLegVotes(body, {
        billIdentifier: opts.billIdentifier,
        billTitle: opts.billTitle ?? null,
        voteDate: opts.voteDate ?? null,
        chamber: opts.chamber ?? 'lower',
        sessionYear,
        sourceUrl: url,
      }),
  });
}
