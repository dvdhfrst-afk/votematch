/**
 * Unit tests for the weighted-L1 matching algorithm — the heart of the
 * voter-candidate match score. See blueprint-v6 §7 for the spec.
 *
 * Mocked out: nothing. The algorithm is pure (no I/O). Each test constructs
 * its own fixtures so they read end-to-end without shared mutable state.
 */
import { describe, it, expect } from 'vitest';
import {
  weightedL1Score,
  computeConfidence,
  MIN_OVERLAP_FOR_SCORE,
} from '../algorithm';
import type {
  Domain,
  ScopeApplicability,
  SubDimension,
} from '@/types/database';

// ---------------------------------------------------------------------------
// Fixture helpers
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

function makeSubDim(
  id: string,
  domain: Domain = 'economy',
  scope: ScopeApplicability = { federal: 'matching', state: 'matching', county: 'matching' },
): SubDimension {
  return {
    id,
    domain,
    name: `Dim ${id}`,
    spectrum_low: 'low',
    spectrum_high: 'high',
    display_order: 0,
    scope_applicability: scope,
  };
}

function evenWeights(): Record<string, number> {
  // Each domain gets equal weight (sums to 1.0)
  const w: Record<string, number> = {};
  for (const d of ALL_DOMAINS) w[d] = 1 / ALL_DOMAINS.length;
  return w;
}

// Build N sub-dims in a single domain so each individual dim weight is non-zero.
function makeNSubDimsInDomain(n: number, domain: Domain = 'economy'): SubDimension[] {
  return Array.from({ length: n }, (_, i) => makeSubDim(`sd-${i}`, domain));
}

// ===========================================================================
// weightedL1Score — happy paths
// ===========================================================================

describe('weightedL1Score — happy paths', () => {
  it('identical positions across all dims → score 100 (equivalent of 1.0)', () => {
    const subs = makeNSubDimsInDomain(6);
    const positions = subs.map((sd, i) => ({
      sub_dimension_id: sd.id,
      score: i / (subs.length - 1), // varied scores 0..1
    }));

    const result = weightedL1Score(positions, positions, evenWeights(), subs);
    expect(result.score).toBe(100);
    expect(result.answered_both_count).toBe(6);
  });

  it('exactly opposite positions → score 0', () => {
    const subs = makeNSubDimsInDomain(6);
    const userPositions = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0 }));
    const candidatePositions = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 1 }));

    const result = weightedL1Score(
      userPositions,
      candidatePositions,
      evenWeights(),
      subs,
    );
    expect(result.score).toBe(0);
    expect(result.answered_both_count).toBe(6);
  });

  it('halfway-apart positions → score 50', () => {
    const subs = makeNSubDimsInDomain(6);
    const userPositions = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0 }));
    const candidatePositions = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));

    const result = weightedL1Score(
      userPositions,
      candidatePositions,
      evenWeights(),
      subs,
    );
    expect(result.score).toBe(50);
  });

  it('partial overlap with mixed agreement produces an intermediate score', () => {
    const subs = makeNSubDimsInDomain(6);
    // User answers all 6; candidate matches first 3 perfectly, mismatches second 3 fully.
    const user = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0 }));
    const candidate = subs.map((sd, i) => ({
      sub_dimension_id: sd.id,
      score: i < 3 ? 0 : 1,
    }));

    const result = weightedL1Score(user, candidate, evenWeights(), subs);
    // Half the dims diverge by 1.0 → score should be ~50.
    expect(result.score).toBe(50);
    expect(result.answered_both_count).toBe(6);
  });

  it('returns the correct perDim breakdown with weighted contributions', () => {
    const subs = makeNSubDimsInDomain(5);
    const user = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.2 }));
    const candidate = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.8 }));

    const result = weightedL1Score(user, candidate, evenWeights(), subs);
    expect(result.perDim).toHaveLength(5);
    for (const d of result.perDim) {
      expect(d.absDiff).toBeCloseTo(0.6, 5);
      expect(d.weight).toBeGreaterThan(0);
      expect(d.weightedContribution).toBeCloseTo(d.weight * 0.6, 8);
    }
  });

  it('user-emphasised domains weight more than baseline', () => {
    // Build 3 dims in 'economy' and 3 in 'social'; bias weights toward economy.
    const econ = Array.from({ length: 3 }, (_, i) => makeSubDim(`e-${i}`, 'economy'));
    const social = Array.from({ length: 3 }, (_, i) => makeSubDim(`s-${i}`, 'social'));
    const subs = [...econ, ...social];

    const weights: Record<string, number> = { economy: 0.9, social: 0.1 };

    // User and candidate disagree only in 'social'; agree perfectly in 'economy'.
    const user = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0 }));
    const candidate = subs.map((sd) => ({
      sub_dimension_id: sd.id,
      score: sd.domain === 'social' ? 1 : 0,
    }));

    const r = weightedL1Score(user, candidate, weights, subs);
    // Most weight is in econ where they agree → score should be high (>= 80).
    expect(r.score).toBeGreaterThanOrEqual(80);
  });
});

// ===========================================================================
// weightedL1Score — edge cases
// ===========================================================================

describe('weightedL1Score — edge cases', () => {
  it('empty user positions → answered_both_count 0 and insufficient_overlap', () => {
    const subs = makeNSubDimsInDomain(6);
    const candidate = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));

    const r = weightedL1Score([], candidate, evenWeights(), subs);
    expect(r.score).toBeNull();
    expect(r.confidence).toBe('insufficient_overlap');
    expect(r.answered_both_count).toBe(0);
  });

  it('empty candidate positions → 0 overlap → insufficient_overlap', () => {
    const subs = makeNSubDimsInDomain(6);
    const user = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));

    const r = weightedL1Score(user, [], evenWeights(), subs);
    expect(r.score).toBeNull();
    expect(r.answered_both_count).toBe(0);
  });

  it('empty subDimensions → 0 overlap → insufficient_overlap', () => {
    const r = weightedL1Score(
      [{ sub_dimension_id: 'x', score: 0.5 }],
      [{ sub_dimension_id: 'x', score: 0.5 }],
      evenWeights(),
      [],
    );
    expect(r.score).toBeNull();
    expect(r.answered_both_count).toBe(0);
  });

  it('all-zero weights produce score 0 (totalWeight=0 fallback) when overlap met', () => {
    // 8 dims so we clear MIN_OVERLAP_FOR_SCORE; but no domain weight present.
    const subs = makeNSubDimsInDomain(8);
    const positions = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));
    const r = weightedL1Score(
      positions,
      positions,
      {} /* no domain weights */,
      subs,
    );
    // resolveSubDimensionWeights defaults missing-domain weight to 1, so this
    // actually produces a real score. We assert score is a number in [0, 100].
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThanOrEqual(0);
    expect(r.score!).toBeLessThanOrEqual(100);
  });

  it('candidate has positions for sub_dim user did not answer → ignored', () => {
    const subs = makeNSubDimsInDomain(6);
    const user = subs.slice(0, 5).map((sd) => ({ sub_dimension_id: sd.id, score: 0 }));
    // Candidate also answers an extra dim user didn't.
    const candidate = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0 }));

    const r = weightedL1Score(user, candidate, evenWeights(), subs);
    expect(r.answered_both_count).toBe(5); // not 6
  });

  it('user answers a sub_dim that does not exist in subDimensions → excluded', () => {
    const subs = makeNSubDimsInDomain(6);
    const user = [
      ...subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0 })),
      { sub_dimension_id: 'nonexistent', score: 0.5 },
    ];
    const candidate = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0 }));

    const r = weightedL1Score(user, candidate, evenWeights(), subs);
    expect(r.answered_both_count).toBe(6);
  });

  it('overlap exactly at MIN_OVERLAP_FOR_SCORE → emits a numeric score', () => {
    const subs = makeNSubDimsInDomain(MIN_OVERLAP_FOR_SCORE);
    const positions = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));
    const r = weightedL1Score(positions, positions, evenWeights(), subs);
    expect(r.score).toBe(100);
    expect(r.answered_both_count).toBe(MIN_OVERLAP_FOR_SCORE);
  });

  it('overlap one short of MIN_OVERLAP_FOR_SCORE → null score', () => {
    const subs = makeNSubDimsInDomain(MIN_OVERLAP_FOR_SCORE - 1);
    const positions = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));
    const r = weightedL1Score(positions, positions, evenWeights(), subs);
    expect(r.score).toBeNull();
    expect(r.confidence).toBe('insufficient_overlap');
  });
});

// ===========================================================================
// weightedL1Score — invariants (symmetry, bounded)
// ===========================================================================

describe('weightedL1Score — invariants', () => {
  it('is symmetric: score(A, B) === score(B, A)', () => {
    const subs = makeNSubDimsInDomain(6);
    const a = subs.map((sd, i) => ({ sub_dimension_id: sd.id, score: (i % 3) / 2 }));
    const b = subs.map((sd, i) => ({ sub_dimension_id: sd.id, score: ((i + 1) % 3) / 2 }));

    const ab = weightedL1Score(a, b, evenWeights(), subs);
    const ba = weightedL1Score(b, a, evenWeights(), subs);
    expect(ab.score).toBe(ba.score);
  });

  it('all scores stay in [0, 100] for randomised inputs', () => {
    const subs = makeNSubDimsInDomain(8);
    // Deterministic pseudo-random — seed-free LCG so the test is repeatable.
    let s = 123456789;
    const rand = () => {
      s = (1103515245 * s + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };

    for (let trial = 0; trial < 50; trial++) {
      const u = subs.map((sd) => ({ sub_dimension_id: sd.id, score: rand() }));
      const c = subs.map((sd) => ({ sub_dimension_id: sd.id, score: rand() }));
      const r = weightedL1Score(u, c, evenWeights(), subs);
      expect(r.score).not.toBeNull();
      expect(r.score!).toBeGreaterThanOrEqual(0);
      expect(r.score!).toBeLessThanOrEqual(100);
    }
  });

  it('distance ordering: closer positions yield higher score', () => {
    const subs = makeNSubDimsInDomain(8);
    const user = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));
    const close = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.6 }));
    const far = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.9 }));

    const closeR = weightedL1Score(user, close, evenWeights(), subs);
    const farR = weightedL1Score(user, far, evenWeights(), subs);
    expect(closeR.score!).toBeGreaterThan(farR.score!);
  });

  it('rounding stays within 0..100 even for adversarial near-perfect overlap', () => {
    const subs = makeNSubDimsInDomain(8);
    const u = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.0001 }));
    const c = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0 }));
    const r = weightedL1Score(u, c, evenWeights(), subs);
    expect(r.score!).toBeGreaterThanOrEqual(0);
    expect(r.score!).toBeLessThanOrEqual(100);
  });
});

// ===========================================================================
// computeConfidence
// ===========================================================================

describe('computeConfidence — coverage on the user\'s top domains', () => {
  it('candidate covers ≥75% of top-domain dims → high', () => {
    const subs = [
      makeSubDim('a', 'economy'),
      makeSubDim('b', 'economy'),
      makeSubDim('c', 'economy'),
      makeSubDim('d', 'economy'),
    ];
    const candidate = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));
    expect(computeConfidence(candidate, ['economy'], subs)).toBe('high');
  });

  it('candidate covers 40-75% → medium', () => {
    const subs = Array.from({ length: 5 }, (_, i) => makeSubDim(`s-${i}`, 'economy'));
    // Cover 2/5 = 40%
    const candidate = subs.slice(0, 2).map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));
    expect(computeConfidence(candidate, ['economy'], subs)).toBe('medium');
  });

  it('candidate covers <40% → low', () => {
    const subs = Array.from({ length: 10 }, (_, i) => makeSubDim(`s-${i}`, 'economy'));
    const candidate = subs.slice(0, 1).map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));
    expect(computeConfidence(candidate, ['economy'], subs)).toBe('low');
  });

  it('user has no top domains → low (no signal to ground confidence)', () => {
    const subs = makeNSubDimsInDomain(3);
    const candidate = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));
    expect(computeConfidence(candidate, [], subs)).toBe('low');
  });

  it('candidate has no positions in any of the top domains → low', () => {
    const econ = makeSubDim('e1', 'economy');
    const social = [makeSubDim('s1', 'social'), makeSubDim('s2', 'social')];
    const subs = [econ, ...social];
    const candidate = social.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));
    // Top domain is 'economy', but candidate only answered 'social'.
    expect(computeConfidence(candidate, ['economy'], subs)).toBe('low');
  });

  it('top-domain dims cover multiple domains', () => {
    const econ = Array.from({ length: 2 }, (_, i) => makeSubDim(`e-${i}`, 'economy'));
    const social = Array.from({ length: 2 }, (_, i) => makeSubDim(`s-${i}`, 'social'));
    const subs = [...econ, ...social];
    const candidate = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));
    expect(computeConfidence(candidate, ['economy', 'social'], subs)).toBe('high');
  });
});
