/**
 * multivariable-match.ts - the LIVE request-path wiring for multivariable
 * matching (doc 09 Part 3.4, task #23).
 *
 * The matcher (algorithm.ts) already ACCEPTS a pre-composed per-axis weight map
 * (the axisWeightsByRace param), and the weight loader (axis-weights.ts) already
 * KNOWS how to build one map for one race. This module is the missing seam that
 * calls them together in the request path: for every distinct race on a voter's
 * ballot it resolves the race's office authority and state, resolves the race's
 * in-scope axes, derives the voter's per-axis salience from the voter's domain
 * weights, loads the composed weight map, and assembles the per-race map the
 * matcher consumes.
 *
 * Strict OFF-path discipline (the MATCHING_MULTIVARIABLE feature flag defaults
 * OFF, in dev AND prod): computeMultivariableMatches checks the flag FIRST. When
 * OFF it does ZERO weight loading and ZERO supplemental queries - it just calls
 * computeMatchesForUser exactly as the callers do today, so the OFF behaviour is
 * byte-for-byte unchanged. Only when the flag is ON does it run buildAxisWeights-
 * ByRace and pass the resulting map.
 *
 * Design discipline (mirrors axis-weights.ts):
 *   - ALL database reads live here. algorithm.ts is NOT touched.
 *   - The office-authority + state resolution is the one supplemental query this
 *     module owns; the matcher's Race type carries neither, so we fetch them by
 *     the race's office (via its election id) - the same elections -> offices
 *     walk office-dims.ts already uses for relevant_dimensions.
 *
 * Acronyms, spelled out on first use: UID (unique identifier), FIPS (Federal
 * Information Processing Standards, the numeric state codes), USPS (United States
 * Postal Service, the two-letter state codes), DB (database).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CandidateWithPositions,
  Domain,
  MatchResult,
  MatchView,
  SubDimension,
  User,
} from '@/types/database';
import {
  computeMatchesForUser,
  multivariableMatchingEnabled,
} from '@/lib/matching/algorithm';
import {
  loadAxisWeightsForRace,
  type OfficeAuthority,
  type RaceAxis,
} from '@/lib/matching/axis-weights';
import { resolveActiveAxisSet } from '@/lib/positioning/axis-set';
import { filterMatchingDims, raceLevelToScope } from '@/lib/taxonomy/scope';
import { respectOfficeDimsEnabled } from '@/lib/matching/office-dims';

// ---------------------------------------------------------------------------
// Office-authority + state resolution for one race
// ---------------------------------------------------------------------------

/** The two facts loadAxisWeightsForRace needs that the Race type does not carry. */
export interface RaceAuthorityContext {
  /** policy_authority_domains_v1 + authority_mode for the race's office. */
  office: OfficeAuthority;
  /** The race's state as a FIPS or USPS code (jurisdictions.fips_state). */
  stateOrFips: string | null;
}

/**
 * Resolve, for a set of races, the office authority (domains + mode) and the
 * state, by walking the office-centric graph from the race's election id:
 *
 *   election.office_id -> offices
 *     - offices.policy_authority_domains_v1 / authority_mode   (seat-level)
 *     - offices.governing_body_id -> governing_bodies          (body inheritance)
 *     - offices.jurisdiction_id -> jurisdictions.fips_state    (the state)
 *
 * The caller already builds a (race_id -> election_id) map for BOTH legacy races
 * (races.election_id) and new-graph races (race.id IS election.id), exactly as
 * office-dims.ts does, so we take that map rather than re-deriving the bridge.
 *
 * Authority precedence: a body-member office (governing_body_id set) inherits
 * its authority from the body, which is where the structured authority is
 * curated (migration 20260526220000 + 20260525000000). A standalone office
 * (governing_body_id null - governor, mayor, sheriff, clerk) carries its own
 * authority on the office row. So we prefer the OFFICE's own non-empty domains
 * when present, and fall back to the BODY's. An office with neither resolves to
 * empty domains (the competence mask then treats every mapped axis as dropped,
 * which is the honest "we don't know this office's authority yet" degrade; the
 * loader's empty-map result then routes the race back to the unweighted path).
 *
 * Degrades gracefully on any DB error: a race we cannot resolve gets
 * { office: { domains: [], mode: null }, stateOrFips: null }. With empty
 * domains every mapped axis masks out, the composed map comes back empty, and
 * the matcher falls through to resolveSubDimensionWeights for that race - i.e.
 * the OFF-path math - which is the safe failure mode.
 */
export async function resolveRaceAuthorityContexts(
  sb: SupabaseClient,
  raceToElectionId: Map<string, string>,
): Promise<Map<string, RaceAuthorityContext>> {
  const out = new Map<string, RaceAuthorityContext>();
  if (raceToElectionId.size === 0) return out;

  // PostgREST embeds many-to-one relations as either an object or a 1-element
  // array depending on the cardinality it infers; normalize defensively, the
  // same way office-dims.ts and axis-set.ts do.
  const pickOne = <T>(v: T | T[] | null | undefined): T | undefined =>
    Array.isArray(v) ? v[0] : v ?? undefined;

  const electionToRace = new Map<string, string>();
  const electionIds: string[] = [];
  for (const [raceId, electionId] of raceToElectionId) {
    if (!electionId) continue;
    electionToRace.set(electionId, raceId);
    electionIds.push(electionId);
  }
  if (electionIds.length === 0) return out;

  type OfficeEmbed = {
    policy_authority_domains_v1: string[] | null;
    authority_mode: string | null;
    governing_body:
      | {
          policy_authority_domains_v1: string[] | null;
          authority_mode: string | null;
        }
      | Array<{
          policy_authority_domains_v1: string[] | null;
          authority_mode: string | null;
        }>
      | null;
    jurisdiction: { fips_state: string | null } | Array<{ fips_state: string | null }> | null;
  };
  type ElectionRow = { id: string; office: OfficeEmbed | OfficeEmbed[] | null };

  const BATCH = 300;
  try {
    for (let i = 0; i < electionIds.length; i += BATCH) {
      const slice = electionIds.slice(i, i + BATCH);
      const { data, error } = await sb
        .from('elections')
        .select(
          `id, office:offices(
             policy_authority_domains_v1, authority_mode,
             governing_body:governing_bodies(policy_authority_domains_v1, authority_mode),
             jurisdiction:jurisdictions!offices_jurisdiction_id_fkey(fips_state)
           )`,
        )
        .in('id', slice);
      if (error) throw error;
      for (const e of (data as ElectionRow[] | null) ?? []) {
        const raceId = electionToRace.get(e.id);
        if (!raceId) continue;
        const office = pickOne(e.office);
        const body = pickOne(office?.governing_body);
        const juris = pickOne(office?.jurisdiction);

        // Office's own domains win when non-empty; else inherit from the body.
        const officeDomains = office?.policy_authority_domains_v1 ?? [];
        const bodyDomains = body?.policy_authority_domains_v1 ?? [];
        const domains = officeDomains.length > 0 ? officeDomains : bodyDomains;
        const mode =
          officeDomains.length > 0
            ? office?.authority_mode ?? null
            : body?.authority_mode ?? office?.authority_mode ?? null;

        out.set(raceId, {
          office: { domains, mode },
          stateOrFips: juris?.fips_state ?? null,
        });
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[resolveRaceAuthorityContexts] degrading:', err);
  }

  // Any race we could not resolve gets a conservative empty context.
  for (const raceId of raceToElectionId.keys()) {
    if (!out.has(raceId)) {
      out.set(raceId, { office: { domains: [], mode: null }, stateOrFips: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Voter per-axis salience from the voter's domain weights
// ---------------------------------------------------------------------------

/**
 * Spread each domain's weight equally across the axes of that domain, keyed by
 * axis_uid. This mirrors resolveSubDimensionWeights in algorithm.ts (which
 * spreads a domain weight across the domain's sub_dimensions) but at axis grain:
 * an issue can carry several axes (primary + backbone + propositions), so a
 * domain's weight is spread across ALL the axes whose owning issue is in that
 * domain.
 *
 * An axis whose domain has no voter emphasis defaults to 1 (composeAxisWeights
 * already treats a MISSING entry as 1; we make that explicit per the task spec:
 * "an axis with no voter emphasis defaults to 1"). Concretely, when the voter's
 * weight map has no entry for an axis's domain, that axis is left OUT of the
 * returned map, so the loader's default of 1 applies.
 *
 * @param weights         user.weights: Record<domain, number> (deriveWeights).
 * @param axesBySubDim    the resolved axes per in-scope issue for this race.
 * @param subDimDomain    sub_dimension_id -> Domain, for the issues in scope.
 */
export function voterSalienceByAxisUid(
  weights: Record<string, number>,
  axesBySubDim: Map<string, RaceAxisResolved[]>,
  subDimDomain: Map<string, Domain>,
): Map<string, number> {
  // Group the in-scope axes by domain so a domain's weight is spread across all
  // of its axes (across every in-scope issue in that domain), not per-issue.
  const axesByDomain = new Map<Domain, RaceAxisResolved[]>();
  for (const [subDimId, axes] of axesBySubDim) {
    const domain = subDimDomain.get(subDimId);
    if (!domain) continue;
    const arr = axesByDomain.get(domain) ?? [];
    for (const ax of axes) arr.push(ax);
    axesByDomain.set(domain, arr);
  }

  const out = new Map<string, number>();
  for (const [domain, axes] of axesByDomain) {
    // No voter emphasis for this domain -> leave its axes out (default 1).
    if (!(domain in weights)) continue;
    const w = weights[domain];
    const perAxis = axes.length > 0 ? w / axes.length : 0;
    for (const ax of axes) out.set(ax.axis_uid, perAxis);
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildAxisWeightsByRace
// ---------------------------------------------------------------------------

/** An axis resolved for a race, in the RaceAxis shape the loader needs plus its uid. */
interface RaceAxisResolved extends RaceAxis {
  axis_uid: string;
}

/**
 * Compute the per-race, per-axis weight map the matcher consumes (doc 09 Part
 * 3.4). For each DISTINCT race among the candidates:
 *
 *   1. Apply the SAME scope filter computeMatchesForUser uses (filterMatchingDims
 *      at the race level, intersected with the office's relevant_dimensions when
 *      MATCHING_RESPECT_OFFICE_DIMS is on) to get the in-scope issues.
 *   2. resolveActiveAxisSet for each in-scope issue -> the race's axis battery.
 *   3. Derive the voter's per-axis salience from user.weights (domain weight
 *      spread across that domain's axes; missing -> default 1).
 *   4. Fetch the race's office authority + state (resolveRaceAuthorityContexts).
 *   5. loadAxisWeightsForRace -> the composed, normalized Map<axis_uid, number>.
 *   6. Put a NON-EMPTY map under the race_id. An EMPTY map (degenerate
 *      composition - nothing in scope, or every axis masked out) is OMITTED so
 *      the matcher falls through to resolveSubDimensionWeights for that race.
 *
 * Keyed by candidate.race_id, matching how the matcher groups candidates and
 * reads axisWeightsByRace.get(raceId).
 *
 * @param raceToElectionId  (race_id -> election_id) for office resolution. The
 *        caller already builds this for office-dims; pass the same map. A race
 *        absent here resolves to empty authority (safe degrade).
 * @param officeDimsByRace  the per-race relevant_dimensions the caller already
 *        loaded (loadRaceOfficeDimensions). Used to mirror the matcher's office-
 *        dims intersection so the in-scope axis set matches the matcher's.
 */
export async function buildAxisWeightsByRace(
  sb: SupabaseClient,
  user: User,
  candidates: CandidateWithPositions[],
  subDimensions: SubDimension[],
  opts?: {
    raceToElectionId?: Map<string, string>;
    officeDimsByRace?: Map<string, string[]>;
  },
): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const weights = user.weights ?? {};
  const raceToElectionId = opts?.raceToElectionId ?? new Map<string, string>();
  const officeDimsByRace = opts?.officeDimsByRace ?? new Map<string, string[]>();

  const subDimDomain = new Map<string, Domain>();
  for (const sd of subDimensions) subDimDomain.set(sd.id, sd.domain);

  // Group candidates by race (one entry per distinct race), capturing each
  // race's level for the scope filter.
  const raceLevelById = new Map<string, CandidateWithPositions['race']['level']>();
  for (const c of candidates) {
    if (!raceLevelById.has(c.race_id)) raceLevelById.set(c.race_id, c.race.level);
  }
  if (raceLevelById.size === 0) return out;

  // One supplemental query for office authority + state across all races.
  const authorityByRace = await resolveRaceAuthorityContexts(sb, raceToElectionId);

  const respectOfficeDims = respectOfficeDimsEnabled();

  for (const [raceId, level] of raceLevelById) {
    // 1. In-scope issues for this race - the SAME filter the matcher applies.
    let scoped = filterMatchingDims(subDimensions, raceLevelToScope(level));
    if (respectOfficeDims) {
      const relevant = officeDimsByRace.get(raceId);
      if (Array.isArray(relevant) && relevant.length > 0) {
        const officeDims = new Set(relevant);
        const filtered = scoped.filter(
          (sd) => officeDims.has(sd.id) || officeDims.has(sd.name),
        );
        if (filtered.length > 0) scoped = filtered;
      }
    }
    if (scoped.length === 0) continue; // nothing in scope -> no weight map.

    // 2. Resolve the active axis set for each in-scope issue.
    const axesBySubDim = new Map<string, RaceAxisResolved[]>();
    const allAxes: RaceAxisResolved[] = [];
    for (const sd of scoped) {
      const active = await resolveActiveAxisSet(sb, sd.id);
      const resolved: RaceAxisResolved[] = active.map((ax) => ({
        axis_kind: ax.axis_kind,
        axis_id: ax.axis_id,
        sub_dimension_id: ax.sub_dimension_id,
        axis_uid: ax.axis_uid,
      }));
      if (resolved.length === 0) continue;
      axesBySubDim.set(sd.id, resolved);
      for (const r of resolved) allAxes.push(r);
    }
    if (allAxes.length === 0) continue; // issue resolved to no axes.

    // 3. Voter per-axis salience from the voter's domain weights.
    const voterSalience = voterSalienceByAxisUid(weights, axesBySubDim, subDimDomain);

    // 4. Office authority + state for this race.
    const ctx =
      authorityByRace.get(raceId) ?? {
        office: { domains: [], mode: null },
        stateOrFips: null,
      };

    // 5. Load + compose the per-axis weight map for this race.
    const weightMap = await loadAxisWeightsForRace(sb, {
      office: ctx.office,
      stateOrFips: ctx.stateOrFips,
      axes: allAxes.map((a) => ({
        axis_kind: a.axis_kind,
        axis_id: a.axis_id,
        sub_dimension_id: a.sub_dimension_id,
      })) as RaceAxis[],
      voterSalienceByAxisUid: voterSalience,
    });

    // 6. Only carry a NON-EMPTY map; empty -> matcher uses the unweighted path.
    if (weightMap.size > 0) out.set(raceId, weightMap);
  }

  return out;
}

// ---------------------------------------------------------------------------
// computeMultivariableMatches - the live entry point
// ---------------------------------------------------------------------------

/**
 * The single function the request path calls. It is a no-op-equivalent to the
 * existing computeMatchesForUser call when MATCHING_MULTIVARIABLE is OFF: in
 * that case it does NO weight loading and NO supplemental query, just calls
 * computeMatchesForUser without an axis-weight map, so the OFF behaviour is
 * byte-for-byte unchanged.
 *
 * When the flag is ON it builds the per-race weight map (buildAxisWeightsByRace)
 * and passes it through. The matcher then vectors on axis_uid and uses the
 * composed competence x jurisdiction x voter weights for each race (falling back
 * to resolveSubDimensionWeights for any race whose map is absent/empty).
 *
 * @param opts  passes the caller's already-built (race_id -> election_id) map
 *        and per-race relevant_dimensions through to buildAxisWeightsByRace, so
 *        we do not re-derive the office bridge the caller already has.
 */
export async function computeMultivariableMatches(
  sb: SupabaseClient,
  user: User,
  candidates: CandidateWithPositions[],
  subDimensions: SubDimension[],
  matchView?: MatchView | null,
  opts?: {
    raceToElectionId?: Map<string, string>;
    officeDimsByRace?: Map<string, string[]>;
  },
): Promise<MatchResult[]> {
  // OFF path: skip ALL weight loading; identical to the legacy call.
  if (!multivariableMatchingEnabled()) {
    return computeMatchesForUser(user, candidates, subDimensions, matchView ?? null);
  }

  // ON path: build the per-race weight map and feed it to the matcher.
  const axisWeightsByRace = await buildAxisWeightsByRace(
    sb,
    user,
    candidates,
    subDimensions,
    opts,
  );

  return computeMatchesForUser(
    user,
    candidates,
    subDimensions,
    matchView ?? null,
    axisWeightsByRace,
  );
}
