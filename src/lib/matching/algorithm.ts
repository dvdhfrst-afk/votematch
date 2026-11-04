/**
 * Havesay — matching algorithm.
 *
 * Implements **weighted L1 (Manhattan) distance** over the sub-dimensions
 * where both voter and candidate have stated positions.
 *
 * Why L1 (not L2/RMSE, not cosine): per blueprint-v6 §7 and
 * 08-research/matching-algorithms.md. L1 matches the field consensus
 * (Kieskompas, euandi, EU Profiler), has linear decomposability for
 * explanation purposes, and avoids the quadratic penalty on single-issue
 * dealbreakers that L2 embeds.
 *
 * Missing-data handling (blueprint-v6 §7.2): dimensions answered by only
 * one side are excluded from the distance calculation; we do NOT impute.
 * The exclusion is disclosed in the UI via `answered_both_count`.
 *
 * Sub-dimension weighting (blueprint-v6 §7.1): a user's salience weight
 * lives at the domain level; we redistribute it equally across the
 * sub-dimensions within that domain so bigger domains don't get hidden
 * extra weight.
 */
import type {
  CandidateWithPositions,
  Confidence,
  Domain,
  DomainAlignment,
  MatchExplanation,
  MatchPoint,
  MatchResult,
  MatchView,
  Position,
  Race,
  RaceDimsSource,
  SubDimension,
  User,
} from '@/types/database';
import { TIED_THRESHOLD_POINTS } from '@/types/database';
import { filterMatchingDims, raceLevelToScope } from '@/lib/taxonomy/scope';
import { respectOfficeDimsEnabled } from '@/lib/matching/office-dims';
import { computeAxisUid, type AxisKind } from '@/lib/positioning/axis-set';

// ---------------------------------------------------------------------------
// Feature flag: MATCHING_MULTIVARIABLE
// ---------------------------------------------------------------------------
// Gates the multivariable axis-vector scoring path (doc 09). When OFF (the
// default, including production), every code path below behaves byte-for-byte
// as it did before this flag existed: the engine keys on sub_dimension_id, the
// overlap floor counts dimensions, and the axis-weight overload is ignored.
//
// Flag policy mirrors office-dims.ts's MATCHING_RESPECT_OFFICE_DIMS but is
// stricter: this flag defaults OFF everywhere (prod AND dev), because it
// changes how live scores are computed. It must be turned on explicitly.
//   MATCHING_MULTIVARIABLE = 'true'  -> on
//   anything else (including unset)  -> off
// ---------------------------------------------------------------------------

export function multivariableMatchingEnabled(): boolean {
  return process.env.MATCHING_MULTIVARIABLE === 'true';
}

// ---------------------------------------------------------------------------
// Types local to this module
// ---------------------------------------------------------------------------

export interface PositionVector {
  sub_dimension_id: string;
  score: number; // 0-1
  /**
   * Multivariable (doc 09) axis key. When present and the MATCHING_MULTIVARIABLE
   * flag is ON, this is the key the engine vectors on instead of
   * sub_dimension_id. Composite form is '<sub_dim>:<axis_kind>:<axis_id>'
   * (see v_axis_positions.axis_uid in 12-positioning-engine doc 09 Part 4.1);
   * for a primary sub-dimension axis it may just be the sub_dimension_id.
   * Absent on every legacy/single-axis row, so the OFF path never sees it.
   */
  axis_uid?: string;
  // Council #63: the per-position confidence of the row(s) this vector was
  // built from. Used by computeConfidence to stop a match made of all-low-
  // confidence positions from displaying a "high" confidence badge.
  confidence?: 'high' | 'medium' | 'low' | string;
}

// ---------------------------------------------------------------------------
// Multivariable key helpers (doc 09 Parts 1.5, 4.1)
// ---------------------------------------------------------------------------
// keyOf  : the engine's vector key for a position. With the flag ON this is the
//          axis_uid when present (so the same issue can carry several axes);
//          otherwise the bare sub_dimension_id. The OFF path never calls keyOf
//          and always keys on sub_dimension_id directly, preserving today's math.
// issueOf: the distinct-ISSUE identity for an axis key. A composite axis_uid of
//          the form '<sub_dim>:<axis_kind>:<axis_id>' collapses to its
//          sub_dimension_id (the substring before the first ':'). A bare key
//          (no ':') is its own issue. This is what the overlap floor counts,
//          per the HARD requirement in doc 09 (red-team M1): the floor measures
//          breadth of issues, never depth of axes on one issue.
// ---------------------------------------------------------------------------

function keyOf(p: PositionVector): string {
  return p.axis_uid ?? p.sub_dimension_id;
}

function issueOf(key: string): string {
  const idx = key.indexOf(':');
  return idx === -1 ? key : key.slice(0, idx);
}

/**
 * Float-noise floor for axis weights (doc 09 Part 3.4, red-team M4). When a
 * composed axis-weight vector has several near-zero entries, summing them can
 * produce a tiny totalWeight that turns rounding noise into a "score". Treat a
 * total weight at or below this epsilon as effectively zero. Only consulted on
 * the multivariable path; the OFF path is untouched.
 */
const WEIGHT_EPSILON = 1e-9;

/**
 * Council finding #29: refuse to emit a numeric score when the answered-by-both
 * overlap is too small. With 1-2 dimensions the score swings 100→0 on a single
 * coincidence and the buried `confidence: 'low'` label fails to convey the
 * uncertainty. Below this threshold the algorithm returns `score: null` and
 * the UI renders an "insufficient overlap" message.
 */
export const MIN_OVERLAP_FOR_SCORE = 5;

interface PairScore {
  /**
   * 0-100, or null when answered_both_count < MIN_OVERLAP_FOR_SCORE.
   * Council #29: a single-dimension coincidence shouldn't drive a 100% score.
   */
  score: number | null;
  /**
   * 'insufficient_overlap' when score is null; otherwise the standard
   * coverage-on-top-domains assessment ('high' | 'medium' | 'low').
   */
  confidence: Confidence | 'insufficient_overlap';
  answered_both_count: number;
  applicable_count: number;
  /** Per-sub_dim contribution breakdown for explanation */
  perDim: {
    id: string;
    sub_dim: SubDimension;
    userScore: number;
    candidateScore: number;
    absDiff: number;
    weight: number;
    /** Contribution to the raw L1 distance: weight × absDiff */
    weightedContribution: number;
  }[];
}

// ---------------------------------------------------------------------------
// resolveSubDimensionWeights
// ---------------------------------------------------------------------------
// Spreads each domain's weight equally across the sub_dimensions within it.
// Addresses the blueprint-v6 correction: previously a domain with 4 sub-items
// got implicitly more weight than a domain with 3, because we weighted at the
// dim level using the domain weight directly.
// ---------------------------------------------------------------------------

function resolveSubDimensionWeights(
  domainWeights: Record<string, number>,
  subDimensions: SubDimension[],
): Map<string, number> {
  const byDomain = new Map<Domain, SubDimension[]>();
  for (const sd of subDimensions) {
    const arr = byDomain.get(sd.domain) ?? [];
    arr.push(sd);
    byDomain.set(sd.domain, arr);
  }

  const out = new Map<string, number>();
  for (const [domain, dims] of byDomain) {
    const w = domainWeights[domain] ?? 1;
    const perDim = dims.length > 0 ? w / dims.length : 0;
    for (const sd of dims) out.set(sd.id, perDim);
  }
  return out;
}

// ---------------------------------------------------------------------------
// weightedL1Score
// ---------------------------------------------------------------------------
// Per blueprint-v6 §7:
//
//   distance = Σ_{i ∈ A} w_i · |v_i − c_i|  /  Σ_{i ∈ A} w_i
//   score    = 100 · (1 − distance)
//
// Where A is the answered-by-both set.  Weights are sub-dimension-level
// (see resolveSubDimensionWeights above).  Returns 0 when no overlap exists.
// ---------------------------------------------------------------------------

export function weightedL1Score(
  userPositions: PositionVector[],
  candidatePositions: PositionVector[],
  domainWeights: Record<string, number>,
  subDimensions: SubDimension[],
  /**
   * Doc 09 Part 3.4: optional pre-composed per-axis weight map, keyed by the
   * same key the engine vectors on (axis_uid when the flag is ON, else
   * sub_dimension_id). The caller composes competence_mask (including the
   * `indirect` down-weight), jurisdiction_salience, and voter_salience and
   * passes the result here already normalized. This module does NOT load
   * salience/competence from the database; that is app-layer work.
   *
   * Only consulted when MATCHING_MULTIVARIABLE is ON. When omitted (or when the
   * flag is OFF), the engine falls back to resolveSubDimensionWeights exactly
   * as today, so the OFF arithmetic is byte-for-byte unchanged.
   */
  axisWeights?: Map<string, number>,
): PairScore {
  const multivariable = multivariableMatchingEnabled();

  const subDimMap = new Map<string, SubDimension>();
  for (const sd of subDimensions) subDimMap.set(sd.id, sd);

  // Key the engine vectors. OFF: bare sub_dimension_id (unchanged). ON:
  // keyOf(p) so a single issue can carry several axes (axis_uid widening).
  const keyFor = multivariable ? keyOf : (p: PositionVector) => p.sub_dimension_id;

  const userMap = new Map<string, number>();
  for (const p of userPositions) userMap.set(keyFor(p), p.score);

  const candidateMap = new Map<string, number>();
  for (const p of candidatePositions) candidateMap.set(keyFor(p), p.score);

  const subDimWeights = resolveSubDimensionWeights(domainWeights, subDimensions);

  // Applicable = keys the user answered whose issue (sub_dimension) exists in
  // subDimensions. ON path resolves each axis key back to its issue via
  // issueOf() so backbone/proposition axes inherit their issue's applicability;
  // OFF path checks the bare sub_dimension_id, exactly as before.
  const applicableIds = [...userMap.keys()].filter((key) =>
    subDimMap.has(multivariable ? issueOf(key) : key),
  );

  const perDim: PairScore['perDim'] = [];
  let weightedAbsSum = 0;
  let totalWeight = 0;
  let answeredBoth = 0;
  // Doc 09 red-team M1 (HARD): the overlap floor counts DISTINCT ISSUES, never
  // axes. A voter who answered one multivariable issue (several axes)
  // contributes ONE to the floor. Tracked as a set of issueOf(key) values over
  // the covered (answered-by-both) axes. On the OFF path each key IS its issue,
  // so this set's size equals answeredBoth and the gate is identical to before.
  const answeredIssues = new Set<string>();

  for (const id of applicableIds) {
    // The SubDimension context for this axis: its own issue on the ON path
    // (issueOf), or itself on the OFF path. Used for perDim + explanation.
    const issueId = multivariable ? issueOf(id) : id;
    const sd = subDimMap.get(issueId)!;
    // Weight source: the composed axisWeights map (ON path, when provided),
    // else today's resolveSubDimensionWeights keyed on the issue's sub_dim.
    const w =
      multivariable && axisWeights
        ? axisWeights.get(id) ?? 0
        : subDimWeights.get(issueId) ?? 0;
    const uScore = userMap.get(id)!;
    const cRaw = candidateMap.get(id);

    if (cRaw === undefined) continue; // candidate hasn't stated a position
    answeredBoth += 1;
    answeredIssues.add(issueId);

    const absDiff = Math.abs(uScore - cRaw);
    const contribution = w * absDiff;

    weightedAbsSum += contribution;
    totalWeight += w;

    perDim.push({
      id,
      sub_dim: sd,
      userScore: uScore,
      candidateScore: cRaw,
      absDiff,
      weight: w,
      weightedContribution: contribution,
    });
  }

  // Council #29 + doc 09 red-team M1: insufficient overlap -> emit null score,
  // not a misleading number. The overlap predicate is distinct-ISSUE count on
  // the ON path (answeredIssues.size) and answered-axis count on the OFF path
  // (answeredBoth); the two are equal off-flag, so OFF behavior is unchanged.
  const overlapCount = multivariable ? answeredIssues.size : answeredBoth;
  if (overlapCount < MIN_OVERLAP_FOR_SCORE) {
    return {
      score: null,
      confidence: 'insufficient_overlap',
      answered_both_count: answeredBoth,
      applicable_count: applicableIds.length,
      perDim,
    };
  }

  // Doc 09 red-team M4: normalization guards on the axis-weight path. A
  // degenerate weight vector (all surviving axes weight 0, or only float-noise
  // weight) must yield insufficient_overlap, never a divide-by-zero or a
  // noise-driven score. The OFF path never hits this branch because domain
  // weights default to 1 (totalWeight is always > 0 there), so its behavior is
  // preserved; the legacy totalWeight===0 -> score 0 fallback is kept for OFF.
  if (multivariable && totalWeight <= WEIGHT_EPSILON) {
    return {
      score: null,
      confidence: 'insufficient_overlap',
      answered_both_count: answeredBoth,
      applicable_count: applicableIds.length,
      perDim,
    };
  }

  const score =
    totalWeight === 0
      ? 0
      : Math.max(0, Math.min(100, Math.round((1 - weightedAbsSum / totalWeight) * 100)));

  return {
    score,
    // Real (non-insufficient) confidence is filled in by the caller, which
    // has the user's top domains. This placeholder keeps the type honest.
    confidence: 'low',
    answered_both_count: answeredBoth,
    applicable_count: applicableIds.length,
    perDim,
  };
}

// ---------------------------------------------------------------------------
// computeConfidence
// ---------------------------------------------------------------------------
// Coverage on the user's top-weighted domains. Display-only, never penalizes
// the score (blueprint-v6 rule preserved from v5).
// ---------------------------------------------------------------------------

export function computeConfidence(
  candidatePositions: PositionVector[],
  userTopDomains: Domain[],
  subDimensions: SubDimension[],
): Confidence {
  const topSubDimIds = subDimensions
    .filter((sd) => userTopDomains.includes(sd.domain))
    .map((sd) => sd.id);

  if (topSubDimIds.length === 0) return 'low';

  const candidateIds = new Set(candidatePositions.map((p) => p.sub_dimension_id));
  const covered = topSubDimIds.filter((id) => candidateIds.has(id)).length;
  const ratio = covered / topSubDimIds.length;

  let tier: Confidence;
  if (ratio >= 0.75) tier = 'high';
  else if (ratio >= 0.4) tier = 'medium';
  else tier = 'low';

  // Council #63 (2026-05-16, voter): coverage alone over-promises. With the
  // third research_outcome (identity_unverified_platform_found), many
  // candidates have positions that are ALL low-confidence — coverage is fine
  // but quality is not. A "high" badge on a match made of all-low scores tells
  // the voter to trust a guess. Downgrade the tier by per-position quality.
  // Downgrade-only — this can never inflate a badge.
  const topSubDimIdSet = new Set(topSubDimIds);
  const coveredLow = candidatePositions.filter(
    (p) => topSubDimIdSet.has(p.sub_dimension_id) && p.confidence === 'low',
  ).length;
  if (covered > 0) {
    const lowShare = coveredLow / covered;
    if (lowShare >= 0.75) return 'low';
    if (lowShare >= 0.5 && tier === 'high') return 'medium';
  }
  return tier;
}

// ---------------------------------------------------------------------------
// buildExplanation
// ---------------------------------------------------------------------------
// From the per-dimension contributions, surface top-N agreements, top-N
// disagreements, per-domain alignment breakdown, and disagreement hotspots
// (big single-issue divergences regardless of overall domain alignment).
// ---------------------------------------------------------------------------

function buildExplanation(
  pair: PairScore,
  topDomains: Domain[],
  subDimensions: SubDimension[],
  candidatePositions: PositionVector[],
): MatchExplanation {
  const toPoint = (d: PairScore['perDim'][number], isAgreement: boolean): MatchPoint => {
    const summary = isAgreement
      ? `You both align on ${d.sub_dim.name} (${d.sub_dim.spectrum_low} – ${d.sub_dim.spectrum_high})`
      : `You differ on ${d.sub_dim.name}: you lean toward "${
          d.userScore < 0.5 ? d.sub_dim.spectrum_low : d.sub_dim.spectrum_high
        }" while the candidate leans toward "${
          d.candidateScore < 0.5 ? d.sub_dim.spectrum_low : d.sub_dim.spectrum_high
        }"`;
    return {
      sub_dimension_id: d.id,
      sub_dimension_name: d.sub_dim.name,
      domain: d.sub_dim.domain,
      summary,
    };
  };

  // Top agreements: smallest absDiff first, tie-break by weight desc
  const forAgreements = [...pair.perDim].sort((a, b) => {
    if (a.absDiff !== b.absDiff) return a.absDiff - b.absDiff;
    return b.weight - a.weight;
  });
  const agreements = forAgreements.slice(0, 3).map((d) => toPoint(d, true));

  // Top disagreements: largest absDiff, tie-break by weight desc.
  // Filter out trivial diffs (< 0.1) per v5 behavior; keeps the list meaningful.
  const forDisagreements = [...pair.perDim]
    .filter((d) => d.absDiff > 0.1)
    .sort((a, b) => {
      if (a.absDiff !== b.absDiff) return b.absDiff - a.absDiff;
      return b.weight - a.weight;
    });
  const disagreements = forDisagreements.slice(0, 3).map((d) => toPoint(d, false));

  // Disagreement hotspots: per v6, sub-dimensions where |user − candidate| > 0.5
  const disagreement_hotspots = pair.perDim
    .filter((d) => d.absDiff > 0.5)
    .sort((a, b) => b.absDiff - a.absDiff)
    .map((d) => toPoint(d, false));

  // Per-domain alignment breakdown
  const byDomain = new Map<
    Domain,
    { absSum: number; weightSum: number; answered_both_count: number; total_count: number }
  >();
  for (const sd of subDimensions) {
    const bucket = byDomain.get(sd.domain) ?? {
      absSum: 0,
      weightSum: 0,
      answered_both_count: 0,
      total_count: 0,
    };
    bucket.total_count += 1;
    byDomain.set(sd.domain, bucket);
  }
  for (const d of pair.perDim) {
    const bucket = byDomain.get(d.sub_dim.domain);
    if (!bucket) continue;
    bucket.absSum += d.absDiff;
    bucket.weightSum += 1; // equal per-dim weighting within the domain breakdown
    bucket.answered_both_count += 1;
  }
  const per_domain: DomainAlignment[] = [];
  for (const [domain, b] of byDomain) {
    const alignment =
      b.weightSum === 0 ? 0 : Math.round((1 - b.absSum / b.weightSum) * 100);
    per_domain.push({
      domain,
      alignment: Math.max(0, Math.min(100, alignment)),
      answered_both_count: b.answered_both_count,
      total_count: b.total_count,
    });
  }
  per_domain.sort((a, b) => b.alignment - a.alignment);

  const confidence = computeConfidence(candidatePositions, topDomains, subDimensions);

  return {
    agreements,
    disagreements,
    confidence,
    per_domain,
    disagreement_hotspots,
  };
}

// ---------------------------------------------------------------------------
// computeMatchesForUser
// ---------------------------------------------------------------------------

/**
 * Decision 007 §4: pick candidate positions (one per sub_dim) according to the
 * user's `match_view` preference.
 *
 *   - 'stated'   → prefer stated row; fall back to inferred when stated is missing
 *   - 'inferred' → prefer inferred row; fall back to stated (current default)
 *   - 'both'     → average stated + inferred scores when BOTH exist for a sub_dim;
 *                  otherwise use whichever row exists
 *
 * Returns the per-sub_dim vector plus a flag indicating whether any sub_dim
 * actually used both-view averaging (so the caller can label the card
 * accurately when the user asked for 'both' but no overlap materialised).
 */
export function selectPositionsForView(
  candidatePositions: Position[],
  matchView: MatchView,
): { positions: PositionVector[]; anyBothUsed: boolean } {
  // Council #51 (2026-05-10, trust): exclude rows whose every citation has an
  // empty URL — the swarm-era placeholder pattern.
  candidatePositions = candidatePositions.filter(
    (p) => (p.source_citations ?? []).some((c) => !!c.url),
  );
  // Council #62 (2026-05-11, trust): exclude view_type='stated' rows whose
  // source_tier is NOT a candidate-own-source value. Stated view is meant to
  // surface positions FROM the candidate's own words/actions. A 'stated' row
  // tagged 'media_paraphrase_*' or 'ml_inferred_*' is a label mismatch: the
  // matching engine treats it as the candidate's own claim, but the source
  // isn't actually from them. Filter at scoring time so voters' match scores
  // don't get influenced by these mismatched rows. The detail page already
  // filters by confidence; this is the equivalent guard for source_tier.
  const STATED_OK_TIERS = new Set([
    'candidate_stated_current', 'candidate_stated_prior',
    'candidate_direct_response', 'candidate_action_voting_record',
    'voting_record_authoritative', 'voting_record_scraped',
    'social_media_verified',
  ]);
  candidatePositions = candidatePositions.filter((p) => {
    if (p.view_type !== 'stated') return true;
    const t = (p as { source_tier?: string | null }).source_tier;
    return t === null || t === undefined || STATED_OK_TIERS.has(t);
  });

  // Multivariable (doc 09) axis plumbing. The DB positions table carries
  // axis_kind ('sub_dimension'|'backbone'|'proposition') + axis_id (UUID|null)
  // via migration 20260615000000; loaders select '*', so legacy rows arrive as
  // axis_kind='sub_dimension'/axis_id=null. The global Position type predates
  // these columns, so we read them through a local additive type, exactly the
  // way the source_tier guard above reads its column.
  const multivariable = multivariableMatchingEnabled();
  const axisKindOf = (p: Position): AxisKind =>
    ((p as { axis_kind?: AxisKind | null }).axis_kind ?? 'sub_dimension');
  const axisIdOf = (p: Position): string | null =>
    ((p as { axis_id?: string | null }).axis_id ?? null);
  // The bucket key: ON groups by the FULL axis identity so one issue can carry
  // several axes; OFF groups by sub_dimension_id alone (unchanged from today).
  const bucketKeyOf = (p: Position): string =>
    multivariable
      ? `${p.sub_dimension_id}:${axisKindOf(p)}:${axisIdOf(p) ?? 'primary'}`
      : p.sub_dimension_id;

  // Bucket by axis (ON) or by sub_dim (OFF) → stated row + inferred row
  // (whichever latest each view). The bucket records the axis identity so the
  // emitted vector can carry the right axis_uid on the ON path.
  interface AxisBucket {
    sub_dimension_id: string;
    axis_kind: AxisKind;
    axis_id: string | null;
    stated?: Position;
    inferred?: Position;
  }
  const byDim = new Map<string, AxisBucket>();
  for (const p of candidatePositions) {
    const key = bucketKeyOf(p);
    const bucket: AxisBucket =
      byDim.get(key) ?? {
        sub_dimension_id: p.sub_dimension_id,
        axis_kind: axisKindOf(p),
        axis_id: axisIdOf(p),
      };
    if (p.view_type === 'stated') {
      // Keep most-recently-created when multiple stated rows exist.
      if (!bucket.stated || p.created_at > bucket.stated.created_at) {
        bucket.stated = p;
      }
    } else if (p.view_type === 'inferred') {
      if (!bucket.inferred || p.created_at > bucket.inferred.created_at) {
        bucket.inferred = p;
      }
    }
    byDim.set(key, bucket);
  }

  const out: PositionVector[] = [];
  let anyBothUsed = false;

  // Council #63 (2026-05-16, voter): pick the weaker of two confidences when
  // averaging stated+inferred. Rank: high > medium > low > no_data.
  const confRank: Record<string, number> = { high: 3, medium: 2, low: 1, no_data: 0 };
  const weakerConf = (a?: string | null, b?: string | null): string | undefined => {
    if (a == null) return b ?? undefined;
    if (b == null) return a ?? undefined;
    return (confRank[a] ?? 1) <= (confRank[b] ?? 1) ? a : b;
  };

  for (const bucket of byDim.values()) {
    const { sub_dimension_id, axis_kind, axis_id, stated, inferred } = bucket;
    let score: number | null = null;
    let confidence: string | undefined;

    if (matchView === 'stated') {
      score = stated?.score ?? inferred?.score ?? null;
      confidence = (stated ?? inferred)?.confidence ?? undefined;
    } else if (matchView === 'inferred') {
      score = inferred?.score ?? stated?.score ?? null;
      confidence = (inferred ?? stated)?.confidence ?? undefined;
    } else {
      // 'both': average when both exist; else whichever row exists.
      if (stated && inferred) {
        score = (stated.score + inferred.score) / 2;
        anyBothUsed = true;
        confidence = weakerConf(stated.confidence, inferred.confidence);
      } else {
        score = stated?.score ?? inferred?.score ?? null;
        confidence = (stated ?? inferred)?.confidence ?? undefined;
      }
    }

    if (score !== null) {
      if (multivariable) {
        // ON: emit the composite axis_uid so the engine vectors on the full
        // axis identity and one issue can carry several axes (doc 09 Part 4.1).
        out.push({
          sub_dimension_id,
          score,
          confidence,
          axis_uid: computeAxisUid(sub_dimension_id, axis_kind, axis_id),
        });
      } else {
        // OFF: byte-for-byte identical to the pre-flag emit (no axis_uid key).
        out.push({ sub_dimension_id, score, confidence });
      }
    }
  }

  return { positions: out, anyBothUsed };
}

/**
 * Resolve which view label to show the user on the result card for a given
 * candidate. Reflects what actually got used after fallbacks, not just what
 * the user asked for.
 */
function resolveMatchViewUsed(
  requested: MatchView,
  candidatePositions: Position[],
  anyBothUsed: boolean,
): MatchView {
  const hasStated = candidatePositions.some((p) => p.view_type === 'stated');
  const hasInferred = candidatePositions.some((p) => p.view_type === 'inferred');

  if (requested === 'both') {
    // If any sub_dim actually averaged both views, the label is 'both'.
    if (anyBothUsed) return 'both';
    // Otherwise fall back to whichever single view was available.
    if (hasStated && !hasInferred) return 'stated';
    if (hasInferred && !hasStated) return 'inferred';
    // Neither exists (or only overlap-less singletons of the same view) —
    // default label to 'inferred' (matches the type's default contract).
    return hasInferred ? 'inferred' : hasStated ? 'stated' : 'inferred';
  }

  if (requested === 'stated') {
    // Used stated if any stated row exists; otherwise fell back to inferred.
    if (hasStated) return 'stated';
    return 'inferred';
  }

  // requested === 'inferred' (default)
  if (hasInferred) return 'inferred';
  return hasStated ? 'stated' : 'inferred';
}

export function computeMatchesForUser(
  user: User,
  candidates: CandidateWithPositions[],
  subDimensions: SubDimension[],
  matchView?: MatchView | null,
  /**
   * Doc 09 Part 3.4: optional pre-composed per-axis weights, keyed by axis_uid,
   * resolved per race. Only consulted when MATCHING_MULTIVARIABLE is ON; passed
   * straight through to weightedL1Score. When omitted (or flag OFF), scoring
   * falls back to resolveSubDimensionWeights, i.e. today's behavior. The
   * app-layer caller is responsible for loading and composing competence,
   * jurisdiction salience, and voter salience into this map; this module does
   * not touch the database.
   */
  axisWeightsByRace?: Map<string, Map<string, number>> | null,
): MatchResult[] {
  const weights = user.weights ?? {};
  const userPositions: PositionVector[] = user.quick_match_answers?.positions ?? [];

  // Precedence: explicit arg > user.quick_match_answers.match_view >
  //             user.match_view (convenience) > 'inferred' (default).
  const effectiveMatchView: MatchView =
    matchView ??
    user.quick_match_answers?.match_view ??
    user.match_view ??
    'inferred';

  const topDomains = Object.entries(weights)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([d]) => d as Domain);

  // Group candidates by race_id
  const raceMap = new Map<string, { race: Race; candidates: CandidateWithPositions[] }>();
  for (const c of candidates) {
    if (!raceMap.has(c.race_id)) {
      raceMap.set(c.race_id, { race: c.race, candidates: [] });
    }
    raceMap.get(c.race_id)!.candidates.push(c);
  }

  const results: MatchResult[] = [];

  for (const [raceId, { race, candidates: raceCandidates }] of raceMap) {
    // Doc 09 Part 3.4: the pre-composed per-axis weight map for this race, if
    // the caller supplied one. Only used on the multivariable path; ignored by
    // weightedL1Score when MATCHING_MULTIVARIABLE is OFF.
    const axisWeights = axisWeightsByRace?.get(raceId) ?? undefined;

    // Scope filter: only dims marked 'matching' at this race's scope count
    // toward the match score. Informational dims stay visible on the profile
    // but are excluded here. See src/lib/taxonomy/scope.ts.
    let scopedSubDimensions = filterMatchingDims(subDimensions, raceLevelToScope(race.level));

    // Per-office relevance (feature-flag-gated by MATCHING_RESPECT_OFFICE_DIMS;
    // on in dev, off in prod by default). When set + non-empty, intersect with
    // the office's own relevant_dimensions so a school-board candidate isn't
    // scored on the same dim set as a US Senator.
    //
    // dims_source records HOW the scoring set was chosen so the UI/logs can tell
    // "scored on office-scoped dims" from "scored on the whole level":
    //   - 'office_scoped'  : we resolved + applied the office's own dims.
    //   - 'level_fallback' : relevance was unknown (NULL/empty office dims) or
    //                        the flag is off, so we kept the level-scope set.
    //
    // NULL-means-unknown, NOT NULL-means-everything: for a single-purpose office
    // (e.g. State Mine Inspector) with no relevant_dimensions set, scoring on the
    // full level set over-scores the race. We keep the level-scope fallback so we
    // never silently zero anyone's score, but we FLAG it as 'level_fallback' so
    // the gap is visible and the data fix (backfilling office_types) is driven.
    let dimsSource: RaceDimsSource = 'level_fallback';
    if (respectOfficeDimsEnabled()) {
      if (Array.isArray(race.relevant_dimensions) && race.relevant_dimensions.length > 0) {
        const officeDims = new Set(race.relevant_dimensions);
        const filtered = scopedSubDimensions.filter(
          (sd) => officeDims.has(sd.id) || officeDims.has(sd.name),
        );
        // Defensive: if the intersection comes out empty (e.g. office_types
        // has stale dim names), fall back to the scope filter rather than
        // produce a zero-dim score - and record it as a fallback, not a
        // successful office-scoped filter.
        if (filtered.length > 0) {
          scopedSubDimensions = filtered;
          dimsSource = 'office_scoped';
        }
      }
    }

    const scored = raceCandidates.map((candidate) => {
      // Two-view selection per decision 007 §4. Honors the user's match_view
      // preference: stated | inferred | both. See selectPositionsForView.
      const { positions: candidatePositions, anyBothUsed } =
        selectPositionsForView(candidate.positions, effectiveMatchView);

      const match_view_used = resolveMatchViewUsed(
        effectiveMatchView,
        candidate.positions,
        anyBothUsed,
      );

      const pair = weightedL1Score(
        userPositions,
        candidatePositions,
        weights,
        scopedSubDimensions,
        axisWeights,
      );

      const explanation = buildExplanation(
        pair,
        topDomains,
        subDimensions,
        candidatePositions,
      );

      // Persist `match_view_used` inside the explanation JSONB so it
      // survives the matches-table round-trip without a new column.
      explanation.match_view_used = match_view_used;

      // Council #29: when overlap < MIN_OVERLAP_FOR_SCORE, pair.score is null
      // and pair.confidence is 'insufficient_overlap'. We propagate both up so
      // the UI can render "Insufficient overlap (N of K dimensions)" instead
      // of a misleading numeric percentage. We also override the
      // explanation's confidence so the persisted matches row reflects the
      // insufficient-overlap state.
      if (pair.confidence === 'insufficient_overlap') {
        explanation.confidence = 'insufficient_overlap';
      }

      return {
        candidate,
        score: pair.score,
        answered_both_count: pair.answered_both_count,
        applicable_count: pair.applicable_count,
        explanation,
        confidence: explanation.confidence,
        match_view_used,
      };
    });

    // Sort by score descending, assign rank. Null scores (insufficient
    // overlap) sort to the bottom — they have no comparable signal.
    scored.sort((a, b) => {
      if (a.score === null && b.score === null) return 0;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score;
    });
    const topScore = scored[0]?.score ?? null;

    // `tied_with_top` flags candidates in a cluster of approximate equality
    // near the top. Semantically: there are ≥2 candidates within
    // TIED_THRESHOLD_POINTS of the top score, and this candidate is one of
    // them. If the top candidate is alone, it gets tied_with_top=false
    // (and the UI shows "Top Match" unambiguously).
    //
    // Council #29: candidates with null score (insufficient overlap) are
    // never in the tied cluster — they have no number to compare against.
    const inTopCluster =
      topScore === null
        ? []
        : scored.filter(
            (s) =>
              s.score !== null && topScore - s.score <= TIED_THRESHOLD_POINTS,
          );
    const clusterHasTie = inTopCluster.length > 1;

    const withRank = scored.map((s, idx) => ({
      candidate: s.candidate,
      score: s.score,
      rank: idx + 1,
      tied_with_top:
        topScore !== null
        && s.score !== null
        && clusterHasTie
        && topScore - s.score <= TIED_THRESHOLD_POINTS,
      answered_both_count: s.answered_both_count,
      applicable_count: s.applicable_count,
      explanation: s.explanation,
      confidence: s.confidence,
      match_view_used: s.match_view_used,
    }));

    results.push({ race, dims_source: dimsSource, candidates: withRank });
  }

  return results;
}
