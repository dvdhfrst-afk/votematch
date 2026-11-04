import type { Domain, QuickMatchAnswers } from '@/types/database';

// ---------------------------------------------------------------------------
// All eight policy domains
// ---------------------------------------------------------------------------

const ALL_DOMAINS: Domain[] = [
  'economy',
  'social',
  'healthcare',
  'education',
  'environment',
  'governance',
  'public_safety',
  'infrastructure',
];

// ---------------------------------------------------------------------------
// Weight tiers for the 3 user-selected domains
// ---------------------------------------------------------------------------

const TOP_WEIGHT = 3.0;
const SECOND_WEIGHT = 2.0;
const THIRD_WEIGHT = 1.5;
const BASELINE_WEIGHT = 1.0; // non-selected domains still count

// ---------------------------------------------------------------------------
// deriveWeights
// ---------------------------------------------------------------------------
// Takes the user's QuickMatchAnswers (which includes 3 prioritized domains
// and 2 calibration position answers) and returns a normalized weight vector
// keyed by domain name that sums to 1.0.
//
// Weight assignment:
//   1st selected domain → 3.0 (raw)
//   2nd selected domain → 2.0
//   3rd selected domain → 1.5
//   All other domains   → 1.0
//
// The raw weights are then normalized so the full vector sums to 1.0.
// ---------------------------------------------------------------------------

export function deriveWeights(quickMatchAnswers: QuickMatchAnswers): Record<string, number> {
  const { domains } = quickMatchAnswers;

  // Build raw weight map
  const rawWeights: Record<string, number> = {};

  for (const d of ALL_DOMAINS) {
    rawWeights[d] = BASELINE_WEIGHT;
  }

  if (domains.length >= 1) rawWeights[domains[0]] = TOP_WEIGHT;
  if (domains.length >= 2) rawWeights[domains[1]] = SECOND_WEIGHT;
  if (domains.length >= 3) rawWeights[domains[2]] = THIRD_WEIGHT;

  // Normalize so weights sum to 1.0
  const sum = Object.values(rawWeights).reduce((a, b) => a + b, 0);
  const normalized: Record<string, number> = {};

  for (const [key, val] of Object.entries(rawWeights)) {
    normalized[key] = val / sum;
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// derivePositionsFromCalibration
// ---------------------------------------------------------------------------
// Extracts the position estimates that came from the 2 per-domain calibration
// questions.  These are already stored as { sub_dimension_id, score } in the
// QuickMatchAnswers.  This helper just passes them through in the shape the
// matching algorithm expects.
// ---------------------------------------------------------------------------

export function derivePositionsFromCalibration(
  quickMatchAnswers: QuickMatchAnswers,
): { sub_dimension_id: string; score: number }[] {
  return quickMatchAnswers.positions.map((p) => ({
    sub_dimension_id: p.sub_dimension_id,
    score: p.score,
  }));
}

// ---------------------------------------------------------------------------
// processWeights
// ---------------------------------------------------------------------------
// Convenience function that performs the full derivation: weights + positions.
// ---------------------------------------------------------------------------

export function processWeights(quickMatchAnswers: QuickMatchAnswers): {
  weights: Record<string, number>;
  positions: { sub_dimension_id: string; score: number }[];
} {
  return {
    weights: deriveWeights(quickMatchAnswers),
    positions: derivePositionsFromCalibration(quickMatchAnswers),
  };
}
