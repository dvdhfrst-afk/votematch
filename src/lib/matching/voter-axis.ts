/**
 * voter-axis.ts - the VOTER side of multivariable matching (doc 09 Part 4.1).
 *
 * The candidate side keys positions by a composite axis_uid (when the
 * MATCHING_MULTIVARIABLE flag is on); see selectPositionsForView in
 * algorithm.ts and v_axis_positions in the axis-registry migration. For a
 * voter's answers to OVERLAP a candidate's axes, the voter vector must use the
 * SAME axis_uid keys. This module builds that vector and exposes the askable
 * axis set per issue so a future UI can render one continuous slider per axis
 * (doc 07 section 2.8 prefers a continuous 0-1 slider over a 5-point Likert).
 *
 * No UI here. No database writes. buildVoterAxisVector is pure; getAxisQuestions
 * is a read-only query that delegates the active-axis resolution to
 * positioning/axis-set.ts (the single shared resolver).
 *
 * Acronyms, spelled out on first use: UID (unique identifier), UI (user
 * interface), DB (database).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PositionVector } from '@/lib/matching/algorithm';
import {
  computeAxisUid,
  resolveActiveAxisSet,
  type AxisKind,
} from '@/lib/positioning/axis-set';

/**
 * One voter answer on one axis. axis_kind + axis_id identify which axis of the
 * issue this score lands on; computeAxisUid turns the triple into the composite
 * key the matcher vectors on. confidence is optional metadata (a future UI may
 * let a voter mark an answer tentative); it is passed through unchanged.
 */
export interface VoterAxisAnswer {
  sub_dimension_id: string;
  axis_kind: AxisKind;
  axis_id: string | null;
  /** 0-1, equal-interval (doc 07 section 2.8). */
  score: number;
  confidence?: 'high' | 'medium' | 'low';
}

/**
 * Build the voter's axis-keyed PositionVector[] from their per-axis answers.
 * Each output row carries axis_uid = computeAxisUid(sub_dimension_id, axis_kind,
 * axis_id) and the score passed straight through. This array is what becomes
 * user.quick_match_answers.positions for a multivariable voter, so it overlaps
 * the candidate's axis_uid-keyed positions inside weightedL1Score (with the
 * MATCHING_MULTIVARIABLE flag on).
 *
 * Pure and synchronous: no DB, no flag read. The flag is consulted only in the
 * matcher; this just produces correctly-keyed rows that work on both paths
 * (the OFF path ignores axis_uid and keys on sub_dimension_id, which is also
 * carried here).
 */
export function buildVoterAxisVector(
  answers: VoterAxisAnswer[],
): PositionVector[] {
  return answers.map((a) => ({
    sub_dimension_id: a.sub_dimension_id,
    score: a.score,
    axis_uid: computeAxisUid(a.sub_dimension_id, a.axis_kind, a.axis_id),
    ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
  }));
}

/**
 * One askable axis for the voter UI: enough to render a continuous slider
 * (label + the two spectrum poles) and to key the resulting answer (axis_uid).
 */
export interface AxisQuestion {
  sub_dimension_id: string;
  axis_kind: AxisKind;
  axis_id: string | null;
  axis_uid: string;
  label: string;
  /** Slider pole at score 0.0. */
  spectrum_low: string;
  /** Slider pole at score 1.0. */
  spectrum_high: string;
}

/** getAxisQuestions return: the askable axes grouped per issue. */
export interface IssueAxisQuestions {
  sub_dimension_id: string;
  axes: AxisQuestion[];
}

/**
 * For each requested issue, return the list of askable axes (primary +
 * matching-mode backbone + active propositions), resolved via the shared
 * resolveActiveAxisSet. The voter UI iterates these to render one slider per
 * axis; the resulting answers feed buildVoterAxisVector.
 *
 * Read-only. Issues that resolve to no axes (not found / DB error) come back as
 * an empty `axes` array rather than being dropped, so the caller can tell the
 * difference between "asked and empty" and "never asked".
 */
export async function getAxisQuestions(
  sb: SupabaseClient,
  subDimensionIds: string[],
): Promise<IssueAxisQuestions[]> {
  const out: IssueAxisQuestions[] = [];
  // De-duplicate while preserving caller order.
  const seen = new Set<string>();
  for (const id of subDimensionIds) {
    if (seen.has(id)) continue;
    seen.add(id);

    const active = await resolveActiveAxisSet(sb, id);
    out.push({
      sub_dimension_id: id,
      axes: active.map((ax) => ({
        sub_dimension_id: ax.sub_dimension_id,
        axis_kind: ax.axis_kind,
        axis_id: ax.axis_id,
        axis_uid: ax.axis_uid,
        label: ax.label,
        spectrum_low: ax.spectrum_low,
        spectrum_high: ax.spectrum_high,
      })),
    });
  }
  return out;
}
