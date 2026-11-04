/**
 * Texas legislator-votes adapter (FIPS 48).
 *
 * Source: Texas Legislature Online — capitol.texas.gov
 *   Vote information: https://capitol.texas.gov/billlookup/voteinfo.aspx
 *   FTP bulk data:    ftp://ftp.legis.state.tx.us   (Texas Legislative Council)
 *
 * TX publishes record votes as part of the House / Senate journals, which
 * are XML on the FTP site (one file per day of session). Each journal's
 * <RecordVote> element captures the ayes / nays / PNV / absent lists.
 *
 * Representative XML shape (abbreviated; based on TLC public documentation):
 *   <Journal>
 *     <Chamber>House</Chamber>
 *     <SessionYear>2025</SessionYear>
 *     <Date>2025-04-15</Date>
 *     <RecordVote>
 *       <BillNumber>HB 1</BillNumber>
 *       <Description>...</Description>
 *       <Yeas>
 *         <Member>Smith</Member>
 *         ...
 *       </Yeas>
 *       <Nays>
 *         <Member>Jones</Member>
 *       </Nays>
 *       <PresentNotVoting>
 *         <Member>Brown</Member>
 *       </PresentNotVoting>
 *       <Absent>
 *         <Member>White</Member>
 *       </Absent>
 *     </RecordVote>
 *   </Journal>
 */

import { XMLParser } from 'fast-xml-parser';
import {
  createStateVotesAdapter,
  normalizeDate,
  normalizeChamber,
  type StateLegVoteRow,
  type StateVotesFetchResult,
  type LegislativeChamber,
  type VotePosition,
} from '../base';
import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';

export const TX_STATE_FIPS = '48';
export const TX_STATE_ABBR = 'TX';

const DEFAULT_URL = 'https://capitol.texas.gov/billlookup/voteinfo.aspx';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type XmlBag = Record<string, unknown>;

function pick(obj: XmlBag, ...keys: string[]): unknown {
  const lowerMap: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) lowerMap[k.toLowerCase()] = v;
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
    const text = (v as XmlBag)['#text'];
    if (text !== undefined) return String(text);
  }
  return null;
}

export function parseTxLegVotes(xml: string): StateLegVoteRow[] {
  if (!xml.trim()) return [];
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) =>
      /^(RecordVote|Journal|Member)$/i.test(name),
  });
  let tree: XmlBag;
  try {
    tree = parser.parse(xml) as XmlBag;
  } catch {
    return [];
  }

  // Root could be <Journals> wrapping <Journal>[], or a single <Journal>.
  const journals: XmlBag[] = (() => {
    const wrap = pick(tree, 'Journals');
    if (wrap && typeof wrap === 'object') {
      return toArray(pick(wrap as XmlBag, 'Journal')) as XmlBag[];
    }
    const direct = pick(tree, 'Journal');
    return toArray(direct) as XmlBag[];
  })();

  const out: StateLegVoteRow[] = [];
  let idx = 0;

  for (const journal of journals) {
    const chamber: LegislativeChamber = normalizeChamber(
      toStr(pick(journal, 'Chamber')) ?? 'lower',
    );
    const sessionYearRaw = toStr(pick(journal, 'SessionYear', 'Session'));
    const sessionYear = sessionYearRaw
      ? parseInt(sessionYearRaw, 10) || new Date().getUTCFullYear()
      : new Date().getUTCFullYear();
    const journalDate = normalizeDate(toStr(pick(journal, 'Date')));

    const rvs = toArray(pick(journal, 'RecordVote')) as XmlBag[];
    for (const rv of rvs) {
      const billId = toStr(pick(rv, 'BillNumber', 'Bill'))?.replace(/\s+/g, '').trim() ?? '';
      if (!billId) continue;
      const billTitle = toStr(pick(rv, 'Description', 'Title'));
      const voteDate = normalizeDate(toStr(pick(rv, 'Date'))) ?? journalDate;

      const sections: Array<{ key: string; position: VotePosition }> = [
        { key: 'Yeas', position: 'yea' },
        { key: 'Nays', position: 'nay' },
        { key: 'PresentNotVoting', position: 'abstain' },
        { key: 'Absent', position: 'absent' },
      ];
      for (const sec of sections) {
        const wrap = pick(rv, sec.key);
        if (!wrap || typeof wrap !== 'object') continue;
        const members = toArray(pick(wrap as XmlBag, 'Member'));
        for (const m of members) {
          const name = toStr(m)?.trim();
          if (!name) continue;
          out.push({
            legislator_name: name,
            legislator_district: null,
            legislator_party: null,
            bill_identifier: billId,
            bill_title: billTitle,
            vote_date: voteDate,
            position: sec.position,
            chamber,
            session_year: sessionYear,
            source_url: null,
            source_row_id: `tx-xml:${billId}:${chamber}:${sec.position}:${idx++}`,
          });
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type TxVotesAdapterOptions = {
  sourceUrl?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateVotesFetchResult>;
};

export function createTxVotesAdapter(opts: TxVotesAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateVotesAdapter({
    stateFips: TX_STATE_FIPS,
    stateAbbrev: TX_STATE_ABBR,
    sourceName: 'tx-leg-votes',
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
          throw new Error(`tx-leg-votes: HTTP ${res.status} for ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) => parseTxLegVotes(body),
  });
}
