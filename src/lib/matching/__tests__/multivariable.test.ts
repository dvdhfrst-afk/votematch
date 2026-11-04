/**
 * Tests for the multivariable axis-vector scoring path (doc 09), gated behind
 * the MATCHING_MULTIVARIABLE feature flag.
 *
 * The whole point of this file is to prove the change is SAFE:
 *   1. Flag OFF reproduces today's behavior exactly (regression).
 *   2. Flag ON, one multivariable issue made of 6 axes -> insufficient_overlap
 *      (the distinct-ISSUE overlap floor holds; axes do not clear it). Red-team M1.
 *   3. Flag ON, 5 distinct issues -> a real numeric score.
 *   4. Flag ON, the totalWeight==0 guard returns insufficient_overlap. Red-team M4.
 *   5. Flag ON, when each issue has exactly one axis, the distance math equals
 *      the OFF path byte-for-byte (key-widening, not a distance change).
 *
 * The algorithm reads the flag from process.env at call time, so each test sets
 * or clears MATCHING_MULTIVARIABLE around the call and restores it after. No
 * module re-import gymnastics needed because multivariableMatchingEnabled()
 * reads process.env fresh on every invocation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { weightedL1Score, MIN_OVERLAP_FOR_SCORE } from '../algorithm';
import type { Domain, ScopeApplicability, SubDimension } from '@/types/database';

// ---------------------------------------------------------------------------
// Flag helpers
// ---------------------------------------------------------------------------

function withFlag<T>(value: 'true' | undefined, fn: () => T): T {
  const prev = process.env.MATCHING_MULTIVARIABLE;
  if (value === undefined) {
    delete process.env.MATCHING_MULTIVARIABLE;
  } else {
    process.env.MATCHING_MULTIVARIABLE = value;
  }
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MATCHING_MULTIVARIABLE;
    else process.env.MATCHING_MULTIVARIABLE = prev;
  }
}

afterEach(() => {
  // Belt-and-suspenders: never leak the flag across tests.
  delete process.env.MATCHING_MULTIVARIABLE;
});

// ---------------------------------------------------------------------------
// Fixture helpers (mirrors algorithm.test.ts conventions)
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
  const w: Record<string, number> = {};
  for (const d of ALL_DOMAINS) w[d] = 1 / ALL_DOMAINS.length;
  return w;
}

function makeNSubDimsInDomain(n: number, domain: Domain = 'economy'): SubDimension[] {
  return Array.from({ length: n }, (_, i) => makeSubDim(`sd-${i}`, domain));
}

/**
 * Build an axis_uid in the composite form documented in doc 09 Part 4.1:
 *   '<sub_dimension_id>:<axis_kind>:<axis_id>'
 * issueOf() collapses these back to the leading sub_dimension_id.
 */
function axisUid(subDim: string, kind: string, axisId: string): string {
  return `${subDim}:${kind}:${axisId}`;
}

// ===========================================================================
// 1. Flag OFF reproduces current behavior exactly (regression)
// ===========================================================================

describe('MATCHING_MULTIVARIABLE OFF: exact regression of today behavior', () => {
  it('OFF ignores axis_uid entirely and keys on sub_dimension_id', () => {
    const subs = makeNSubDimsInDomain(6);
    // Each position carries an axis_uid that DIFFERS from its sub_dimension_id.
    // With the flag OFF these must be ignored: the engine keys on sub_dim only.
    const user = subs.map((sd) => ({
      sub_dimension_id: sd.id,
      score: 0,
      axis_uid: axisUid(sd.id, 'backbone', 'B1'),
    }));
    const candidate = subs.map((sd) => ({
      sub_dimension_id: sd.id,
      score: 1,
      axis_uid: axisUid(sd.id, 'backbone', 'B1'),
    }));

    const r = withFlag(undefined, () =>
      weightedL1Score(user, candidate, evenWeights(), subs),
    );
    // Opposite positions on all 6 dims -> score 0, overlap 6 (the dims, keyed
    // by sub_dimension_id, not by the differing axis_uids).
    expect(r.score).toBe(0);
    expect(r.answered_both_count).toBe(6);
  });

  it('OFF: identical positions -> 100 (unchanged)', () => {
    const subs = makeNSubDimsInDomain(6);
    const positions = subs.map((sd, i) => ({
      sub_dimension_id: sd.id,
      score: i / (subs.length - 1),
    }));
    const r = withFlag(undefined, () =>
      weightedL1Score(positions, positions, evenWeights(), subs),
    );
    expect(r.score).toBe(100);
    expect(r.answered_both_count).toBe(6);
  });

  it('OFF: passing an axisWeights map is ignored (no effect on the OFF path)', () => {
    const subs = makeNSubDimsInDomain(6);
    const user = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0 }));
    const candidate = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));

    // A bogus axis-weight map that would, if honored, skew the result.
    const bogus = new Map<string, number>(subs.map((sd) => [sd.id, 999]));

    const withMap = withFlag(undefined, () =>
      weightedL1Score(user, candidate, evenWeights(), subs, bogus),
    );
    const withoutMap = withFlag(undefined, () =>
      weightedL1Score(user, candidate, evenWeights(), subs),
    );
    expect(withMap.score).toBe(withoutMap.score);
    expect(withMap.score).toBe(50);
  });
});

// ===========================================================================
// 2. Flag ON: a single multivariable issue of 6 axes -> insufficient_overlap
//    (the distinct-ISSUE floor holds; red-team M1)
// ===========================================================================

describe('MATCHING_MULTIVARIABLE ON: issue-count overlap floor (red-team M1)', () => {
  it('one issue spanning 6 axes does NOT clear MIN_OVERLAP_FOR_SCORE', () => {
    // A single sub_dimension ('abortion') decomposed into 6 axes. All answered
    // by both sides, so axis-overlap is 6 (>= MIN). But it is ONE issue, so the
    // distinct-issue overlap is 1, which is < MIN_OVERLAP_FOR_SCORE.
    const issue = 'abortion';
    const sub = makeSubDim(issue, 'healthcare');
    const kinds = [
      ['sub_dimension', 'primary'],
      ['backbone', 'B1'],
      ['backbone', 'B2'],
      ['backbone', 'B5'],
      ['proposition', 'gestational_limit'],
      ['proposition', 'public_funding'],
    ] as const;

    const user = kinds.map(([kind, id]) => ({
      sub_dimension_id: issue,
      score: 0.3,
      axis_uid: axisUid(issue, kind, id),
    }));
    const candidate = kinds.map(([kind, id]) => ({
      sub_dimension_id: issue,
      score: 0.3,
      axis_uid: axisUid(issue, kind, id),
    }));

    const r = withFlag('true', () =>
      weightedL1Score(user, candidate, { healthcare: 1 }, [sub]),
    );

    // Six axes answered by both, but ONE distinct issue.
    expect(r.answered_both_count).toBe(6);
    expect(r.score).toBeNull();
    expect(r.confidence).toBe('insufficient_overlap');
    // MIN floor really is 5 issues; one issue cannot clear it no matter the axes.
    expect(MIN_OVERLAP_FOR_SCORE).toBe(5);
  });
});

// ===========================================================================
// 3. Flag ON: 5 distinct issues -> a real numeric score
// ===========================================================================

describe('MATCHING_MULTIVARIABLE ON: 5 distinct issues clear the floor', () => {
  it('five issues (one axis each) produce a numeric score', () => {
    const issues = ['taxes', 'guns', 'water', 'schools', 'health'];
    const subs = issues.map((id) => makeSubDim(id, 'economy'));
    const user = issues.map((id) => ({
      sub_dimension_id: id,
      score: 0.5,
      axis_uid: axisUid(id, 'sub_dimension', 'primary'),
    }));
    const candidate = issues.map((id) => ({
      sub_dimension_id: id,
      score: 0.5,
      axis_uid: axisUid(id, 'sub_dimension', 'primary'),
    }));

    const r = withFlag('true', () =>
      weightedL1Score(user, candidate, { economy: 1 }, subs),
    );
    expect(r.score).not.toBeNull();
    expect(r.score).toBe(100); // identical -> perfect
    expect(r.answered_both_count).toBe(5);
  });

  it('five issues that EACH carry several axes also score (issues=5, axes>5)', () => {
    // 5 issues x 2 axes each = 10 axes; distinct issues = 5 = MIN floor.
    const issues = ['i1', 'i2', 'i3', 'i4', 'i5'];
    const subs = issues.map((id) => makeSubDim(id, 'economy'));
    const mkRows = (score: number) =>
      issues.flatMap((id) => [
        { sub_dimension_id: id, score, axis_uid: axisUid(id, 'sub_dimension', 'primary') },
        { sub_dimension_id: id, score, axis_uid: axisUid(id, 'backbone', 'B1') },
      ]);

    const r = withFlag('true', () =>
      weightedL1Score(mkRows(0), mkRows(1), { economy: 1 }, subs),
    );
    expect(r.answered_both_count).toBe(10); // 10 axes
    expect(r.score).toBe(0); // opposite on every axis
    expect(r.score).not.toBeNull();
  });
});

// ===========================================================================
// 4. Flag ON: the totalWeight==0 guard (red-team M4)
// ===========================================================================

describe('MATCHING_MULTIVARIABLE ON: normalization guards (red-team M4)', () => {
  it('all-zero axis weights -> insufficient_overlap (no divide-by-zero)', () => {
    const issues = ['a', 'b', 'c', 'd', 'e', 'f'];
    const subs = issues.map((id) => makeSubDim(id, 'economy'));
    const user = issues.map((id) => ({
      sub_dimension_id: id,
      score: 0.5,
      axis_uid: axisUid(id, 'sub_dimension', 'primary'),
    }));
    const candidate = issues.map((id) => ({
      sub_dimension_id: id,
      score: 0.2,
      axis_uid: axisUid(id, 'sub_dimension', 'primary'),
    }));

    // Composed axis-weight map where every surviving axis weighs 0.
    const allZero = new Map<string, number>(
      user.map((p) => [p.axis_uid, 0]),
    );

    const r = withFlag('true', () =>
      weightedL1Score(user, candidate, { economy: 1 }, subs, allZero),
    );
    // Six issues clear the issue floor, but the weight vector is degenerate.
    expect(r.answered_both_count).toBe(6);
    expect(r.score).toBeNull();
    expect(r.confidence).toBe('insufficient_overlap');
  });

  it('near-zero (epsilon) axis weights -> insufficient_overlap, not float noise', () => {
    const issues = ['a', 'b', 'c', 'd', 'e', 'f'];
    const subs = issues.map((id) => makeSubDim(id, 'economy'));
    const user = issues.map((id) => ({
      sub_dimension_id: id,
      score: 0.5,
      axis_uid: axisUid(id, 'sub_dimension', 'primary'),
    }));
    const candidate = issues.map((id) => ({
      sub_dimension_id: id,
      score: 0.9,
      axis_uid: axisUid(id, 'sub_dimension', 'primary'),
    }));

    // Each weight below the WEIGHT_EPSILON floor; total stays at/under epsilon.
    const tiny = new Map<string, number>(user.map((p) => [p.axis_uid, 1e-12]));

    const r = withFlag('true', () =>
      weightedL1Score(user, candidate, { economy: 1 }, subs, tiny),
    );
    expect(r.score).toBeNull();
    expect(r.confidence).toBe('insufficient_overlap');
  });

  it('a well-formed axis-weight map produces a normalized numeric score', () => {
    const issues = ['a', 'b', 'c', 'd', 'e', 'f'];
    const subs = issues.map((id) => makeSubDim(id, 'economy'));
    const user = issues.map((id) => ({
      sub_dimension_id: id,
      score: 0,
      axis_uid: axisUid(id, 'sub_dimension', 'primary'),
    }));
    const candidate = issues.map((id) => ({
      sub_dimension_id: id,
      score: 0.5,
      axis_uid: axisUid(id, 'sub_dimension', 'primary'),
    }));

    // Equal, non-zero weights -> half-apart -> score 50.
    const equal = new Map<string, number>(user.map((p) => [p.axis_uid, 1 / 6]));
    const r = withFlag('true', () =>
      weightedL1Score(user, candidate, { economy: 1 }, subs, equal),
    );
    expect(r.score).toBe(50);
  });
});

// ===========================================================================
// 5. Flag ON with one-axis-per-issue equals the OFF path byte-for-byte
// ===========================================================================

describe('MATCHING_MULTIVARIABLE ON: distance math matches OFF when 1 axis/issue', () => {
  // Deterministic pseudo-random (LCG), same generator style as algorithm.test.ts.
  function makeRand(seed: number) {
    let s = seed;
    return () => {
      s = (1103515245 * s + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  it('ON (one axis per issue) === OFF for many randomized vectors', () => {
    const subs = makeNSubDimsInDomain(8);
    const rand = makeRand(987654321);

    for (let trial = 0; trial < 50; trial++) {
      // OFF-shaped rows: keyed purely on sub_dimension_id.
      const offUser = subs.map((sd) => ({ sub_dimension_id: sd.id, score: rand() }));
      const offCand = subs.map((sd) => ({ sub_dimension_id: sd.id, score: rand() }));

      // ON-shaped rows: same scores, each issue carries exactly ONE axis whose
      // axis_uid is the composite primary key. issueOf() collapses each back to
      // its sub_dimension_id, so the issue set == the sub-dim set.
      const onUser = offUser.map((p) => ({
        ...p,
        axis_uid: axisUid(p.sub_dimension_id, 'sub_dimension', 'primary'),
      }));
      const onCand = offCand.map((p) => ({
        ...p,
        axis_uid: axisUid(p.sub_dimension_id, 'sub_dimension', 'primary'),
      }));

      const off = withFlag(undefined, () =>
        weightedL1Score(offUser, offCand, evenWeights(), subs),
      );
      // ON path WITHOUT an axisWeights map -> falls back to
      // resolveSubDimensionWeights, the same weights the OFF path uses.
      const on = withFlag('true', () =>
        weightedL1Score(onUser, onCand, evenWeights(), subs),
      );

      expect(on.score).toBe(off.score);
      expect(on.answered_both_count).toBe(off.answered_both_count);
      // perDim contributions match element-for-element (same order, same math).
      expect(on.perDim).toHaveLength(off.perDim.length);
      for (let i = 0; i < off.perDim.length; i++) {
        expect(on.perDim[i].absDiff).toBeCloseTo(off.perDim[i].absDiff, 12);
        expect(on.perDim[i].weight).toBeCloseTo(off.perDim[i].weight, 12);
        expect(on.perDim[i].weightedContribution).toBeCloseTo(
          off.perDim[i].weightedContribution,
          12,
        );
      }
    }
  });

  it('ON one-axis-per-issue matches OFF on the canonical halfway-apart case', () => {
    const subs = makeNSubDimsInDomain(6);
    const offUser = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0 }));
    const offCand = subs.map((sd) => ({ sub_dimension_id: sd.id, score: 0.5 }));
    const onUser = offUser.map((p) => ({
      ...p,
      axis_uid: axisUid(p.sub_dimension_id, 'sub_dimension', 'primary'),
    }));
    const onCand = offCand.map((p) => ({
      ...p,
      axis_uid: axisUid(p.sub_dimension_id, 'sub_dimension', 'primary'),
    }));

    const off = withFlag(undefined, () =>
      weightedL1Score(offUser, offCand, evenWeights(), subs),
    );
    const on = withFlag('true', () =>
      weightedL1Score(onUser, onCand, evenWeights(), subs),
    );
    expect(off.score).toBe(50);
    expect(on.score).toBe(50);
  });
});
