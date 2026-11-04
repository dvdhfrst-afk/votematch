/**
 * Utah legislator-votes adapter (FIPS 49).
 *
 * Source: le.utah.gov developer tools — https://le.utah.gov/data/developer.htm
 *
 * Utah publishes a session BillList JSON listing every bill and then one
 * JSON blob per bill that includes:
 *   - General bill metadata (identifier, title, sponsor)
 *   - Actions[] (floor + committee actions)
 *   - Votes[] on each action with member-level tallies
 *
 * For simplicity + reliability we parse ONE input shape here: the
 * per-bill JSON blob. The top-level CLI hits BillList JSON first, then
 * walks each bill URL; the parser below consumes whichever shape it
 * gets (BillList array or per-bill object).
 *
 * Format (per-bill) — abbreviated:
 * {
 *   "number": "HB0001",
 *   "title": "General Session Appropriations",
 *   "session": "2025GS",
 *   "actions": [
 *     {
 *       "action": "3rd Reading / Final Passage",
 *       "date": "2025-02-14",
 *       "location": "House",
 *       "votes": [
 *         {
 *           "yea": 55, "nay": 15, "abs": 5,
 *           "yeas": [{"name": "Smith, J."}, ...],
 *           "nays": [{"name": "Jones, B."}, ...],
 *           "absent": [{"name": "Brown, A."}, ...]
 *         }
 *       ]
 *     }
 *   ]
 * }
 */

import {
  createStateVotesAdapter,
  normalizeDate,
  normalizeChamber,
  type StateLegVoteRow,
  type StateVotesFetchResult,
  type LegislativeChamber,
} from '../base';
import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';

export const UT_STATE_FIPS = '49';
export const UT_STATE_ABBR = 'UT';

const DEFAULT_BILL_LIST_URL = 'https://le.utah.gov/data/';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal subset of the Utah per-bill JSON we actually consume. */
export type UtahBillJson = {
  number?: string;
  title?: string;
  session?: string;
  actions?: UtahAction[];
};

export type UtahAction = {
  action?: string;
  date?: string;
  location?: string;
  votes?: UtahVoteRecord[];
};

export type UtahVoteRecord = {
  yeas?: UtahMemberRef[];
  nays?: UtahMemberRef[];
  absent?: UtahMemberRef[];
  abstain?: UtahMemberRef[];
};

export type UtahMemberRef = {
  name?: string;
  district?: string;
  party?: string;
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a Utah JSON body into StateLegVoteRow[]. Accepts either:
 *   - A single bill object (UtahBillJson)
 *   - An array of bill objects
 *
 * Anything else returns [].
 */
export function parseUtahLegVotes(body: string): StateLegVoteRow[] {
  if (!body.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const bills: UtahBillJson[] = Array.isArray(parsed)
    ? (parsed as UtahBillJson[])
    : typeof parsed === 'object' && parsed !== null
      ? [parsed as UtahBillJson]
      : [];

  const out: StateLegVoteRow[] = [];
  let idx = 0;
  for (const bill of bills) {
    const billId = (bill.number ?? '').trim();
    if (!billId) continue;
    const billTitle = bill.title?.trim() ?? null;
    const sessionYear = parseSessionYear(bill.session);

    for (const action of bill.actions ?? []) {
      const chamber = inferChamber(action.location);
      const date = normalizeDate(action.date);
      for (const vote of action.votes ?? []) {
        for (const m of vote.yeas ?? []) {
          out.push(makeRow(m, 'yea', billId, billTitle, date, chamber, sessionYear, idx++));
        }
        for (const m of vote.nays ?? []) {
          out.push(makeRow(m, 'nay', billId, billTitle, date, chamber, sessionYear, idx++));
        }
        for (const m of vote.absent ?? []) {
          out.push(makeRow(m, 'absent', billId, billTitle, date, chamber, sessionYear, idx++));
        }
        for (const m of vote.abstain ?? []) {
          out.push(makeRow(m, 'abstain', billId, billTitle, date, chamber, sessionYear, idx++));
        }
      }
    }
  }
  return out;
}

function makeRow(
  m: UtahMemberRef,
  position: 'yea' | 'nay' | 'absent' | 'abstain',
  billId: string,
  billTitle: string | null,
  date: string | null,
  chamber: LegislativeChamber,
  sessionYear: number,
  idx: number,
): StateLegVoteRow {
  return {
    legislator_name: (m.name ?? '').trim(),
    legislator_district: m.district?.trim() ?? null,
    legislator_party: m.party?.trim() ?? null,
    bill_identifier: billId,
    bill_title: billTitle,
    vote_date: date,
    position,
    chamber,
    session_year: sessionYear,
    source_url: `https://le.utah.gov/~${sessionYear}/bills/static/${billId}.html`,
    source_row_id: `ut-json:${billId}:${idx}`,
  };
}

function inferChamber(location: string | undefined): LegislativeChamber {
  if (!location) return 'lower';
  return normalizeChamber(location);
}

export function parseSessionYear(session: string | undefined): number {
  if (!session) return new Date().getUTCFullYear();
  const m = session.match(/^(\d{4})/);
  if (m) return parseInt(m[1], 10);
  return new Date().getUTCFullYear();
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type UtVotesAdapterOptions = {
  sourceUrl?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateVotesFetchResult>;
};

export function createUtVotesAdapter(opts: UtVotesAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_BILL_LIST_URL;
  return createStateVotesAdapter({
    stateFips: UT_STATE_FIPS,
    stateAbbrev: UT_STATE_ABBR,
    sourceName: 'utah-leg-votes',
    sourceUrl: url,
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    fetch:
      opts.fetchImpl ??
      (async () => {
        const res = await politeFetch(url, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          throw new Error(`ut-leg-votes: HTTP ${res.status} for ${url}`);
        }
        return {
          rawBody: await res.text(),
          resolvedUrl: res.url ?? url,
          meta: { contentType: res.headers.get('content-type') },
        };
      }),
    parse: async (body) => parseUtahLegVotes(body),
  });
}
