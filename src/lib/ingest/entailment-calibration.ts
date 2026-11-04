/**
 * entailment-calibration.ts -- the G1 calibration layer for the entailment gate.
 *
 * WHAT THIS IS
 * ----------------------------------------------------------------------------
 * The entailment gate (entailment-gate.ts) turns a backend's 0..1 support score
 * into a routing decision. Historically that used HAND-TUNED constants
 * (ENTAILMENT_SUPPORTED_MIN / ENTAILMENT_NOTSUP_MAX defaults 0.60 / 0.40). This
 * module replaces those constants with thresholds LEARNED from the human-labeled
 * golden set, so the cut points are set by data, not by guesswork.
 *
 * It exposes:
 *   - The pure calibration MATH (Wilson bounds, label normalization, label merge
 *     with human-overrides-agent precedence, split-conformal threshold search).
 *     All deterministic and unit-tested with fixtures.
 *   - loadCalibration(): read the committed entailment-calibration.json so the gate
 *     can consume it. Absent/invalid file -> null (the gate falls back to the
 *     hand-tuned defaults, preserving backward compatibility).
 *
 * THREE-WAY ROUTING (V2-VISION "Data-quality rule")
 * ----------------------------------------------------------------------------
 *   voter_visible     (score >= upper)  -- auto-publishable; the calibration
 *                                          TARGETS >=95% of these being human
 *                                          "clearly supports".
 *   candidate_confirm (lower <= s < up) -- goes to the candidate-confirmation
 *                                          queue, not shown as verified.
 *   abstain           (score < lower)   -- withheld (clearly not supporting).
 *
 * Two independent split-conformal guarantees set the two thresholds:
 *   upper: the LOWEST cut whose Wilson lower bound on voter-visible precision
 *          (fraction that are "clear") clears the precision target -> max coverage
 *          subject to the precision floor.
 *   lower: the HIGHEST cut whose Wilson upper bound on the share of "clear" pairs
 *          sent to abstain stays under the allowed clear-loss -> we do not throw
 *          away true supports.
 *
 * Conservative by construction on small N: the Wilson bounds widen as N shrinks,
 * so a thin golden set yields a narrow voter-visible band and a wide middle band
 * (abstain-not-guess). That is the correct low-N posture, not a bug.
 *
 * No em-dashes / en-dashes; acronyms spelled out on first use.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ===========================================================================
// Canonical label tiers + routing bands
// ===========================================================================

/**
 * The canonical three-tier label the calibration reasons over. The golden set
 * may be labeled with either the current 3-way vocabulary
 * (supported / not_supported / unclear) or the future 4-band ordinal vocabulary
 * (clearly supports / partially or ambiguously supports / unrelated / contradicts,
 * per V2-VISION). normalizeLabel() maps BOTH onto these three tiers.
 */
export type LabelTier = 'clear' | 'partial' | 'reject';

/** The three-way routing band the gate emits when a calibration is loaded. */
export type RoutingBand = 'voter_visible' | 'candidate_confirm' | 'abstain';

/** Ordinal used for deterministic conservative tie-breaking (higher = safer). */
const TIER_ORDINAL: Record<LabelTier, number> = { clear: 0, partial: 1, reject: 2 };

/**
 * normalizeLabel(raw): map any label string (3-way or 4-band vocab, any case,
 * spaces or underscores) to a canonical LabelTier, or null if unrecognized /
 * blank. Reject patterns are tested FIRST so "not supported" is not mis-read as
 * "supported"; partial before clear so "partially supports" is partial, not clear.
 */
export function normalizeLabel(raw: unknown): LabelTier | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!s) return null;
  if (/(not supported|unsupported|not support|unrelated|off topic|contradict|contradicts|contradiction|reject)/.test(s)) {
    return 'reject';
  }
  if (/(partial|partially|ambiguous|ambiguously|unclear|mixed|uncertain|candidate confirm)/.test(s)) {
    return 'partial';
  }
  if (/(clearly supports|clearly support|clearly|clear support|clear|supported|supports|support|voter visible|entail)/.test(s)) {
    return 'clear';
  }
  return null;
}

/** Map a routing band's source tier: which human tier populates which band. */
export function tierToBand(tier: LabelTier): RoutingBand {
  if (tier === 'clear') return 'voter_visible';
  if (tier === 'partial') return 'candidate_confirm';
  return 'abstain';
}

// ===========================================================================
// Golden-set row exclusion: "cannot verify from source" (skip) rows
// ===========================================================================
//
// The labeling tool has a fifth action, "cannot verify from source" (keyboard
// 5): the reviewer could not confirm the quote against the source (dead link,
// unscrubable video, paywall, source mismatch). These rows are stored in the
// same labels-*.jsonl with `band: null` and a `skip_reason`. They are NOT
// evidence about whether the model's support score is right, so they MUST be
// EXCLUDED from calibration entirely (including them would poison the label
// counts and the threshold search). The two helpers below are the single point
// that decides "does this golden row contribute a usable label?" and are used
// by g1-calibrate-entailment.ts when it loads labels.

/** The shape of one golden-label row on disk (band vocabulary or legacy label). */
export interface GoldenLabelRow {
  band?: number | null;
  band_label?: string | null;
  label?: unknown;
  skip_reason?: string | null;
  [k: string]: unknown;
}

/**
 * isSkipLabel(row): true when the row is a "cannot verify from source" skip and
 * must be excluded from calibration. A row is a skip when it carries a
 * non-empty `skip_reason`, or when it explicitly sets `band: null` with no
 * usable label string. Ordinary band labels (band 1..4 / band_label / legacy
 * `label`) are NOT skips.
 */
export function isSkipLabel(row: GoldenLabelRow | null | undefined): boolean {
  if (row == null) return false;
  if (row.skip_reason != null && String(row.skip_reason).trim() !== '') return true;
  if ('band' in row && (row.band === null || row.band === undefined)) {
    const hasLabelStr =
      (row.band_label != null && String(row.band_label).trim() !== '') ||
      (row.label != null && String(row.label).trim() !== '');
    if (!hasLabelStr) return true;
  }
  return false;
}

/**
 * calibrationLabelOf(row): the label string this golden row contributes to
 * calibration, or null if it contributes none. Skip rows return null (excluded).
 * Otherwise prefer the 4-band `band_label`, falling back to the legacy `label`.
 * Callers feed the result to normalizeLabel() (which also returns null for any
 * unrecognized string), so a null here is a clean, uniform "drop this row".
 */
export function calibrationLabelOf(row: GoldenLabelRow | null | undefined): string | null {
  if (row == null || isSkipLabel(row)) return null;
  const s = row.band_label ?? row.label;
  if (s == null) return null;
  const str = String(s).trim();
  return str === '' ? null : str;
}

// ===========================================================================
// Label merge (human overrides agent; majority within a provenance class)
// ===========================================================================

export type LabelProvenance = 'human' | 'agent';

/** One raw label record fed to the merge (from any labels-*.jsonl file). */
export interface RawLabelRecord {
  /** Stable pair key (signal_id, or signal_id + claim for multi-claim pairs). */
  key: string;
  /** The label string as written by the labeler (any supported vocabulary). */
  label: unknown;
  /** Whether this label came from a human labeler or an agent draft. */
  provenance: LabelProvenance;
}

/** The merged label for one pair, plus how it was decided (for the report). */
export interface MergedLabel {
  key: string;
  tier: LabelTier;
  provenance: LabelProvenance;
  /** Number of labels that voted for the winning tier / total in its class. */
  agreement: { winning: number; total: number };
}

/**
 * mergeLabels(records): collapse many label records per pair to ONE merged tier.
 *
 * Precedence (V2-VISION): HUMAN labels override AGENT labels entirely. Within the
 * winning provenance class, the tier is the MAJORITY vote; ties break toward the
 * MORE CONSERVATIVE tier (higher ordinal: reject > partial > clear), because on a
 * trust-first voter product an unresolved tie should never earn voter-visibility.
 * Unrecognized label strings are dropped before voting.
 *
 * Deterministic: tie-breaks by ordinal, then the merge is order-independent.
 */
export function mergeLabels(records: RawLabelRecord[]): Map<string, MergedLabel> {
  const byKey = new Map<string, RawLabelRecord[]>();
  for (const r of records) {
    if (!r || !r.key) continue;
    const arr = byKey.get(r.key) ?? [];
    arr.push(r);
    byKey.set(r.key, arr);
  }
  const out = new Map<string, MergedLabel>();
  for (const [key, arr] of byKey) {
    const human = arr.filter((r) => r.provenance === 'human');
    const agent = arr.filter((r) => r.provenance === 'agent');
    const winningClass = human.length > 0 ? human : agent;
    const provenance: LabelProvenance = human.length > 0 ? 'human' : 'agent';
    const tiers = winningClass
      .map((r) => normalizeLabel(r.label))
      .filter((t): t is LabelTier => t !== null);
    if (tiers.length === 0) continue;
    // Count votes per tier.
    const counts = new Map<LabelTier, number>();
    for (const t of tiers) counts.set(t, (counts.get(t) ?? 0) + 1);
    // Winner: highest count; tie -> most conservative (max ordinal).
    let winner: LabelTier = tiers[0];
    let best = -1;
    for (const [tier, c] of counts) {
      if (c > best || (c === best && TIER_ORDINAL[tier] > TIER_ORDINAL[winner])) {
        winner = tier;
        best = c;
      }
    }
    out.set(key, {
      key,
      tier: winner,
      provenance,
      agreement: { winning: counts.get(winner) ?? 0, total: tiers.length },
    });
  }
  return out;
}

// ===========================================================================
// Committee-consensus calibration assembly (two independent agent annotators
// + human adjudication)
// ===========================================================================
//
// V2 methodology: the golden set is labeled by TWO INDEPENDENT agent passes
// (agent-proposal + agent-skeptic). g1-compute-consensus.ts joins them per pair
// into a tier:
//   consensus     -- the two agent bands EXACTLY match (adjacent counts as
//                    DISPUTED, not consensus).
//   disputed      -- any mismatch (adjacent or far).
//   incomparable  -- at least one annotator skipped ("cannot verify").
// The operator (human) adjudicates a queue of ALL disputed pairs plus a stratified 10%
// audit sample of consensus pairs.
//
// CALIBRATION-GRADE label (what the threshold search is allowed to trust):
//   1. HUMAN (david-f) labels win, always, for any pair (highest precedence).
//   2. the CONSENSUS band for a consensus pair that carries NO human label
//      (i.e. it was not overturned in the audit; an overturned audit pair has a
//      human label, which wins via rule 1).
// Disputed pairs with no human adjudication, and incomparable pairs, are NOT
// calibration-grade: we do not calibrate on unresolved disagreement.

/** The 4-band ordinal -> canonical LabelTier (matches normalizeLabel: 3+4 -> reject). */
export function bandToTier(band: number | null | undefined): LabelTier | null {
  if (band === 1) return 'clear'; // clearly_supports
  if (band === 2) return 'partial'; // partially_supports
  if (band === 3 || band === 4) return 'reject'; // unrelated / contradicts
  return null;
}

/** One pair row from consensus-2026-07.json (the subset this module needs). */
export interface ConsensusPairRecord {
  pair_id: string;
  proposal_band: number | null;
  skeptic_band: number | null;
  agreement: boolean | null;
  tier: 'consensus' | 'disputed' | 'incomparable';
  in_adjudication_queue: boolean;
  adjudication_reason: 'disputed' | 'audit' | null;
}

/** One calibration-grade label + its provenance (human beats consensus). */
export interface CalibrationGradeLabel {
  key: string;
  band: number;
  tier: LabelTier;
  provenance: 'human' | 'consensus';
}

/**
 * assembleCalibrationGrade(consensus, humanBands): build the calibration-grade
 * label set. `humanBands` maps pair_id -> human band (1..4) from labels-david-f
 * (skip rows excluded by the caller). Human labels win; otherwise a consensus
 * pair contributes its agreed band. Disputed-without-human and incomparable
 * pairs contribute nothing. Deterministic and pure.
 */
export function assembleCalibrationGrade(
  consensus: ConsensusPairRecord[],
  humanBands: Map<string, number>,
): Map<string, CalibrationGradeLabel> {
  const out = new Map<string, CalibrationGradeLabel>();
  for (const rec of consensus) {
    const human = humanBands.get(rec.pair_id);
    if (human != null) {
      const tier = bandToTier(human);
      if (tier) out.set(rec.pair_id, { key: rec.pair_id, band: human, tier, provenance: 'human' });
      continue;
    }
    if (rec.tier === 'consensus' && rec.proposal_band != null) {
      const tier = bandToTier(rec.proposal_band);
      if (tier) out.set(rec.pair_id, { key: rec.pair_id, band: rec.proposal_band, tier, provenance: 'consensus' });
    }
  }
  // Defensive: a human label for a pair absent from the consensus list still lands.
  for (const [key, band] of humanBands) {
    if (out.has(key)) continue;
    const tier = bandToTier(band);
    if (tier) out.set(key, { key, band, tier, provenance: 'human' });
  }
  return out;
}

/** Audit-sample human-vs-consensus agreement (the calibration trust gate). */
export interface AuditAgreement {
  /** audit-sample pairs a human has adjudicated. */
  audited: number;
  /** ... whose human band matches the consensus band. */
  agreed: number;
  /** agreed / audited (0 when nothing audited yet). */
  rate: number;
}

/**
 * auditAgreement(consensus, humanBands): over the AUDIT-sample pairs
 * (adjudication_reason === 'audit') that a human has adjudicated, the fraction
 * whose human band exactly matches the consensus band. Audit pairs are consensus
 * pairs, so proposal_band === skeptic_band === the consensus band.
 */
export function auditAgreement(
  consensus: ConsensusPairRecord[],
  humanBands: Map<string, number>,
): AuditAgreement {
  let audited = 0;
  let agreed = 0;
  for (const rec of consensus) {
    if (rec.adjudication_reason !== 'audit') continue;
    const human = humanBands.get(rec.pair_id);
    if (human == null) continue;
    audited++;
    if (rec.proposal_band != null && human === rec.proposal_band) agreed++;
  }
  return { audited, agreed, rate: audited > 0 ? agreed / audited : 0 };
}

/** Disputed-pair adjudication coverage (every disputed pair must get a human call). */
export interface DisputedCoverage {
  disputed: number;
  adjudicated: number;
  allAdjudicated: boolean;
}

/** disputedCoverage(consensus, humanBands): how many disputed pairs a human has resolved. */
export function disputedCoverage(
  consensus: ConsensusPairRecord[],
  humanBands: Map<string, number>,
): DisputedCoverage {
  let disputed = 0;
  let adjudicated = 0;
  for (const rec of consensus) {
    if (rec.tier !== 'disputed') continue;
    disputed++;
    if (humanBands.has(rec.pair_id)) adjudicated++;
  }
  return { disputed, adjudicated, allAdjudicated: disputed === 0 ? true : adjudicated === disputed };
}

/** Tunable floors for the committee-consensus READY gate. */
export interface CommitteeTargets {
  /** Minimum audit-sample human-vs-consensus agreement (default 0.90). */
  auditAgreementFloor: number;
  /** Minimum count of calibration-grade labels (default 500). */
  calibrationGradeFloor: number;
}

export const DEFAULT_COMMITTEE_TARGETS: CommitteeTargets = {
  auditAgreementFloor: 0.9,
  calibrationGradeFloor: 500,
};

/** The three READY conditions for the committee-consensus calibration, plus detail. */
export interface CommitteeReadiness {
  allDisputedAdjudicated: boolean;
  auditAgreementMet: boolean;
  calibrationGradeMet: boolean;
  ready: boolean;
  detail: {
    disputed: DisputedCoverage;
    audit: AuditAgreement;
    calibrationGradeTotal: number;
    humanCount: number;
    consensusCount: number;
    auditAgreementFloor: number;
    calibrationGradeFloor: number;
  };
}

/**
 * committeeReadiness(consensus, humanBands, targets): the flip gate for the
 * committee-consensus calibration. READY iff (1) every disputed pair is human-
 * adjudicated, AND (2) audit-sample human-vs-consensus agreement >= floor
 * (0.90), AND (3) total calibration-grade labels >= floor (500). Pure.
 */
export function committeeReadiness(
  consensus: ConsensusPairRecord[],
  humanBands: Map<string, number>,
  targets: CommitteeTargets = DEFAULT_COMMITTEE_TARGETS,
): CommitteeReadiness {
  const disputed = disputedCoverage(consensus, humanBands);
  const audit = auditAgreement(consensus, humanBands);
  const grade = assembleCalibrationGrade(consensus, humanBands);
  let humanCount = 0;
  let consensusCount = 0;
  for (const g of grade.values()) {
    if (g.provenance === 'human') humanCount++;
    else consensusCount++;
  }
  const allDisputedAdjudicated = disputed.allAdjudicated;
  const auditAgreementMet = audit.audited > 0 && audit.rate >= targets.auditAgreementFloor;
  const calibrationGradeMet = grade.size >= targets.calibrationGradeFloor;
  return {
    allDisputedAdjudicated,
    auditAgreementMet,
    calibrationGradeMet,
    ready: allDisputedAdjudicated && auditAgreementMet && calibrationGradeMet,
    detail: {
      disputed,
      audit,
      calibrationGradeTotal: grade.size,
      humanCount,
      consensusCount,
      auditAgreementFloor: targets.auditAgreementFloor,
      calibrationGradeFloor: targets.calibrationGradeFloor,
    },
  };
}

// ===========================================================================
// Wilson score interval (finite-sample confidence bounds on a proportion)
// ===========================================================================

/** Two-sided z multiplier for a confidence level (default 0.95 -> 1.96). */
export function zForConfidence(confidence: number): number {
  // A small lookup covers the levels we use; fall back to 1.96.
  const table: Record<string, number> = {
    '0.80': 1.281552,
    '0.90': 1.644854,
    '0.95': 1.959964,
    '0.98': 2.326348,
    '0.99': 2.575829,
  };
  return table[confidence.toFixed(2)] ?? 1.959964;
}

/**
 * wilsonInterval(k, n, z): the Wilson score interval for a binomial proportion
 * k/n. Returns { lo, hi, p } clamped to [0,1]. For n = 0 returns { lo: 0, hi: 1 }.
 * Used for BOTH the threshold guarantees (lower bound on precision, upper bound on
 * clear-loss) and the reported confidence intervals.
 */
export function wilsonInterval(k: number, n: number, z = 1.959964): { lo: number; hi: number; p: number } {
  if (n <= 0) return { lo: 0, hi: 1, p: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    lo: Math.max(0, center - half),
    hi: Math.min(1, center + half),
    p,
  };
}

// ===========================================================================
// The calibration score scalar (what we threshold)
// ===========================================================================

/**
 * The scalar the thresholds operate on. 'entail' is the backend's supported-class
 * probability (EntailmentResult.score) and is the DEFAULT (it is what the gate
 * natively returns and thresholds, keeping the integration trivial). The others
 * use the full 3-way distribution when the backend provides it; they are recorded
 * for transparency but only chosen when a future calibration finds them clearly
 * better than 'entail' on a larger golden set.
 */
export type ScoreKind = 'entail' | 'support_mass' | 'support_margin' | 'entail_minus_contradict';

/** The minimal result shape the scalar needs (structurally an EntailmentResult). */
export interface ScoredResult {
  score: number;
  scores?: { entail: number; contradict: number; neutral: number } | null;
}

/**
 * calibScore(result, kind): compute the calibration scalar in 0..1. For kinds
 * that need the 3-way distribution, fall back to result.score when it is absent
 * (so a backend that only reports the entail probability still works).
 */
export function calibScore(result: ScoredResult, kind: ScoreKind = 'entail'): number {
  const s = result.scores;
  const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
  if (kind === 'entail' || !s) return clamp01(result.score);
  if (kind === 'support_mass') return clamp01(s.entail + 0.5 * s.neutral);
  if (kind === 'support_margin') return clamp01(s.entail + 0.5 * s.neutral - s.contradict);
  // entail_minus_contradict, mapped from [-1,1] to [0,1].
  return clamp01((s.entail - s.contradict + 1) / 2);
}

// ===========================================================================
// Threshold search (split-conformal)
// ===========================================================================

export interface CalibrationTargets {
  /** Target precision for the voter-visible band (fraction that are "clear"). */
  voterVisiblePrecision: number;
  /** Confidence level for the Wilson bounds (e.g. 0.95). */
  confidence: number;
  /** Allowed share of "clear" pairs routed to abstain (clear-loss ceiling). */
  abstainClearLoss: number;
}

export const DEFAULT_TARGETS: CalibrationTargets = {
  voterVisiblePrecision: 0.95,
  confidence: 0.95,
  abstainClearLoss: 0.05,
};

/** One (score, tier) observation the search runs over. */
export interface ScoredLabel {
  score: number;
  tier: LabelTier;
}

export interface BandStats {
  n: number;
  clear: number;
  partial: number;
  reject: number;
  /** Precision of the "clear" class in this band (clear / n). */
  precision: number;
  precisionCi: { lo: number; hi: number };
  /** Coverage: n / total. */
  coverage: number;
}

export interface ThresholdResult {
  thresholds: { upper: number; lower: number };
  meetsUpperTarget: boolean;
  meetsLowerTarget: boolean;
  bands: { voter_visible: BandStats; candidate_confirm: BandStats; abstain: BandStats };
  total: number;
}

function bandStats(rows: ScoredLabel[], all: number, z: number): BandStats {
  const clear = rows.filter((r) => r.tier === 'clear').length;
  const partial = rows.filter((r) => r.tier === 'partial').length;
  const reject = rows.filter((r) => r.tier === 'reject').length;
  const n = rows.length;
  const ci = wilsonInterval(clear, n, z);
  return {
    n,
    clear,
    partial,
    reject,
    precision: n > 0 ? clear / n : 0,
    precisionCi: { lo: ci.lo, hi: ci.hi },
    coverage: all > 0 ? n / all : 0,
  };
}

/**
 * computeThresholds(data, targets): the split-conformal search described in the
 * file header. Pure and deterministic.
 *
 *   upper = lowest cut c where wilsonLower(precision of {score >= c}) >= target.
 *           If none qualifies, the cut with the highest lower bound is used and
 *           meetsUpperTarget=false (the flip gate then reports "not ready").
 *   lower = highest cut c where wilsonUpper(clear-share of {score < c}) <= loss.
 *           If none qualifies, lower collapses below the minimum score (empty
 *           abstain band) and meetsLowerTarget=false.
 *
 * lower is clamped to <= upper so the three bands never overlap.
 */
export function computeThresholds(
  data: ScoredLabel[],
  targets: CalibrationTargets = DEFAULT_TARGETS,
): ThresholdResult {
  const z = zForConfidence(targets.confidence);
  const total = data.length;
  // Candidate cut points: every observed score, plus a sentinel just above the
  // max so an "empty voter-visible band" is representable.
  const scores = [...new Set(data.map((d) => d.score))].sort((a, b) => a - b);
  const maxScore = scores.length ? scores[scores.length - 1] : 1;
  const minScore = scores.length ? scores[0] : 0;

  // ---- UPPER: precision-guaranteed voter-visible cut -----------------------
  let upper = maxScore + 1e-9; // default: empty voter-visible band
  let meetsUpperTarget = false;
  let bestLo = -1;
  let bestLoCut = maxScore + 1e-9;
  for (const c of scores) {
    const region = data.filter((d) => d.score >= c);
    const k = region.filter((d) => d.tier === 'clear').length;
    const lo = wilsonInterval(k, region.length, z).lo;
    if (lo > bestLo) {
      bestLo = lo;
      bestLoCut = c;
    }
    if (lo >= targets.voterVisiblePrecision) {
      upper = c; // ascending scan -> first qualifier is the lowest cut (max coverage)
      meetsUpperTarget = true;
      break;
    }
  }
  if (!meetsUpperTarget) upper = bestLoCut; // best-available cut, target not met

  // ---- LOWER: clear-loss-bounded abstain cut -------------------------------
  let lower = minScore - 1e-9; // default: empty abstain band
  let meetsLowerTarget = false;
  for (let i = scores.length - 1; i >= 0; i--) {
    const c = scores[i];
    const region = data.filter((d) => d.score < c);
    if (region.length === 0) continue;
    const k = region.filter((d) => d.tier === 'clear').length;
    const hi = wilsonInterval(k, region.length, z).hi;
    if (hi <= targets.abstainClearLoss) {
      lower = c; // descending scan -> first qualifier is the highest cut (max abstain)
      meetsLowerTarget = true;
      break;
    }
  }
  // Never let the abstain cut exceed the voter-visible cut.
  if (lower > upper) lower = upper;

  const vv = data.filter((d) => d.score >= upper);
  const ab = data.filter((d) => d.score < lower);
  const cc = data.filter((d) => d.score >= lower && d.score < upper);

  return {
    thresholds: { upper, lower },
    meetsUpperTarget,
    meetsLowerTarget,
    total,
    bands: {
      voter_visible: bandStats(vv, total, z),
      candidate_confirm: bandStats(cc, total, z),
      abstain: bandStats(ab, total, z),
    },
  };
}

/**
 * scoreToBand(score, thresholds): the routing used by the gate at inference time.
 * Identical banding to computeThresholds so calibration and enforcement agree.
 */
export function scoreToBand(score: number, thresholds: { upper: number; lower: number }): RoutingBand {
  if (score >= thresholds.upper) return 'voter_visible';
  if (score < thresholds.lower) return 'abstain';
  return 'candidate_confirm';
}

/** Area under the ROC curve for separating "clear" from the rest (Mann-Whitney). */
export function aucClearVsRest(data: ScoredLabel[]): number {
  const pos = data.filter((d) => d.tier === 'clear');
  const neg = data.filter((d) => d.tier !== 'clear');
  if (pos.length === 0 || neg.length === 0) return NaN;
  // Rank-sum with tie-averaged ranks.
  const sorted = [...data].sort((a, b) => a.score - b.score);
  let rankSum = 0;
  let i = 0;
  let rank = 1;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].score === sorted[i].score) j++;
    const avg = (rank + (rank + (j - i))) / 2;
    for (let k = i; k <= j; k++) if (sorted[k].tier === 'clear') rankSum += avg;
    rank += j - i + 1;
    i = j + 1;
  }
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

// ===========================================================================
// The on-disk calibration file + loader (what the gate consumes)
// ===========================================================================

export interface EntailmentCalibrationFile {
  version: number;
  calibrated_at: string;
  backend_model: string;
  score_kind: ScoreKind;
  thresholds: { upper: number; lower: number };
  targets: CalibrationTargets;
  achieved: unknown;
  label_counts: { clear: number; partial: number; reject: number; total: number; human: number; agent: number };
  low_n: boolean;
  meets_target: boolean;
  notes?: string;
}

/** Default calibration path: app/data/golden/entailment-calibration.json. */
export function defaultCalibrationPath(): string {
  // src/lib/ingest -> ../../../data/golden/entailment-calibration.json = app/data/golden.
  const url = new URL('../../../data/golden/entailment-calibration.json', import.meta.url);
  return fileURLToPath(url);
}

/** The minimal validated calibration the gate needs at inference time. */
export interface LoadedCalibration {
  thresholds: { upper: number; lower: number };
  score_kind: ScoreKind;
  backend_model: string;
  path: string;
}

const _calibCache = new Map<string, LoadedCalibration | null>();

/**
 * loadCalibration(path?): read + validate the calibration JSON. Precedence for
 * the path: explicit arg > ENTAILMENT_CALIBRATION_PATH env > default path. Returns
 * null (never throws) when the file is missing or malformed, so the gate falls
 * back to its hand-tuned defaults (backward compatible). Result cached by path;
 * clear with _resetCalibrationCache() in tests.
 */
export function loadCalibration(path?: string): LoadedCalibration | null {
  const p = path ?? process.env.ENTAILMENT_CALIBRATION_PATH ?? defaultCalibrationPath();
  if (_calibCache.has(p)) return _calibCache.get(p) ?? null;
  let loaded: LoadedCalibration | null = null;
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<EntailmentCalibrationFile>;
    const upper = Number(parsed?.thresholds?.upper);
    const lower = Number(parsed?.thresholds?.lower);
    if (
      Number.isFinite(upper) &&
      Number.isFinite(lower) &&
      upper >= 0 &&
      upper <= 1 &&
      lower >= 0 &&
      lower <= 1 &&
      lower <= upper
    ) {
      loaded = {
        thresholds: { upper, lower },
        score_kind: (parsed?.score_kind as ScoreKind) ?? 'entail',
        backend_model: String(parsed?.backend_model ?? 'unknown'),
        path: p,
      };
    }
  } catch {
    loaded = null; // missing / unreadable / malformed -> defaults
  }
  _calibCache.set(p, loaded);
  return loaded;
}

/** Clear the loadCalibration cache (tests / config reloads). */
export function _resetCalibrationCache(): void {
  _calibCache.clear();
}
