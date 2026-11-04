/**
 * enrich/congress.ts -- Congress.gov member bio + legislative sponsorships.
 *
 * Strong-id source: bound by bioguide_id (kind 'bioguide_id' in person_xref).
 * AUTO-BIND: verified=true, bind_confidence=1.0.
 *
 * SCOPE NOTE (do NOT duplicate Build work): federal ROLL-CALL VOTES are already
 * ingested by scripts/ingest-federal-votes.ts (+ senate) and federal BILLS by
 * scripts/ingest-federal-bills.ts. This wrapper deliberately covers only the
 * MEMBER BIO and the member's SPONSORED / COSPONSORED legislation counts +
 * recent items, which those scripts do not capture per-person.
 *
 * Endpoints (api.congress.gov/v3):
 *   GET /member/{bioguideId}                          -> member record (bio)
 *   GET /member/{bioguideId}/sponsored-legislation    -> sponsored bills
 *   GET /member/{bioguideId}/cosponsored-legislation  -> cosponsored bills
 *
 * Key: env CONGRESS_API_KEY, query parameter ?api_key=...
 *
 * Produces TWO candidate_records rows:
 *   record_type='member_bio'    -- party, state, district, chamber, terms
 *   record_type='sponsorship'   -- sponsored/cosponsored counts + recent items
 */

import {
  fetchJson,
  strongIdRow,
  type CandidateRecordRow,
  type EnrichContext,
} from './types';

const CONGRESS_BASE = 'https://api.congress.gov/v3';

function apiKey(): string | null {
  const k = process.env.CONGRESS_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

export interface CongressMember {
  bioguideId?: string;
  directOrderName?: string;
  invertedOrderName?: string;
  honorificName?: string;
  partyHistory?: Array<{ partyName?: string; partyAbbreviation?: string; startYear?: number }>;
  state?: string;
  district?: number;
  terms?: Array<{
    chamber?: string;
    congress?: number;
    startYear?: number;
    endYear?: number;
    stateName?: string;
  }>;
  birthYear?: string;
  currentMember?: boolean;
  depiction?: { imageUrl?: string };
  updateDate?: string;
}

export interface CongressLegislationItem {
  congress?: number;
  type?: string; // HR, S, HRES, ...
  number?: string;
  title?: string;
  introducedDate?: string;
  policyArea?: { name?: string };
  url?: string;
  latestAction?: { actionDate?: string; text?: string };
}

interface MemberResponse {
  member?: CongressMember;
}
interface SponsoredResponse {
  sponsoredLegislation?: CongressLegislationItem[];
  pagination?: { count?: number };
}
interface CosponsoredResponse {
  cosponsoredLegislation?: CongressLegislationItem[];
  pagination?: { count?: number };
}

const MAX_RECENT = 25;

/** PURE. Map a member record to a member_bio row. */
export function normalizeMemberBio(
  bioguideId: string,
  member: CongressMember | null,
  ctx: EnrichContext,
  fetchedAt?: string,
): CandidateRecordRow | null {
  if (!member) return null;
  const latestTerm = (member.terms ?? [])
    .slice()
    .sort((a, b) => (b.congress ?? 0) - (a.congress ?? 0))[0];
  const latestParty = (member.partyHistory ?? [])
    .slice()
    .sort((a, b) => (b.startYear ?? 0) - (a.startYear ?? 0))[0];

  const payload: Record<string, unknown> = {
    bioguide_id: bioguideId,
    name: member.directOrderName ?? member.invertedOrderName ?? null,
    party: latestParty?.partyName ?? null,
    party_abbreviation: latestParty?.partyAbbreviation ?? null,
    state: member.state ?? latestTerm?.stateName ?? null,
    district: member.district ?? null,
    chamber: latestTerm?.chamber ?? null,
    current_member: member.currentMember ?? null,
    birth_year: member.birthYear ?? null,
    term_count: (member.terms ?? []).length,
    terms: member.terms ?? [],
    image_url: member.depiction?.imageUrl ?? null,
    update_date: member.updateDate ?? null,
  };

  return strongIdRow({
    person_id: ctx.person_id,
    record_type: 'member_bio',
    source: 'congress',
    source_url: `https://www.congress.gov/member/${bioguideId}`,
    external_ref: bioguideId,
    payload,
    id_kind: 'bioguide_id',
    fetched_at: fetchedAt,
  });
}

/** PURE. Map sponsored + cosponsored lists into a sponsorship row. */
export function normalizeSponsorship(
  bioguideId: string,
  sponsored: CongressLegislationItem[],
  sponsoredCount: number | null,
  cosponsored: CongressLegislationItem[],
  cosponsoredCount: number | null,
  ctx: EnrichContext,
  fetchedAt?: string,
): CandidateRecordRow | null {
  // No legislative activity at all -> no row.
  if (
    (sponsored?.length ?? 0) === 0 &&
    (cosponsored?.length ?? 0) === 0 &&
    !sponsoredCount &&
    !cosponsoredCount
  ) {
    return null;
  }

  const compact = (items: CongressLegislationItem[]) =>
    (items ?? []).slice(0, MAX_RECENT).map((b) => ({
      congress: b.congress ?? null,
      type: b.type ?? null,
      number: b.number ?? null,
      title: b.title ?? null,
      introduced_date: b.introducedDate ?? null,
      policy_area: b.policyArea?.name ?? null,
      latest_action: b.latestAction?.text ?? null,
      latest_action_date: b.latestAction?.actionDate ?? null,
    }));

  const payload: Record<string, unknown> = {
    bioguide_id: bioguideId,
    sponsored_count: sponsoredCount ?? sponsored?.length ?? 0,
    cosponsored_count: cosponsoredCount ?? cosponsored?.length ?? 0,
    recent_sponsored: compact(sponsored),
    recent_cosponsored: compact(cosponsored),
  };

  return strongIdRow({
    person_id: ctx.person_id,
    record_type: 'sponsorship',
    source: 'congress',
    source_url: `https://www.congress.gov/member/${bioguideId}/legislation`,
    external_ref: bioguideId,
    payload,
    id_kind: 'bioguide_id',
    fetched_at: fetchedAt,
  });
}

/**
 * fetchCongress: member bio + sponsorship rows. Bound by bioguide_id.
 * Skips gracefully (returns []) when CONGRESS_API_KEY is unset.
 */
export async function fetchCongress(
  bioguideId: string,
  ctx: EnrichContext,
): Promise<CandidateRecordRow[]> {
  const key = apiKey();
  if (!key) return []; // no key configured -> skip this source quietly

  const q = `api_key=${encodeURIComponent(key)}`;

  // Member bio.
  let member: CongressMember | null = null;
  try {
    const res = await fetchJson<MemberResponse>(
      `${CONGRESS_BASE}/member/${encodeURIComponent(bioguideId)}?${q}`,
    );
    member = res.member ?? null;
  } catch (e) {
    if (!(e instanceof Error && /HTTP 404/.test(e.message))) throw e;
  }

  // Sponsored + cosponsored legislation.
  let sponsored: CongressLegislationItem[] = [];
  let sponsoredCount: number | null = null;
  let cosponsored: CongressLegislationItem[] = [];
  let cosponsoredCount: number | null = null;
  try {
    const res = await fetchJson<SponsoredResponse>(
      `${CONGRESS_BASE}/member/${encodeURIComponent(bioguideId)}/sponsored-legislation?${q}&limit=${MAX_RECENT}`,
    );
    sponsored = res.sponsoredLegislation ?? [];
    sponsoredCount = res.pagination?.count ?? null;
  } catch (e) {
    if (!(e instanceof Error && /HTTP 404/.test(e.message))) throw e;
  }
  try {
    const res = await fetchJson<CosponsoredResponse>(
      `${CONGRESS_BASE}/member/${encodeURIComponent(bioguideId)}/cosponsored-legislation?${q}&limit=${MAX_RECENT}`,
    );
    cosponsored = res.cosponsoredLegislation ?? [];
    cosponsoredCount = res.pagination?.count ?? null;
  } catch (e) {
    if (!(e instanceof Error && /HTTP 404/.test(e.message))) throw e;
  }

  const rows: CandidateRecordRow[] = [];
  const bio = normalizeMemberBio(bioguideId, member, ctx);
  if (bio) rows.push(bio);
  const spon = normalizeSponsorship(
    bioguideId,
    sponsored,
    sponsoredCount,
    cosponsored,
    cosponsoredCount,
    ctx,
  );
  if (spon) rows.push(spon);
  return rows;
}
