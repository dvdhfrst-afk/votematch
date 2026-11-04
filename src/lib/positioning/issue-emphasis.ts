/**
 * issue-emphasis.ts - per-issue IMPORTANCE / EMPHASIS (doc 09 extension).
 * ============================================================================
 * The operator's requirement: separate from WHERE a person stands on an issue
 * (direction) and HOW forcefully a single statement is worded (intensity, doc
 * 07), we also need HOW MUCH THE WHOLE ISSUE MATTERS to that person.
 *
 *   - For a VOTER: self-declared. "Healthcare is my top issue; zoning I barely
 *     care about." This is the voter's personal per-issue weight.
 *   - For a CANDIDATE: inferred from engagement. A candidate who makes economic
 *     policy the headline of their campaign, returns to it constantly, and
 *     covers every facet has HIGH emphasis. A candidate with one offhand comment
 *     from years ago has LOW emphasis. Same direction, very different emphasis.
 *
 * Importance is NOT a directional axis. You cannot be "for" or "against" how
 * much an issue matters, so it must never enter the position vector that the
 * weighted L1 (Manhattan) distance runs over (that would corrupt direction
 * matching). It is a per-issue MAGNITUDE: a weight on the voter side, a
 * confidence/coverage/display signal on the candidate side.
 *
 * This module is pure (no database). The DB-bound derivation lives in
 * scripts/compute-candidate-emphasis.ts; the storage is the
 * candidate_issue_emphasis table.
 *
 * Acronyms, spelled out on first use: UID (unique identifier), DB (database).
 */

/** Engagement readout for a candidate on one issue (a categorical view of emphasis). */
export type EngagementLevel = 'headline' | 'platform' | 'mention' | 'incidental' | 'silent';

/**
 * Recency half-life: a signal this many days old contributes half the recency
 * weight of a brand-new one. One year is a reasonable default for a campaign
 * cycle; tune in one place.
 */
export const EMPHASIS_HALF_LIFE_DAYS = 365;

/**
 * Past this age (about 18 months) the most recent signal on an issue is flagged
 * may_be_stale, so the UI can say "based on a statement from 2024" rather than
 * implying a current priority.
 */
export const STALE_AFTER_DAYS = 540;

/** Signal volume at which the volume term is ~63% saturated (1 - 1/e). */
const VOLUME_SATURATION_K = 3;

/**
 * Blend weights for the three emphasis components. They sum to 1. Volume (how
 * often they engage) leads, then recency (are they still on it), then coverage
 * (do they address the whole issue or one corner of it).
 */
export const EMPHASIS_WEIGHTS = { volume: 0.45, recency: 0.3, coverage: 0.25 } as const;

export interface EmphasisInputs {
  /** Distinct engagement signals on this issue (statements, posts, votes, etc.). */
  signalCount: number;
  /**
   * Fraction of the issue's ACTIVE axes the candidate has actually addressed
   * (0..1). Addressing every facet reads as deeper engagement than one corner.
   */
  axisCoverage: number;
  /** Days since the most recent signal on this issue; null when there are none. */
  daysSinceLatest: number | null;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * computeIssueEmphasis -> 0..1.
 *   volume   = 1 - e^(-signalCount / K)        (saturating; one comment is low)
 *   recency  = 0.5 ^ (daysSinceLatest / HALF)  (an old-only record decays toward 0)
 *   coverage = axisCoverage                    (one facet vs the whole issue)
 *   emphasis = 0.45*volume + 0.30*recency + 0.25*coverage
 *
 * A single comment from years ago: signalCount 1, large daysSinceLatest, low
 * coverage -> low emphasis. A campaign headline: many recent signals, full
 * coverage -> high emphasis. No signals at all -> 0 (silent).
 */
export function computeIssueEmphasis(i: EmphasisInputs): number {
  if (i.signalCount <= 0) return 0;
  const volume = 1 - Math.exp(-i.signalCount / VOLUME_SATURATION_K);
  const recency =
    i.daysSinceLatest === null ? 0 : Math.pow(0.5, Math.max(0, i.daysSinceLatest) / EMPHASIS_HALF_LIFE_DAYS);
  const coverage = clamp01(i.axisCoverage);
  return clamp01(
    EMPHASIS_WEIGHTS.volume * volume +
      EMPHASIS_WEIGHTS.recency * recency +
      EMPHASIS_WEIGHTS.coverage * coverage,
  );
}

/** Bucket a candidate's emphasis into a readable engagement level. */
export function engagementLevel(emphasis: number, signalCount: number): EngagementLevel {
  if (signalCount <= 0 || emphasis <= 0.05) return 'silent';
  if (emphasis >= 0.75) return 'headline';
  if (emphasis >= 0.5) return 'platform';
  if (emphasis >= 0.25) return 'mention';
  return 'incidental';
}

/** Is the most recent signal old enough to caveat the displayed position? */
export function mayBeStale(daysSinceLatest: number | null): boolean {
  return daysSinceLatest !== null && daysSinceLatest > STALE_AFTER_DAYS;
}

// ---------------------------------------------------------------------------
// Voter side: per-issue importance -> per-axis voter salience.
// ---------------------------------------------------------------------------

/** Minimal axis shape needed to map an issue's importance onto its axes. */
export interface IssueAxis {
  sub_dimension_id: string;
  axis_uid: string;
}

/**
 * Convert a voter's self-declared per-ISSUE importance into the per-AXIS voter
 * salience map the weight composer consumes (every axis of an issue inherits
 * that issue's importance). This SUPERSEDES the domain-weight spread for the
 * issues the voter explicitly rated: the voter decides what matters, at issue
 * grain, not just domain grain. Issues the voter did not rate are left out, so
 * the existing domain-spread default still applies to them.
 *
 * @param importanceByIssue  sub_dimension_id -> importance (0..1), voter-declared.
 * @param axesByIssue        sub_dimension_id -> the issue's resolved axes.
 */
export function voterIssueImportanceToAxisSalience(
  importanceByIssue: Map<string, number>,
  axesByIssue: Map<string, IssueAxis[]>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [subDimId, importance] of importanceByIssue) {
    const axes = axesByIssue.get(subDimId);
    if (!axes) continue;
    const v = clamp01(importance);
    for (const ax of axes) out.set(ax.axis_uid, v);
  }
  return out;
}
