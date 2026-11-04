/**
 * Pennsylvania legislator-votes adapter (FIPS 42).
 *
 * Source: https://www.legis.state.pa.us/Data/  (hourly refresh, M-F)
 *
 * PA's Data Downloads site publishes session XML that includes roll-call
 * votes. As of 2026-02 the feed is:
 *   https://www.legis.state.pa.us/Data/{chamber}/RollCalls/{sessionYear}/
 *
 * Each roll call XML document has this shape (abbreviated):
 *   <RollCall>
 *     <SessionYear>2025</SessionYear>
 *     <Chamber>House</Chamber>
 *     <BillNumber>HB0123</BillNumber>
 *     <BillTitle>An Act...</BillTitle>
 *     <VoteDate>2025-03-12</VoteDate>
 *     <Members>
 *       <Member>
 *         <Name>Smith, John</Name>
 *         <District>123</District>
 *         <Party>D</Party>
 *         <Vote>Y</Vote>
 *       </Member>
 *       ...
 *     </Members>
 *   </RollCall>
 *
 * We accept single <RollCall> docs or a wrapper <RollCalls><RollCall>...
 * for bulk feeds.
 *
 * NOTE: The exact XML element casing varies between House and Senate feeds
 * on legis.state.pa.us (House uses PascalCase, Senate historically used
 * ALLCAPS). The parser below is case-insensitive for safety.
 */

import { XMLParser } from 'fast-xml-parser';
import {
  createStateVotesAdapter,
  normalizeDate,
  normalizePosition,
  normalizeChamber,
  type StateLegVoteRow,
  type StateVotesFetchResult,
} from '../base';
import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';

export const PA_STATE_FIPS = '42';
export const PA_STATE_ABBR = 'PA';

const DEFAULT_URL = 'https://www.legis.state.pa.us/Data/';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type XmlBag = Record<string, unknown>;

function pick(obj: XmlBag, ...keys: string[]): unknown {
  // Case-insensitive pick — walks keys, returns first match.
  const lowerMap: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    lowerMap[k.toLowerCase()] = v;
  }
  for (const k of keys) {
    const v = lowerMap[k.toLowerCase()];
    if (v !== undefined) return v;
  }
  return undefined;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function toStr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && v !== null) {
    // fast-xml-parser can leave `{ '#text': 'value' }` for mixed nodes.
    const bag = v as XmlBag;
    const text = bag['#text'];
    if (text !== undefined) return String(text);
  }
  return null;
}

export function parsePaLegVotes(xml: string): StateLegVoteRow[] {
  if (!xml.trim()) return [];
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => /^(Member|RollCall)$/i.test(name),
  });
  let tree: XmlBag;
  try {
    tree = parser.parse(xml) as XmlBag;
  } catch {
    return [];
  }

  // Root might be <RollCalls> (bulk) or <RollCall> (single).
  const rollCalls: XmlBag[] = (() => {
    const rc = pick(tree, 'RollCalls');
    if (rc && typeof rc === 'object') {
      const inner = pick(rc as XmlBag, 'RollCall');
      if (inner) return toArray(inner) as XmlBag[];
    }
    const direct = pick(tree, 'RollCall');
    if (direct) return toArray(direct) as XmlBag[];
    return [];
  })();

  const out: StateLegVoteRow[] = [];
  let idx = 0;

  for (const rc of rollCalls) {
    const billId = toStr(pick(rc, 'BillNumber', 'Bill', 'BillNo'))?.trim() ?? '';
    if (!billId) continue;
    const billTitle = toStr(pick(rc, 'BillTitle', 'Title'));
    const voteDate = normalizeDate(toStr(pick(rc, 'VoteDate', 'Date')));
    const chamber = normalizeChamber(toStr(pick(rc, 'Chamber')) ?? 'lower');
    const sessionYearRaw = toStr(pick(rc, 'SessionYear', 'Session', 'Year'));
    const sessionYear = sessionYearRaw
      ? parseInt(sessionYearRaw, 10) || new Date().getUTCFullYear()
      : new Date().getUTCFullYear();

    const members = (() => {
      const wrap = pick(rc, 'Members');
      if (wrap && typeof wrap === 'object') {
        return toArray(pick(wrap as XmlBag, 'Member')) as XmlBag[];
      }
      return toArray(pick(rc, 'Member')) as XmlBag[];
    })();

    for (const m of members) {
      const name = toStr(pick(m, 'Name', 'MemberName'))?.trim();
      if (!name) continue;
      const district = toStr(pick(m, 'District', 'DistrictNumber'))?.trim() ?? null;
      const party = toStr(pick(m, 'Party'))?.trim() ?? null;
      const rawVote = toStr(pick(m, 'Vote', 'Position'));
      const position = normalizePosition(rawVote);

      out.push({
        legislator_name: name,
        legislator_district: district,
        legislator_party: party,
        bill_identifier: billId,
        bill_title: billTitle,
        vote_date: voteDate,
        position,
        chamber,
        session_year: sessionYear,
        source_url: null,
        source_row_id: `pa-xml:${billId}:${chamber}:${idx++}`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type PaVotesAdapterOptions = {
  sourceUrl?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateVotesFetchResult>;
};

export function createPaVotesAdapter(opts: PaVotesAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateVotesAdapter({
    stateFips: PA_STATE_FIPS,
    stateAbbrev: PA_STATE_ABBR,
    sourceName: 'pa-leg-votes',
    sourceUrl: url,
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    fetch:
      opts.fetchImpl ??
      (async () => {
        const res = await politeFetch(url, {
          headers: { Accept: 'application/xml,text/xml' },
        });
        if (!res.ok) {
          throw new Error(`pa-leg-votes: HTTP ${res.status} for ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) => parsePaLegVotes(body),
  });
}
