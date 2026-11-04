/**
 * Havesay - AXIS-WEIGHT composition and loader (doc 09 Part 3.4).
 *
 * This module builds the per-axis weight map that `weightedL1Score()` and
 * `computeMatchesForUser()` already ACCEPT but that nothing built before, so
 * office competence and jurisdiction salience finally affect match scores.
 *
 * The composition (doc 09 Part 3.4):
 *
 *   axis_weight(axis, voter, race) =
 *         competence_mask(axis, office)       // {0, indirect_factor, 1}
 *       * jurisdiction_salience(axis, race)   // 0..1
 *       * voter_salience(axis, voter)         // 0..1
 *
 * then normalized to sum 1.0 across the race's surviving axes (competence != 0),
 * with the M4 guards (sum == 0 returns an empty map, single survivor normalizes
 * to 1.0, a small epsilon floor stops float noise from dominating).
 *
 * Design discipline:
 *   - The PURE functions (competenceMaskForAxis, jurisdictionSalienceForAxis,
 *     composeAxisWeights) have NO database dependency and are unit-testable
 *     without a Supabase client.
 *   - Only loadAxisWeightsForRace touches the database. It fetches the four
 *     inputs (axis_authority_map, the office authority, the cluster and
 *     jurisdiction salience rows, and sub_dimensions.editorial_salience), builds
 *     the three per-axis-uid input maps, and calls composeAxisWeights.
 *   - This module does NOT edit algorithm.ts. Its output is consumed via the
 *     existing axisWeightsByRace param. (A parallel task owns algorithm.ts.)
 *
 * Acronyms spelled out on first use: L1 (Manhattan distance, the sum of absolute
 * differences); FIPS (Federal Information Processing Standards, the numeric
 * state codes); USPS (United States Postal Service, the two-letter state codes);
 * RLS (row-level security).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { computeAxisUid, type AxisKind } from '@/lib/positioning/axis-set';

export type { AxisKind };

// ---------------------------------------------------------------------------
// axis_uid helper (doc 09 Part 4.1)
// ---------------------------------------------------------------------------
// The engine vectors on a composite axis_uid of the exact form
//   `${sub_dimension_id}:${axis_kind}:${axis_id ?? 'primary'}`
// matching v_axis_positions.axis_uid in the migration:
//   sub_dimension_id::text || ':' || axis_kind || ':' || coalesce(axis_id::text,'primary')
//
// computeAxisUid is the single shared source of truth (src/lib/positioning/
// axis-set.ts). It takes POSITIONAL args (subDimensionId, axisKind, axisId). We
// expose an object-shaped `axisUid` wrapper here so the rest of this module can
// pass {sub_dimension_id, axis_kind, axis_id} objects (its natural row shape)
// while still delegating the actual format to the one shared implementation, so
// the weight keys line up byte-for-byte with the position keys the matcher reads.
// ---------------------------------------------------------------------------

export function axisUid(input: {
  sub_dimension_id: string;
  axis_kind: AxisKind;
  axis_id?: string | null;
}): string {
  return computeAxisUid(input.sub_dimension_id, input.axis_kind, input.axis_id ?? null);
}

// ---------------------------------------------------------------------------
// Open Decisions (named constants surfaced for the operator, doc 09 Part 6)
// ---------------------------------------------------------------------------

/**
 * INDIRECT_FACTOR (Open Decision, doc 09 Parts 3.2 / 3.4).
 *
 * When an office holds a required authority domain but only at a WEAKER mode
 * than the axis requires (the governor who can only VETO abortion law, or an
 * advisory/confirming body), competence is `indirect`: the axis is DOWN-weighted,
 * not dropped. This constant is that down-weight. 0.5 halves the axis's weight,
 * which is a defensible "the office matters here, but at one remove" default.
 *
 * The operator may tune this. Lower (e.g. 0.25) makes veto-only levers count much less;
 * higher (e.g. 0.75) makes them nearly first-class. It is intentionally a single
 * named constant so the choice is one edit, not a scatter of magic numbers.
 */
export const INDIRECT_FACTOR = 0.5;

/**
 * WEIGHT_EPSILON (doc 09 Part 3.4, red-team M4).
 *
 * Float-noise floor. After normalization, any surviving weight below this is
 * clamped UP to it so a handful of genuinely near-zero axes cannot turn rounding
 * noise into a score, and the post-clamp vector is re-normalized. This mirrors
 * the WEIGHT_EPSILON guard already present in algorithm.ts; kept in sync here so
 * the composed map the matcher receives is already floored.
 */
export const WEIGHT_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Authority-mode strength ordering (for the competence mask)
// ---------------------------------------------------------------------------
// `authority_mode_t` is an enum, not an ordered scale, but competence needs a
// STRONG-vs-WEAK split to decide direct (1) vs indirect (INDIRECT_FACTOR). The
// split, per doc 09 Part 3.2: an office that ACTS on an issue (writes the law or
// executes it) is a direct actor; an office that only ADVISES or CONFIRMS, or an
// executive that can only veto, is indirect.
//
//   STRONG (direct actor):  legislative, executive, quasi_judicial
//   WEAK   (indirect lever): advisory, confirming
//
// The rule below is not a numeric ">=" on an arbitrary rank (that would imply a
// total order the enum does not have). It is: the office is a DIRECT match for
// the axis if it holds a required domain at a STRONG mode; it is INDIRECT if it
// holds a required domain only at a WEAK mode; it is masked out (0) if it holds
// no required domain at all. The seed's min_authority_mode values are all STRONG
// (legislative / executive), so "weaker than required" reduces to "the office's
// own mode is WEAK". If a future axis sets a WEAK min_authority_mode, see the
// note in `competenceMaskForAxis` for how that case is handled.

const STRONG_MODES = new Set<string>(['legislative', 'executive', 'quasi_judicial']);

function isStrongMode(mode: string | null | undefined): boolean {
  return mode != null && STRONG_MODES.has(mode);
}

// ---------------------------------------------------------------------------
// Pure function 1: competenceMaskForAxis
// ---------------------------------------------------------------------------

/**
 * One row of `axis_authority_map` for a single axis: a required authority domain
 * (and optional finer subdomain) plus the minimum mode that makes the axis fully
 * matching-relevant. An axis may have SEVERAL such rows (e.g. criminal_justice
 * requires public_safety OR justice); holding ANY one of them at a strong-enough
 * mode is sufficient.
 */
export interface AxisAuthorityRequirement {
  required_authority_domain: string;
  /** Finer-than-enum tag (e.g. 'water'); null when the enum value is precise enough. */
  authority_subdomain?: string | null;
  /** The mode at/above which the axis is fully (direct) matching-relevant. */
  min_authority_mode?: string | null;
}

/**
 * The office's structured authority, read from offices/governing_bodies:
 *   policy_authority_domains_v1 -> domains
 *   authority_mode              -> mode
 * The office carries ONE authority_mode (its dominant posture); per-domain mode
 * variation is not modeled on the office row, so the mask compares the office's
 * single mode against each requirement.
 */
export interface OfficeAuthority {
  /** policy_authority_domains_v1: the enum-array of domains the office holds. */
  domains: string[];
  /** authority_mode: the office's authority posture (legislative/executive/...). */
  mode: string | null;
}

/**
 * competenceMaskForAxis (doc 09 Part 3.2).
 *
 * Returns the competence factor for one axis given its authority requirements
 * and the office's authority:
 *   - 1                : the office holds a required domain AND its mode is
 *                        strong enough (a direct actor). KEEP the axis.
 *   - INDIRECT_FACTOR  : the office holds a required domain but only at a weaker
 *                        mode than required (the governor-veto / advisory case).
 *                        DOWN-WEIGHT the axis, do not drop it.
 *   - 0                : the office holds NONE of the axis's required domains.
 *                        DROP the axis (the sheriff-on-education case).
 *
 * Subdomain handling (red-team C3): the enum is coarser than the axis grain, so
 * a requirement may carry an authority_subdomain (e.g. 'water' under
 * health_environment). The office row only lists enum DOMAINS, not subdomains,
 * so we cannot positively confirm the subdomain from the office alone. The
 * conservative, non-dropping rule: a domain match is treated as satisfying the
 * requirement regardless of subdomain (the office holds the coarse authority);
 * the subdomain is advisory metadata for the voter-facing scope copy, not a
 * second gate that could silently drop a water axis from a water district whose
 * row only says 'utilities'. This avoids false-dropping at the cost of not
 * false-keeping rarely; doc 09 Part 3.2 explicitly prefers not-dropping here.
 *
 * If NO requirement rows exist for the axis (the axis was never mapped), the
 * axis is UNGATED and returns 1 - an unmapped axis is not competence-droppable,
 * matching how office-dims.ts degrades gracefully when an office has no
 * relevant_dimensions. (An axis that should be droppable must have a mapping.)
 */
export function competenceMaskForAxis(
  axisAuthorityRows: AxisAuthorityRequirement[],
  office: OfficeAuthority,
): number {
  // Unmapped axis: nothing requires any authority, so it is not droppable here.
  if (!axisAuthorityRows || axisAuthorityRows.length === 0) return 1;

  const officeDomains = new Set(office.domains ?? []);
  const officeModeStrong = isStrongMode(office.mode);

  let holdsAnyRequiredDomain = false;
  let anyDirect = false;

  for (const req of axisAuthorityRows) {
    if (!officeDomains.has(req.required_authority_domain)) continue;
    holdsAnyRequiredDomain = true;

    // Does the office meet the required strength for THIS requirement?
    // Requirement strength = strength of min_authority_mode.
    //   - min is STRONG (the seed's case, legislative/executive): the office is
    //     a direct actor only if its own mode is also STRONG.
    //   - min is WEAK or unset: any mode the office holds is sufficient for a
    //     direct match (the axis is matching-relevant even via a weak lever).
    const minIsStrong = isStrongMode(req.min_authority_mode);
    const directForThisReq = minIsStrong ? officeModeStrong : true;
    if (directForThisReq) anyDirect = true;
  }

  if (!holdsAnyRequiredDomain) return 0;          // sheriff on education: drop.
  if (anyDirect) return 1;                         // direct actor: keep at full.
  return INDIRECT_FACTOR;                          // holds domain, weak mode: down-weight.
}

// ---------------------------------------------------------------------------
// Pure function 2: jurisdictionSalienceForAxis
// ---------------------------------------------------------------------------

/**
 * jurisdictionSalienceForAxis (doc 09 Part 3.3).
 *
 * Composes the place-specific salience of one axis from:
 *   - editorialSalience : the baseline (sub_dimensions.editorial_salience, 0..1,
 *                         0.5 neutral). How much the issue matters in general.
 *   - clusterModifiers  : zero or more regional-cluster salience modifiers for
 *                         the race's state (e.g. Western Water raises water
 *                         salience to 0.95 for Utah). Each in 0..1.
 *   - jurisdictionOverride : an optional per-jurisdiction override (0..1) for the
 *                         cases a cluster is too coarse.
 *
 * COMPOSITION RULE (chosen, documented; an Open Decision for the operator):
 *   result = clamp01( max( editorialSalience, ...clusterModifiers, jurisdictionOverride? ) )
 *
 * We take the MAX, not the product or a sum. Rationale, straight from doc 09
 * Part 3.3: a cluster RAISES the salience of its signature axes for member
 * states. "Raise" means a member state should never see LOWER salience than the
 * baseline, and a strong cluster signal (0.95 water in Utah) should win over a
 * neutral baseline (0.5) rather than be diluted by it. MAX gives exactly that:
 *   - non-member state, no override -> baseline (cluster is absent, water stays
 *     at its low baseline and likely falls below the surfacing floor: the
 *     Maine-water case);
 *   - member state -> the raised cluster value (the Utah-water case);
 *   - explicit jurisdiction override -> wins when it is the strongest signal,
 *     for the town-economy edge cases a cluster cannot capture.
 *
 * MULTIPLY was rejected: multiplying baseline 0.5 by cluster 0.95 gives 0.475,
 * which is LOWER than the baseline - the cluster would LOWER salience, the exact
 * opposite of "raise". A product only makes sense for independent attenuating
 * factors; salience inputs here are competing claims about the same quantity
 * (how much this place cares), so the strongest claim should govern. The cross-
 * factor MULTIPLY that doc 09 Part 3.4 specifies is between jurisdiction_salience
 * and voter_salience (two genuinely different quantities), handled in
 * composeAxisWeights, NOT inside this single-quantity composition.
 */
export function jurisdictionSalienceForAxis(
  editorialSalience: number,
  clusterModifiers: number[],
  jurisdictionOverride?: number,
): number {
  const candidates: number[] = [editorialSalience, ...(clusterModifiers ?? [])];
  if (jurisdictionOverride !== undefined && jurisdictionOverride !== null) {
    candidates.push(jurisdictionOverride);
  }
  const maxVal = candidates.reduce((m, v) => (v > m ? v : m), 0);
  return clamp01(maxVal);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// ---------------------------------------------------------------------------
// Pure function 3: composeAxisWeights
// ---------------------------------------------------------------------------

/**
 * Inputs to composeAxisWeights. Every map is keyed by the SAME axis_uid the
 * engine vectors on, so the composed output lines up with the position keys.
 *
 *   axes                        : the axis_uids in the race's subspace (the
 *                                 universe over which we compose). Anything not
 *                                 in this list is ignored.
 *   competenceByAxisUid         : competence factor per axis (0 / INDIRECT / 1).
 *                                 A missing entry is treated as 1 (ungated).
 *   jurisdictionSalienceByAxisUid : jurisdiction salience per axis (0..1). A
 *                                 missing entry is treated as the neutral 0.5.
 *   voterSalienceByAxisUid      : the voter's own salience per axis (0..1). A
 *                                 missing entry is treated as 1 (the voter has
 *                                 no special de-emphasis for this axis).
 */
export interface ComposeAxisWeightsInput {
  axes: string[];
  competenceByAxisUid: Map<string, number>;
  jurisdictionSalienceByAxisUid: Map<string, number>;
  voterSalienceByAxisUid: Map<string, number>;
}

/**
 * composeAxisWeights (doc 09 Part 3.4).
 *
 * weight(axis) = competence * jurisdiction_salience * voter_salience, with:
 *   - competence == 0 axes DROPPED before weighting (the competence mask is a
 *     clean gate applied first, per Part 3.4: a salient issue the office cannot
 *     affect is removed, not faintly down-weighted);
 *   - the surviving raw weights normalized to sum 1.0;
 *   - M4 guards (red-team M4):
 *       * if the surviving raw-weight sum is 0 (or below epsilon), return an
 *         EMPTY map - the caller treats an empty map as insufficient (it then
 *         falls through to the engine's resolveSubDimensionWeights / the
 *         insufficient-overlap path), never a divide-by-zero;
 *       * a single survivor normalizes to exactly 1.0;
 *       * a small epsilon FLOOR is applied to each normalized survivor and the
 *         vector re-normalized, so float noise on near-zero weights cannot
 *         dominate.
 *
 * Returns Map<axis_uid, number> summing to 1.0 (within float tolerance) over the
 * surviving axes, or an empty Map when nothing survives.
 */
export function composeAxisWeights(input: ComposeAxisWeightsInput): Map<string, number> {
  const {
    axes,
    competenceByAxisUid,
    jurisdictionSalienceByAxisUid,
    voterSalienceByAxisUid,
  } = input;

  // 1. Raw weights, dropping competence == 0 axes.
  const raw = new Map<string, number>();
  let rawSum = 0;
  for (const uid of axes) {
    const competence = competenceByAxisUid.has(uid) ? competenceByAxisUid.get(uid)! : 1;
    if (competence === 0) continue; // masked out: drop before weighting.

    const jur = jurisdictionSalienceByAxisUid.has(uid)
      ? jurisdictionSalienceByAxisUid.get(uid)!
      : 0.5; // neutral baseline when unspecified.
    const voter = voterSalienceByAxisUid.has(uid) ? voterSalienceByAxisUid.get(uid)! : 1;

    const w = competence * jur * voter;
    raw.set(uid, w);
    rawSum += w;
  }

  // 2. M4 guard: degenerate vector (no survivors, or all-zero weight) -> empty.
  if (raw.size === 0 || rawSum <= WEIGHT_EPSILON) {
    return new Map<string, number>();
  }

  // 3. Normalize to sum 1.0. A single survivor lands on exactly 1.0.
  const normalized = new Map<string, number>();
  for (const [uid, w] of raw) {
    normalized.set(uid, w / rawSum);
  }

  // 4. Epsilon floor: lift any near-zero survivor to the floor, then re-normalize
  //    so float noise on tiny weights cannot dominate the score. With a single
  //    survivor this is a no-op (already 1.0, above the floor).
  let flooredSum = 0;
  for (const [uid, w] of normalized) {
    const floored = w < WEIGHT_EPSILON ? WEIGHT_EPSILON : w;
    normalized.set(uid, floored);
    flooredSum += floored;
  }
  if (flooredSum > 0 && flooredSum !== 1) {
    for (const [uid, w] of normalized) {
      normalized.set(uid, w / flooredSum);
    }
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// DB loader: loadAxisWeightsForRace
// ---------------------------------------------------------------------------

/**
 * The minimal description of an axis the loader needs to weight it. The caller
 * (the parallel voter-side / candidate plumbing task) supplies the race's axis
 * battery: for each axis its kind, id, and owning issue (sub_dimension), so the
 * loader can key every input map by the exact axis_uid the matcher reads.
 */
export interface RaceAxis {
  axis_kind: AxisKind;
  /** backbone_axes.id or propositions.id; null for the primary sub_dimension axis. */
  axis_id?: string | null;
  /** The issue this axis belongs to (its sub_dimension). */
  sub_dimension_id: string;
}

export interface LoadAxisWeightsArgs {
  /** The race's office authority (domains + mode), as read by the caller. */
  office: OfficeAuthority;
  /**
   * The race's state, as a USPS two-letter code (e.g. 'UT') or a FIPS code.
   * regional_clusters.member_states stores USPS codes; if a FIPS code is passed
   * it is normalized to USPS via FIPS_TO_USPS before the membership test.
   */
  stateOrFips: string | null;
  /** The race's axis battery (the universe to weight). */
  axes: RaceAxis[];
  /**
   * The voter's own per-axis salience, keyed by axis_uid (0..1). Supplied by the
   * caller from the voter's domain/axis weights (the existing deriveWeights).
   * A missing entry defaults to 1 in composeAxisWeights.
   */
  voterSalienceByAxisUid: Map<string, number>;
  /**
   * Optional per-jurisdiction id for the finer jurisdiction_axis_salience
   * override lookup. When omitted, only cluster + editorial salience compose.
   */
  jurisdictionId?: string | null;
}

/**
 * loadAxisWeightsForRace (doc 09 Part 3.4, the DB-bound half).
 *
 * Fetches the four salience/competence inputs from the live tables, builds the
 * three per-axis-uid input maps, and calls composeAxisWeights. Returns
 * Map<axis_uid, number> (normalized, summing to 1.0) or an EMPTY map when the
 * composition is degenerate (the caller treats empty as insufficient).
 *
 * DB reads (all additive, all from the doc 09 migrations):
 *   - axis_authority_map      : the competence requirements per axis.
 *   - office authority        : passed in by the caller (args.office) - the
 *                               office row read belongs to the caller's race
 *                               resolution, not re-fetched here.
 *   - regional_clusters       : clusters whose member_states include the state.
 *   - cluster_axis_salience   : the salience_modifier rows for those clusters.
 *   - jurisdiction_axis_salience : the optional per-jurisdiction override.
 *   - sub_dimensions          : editorial_salience baselines.
 *
 * Keeping the office authority as an argument (not a fetch) is deliberate: the
 * caller already resolves the race's office (office-dims.ts walks
 * elections -> offices), so re-querying here would duplicate that work and risk
 * drift. The pure functions stay DB-free; this function is the only DB surface.
 */
export async function loadAxisWeightsForRace(
  sb: SupabaseClient,
  args: LoadAxisWeightsArgs,
): Promise<Map<string, number>> {
  const { office, stateOrFips, axes, voterSalienceByAxisUid, jurisdictionId } = args;

  if (!axes || axes.length === 0) return new Map<string, number>();

  // The distinct issues (sub_dimensions) and axis_ids we need to look up.
  const subDimIds = [...new Set(axes.map((a) => a.sub_dimension_id))];
  const axisUidList = axes.map((a) => axisUid(a));

  // Helper: which axis_authority/cluster/jurisdiction row matches which RaceAxis.
  // Salience/authority rows key on (axis_kind, sub_dimension_id, axis_id) with a
  // nullable axis_id (null = primary axis). Build the same composite to match.
  // The DB column axis_kind is CHECK-constrained to the three AxisKind values,
  // but the untyped client surfaces it as a bare string; cast at this one seam.
  const rowAxisUid = (r: {
    axis_kind: string;
    sub_dimension_id: string;
    axis_id?: string | null;
  }): string =>
    axisUid({
      axis_kind: r.axis_kind as AxisKind,
      sub_dimension_id: r.sub_dimension_id,
      axis_id: r.axis_id ?? null,
    });

  // ── 1. Competence: axis_authority_map rows for the race's issues. ──────────
  const competenceByAxisUid = new Map<string, number>();
  {
    const { data, error } = await sb
      .from('axis_authority_map')
      .select('axis_kind, axis_id, sub_dimension_id, required_authority_domain, authority_subdomain, min_authority_mode')
      .in('sub_dimension_id', subDimIds);
    if (error) {
      // Degrade gracefully: without the bridge, no axis is competence-dropped.
      // The matcher then weights on salience x voter alone (or falls back to its
      // resolveSubDimensionWeights when the map is empty). Logged, not thrown.
      // eslint-disable-next-line no-console
      console.warn('[loadAxisWeightsForRace] axis_authority_map read failed:', error.message);
    }
    type AuthRow = {
      axis_kind: string;
      axis_id: string | null;
      sub_dimension_id: string;
      required_authority_domain: string;
      authority_subdomain: string | null;
      min_authority_mode: string | null;
    };
    const byAxisUid = new Map<string, AxisAuthorityRequirement[]>();
    for (const r of (data as AuthRow[] | null) ?? []) {
      const uid = rowAxisUid(r);
      const arr = byAxisUid.get(uid) ?? [];
      arr.push({
        required_authority_domain: r.required_authority_domain,
        authority_subdomain: r.authority_subdomain,
        min_authority_mode: r.min_authority_mode,
      });
      byAxisUid.set(uid, arr);
    }
    for (const a of axes) {
      const uid = axisUid(a);
      const reqs = byAxisUid.get(uid) ?? [];
      competenceByAxisUid.set(uid, competenceMaskForAxis(reqs, office));
    }
  }

  // ── 2. Salience baseline: sub_dimensions.editorial_salience per issue. ─────
  const editorialByIssue = new Map<string, number>();
  {
    const { data, error } = await sb
      .from('sub_dimensions')
      .select('id, editorial_salience')
      .in('id', subDimIds);
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[loadAxisWeightsForRace] sub_dimensions read failed:', error.message);
    }
    for (const r of (data as Array<{ id: string; editorial_salience: number | null }> | null) ?? []) {
      editorialByIssue.set(r.id, r.editorial_salience ?? 0.5);
    }
  }

  // ── 3. Regional clusters for the race's state, and their axis modifiers. ───
  const clusterModifiersByAxisUid = new Map<string, number[]>();
  const usps = toUspsCode(stateOrFips);
  if (usps) {
    const { data: clusters, error: cErr } = await sb
      .from('regional_clusters')
      .select('id, member_states')
      .contains('member_states', [usps]);
    if (cErr) {
      // eslint-disable-next-line no-console
      console.warn('[loadAxisWeightsForRace] regional_clusters read failed:', cErr.message);
    }
    const clusterIds = ((clusters as Array<{ id: string; member_states: string[] }> | null) ?? []).map(
      (c) => c.id,
    );
    if (clusterIds.length > 0) {
      const { data: cas, error: casErr } = await sb
        .from('cluster_axis_salience')
        .select('cluster_id, axis_kind, axis_id, sub_dimension_id, salience_modifier')
        .in('cluster_id', clusterIds)
        .in('sub_dimension_id', subDimIds);
      if (casErr) {
        // eslint-disable-next-line no-console
        console.warn('[loadAxisWeightsForRace] cluster_axis_salience read failed:', casErr.message);
      }
      for (const r of (cas as Array<{
        axis_kind: string;
        axis_id: string | null;
        sub_dimension_id: string;
        salience_modifier: number;
      }> | null) ?? []) {
        const uid = rowAxisUid(r);
        const arr = clusterModifiersByAxisUid.get(uid) ?? [];
        arr.push(r.salience_modifier);
        clusterModifiersByAxisUid.set(uid, arr);
      }
    }
  }

  // ── 4. Optional per-jurisdiction override. ─────────────────────────────────
  const overrideByAxisUid = new Map<string, number>();
  if (jurisdictionId) {
    const { data, error } = await sb
      .from('jurisdiction_axis_salience')
      .select('axis_kind, axis_id, sub_dimension_id, salience')
      .eq('jurisdiction_id', jurisdictionId)
      .in('sub_dimension_id', subDimIds);
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[loadAxisWeightsForRace] jurisdiction_axis_salience read failed:', error.message);
    }
    for (const r of (data as Array<{
      axis_kind: string;
      axis_id: string | null;
      sub_dimension_id: string;
      salience: number;
    }> | null) ?? []) {
      overrideByAxisUid.set(rowAxisUid(r), r.salience);
    }
  }

  // ── 5. Compose jurisdiction salience per axis. ─────────────────────────────
  const jurisdictionSalienceByAxisUid = new Map<string, number>();
  for (const a of axes) {
    const uid = axisUid(a);
    const baseline = editorialByIssue.get(a.sub_dimension_id) ?? 0.5;
    const clusterMods = clusterModifiersByAxisUid.get(uid) ?? [];
    const override = overrideByAxisUid.has(uid) ? overrideByAxisUid.get(uid)! : undefined;
    jurisdictionSalienceByAxisUid.set(
      uid,
      jurisdictionSalienceForAxis(baseline, clusterMods, override),
    );
  }

  // ── 6. Compose the final per-axis weight map. ──────────────────────────────
  return composeAxisWeights({
    axes: axisUidList,
    competenceByAxisUid,
    jurisdictionSalienceByAxisUid,
    voterSalienceByAxisUid,
  });
}

// ---------------------------------------------------------------------------
// State-code normalization (FIPS -> USPS), for the cluster membership test
// ---------------------------------------------------------------------------
// regional_clusters.member_states stores USPS two-letter codes (the seed uses
// ['UT','AZ','NV','CO','NM','ID']). A race's state may arrive as a USPS code or a
// two-digit FIPS code (jurisdictions.fips_state). Normalize to USPS before the
// `.contains()` membership test. A value already two letters is passed through
// uppercased; an unknown value returns null (no cluster membership, baseline
// salience only - the safe degrade).

const FIPS_TO_USPS: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP',
  '72': 'PR', '78': 'VI',
};

export function toUspsCode(stateOrFips: string | null | undefined): string | null {
  if (!stateOrFips) return null;
  const s = stateOrFips.trim();
  if (s.length === 0) return null;
  // Already a USPS two-letter alpha code.
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  // FIPS: normalize 1-2 digit numeric to a zero-padded 2-char key.
  if (/^\d{1,2}$/.test(s)) {
    const key = s.padStart(2, '0');
    return FIPS_TO_USPS[key] ?? null;
  }
  return null;
}
