/**
 * Axis fusion: the deterministic, dependency-free heart of the multivariable
 * positioning engine.
 *
 * This module implements doc 07 section 2.6 (the deterministic aggregation
 * formula) exactly, generalized to a single axis of a multivariable issue per
 * doc 09. It takes the set of per-signal records the classifier emitted for one
 * (candidate, issue, axis, view) cell and fuses them into:
 *   - a fused DIRECTION (a calibrated 0.0-1.0 position, or null), and
 *   - a separate POSITION STRENGTH (how well-evidenced and agreed-upon it is).
 *
 * Hard rules from the spec, all implemented here:
 *   - Only `graded` signals (direction != null) enter the score/strength math.
 *     `abstains_governing` signals are recorded for display but EXCLUDED from
 *     fusion (doc 07 C1). `balanced` signals carry direction 0.50.
 *   - sum(w) == 0 returns null (the M5 divide-by-zero guard). A fused axis with
 *     no graded signals returns null direction. The caller then writes NO
 *     positions row, so the engine drops the axis (same as an unanswered dim).
 *   - signal_concordance is 0.0 for fewer than 2 graded signals (M5), never 1.0.
 *   - count_factor counts DISTINCT (actor, source_domain) groups, saturating at
 *     6 (M1), so self-reposts from one channel cannot inflate strength.
 *   - per-domain / per-actor diversity damp caps any single source's combined
 *     weight at MAX_SINGLE_SOURCE_SHARE of the total (M1 anti-gaming), after
 *     near-duplicate dedup by inputs_hash within a group.
 *   - actions (votes, sponsorships) decay slowly; statements decay fast (M2).
 *   - round_to_band snaps to 3 decimals and applies a small neutral dead-band
 *     around 0.50 so 0.500-jitter does not flip bands (m4/m5).
 *   - all 0-1 outputs are clamped (M5), so a numeric edge can never violate the
 *     positions.score CHECK (score BETWEEN 0 AND 1).
 *
 * Pure and deterministic: no I/O, no imports, no clock reads. The caller passes
 * `nowIso` (or `asOfMonths` is computed from `recency` against a supplied now),
 * so the same signal set with the same `nowIso` always produces the same numbers.
 * That is what makes it unit-testable and auditable.
 *
 * Acronyms, spelled out on first use: L1 (Manhattan distance, the sum of
 * absolute differences), IRR (inter-rater reliability), M1/M2/M5/C1 (the
 * red-team finding identifiers from doc 07b, carried into doc 07 v2).
 */

// ===========================================================================
// Types
// ===========================================================================

/** Which kind of governing position a signal expresses (doc 07 C1 / section 2.2). */
export type PositionKind = 'graded' | 'balanced' | 'abstains_governing';

/** The four named intensity bands, mirror-imaged around 0.50 (doc 07 section 2.2). */
export type IntensityBand = 'neutral' | 'lean' | 'support' | 'strong';

/** Authenticity tier copied from candidate_sources: 1 primary, 2 reported-with-quote, 3 paraphrased/action. */
export type AuthenticityTier = 1 | 2 | 3;

/**
 * The atomic input to fusion: one per-signal record (doc 07 section 1.6).
 *
 * This is the SHAPE the morning's unstructured-data extraction must conform to.
 * Every approved source, after extraction, yields zero or more of these, one
 * per (candidate, axis) it speaks to. Signals are NOT the final positions row;
 * they are fused here into one.
 *
 * Only the fields fusion actually reads are required. The classifier may carry
 * additional display fields (verbatim_quote, model_id, outlet_ideology, etc.);
 * they are accepted but ignored by the math.
 */
export interface PerSignalRecord {
  /** graded | balanced | abstains_governing. Non-graded routing is handled here. */
  position_kind: PositionKind;
  /**
   * 0-1 on the calibrated spectrum, OR null when position_kind != 'graded'.
   * For 'balanced' this is conventionally 0.50; for 'abstains_governing' it is null.
   */
  direction: number | null;
  /** 1 (primary) | 2 (reported-with-quote) | 3 (paraphrased/secondary/action). */
  authenticity_tier: AuthenticityTier;
  /** Source enum, e.g. 'campaign_website' | 'voting_record' | 'debate'. Drives the tier_weight override. */
  source_type: string;
  /** Registrable domain for the per-domain diversity cap (M1), e.g. 'janeforsenate.com'. */
  source_domain: string;
  /** candidate_self | named_outlet:<slug> | org:<slug> | gov_record (M1). */
  actor: string;
  /** published_at as an ISO date string (or any Date-parseable string); drives recency decay. */
  recency: string;
  /** true for votes/sponsorships: routes to slow decay and strength, not intensity (M2/M8). */
  is_action: boolean;
  /** sha256 (or any stable id) of the inputs; near-identical signals within a group dedup on this (M1). */
  inputs_hash?: string;
  /** The rubric/calibration version that produced `direction`; a fusion may only mix one (M5). */
  calibration_version?: string;
}

/** The result of fusing one axis cell. The caller promotes this to a positions row (or drops the axis). */
export interface FusedAxisResult {
  /**
   * The fused calibrated direction, 0-1, OR null. Null means "no graded signals
   * after excluding abstentions" -> caller writes NO positions row and the
   * engine drops the axis (doc 07 C1). A purely-balanced signal set fuses to 0.50.
   */
  direction: number | null;
  /** Named band DERIVED from `direction` via the cutoffs + dead-band; null when direction is null. */
  band: IntensityBand | null;
  /** position_kind for the fused row: 'abstains_governing' when direction is null and abstentions existed. */
  position_kind: PositionKind;
  /**
   * Evidence strength, 0-1 (doc 07 section 2.6). Distinct from `direction`
   * (extremity) and from data-quality confidence. Null when there are no graded
   * signals (nothing to be strong about).
   */
  position_strength: number | null;
  /** Distinct (actor, source_domain) groups among graded signals (the M1 count). */
  signal_count: number;
  /** 1 - stddev(direction) over graded signals; 0.0 for fewer than 2 (M5). Null when no graded signals. */
  signal_concordance: number | null;
  /** True when the newest graded signal is older than STALE_MONTHS (M2 display flag). */
  may_be_outdated: boolean;
}

// ===========================================================================
// Tunable constants (doc 07 section 2.6 defaults; all Open Decisions for the operator)
// ===========================================================================

/** Band cutoffs (doc 07 section 2.2). Initial hypotheses; real cutoffs come from the IRR pass per proposition. */
export const BAND_CUTOFFS = {
  /** |x - 0.5| at/above STRONG_FROM_MID is the strong band: x <= 0.15 or x >= 0.85. */
  STRONG_FROM_MID: 0.35,
  /** |x - 0.5| at/above SUPPORT_FROM_MID (but below strong) is support: 0.15-0.35 from each pole. */
  SUPPORT_FROM_MID: 0.15,
  /** Inside the dead-band of 0.50 the band reports neutral regardless of the stored numeric (m4/m5). */
  NEUTRAL_DEADBAND: 0.02,
} as const;

/** Recency half-lives in months (M2): actions decay much slower than statements. */
export const HALF_LIFE_STATEMENTS = 18;
export const HALF_LIFE_ACTIONS = 60;

/** Per-source-type tier_weight overrides (doc 07 section 2.6): a voting record is tier-3 but high-consistency. */
const ACTION_SOURCE_TYPES = new Set([
  'voting_record',
  'vote',
  'roll_call',
  'sponsorship',
  'co_sponsorship',
  'bill_sponsorship',
]);

/** M1 anti-gaming: no single (actor, source_domain) group may exceed this share of the total weight. */
export const MAX_SINGLE_SOURCE_SHARE = 0.4;

/** count_factor saturates at this many distinct outlets/actors (M1). */
export const COUNT_SATURATION = 6;

/** Staleness (M2): newest graded signal older than this many months caps strength and flags may_be_outdated. */
export const STALE_MONTHS = 18;
export const STALE_PENALTY = 0.5;

/** position_strength blend weights (doc 07 section 2.6). */
const STRENGTH_W_COUNT = 0.45;
const STRENGTH_W_CONCORDANCE = 0.4;
const STRENGTH_W_TIER = 0.15;

/** Days-per-month used to convert an age in milliseconds into months for the decay. */
const DAYS_PER_MONTH = 30.4375;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ===========================================================================
// Small deterministic helpers
// ===========================================================================

/** Clamp to [0, 1] (M5: applied to every 0-1 output so a numeric edge cannot violate the CHECK constraint). */
export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Round to 3 decimals deterministically (avoids float noise in stored scores). */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * round_to_band(x): snap to 3 decimals AND, for a direction score, apply the
 * neutral dead-band around 0.50 (doc 07 section 2.6, m4/m5). Inside the dead-band
 * the NUMBER is unchanged but the band reports neutral; this function returns the
 * snapped number, and `bandFor()` reads the dead-band for the label.
 */
export function roundToBand(x: number): number {
  return round3(clamp01(x));
}

/**
 * Derive the named band from a calibrated direction (doc 07 section 2.2),
 * applying the neutral dead-band around 0.50 (m4/m5). Symmetric about 0.50.
 */
export function bandFor(direction: number): IntensityBand {
  const fromMid = Math.abs(direction - 0.5);
  if (fromMid <= BAND_CUTOFFS.NEUTRAL_DEADBAND) return 'neutral';
  if (fromMid >= BAND_CUTOFFS.STRONG_FROM_MID) return 'strong';
  if (fromMid >= BAND_CUTOFFS.SUPPORT_FROM_MID) return 'support';
  return 'lean';
}

/** Age in months from a recency ISO date to `nowIso` (never negative; future dates clamp to 0). */
export function ageInMonths(recencyIso: string, nowIso: string): number {
  const then = Date.parse(recencyIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(then) || Number.isNaN(now)) return 0;
  const ageDays = (now - then) / MS_PER_DAY;
  if (ageDays <= 0) return 0;
  return ageDays / DAYS_PER_MONTH;
}

// ===========================================================================
// Per-signal weight (doc 07 section 2.6)
// ===========================================================================

/** tier_weight: trust/provenance, with the voting-record override (doc 07 section 2.6). */
function tierWeight(tier: AuthenticityTier, sourceType: string): number {
  if (ACTION_SOURCE_TYPES.has(sourceType)) {
    // A voting record is tier 3 by the migration but high-consistency: bump for strength.
    return 0.9;
  }
  if (tier === 1) return 1.0;
  if (tier === 2) return 0.7;
  return 0.5;
}

/** recency_weight: exponential decay, slow for actions, fast for statements (M2). */
function recencyWeight(ageMonths: number, isAction: boolean): number {
  const halfLife = isAction ? HALF_LIFE_ACTIONS : HALF_LIFE_STATEMENTS;
  return Math.pow(0.5, ageMonths / halfLife);
}

/**
 * intensity_emphasis: a gentle downweight of dead-center signals so genuine
 * positions count more than throwaway neutral mentions (doc 07 section 2.6).
 * 0.5 at neutral to 1.0 at the extremes. Votes carry no language, so the caller
 * passing an action still gets this from its (numeric) mapped direction, which
 * is correct: a mapped vote direction is still a placement.
 */
function intensityEmphasis(direction: number): number {
  return 0.5 + Math.abs(direction - 0.5);
}

/**
 * perSignalWeight: the full per-signal weight BEFORE the diversity damp.
 *
 *   w_pre = tier_weight * recency_weight * intensity_emphasis
 *
 * The diversity damp (M1) is multiplicative and group-relative, so it cannot be
 * computed from a single signal in isolation; `fuseDirection()` and
 * `positionStrength()` apply it across the group. This function is exported for
 * unit testing of the three independent factors.
 */
export function perSignalWeight(signal: PerSignalRecord, nowIso: string): number {
  if (signal.position_kind !== 'graded' && signal.position_kind !== 'balanced') {
    return 0;
  }
  if (signal.direction === null) return 0;
  const age = ageInMonths(signal.recency, nowIso);
  return (
    tierWeight(signal.authenticity_tier, signal.source_type) *
    recencyWeight(age, signal.is_action) *
    intensityEmphasis(signal.direction)
  );
}

// ===========================================================================
// Diversity damp + graded-signal preparation (M1)
// ===========================================================================

interface PreparedSignal {
  direction: number;
  groupKey: string;
  tier: AuthenticityTier;
  wPre: number;
  ageMonths: number;
}

/** A group key for the per-domain / per-actor diversity cap (M1): combine actor and registrable domain. */
function groupKeyFor(s: PerSignalRecord): string {
  return `${s.actor}|${s.source_domain}`;
}

/**
 * Take the raw signal set and produce the graded, deduped, pre-weighted signals
 * ready for fusion. Steps (doc 07 section 2.6, M1):
 *   1. keep only graded/balanced signals with a numeric direction (drop abstentions),
 *   2. within each (actor, domain) group, dedup near-identical signals by inputs_hash,
 *   3. compute the pre-damp per-signal weight.
 */
function prepareGradedSignals(signals: PerSignalRecord[], nowIso: string): PreparedSignal[] {
  const seenHashesByGroup = new Map<string, Set<string>>();
  const prepared: PreparedSignal[] = [];

  for (const s of signals) {
    if (s.position_kind === 'abstains_governing') continue; // excluded from fusion (C1)
    if (s.direction === null) continue;
    if (s.position_kind !== 'graded' && s.position_kind !== 'balanced') continue;

    const groupKey = groupKeyFor(s);

    // Near-identical dedup within a group: same inputs_hash counts once (M1).
    if (s.inputs_hash) {
      let seen = seenHashesByGroup.get(groupKey);
      if (!seen) {
        seen = new Set<string>();
        seenHashesByGroup.set(groupKey, seen);
      }
      if (seen.has(s.inputs_hash)) continue;
      seen.add(s.inputs_hash);
    }

    prepared.push({
      direction: s.direction,
      groupKey,
      tier: s.authenticity_tier,
      wPre: perSignalWeight(s, nowIso),
      ageMonths: ageInMonths(s.recency, nowIso),
    });
  }

  return prepared;
}

/**
 * Apply the diversity damp (M1): cap the combined weight of any single (actor,
 * domain) group at MAX_SINGLE_SOURCE_SHARE of the total. Returns the final
 * per-signal weights aligned with the input order.
 *
 * The cap is enforced by scaling every signal in an over-cap group by the same
 * factor so the group's combined weight equals exactly the cap of the
 * POST-DAMP total. Because capping one group lowers the total (and so the cap
 * for others), this iterates to a fixed point; it converges in a few passes.
 */
function applyDiversityDamp(prepared: PreparedSignal[]): number[] {
  const n = prepared.length;
  if (n === 0) return [];
  // Start from the un-damped weights.
  const w = prepared.map((p) => p.wPre);

  // The diversity cap protects AGAINST flooding from one source RELATIVE TO
  // others. With only one distinct (actor, domain) group there is nothing to
  // share with, so the cap is meaningless and must NOT be applied: a lone
  // legitimate source would otherwise be scaled toward zero, killing the only
  // signal we have (the single-mild-mention case). One group -> no damp.
  const distinctGroups = new Set(prepared.map((p) => p.groupKey)).size;
  if (distinctGroups < 2) return w;

  // Iterate to a fixed point. With at most n groups, a handful of passes is plenty;
  // cap the loop defensively so it can never spin.
  for (let pass = 0; pass < n + 2; pass++) {
    const total = w.reduce((a, b) => a + b, 0);
    if (total <= 0) break;

    // Sum weight per group.
    const groupTotals = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      groupTotals.set(prepared[i].groupKey, (groupTotals.get(prepared[i].groupKey) ?? 0) + w[i]);
    }

    // Find the most over-cap group, if any. The cap is a share of the CURRENT total.
    const cap = MAX_SINGLE_SOURCE_SHARE * total;
    let worstGroup: string | null = null;
    let worstExcess = 0;
    for (const [g, gt] of groupTotals) {
      const excess = gt - cap;
      if (excess > 1e-9 && excess > worstExcess) {
        worstExcess = excess;
        worstGroup = g;
      }
    }
    if (!worstGroup) break; // no group exceeds its share -> fixed point reached

    // Scale the worst group down so it sits exactly at the cap of the total it
    // will produce. Solve: scaled_group / (rest + scaled_group) = share
    //   => scaled_group = share/(1-share) * rest
    const groupWeight = groupTotals.get(worstGroup)!;
    const rest = total - groupWeight;
    const share = MAX_SINGLE_SOURCE_SHARE;
    const targetGroup = (share / (1 - share)) * rest;
    const factor = groupWeight > 0 ? targetGroup / groupWeight : 0;
    for (let i = 0; i < n; i++) {
      if (prepared[i].groupKey === worstGroup) w[i] *= factor;
    }
  }

  return w;
}

// ===========================================================================
// fuseDirection (doc 07 section 2.6 final score)
// ===========================================================================

/**
 * fuseDirection: the intensity-weighted fused direction.
 *
 *   denom = Sum_i w_i        (graded signals only, after diversity damp)
 *   score = (denom == 0) ? null : clamp01( Sum_i (w_i * direction_i) / denom )
 *
 * Returns null when there are no graded signals or all weights decayed/damped to
 * zero (the M5 divide-by-zero guard). The caller then writes NO positions row,
 * so the engine drops the axis. A purely-balanced signal set fuses to 0.50.
 */
export function fuseDirection(signals: PerSignalRecord[], nowIso: string): number | null {
  const prepared = prepareGradedSignals(signals, nowIso);
  if (prepared.length === 0) return null;

  const weights = applyDiversityDamp(prepared);
  let denom = 0;
  let numer = 0;
  for (let i = 0; i < prepared.length; i++) {
    denom += weights[i];
    numer += weights[i] * prepared[i].direction;
  }
  if (denom <= 0) return null; // M5: nothing to place
  return roundToBand(numer / denom);
}

// ===========================================================================
// positionStrength (doc 07 section 2.6 evidence quality, not extremity)
// ===========================================================================

/** Population standard deviation of a set of directions (used for signal_concordance). */
function stddev(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return Math.sqrt(variance);
}

/**
 * positionStrength: a separate evidence-quality number (doc 07 section 2.6).
 *
 *   distinct_outlets   = count of DISTINCT (actor, source_domain) groups        // M1
 *   count_factor       = min(1.0, distinct_outlets / 6)
 *   signal_concordance = (n_graded < 2) ? 0.0 : 1 - stddev(direction_i)         // M5: 0 for n<2
 *   tier_factor        = 1.0 if any tier-1 graded signal else 0.7 if tier-2 else 0.5
 *   staleness_cap      = 1.0 if newest graded signal age <= STALE_MONTHS else STALE_PENALTY
 *   position_strength  = staleness_cap * clamp01( round_to_band(
 *                          0.45*count_factor + 0.40*signal_concordance + 0.15*tier_factor ) )
 *
 * Returns the full set of strength-related outputs (so the caller can store
 * signal_count, signal_concordance, may_be_outdated alongside). Returns a
 * strength of null when there are no graded signals (nothing to be strong about).
 */
export function positionStrength(
  signals: PerSignalRecord[],
  nowIso: string,
): {
  position_strength: number | null;
  signal_count: number;
  signal_concordance: number | null;
  may_be_outdated: boolean;
} {
  const prepared = prepareGradedSignals(signals, nowIso);
  if (prepared.length === 0) {
    return {
      position_strength: null,
      signal_count: 0,
      signal_concordance: null,
      may_be_outdated: false,
    };
  }

  // M1: distinct (actor, source_domain) groups, not raw signal count.
  const distinctGroups = new Set(prepared.map((p) => p.groupKey));
  const distinctOutlets = distinctGroups.size;
  const countFactor = Math.min(1.0, distinctOutlets / COUNT_SATURATION);

  // M5: concordance is 0 for fewer than 2 graded signals (undefined spread).
  const n = prepared.length;
  const concordance = n < 2 ? 0.0 : clamp01(1.0 - stddev(prepared.map((p) => p.direction)));

  // tier_factor from the best tier present among graded signals.
  const hasTier1 = prepared.some((p) => p.tier === 1);
  const hasTier2 = prepared.some((p) => p.tier === 2);
  const tierFactor = hasTier1 ? 1.0 : hasTier2 ? 0.7 : 0.5;

  // M2: staleness from the newest (smallest age) graded signal.
  const newestAge = Math.min(...prepared.map((p) => p.ageMonths));
  const isStale = newestAge > STALE_MONTHS;
  const stalenessCap = isStale ? STALE_PENALTY : 1.0;

  const blended = roundToBand(
    STRENGTH_W_COUNT * countFactor +
      STRENGTH_W_CONCORDANCE * concordance +
      STRENGTH_W_TIER * tierFactor,
  );
  const strength = clamp01(stalenessCap * blended);

  return {
    position_strength: round3(strength),
    signal_count: distinctOutlets,
    signal_concordance: round3(concordance),
    may_be_outdated: isStale,
  };
}

// ===========================================================================
// fuseAxis: the one call the resolver makes per axis
// ===========================================================================

/**
 * fuseAxis: fuse a full per-signal set for one (candidate, issue, axis, view)
 * cell into a single FusedAxisResult, combining `fuseDirection` and
 * `positionStrength`.
 *
 * position_kind handling (C1):
 *   - If there are graded/balanced signals, the fused direction is a number and
 *     position_kind is 'graded' (or 'balanced' if every contributing signal was
 *     'balanced' and the fused direction sits inside the neutral dead-band).
 *   - If there are NO graded/balanced signals but there WERE abstains_governing
 *     signals, direction is null and position_kind is 'abstains_governing' (the
 *     profile can display the nuance; the caller writes no scored row).
 *   - If there were no signals of any kind, direction is null and position_kind
 *     defaults to 'graded' with a null score (caller drops the axis).
 *
 * The caller's rule: if `direction === null`, write NO positions row (the engine
 * drops the axis). Otherwise write a row with score = direction.
 */
export function fuseAxis(signals: PerSignalRecord[], nowIso: string): FusedAxisResult {
  const direction = fuseDirection(signals, nowIso);
  const strength = positionStrength(signals, nowIso);

  if (direction === null) {
    // No graded/balanced signals fused. Distinguish abstention from pure absence
    // for display, even though both drop from matching.
    const hadAbstention = signals.some((s) => s.position_kind === 'abstains_governing');
    return {
      direction: null,
      band: null,
      position_kind: hadAbstention ? 'abstains_governing' : 'graded',
      position_strength: strength.position_strength,
      signal_count: strength.signal_count,
      signal_concordance: strength.signal_concordance,
      may_be_outdated: strength.may_be_outdated,
    };
  }

  // A fused direction inside the neutral dead-band built ONLY from balanced
  // signals is reported as 'balanced'; anything else is 'graded'.
  const onlyBalanced =
    signals.length > 0 &&
    signals
      .filter((s) => s.position_kind !== 'abstains_governing' && s.direction !== null)
      .every((s) => s.position_kind === 'balanced');
  const inDeadBand = Math.abs(direction - 0.5) <= BAND_CUTOFFS.NEUTRAL_DEADBAND;
  const kind: PositionKind = onlyBalanced && inDeadBand ? 'balanced' : 'graded';

  return {
    direction,
    band: bandFor(direction),
    position_kind: kind,
    position_strength: strength.position_strength,
    signal_count: strength.signal_count,
    signal_concordance: strength.signal_concordance,
    may_be_outdated: strength.may_be_outdated,
  };
}
