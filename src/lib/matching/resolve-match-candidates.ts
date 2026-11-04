/**
 * Shared candidate/position resolver for the match write paths.
 *
 * Both `POST /api/match` and `submitQuickMatchAction` must turn a resolved set
 * of `v_voter_races` ids (precinct OR district path — see
 * `resolveSessionRaceIds`) into the `CandidateWithPositions[]` the matcher
 * consumes, plus the per-race election bridge + office-dimension maps the
 * multivariable weight loader needs. This lived inline in the /api/match route;
 * extracting it here lets the server action score the district path IDENTICALLY,
 * so a non-Utah (district-path) voter is matched exactly like a precinct voter.
 *
 * The read path is the unified voter surface (migration 20260425000008):
 *   - `v_voter_races` / `v_voter_candidates` cover BOTH legacy Utah races and
 *     office-graph elections, discriminated by `is_legacy`.
 *   - Positions are fetched two ways and merged (deduped by position id):
 *       · by legacy candidate_id (legacy rows, and new-graph rows that carry a
 *         legacy_candidate_id bridge)
 *       · by person_id (person-native positions for new-graph candidacies with
 *         no legacy candidate_id — 73/93 uncovered Utah candidates)
 *   - A candidate with no bridged positions enters scoring with positions=[],
 *     which the algorithm scores as null (insufficient overlap). We never
 *     fabricate positions.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadRaceOfficeDimensions } from '@/lib/matching/office-dims';
import type { CandidateWithPositions, RaceLevel } from '@/types/database';

type VoterCandRow = {
  id: string;
  race_id: string;
  name: string;
  party: string | null;
  office_name: string | null;
  office_level: string;
  district_identifier: string | null;
  is_legacy: boolean;
  legacy_candidate_id: string | null;
  person_id: string | null;
  photo_url: string | null;
  bio: string | null;
  website_url: string | null;
  published: boolean;
  withdrew: boolean;
};

type VoterRaceRow = {
  id: string;
  name: string;
  level: string;
  district: string | null;
  election_date: string;
  election_type: string;
  is_legacy: boolean;
};

export interface ResolvedMatchCandidates {
  candidates: CandidateWithPositions[];
  /** (race_id → election_id) for the multivariable weight loader. */
  raceToElectionId: Map<string, string>;
  /** (race_id → relevant_dimensions) office-scoped dims. */
  officeDimsByRace: Map<string, string[]>;
  /** Subset of allRaceIds that are legacy `races` rows (FK-constrained writes). */
  legacyRaceIds: string[];
  /** v_voter_candidates ids that are legacy candidates (FK-constrained writes). */
  legacyCandidateIds: string[];
}

function normLevel(L: string): RaceLevel {
  if (
    L === 'federal' || L === 'state' || L === 'county' ||
    L === 'municipal' || L === 'judicial' || L === 'school' ||
    L === 'special'
  ) {
    return L as RaceLevel;
  }
  return 'county'; // conservative fallback
}

/**
 * Resolve candidates + positions + weight-loader maps for a set of ballot race
 * ids. `allRaceIds` should be the union produced by `resolveSessionRaceIds`
 * (legacy race UUIDs + office-graph election UUIDs). Returns null candidates=[]
 * safely when nothing matches. Throws only on a hard candidate-read failure.
 */
export async function resolveMatchCandidates(
  supabase: SupabaseClient,
  allRaceIds: string[],
): Promise<ResolvedMatchCandidates> {
  // legacyRaceIds = the subset of resolved ids that are legacy `races` rows.
  // bridgeRows also feeds raceToElectionId for legacy races.
  const { data: bridgeRows } = await supabase
    .from('races')
    .select('id, election_id')
    .in('id', allRaceIds);
  const legacyRaceIds = (bridgeRows ?? []).map((r) => (r as { id: string }).id);

  const [{ data: vraceData }, { data: vcandData, error: candidatesError }] =
    await Promise.all([
      supabase
        .from('v_voter_races')
        .select('id, name, level, district, election_date, election_type, is_legacy')
        .in('id', allRaceIds),
      supabase
        .from('v_voter_candidates')
        .select(
          'id, race_id, name, party, office_name, office_level, district_identifier, is_legacy, legacy_candidate_id, person_id, photo_url, bio, website_url, published, withdrew',
        )
        .in('race_id', allRaceIds)
        .eq('published', true),
    ]);

  if (candidatesError) {
    throw new Error('Failed to load candidates.');
  }

  const vraces = (vraceData ?? []) as VoterRaceRow[];
  const vcands = (vcandData ?? []) as VoterCandRow[];
  const raceById = new Map<string, VoterRaceRow>(vraces.map((r) => [r.id, r]));

  // Resolve a legacy candidate id per voter row for the candidate_id position
  // read: legacy rows use their own id; new rows use legacy_candidate_id, then
  // walk person.legacy_candidate_ids[] for un-bridged new-graph rows.
  const positionLookupIds = new Set<string>();
  const positionIdByCand = new Map<string, string | null>();
  for (const vc of vcands) {
    if (vc.is_legacy) {
      positionLookupIds.add(vc.id);
      positionIdByCand.set(vc.id, vc.id);
    } else if (vc.legacy_candidate_id) {
      positionLookupIds.add(vc.legacy_candidate_id);
      positionIdByCand.set(vc.id, vc.legacy_candidate_id);
    } else {
      positionIdByCand.set(vc.id, null);
    }
  }

  const personIds = vcands
    .filter((vc) => !vc.is_legacy && !vc.legacy_candidate_id && vc.person_id !== null)
    .map((vc) => vc.person_id as string);
  if (personIds.length > 0) {
    const { data: peopleRows } = await supabase
      .from('people')
      .select('id, legacy_candidate_ids')
      .in('id', personIds);
    const legacyByPerson = new Map<string, string | null>();
    for (const p of (peopleRows ?? []) as Array<{
      id: string;
      legacy_candidate_ids: string[] | null;
    }>) {
      const lcs = p.legacy_candidate_ids ?? [];
      legacyByPerson.set(p.id, lcs.length > 0 ? lcs[0] : null);
    }
    for (const vc of vcands) {
      if (vc.is_legacy || vc.legacy_candidate_id || !vc.person_id) continue;
      const lc = legacyByPerson.get(vc.person_id);
      if (lc) {
        positionLookupIds.add(lc);
        positionIdByCand.set(vc.id, lc);
      }
    }
  }

  // Positions by legacy candidate_id.
  const positionsByCand = new Map<string, unknown[]>();
  if (positionLookupIds.size > 0) {
    const { data: posRows } = await supabase
      .from('positions')
      .select('*')
      .in('candidate_id', [...positionLookupIds]);
    for (const p of (posRows ?? []) as Array<{ candidate_id: string }>) {
      const arr = positionsByCand.get(p.candidate_id) ?? [];
      arr.push(p);
      positionsByCand.set(p.candidate_id, arr);
    }
  }

  // Person-native positions (new-graph candidacies own positions by person_id).
  const personLookupIds = new Set<string>();
  for (const vc of vcands) {
    if (vc.person_id) personLookupIds.add(vc.person_id);
  }
  const positionsByPerson = new Map<string, unknown[]>();
  if (personLookupIds.size > 0) {
    const { data: posRows } = await supabase
      .from('positions')
      .select('*')
      .in('person_id', [...personLookupIds]);
    for (const p of (posRows ?? []) as Array<{ id: string; person_id: string }>) {
      const arr = positionsByPerson.get(p.person_id) ?? [];
      arr.push(p);
      positionsByPerson.set(p.person_id, arr);
    }
  }

  // (race_id → election_id): legacy via bridgeRows, new-graph via identity
  // (v_voter_races.id IS the election.id for new-graph rows).
  const raceToElectionId = new Map<string, string>();
  for (const b of bridgeRows ?? []) {
    const row = b as { id: string; election_id: string | null };
    if (row.election_id) raceToElectionId.set(row.id, row.election_id);
  }
  for (const vr of vraces) {
    if (!vr.is_legacy && !raceToElectionId.has(vr.id)) {
      raceToElectionId.set(vr.id, vr.id);
    }
  }
  const officeDimsByRace = await loadRaceOfficeDimensions(
    supabase,
    [...raceToElectionId.entries()].map(([race_id, election_id]) => ({
      race_id,
      election_id,
    })),
  );

  const candidates = vcands.map((vc) => {
    const lookup = positionIdByCand.get(vc.id);
    const candPositions = lookup ? positionsByCand.get(lookup) ?? [] : [];
    const personPositions = vc.person_id
      ? positionsByPerson.get(vc.person_id) ?? []
      : [];
    const seenPosIds = new Set<string>();
    const positions: unknown[] = [];
    for (const p of [...candPositions, ...personPositions]) {
      const pid = (p as { id?: string }).id;
      if (pid && seenPosIds.has(pid)) continue;
      if (pid) seenPosIds.add(pid);
      positions.push(p);
    }
    const vrace = raceById.get(vc.race_id);
    const relevantDims = officeDimsByRace.get(vc.race_id) ?? null;
    return {
      id: vc.id,
      name: vc.name,
      party: vc.party,
      race_id: vc.race_id,
      bio: vc.bio,
      photo_url: vc.photo_url,
      website_url: vc.website_url,
      questionnaire_status: 'not_invited',
      published: vc.published,
      created_at: '',
      updated_at: '',
      positions,
      race: vrace
        ? {
            id: vrace.id,
            name: vrace.name,
            level: normLevel(vrace.level),
            district: vrace.district,
            election_date: vrace.election_date,
            type: (vrace.election_type === 'primary' ? 'primary' : 'general') as
              | 'primary'
              | 'general',
            relevant_dimensions: relevantDims,
          }
        : {
            id: vc.race_id,
            name: vc.office_name ?? '',
            level: normLevel(vc.office_level),
            district: vc.district_identifier,
            election_date: '',
            type: 'general' as const,
            relevant_dimensions: relevantDims,
          },
    };
  }) as CandidateWithPositions[];

  const legacyCandidateIds = vcands.filter((vc) => vc.is_legacy).map((vc) => vc.id);

  return {
    candidates,
    raceToElectionId,
    officeDimsByRace,
    legacyRaceIds,
    legacyCandidateIds,
  };
}
