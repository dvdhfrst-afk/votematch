/**
 * Congress.gov API wrapper for bulk ingestion.
 *
 * Distinct from scrape-candidate.ts (which does per-candidate lookups for the
 * classification pipeline). This module supports *continuous* ingestion of
 * members, bills, votes, and vote positions for the retention-engine digest.
 *
 * API docs: https://api.congress.gov/
 * Rate limit: 5,000 req/hr per key (extremely generous for our needs).
 *
 * 2026-04-26 fix: switched from raw `fetch()` to `politeFetch`. The previous
 * raw fetch did not honor the per-host rate limit registered in
 * `host_rate_limits` for `api.congress.gov` (500ms / burst 3), which meant
 * concurrent ingestion runs (e.g. continuous-ingest's federal-bills + a
 * parallel backfill script) could overwhelm the API and cause 20-second
 * fetches to start chaining behind one another, blowing past
 * continuous-ingest's 180s task timeout. politeFetch enforces per-host
 * spacing process-globally via `host_rate_limits`.
 */

import { politeFetch } from '@/lib/adapters/fetch-polite';

const BASE = 'https://api.congress.gov/v3';

function apiKey(): string {
  const k = process.env.CONGRESS_API_KEY;
  if (!k) throw new Error('CONGRESS_API_KEY is required for Congress.gov ingestion');
  return k;
}

async function api<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('api_key', apiKey());
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await politeFetch(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Congress.gov ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export type CongressMember = {
  bioguideId: string;
  name: string;
  firstName?: string;
  lastName?: string;
  state: string;
  district?: number;
  partyName?: string;
  chamber?: string;
  terms?: { item?: { chamber?: string; startYear?: number; endYear?: number }[] };
  depiction?: { imageUrl?: string };
  url?: string;
};

/**
 * Fetch all current members. Congress.gov paginates at 250.
 */
export async function* iterCurrentMembers(): AsyncGenerator<CongressMember> {
  let offset = 0;
  const limit = 250;
  while (true) {
    const data = await api<{ members: CongressMember[] }>('/member', {
      currentMember: 'true',
      limit,
      offset,
    });
    const batch = data.members ?? [];
    for (const m of batch) yield m;
    if (batch.length < limit) break;
    offset += limit;
  }
}

// ---------------------------------------------------------------------------
// Bills (introduced in the current Congress, by latest action)
// ---------------------------------------------------------------------------

export type CongressBill = {
  congress: number;
  type: string;
  number: number | string;
  title?: string;
  introducedDate?: string;
  latestAction?: { actionDate?: string; text?: string };
  policyArea?: { name?: string };
  url?: string;
};

/**
 * Fetch recent bills for the current Congress. `sinceDate` (ISO) filters to
 * updates after that timestamp. Use it for daily delta ingestion.
 */
export async function* iterRecentBills(opts: {
  congress: number;
  sinceDate?: string;
  maxPages?: number;
}): AsyncGenerator<CongressBill> {
  let offset = 0;
  const limit = 250;
  let pages = 0;
  const maxPages = opts.maxPages ?? 20;

  while (pages < maxPages) {
    const params: Record<string, string | number> = {
      limit,
      offset,
      sort: 'updateDate+desc',
    };
    if (opts.sinceDate) params.fromDateTime = opts.sinceDate;

    const data = await api<{ bills: CongressBill[] }>(`/bill/${opts.congress}`, params);
    const batch = data.bills ?? [];
    for (const b of batch) yield b;
    if (batch.length < limit) break;
    offset += limit;
    pages += 1;
  }
}

// ---------------------------------------------------------------------------
// Votes — House and Senate roll calls
// ---------------------------------------------------------------------------

export type HouseRollCallSummary = {
  congress: number;
  sessionNumber: number;
  rollCallNumber: number;
  startDate?: string;
  result?: string;
  sourceDataURL?: string;
  legislationUrl?: string;
  legislationType?: string;
  legislationNumber?: string | number;
  voteQuestion?: string;
  voteType?: string;
};

/**
 * House roll call votes for a given Congress × session.
 * Docs: https://api.congress.gov/#/house-vote
 */
export async function* iterHouseRollCalls(
  congress: number,
  session: number,
  maxPages = 20,
): AsyncGenerator<HouseRollCallSummary> {
  let offset = 0;
  const limit = 250;
  let pages = 0;

  while (pages < maxPages) {
    const data = await api<{ houseRollCallVotes: HouseRollCallSummary[] }>(
      `/house-vote/${congress}/${session}`,
      { limit, offset },
    );
    const batch = data.houseRollCallVotes ?? [];
    for (const v of batch) yield v;
    if (batch.length < limit) break;
    offset += limit;
    pages += 1;
  }
}

export type VoteMember = {
  bioguideID?: string;      // Congress.gov returns this key (capital ID)
  bioguideId?: string;      // accept lowercase variant just in case
  firstName?: string;
  lastName?: string;
  voteCast?: string;
  voteParty?: string;
  voteState?: string;
};

/**
 * Fetch individual member positions for a specific House roll call.
 */
export async function fetchHouseRollCallMembers(
  congress: number,
  session: number,
  rollCall: number,
): Promise<VoteMember[]> {
  const data = await api<{ houseRollCallVoteMemberVotes?: { results?: VoteMember[] } }>(
    `/house-vote/${congress}/${session}/${rollCall}/members`,
  );
  return data.houseRollCallVoteMemberVotes?.results ?? [];
}

// Note: the Congress.gov v3 API's Senate-vote coverage is intentionally
// lighter than House (Senate rolls are authoritatively at senate.gov/legislative).
// For completeness, we fall back to senate.gov XML for Senate rolls below.
