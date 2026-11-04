/**
 * Tests for the VOTER side of multivariable matching (voter-axis.ts) and the
 * candidate-side axis_uid plumbing in selectPositionsForView (algorithm.ts).
 *
 * What this proves:
 *   1. buildVoterAxisVector produces the exact composite axis_uid keys that the
 *      candidate side (v_axis_positions / selectPositionsForView) uses, so the
 *      two vectors overlap.
 *   2. Flag ON: selectPositionsForView buckets a candidate's primary + backbone
 *      + proposition rows into DISTINCT axis_uid vectors (the bug this build
 *      closes: voter keyed by bare sub_dimension_id, candidate keyed by
 *      axis_uid, nothing overlapped).
 *   3. Flag ON: a candidate with primary+backbone+proposition positions across
 *      5 distinct issues and a voter answering the SAME axes produce a NONZERO
 *      overlap and a numeric score through weightedL1Score.
 *   4. Flag OFF: selectPositionsForView emits NO axis_uid (byte-for-byte the
 *      pre-flag shape) and buckets by sub_dimension_id alone, so the existing
 *      behavior and the existing matcher tests are unaffected.
 *
 * The flag is read from process.env at call time, so each test sets/clears
 * MATCHING_MULTIVARIABLE around the call and restores it after, mirroring
 * multivariable.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  weightedL1Score,
  selectPositionsForView,
  type PositionVector,
} from '../algorithm';
import { buildVoterAxisVector } from '../voter-axis';
import { computeAxisUid } from '@/lib/positioning/axis-set';
import type {
  Confidence,
  Domain,
  MatchView,
  Position,
  ScopeApplicability,
  SubDimension,
} from '@/types/database';

// ---------------------------------------------------------------------------
// Flag helpers (same idiom as multivariable.test.ts)
// ---------------------------------------------------------------------------

function withFlag<T>(value: 'true' | undefined, fn: () => T): T {
  const prev = process.env.MATCHING_MULTIVARIABLE;
  if (value === undefined) delete process.env.MATCHING_MULTIVARIABLE;
  else process.env.MATCHING_MULTIVARIABLE = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MATCHING_MULTIVARIABLE;
    else process.env.MATCHING_MULTIVARIABLE = prev;
  }
}

afterEach(() => {
  delete process.env.MATCHING_MULTIVARIABLE;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** A candidate Position with valid citations + an inferred view (skips the
 *  stated-tier guard) and the multivariable axis columns set. */
function makePosition(
  overrides: Partial<Position> & {
    sub_dimension_id: string;
    score: number;
    axis_kind?: 'sub_dimension' | 'backbone' | 'proposition';
    axis_id?: string | null;
  },
): Position {
  const base: Position = {
    id: `pos-${overrides.sub_dimension_id}-${overrides.axis_kind ?? 'sub_dimension'}-${overrides.axis_id ?? 'primary'}`,
    candidate_id: 'cand-1',
    sub_dimension_id: overrides.sub_dimension_id,
    view_type: 'inferred',
    score: overrides.score,
    confidence: 'high' as Confidence,
    source_citations: [{ url: 'https://example.gov/x', title: 's', date: '2026-01-01' }],
    nuance_notes: null,
    ai_summary: null,
    extraction_audit_id: null,
    created_at: '2026-06-01T00:00:00.000Z',
  };
  // axis_kind / axis_id live on the DB row (migration 20260615000000) but not
  // (yet) on the Position TS type; attach them through a cast, exactly the way
  // the loaders deliver them via select('*').
  return {
    ...base,
    ...overrides,
    axis_kind: overrides.axis_kind ?? 'sub_dimension',
    axis_id: overrides.axis_id ?? null,
  } as Position;
}

function evenWeights(): Record<string, number> {
  return { economy: 1 };
}

// ===========================================================================
// 1. buildVoterAxisVector produces correct axis_uid keys
// ===========================================================================

describe('buildVoterAxisVector: axis_uid keying', () => {
  it('keys each answer with computeAxisUid(sub_dim, kind, id)', () => {
    const vec = buildVoterAxisVector([
      { sub_dimension_id: 'abortion', axis_kind: 'sub_dimension', axis_id: null, score: 0.3 },
      { sub_dimension_id: 'abortion', axis_kind: 'backbone', axis_id: 'B1', score: 0.6 },
      { sub_dimension_id: 'abortion', axis_kind: 'proposition', axis_id: 'gest_limit', score: 0.8 },
    ]);

    expect(vec).toHaveLength(3);
    expect(vec[0].axis_uid).toBe('abortion:sub_dimension:primary');
    expect(vec[1].axis_uid).toBe('abortion:backbone:B1');
    expect(vec[2].axis_uid).toBe('abortion:proposition:gest_limit');
    // sub_dimension_id is carried alongside (so the OFF path still works).
    expect(vec.map((v) => v.sub_dimension_id)).toEqual(['abortion', 'abortion', 'abortion']);
    // score passed straight through.
    expect(vec.map((v) => v.score)).toEqual([0.3, 0.6, 0.8]);
  });

  it('a null axis_id collapses to the literal "primary" segment', () => {
    const [v] = buildVoterAxisVector([
      { sub_dimension_id: 'taxes', axis_kind: 'sub_dimension', axis_id: null, score: 0.5 },
    ]);
    expect(v.axis_uid).toBe(computeAxisUid('taxes', 'sub_dimension', null));
    expect(v.axis_uid).toBe('taxes:sub_dimension:primary');
  });

  it('passes confidence through only when present', () => {
    const vec = buildVoterAxisVector([
      { sub_dimension_id: 'guns', axis_kind: 'sub_dimension', axis_id: null, score: 0.2, confidence: 'low' },
      { sub_dimension_id: 'water', axis_kind: 'sub_dimension', axis_id: null, score: 0.4 },
    ]);
    expect(vec[0].confidence).toBe('low');
    expect('confidence' in vec[1]).toBe(false);
  });
});

// ===========================================================================
// 2. Flag ON: candidate side buckets primary+backbone+proposition into
//    DISTINCT axis_uid vectors
// ===========================================================================

describe('selectPositionsForView ON: one issue, three axes -> three vectors', () => {
  it('emits a distinct axis_uid per (axis_kind, axis_id) within one issue', () => {
    const issue = 'abortion';
    const positions: Position[] = [
      makePosition({ sub_dimension_id: issue, axis_kind: 'sub_dimension', axis_id: null, score: 0.3 }),
      makePosition({ sub_dimension_id: issue, axis_kind: 'backbone', axis_id: 'B1', score: 0.6 }),
      makePosition({ sub_dimension_id: issue, axis_kind: 'proposition', axis_id: 'gest_limit', score: 0.8 }),
    ];

    const { positions: out } = withFlag('true', () =>
      selectPositionsForView(positions, 'inferred' as MatchView),
    );

    expect(out).toHaveLength(3);
    const uids = out.map((p) => p.axis_uid).sort();
    expect(uids).toEqual(
      [
        'abortion:backbone:B1',
        'abortion:proposition:gest_limit',
        'abortion:sub_dimension:primary',
      ].sort(),
    );
    // Every vector still carries the issue's sub_dimension_id.
    expect(out.every((p) => p.sub_dimension_id === issue)).toBe(true);
  });
});

// ===========================================================================
// 3. Flag ON end-to-end: candidate axes + matching voter axes -> nonzero
//    overlap + numeric score through weightedL1Score
// ===========================================================================

describe('end-to-end ON: voter axes overlap candidate axes', () => {
  it('5 issues x (primary+backbone+proposition) -> nonzero overlap, numeric score', () => {
    const issues = ['taxes', 'guns', 'water', 'schools', 'health'];
    const subs = issues.map((id) => makeSubDim(id, 'economy'));

    // Candidate: each issue carries 3 axes. Build Position rows, then run the
    // real candidate-side selector to get axis_uid-keyed vectors.
    const candPositions: Position[] = issues.flatMap((id) => [
      makePosition({ sub_dimension_id: id, axis_kind: 'sub_dimension', axis_id: null, score: 0.5 }),
      makePosition({ sub_dimension_id: id, axis_kind: 'backbone', axis_id: 'B1', score: 0.5 }),
      makePosition({ sub_dimension_id: id, axis_kind: 'proposition', axis_id: `${id}_p`, score: 0.5 }),
    ]);

    // Voter: answers the SAME 15 axes via the voter-side builder.
    const voterVec: PositionVector[] = buildVoterAxisVector(
      issues.flatMap((id) => [
        { sub_dimension_id: id, axis_kind: 'sub_dimension' as const, axis_id: null, score: 0.5 },
        { sub_dimension_id: id, axis_kind: 'backbone' as const, axis_id: 'B1', score: 0.5 },
        { sub_dimension_id: id, axis_kind: 'proposition' as const, axis_id: `${id}_p`, score: 0.5 },
      ]),
    );

    const result = withFlag('true', () => {
      const { positions: candVec } = selectPositionsForView(candPositions, 'inferred' as MatchView);
      // Sanity: candidate produced 15 axis_uid-keyed vectors.
      expect(candVec).toHaveLength(15);
      return weightedL1Score(voterVec, candVec, evenWeights(), subs);
    });

    // 15 axes answered by both, 5 distinct issues clear the floor.
    expect(result.answered_both_count).toBe(15);
    expect(result.score).not.toBeNull();
    expect(result.score).toBe(100); // identical scores on every axis
  });

  it('mismatched scores on shared axes produce a partial (nonzero, sub-100) score', () => {
    const issues = ['a', 'b', 'c', 'd', 'e'];
    const subs = issues.map((id) => makeSubDim(id, 'economy'));

    const candPositions: Position[] = issues.flatMap((id) => [
      makePosition({ sub_dimension_id: id, axis_kind: 'sub_dimension', axis_id: null, score: 0.0 }),
      makePosition({ sub_dimension_id: id, axis_kind: 'backbone', axis_id: 'B1', score: 0.0 }),
    ]);
    const voterVec = buildVoterAxisVector(
      issues.flatMap((id) => [
        { sub_dimension_id: id, axis_kind: 'sub_dimension' as const, axis_id: null, score: 0.5 },
        { sub_dimension_id: id, axis_kind: 'backbone' as const, axis_id: 'B1', score: 0.5 },
      ]),
    );

    const result = withFlag('true', () => {
      const { positions: candVec } = selectPositionsForView(candPositions, 'inferred' as MatchView);
      return weightedL1Score(voterVec, candVec, evenWeights(), subs);
    });

    // 10 axes, all 0.5 apart -> score 50 (nonzero overlap, partial alignment).
    expect(result.answered_both_count).toBe(10);
    expect(result.score).toBe(50);
  });

  it('regression: bare-sub_dim voter vector does NOT overlap candidate axes (the bug)', () => {
    // This is the pre-fix failure mode: the voter keys by bare sub_dimension_id
    // while the candidate keys by axis_uid. With backbone/proposition axes there
    // is NO bare-sub_dim row on the candidate side, so the overlap is only the
    // primary axes -> demonstrates why buildVoterAxisVector is required.
    const issues = ['a', 'b', 'c', 'd', 'e'];
    const subs = issues.map((id) => makeSubDim(id, 'economy'));

    // Candidate carries ONLY backbone axes (no primary), so a bare-sub_dim voter
    // key cannot match anything.
    const candPositions: Position[] = issues.map((id) =>
      makePosition({ sub_dimension_id: id, axis_kind: 'backbone', axis_id: 'B1', score: 0.5 }),
    );
    // Buggy voter vector: bare sub_dimension_id, no axis_uid.
    const buggyVoter: PositionVector[] = issues.map((id) => ({ sub_dimension_id: id, score: 0.5 }));

    const result = withFlag('true', () => {
      const { positions: candVec } = selectPositionsForView(candPositions, 'inferred' as MatchView);
      return weightedL1Score(buggyVoter, candVec, evenWeights(), subs);
    });

    // No axis overlaps: the candidate's keys are 'a:backbone:B1' etc; the voter's
    // keys are bare 'a'. answered_both_count is 0.
    expect(result.answered_both_count).toBe(0);
  });
});

// ===========================================================================
// 4. Flag OFF: candidate side emits NO axis_uid (byte-for-byte pre-flag)
// ===========================================================================

describe('selectPositionsForView OFF: byte-for-byte pre-flag shape', () => {
  it('buckets by sub_dimension_id and emits no axis_uid even with axis columns set', () => {
    const issue = 'abortion';
    // Three rows that DIFFER only by axis identity. OFF must collapse them to
    // ONE sub_dim bucket (latest created_at wins) and emit no axis_uid.
    const positions: Position[] = [
      makePosition({ sub_dimension_id: issue, axis_kind: 'sub_dimension', axis_id: null, score: 0.3, created_at: '2026-06-01T00:00:00.000Z' }),
      makePosition({ sub_dimension_id: issue, axis_kind: 'backbone', axis_id: 'B1', score: 0.6, created_at: '2026-06-02T00:00:00.000Z' }),
      makePosition({ sub_dimension_id: issue, axis_kind: 'proposition', axis_id: 'gest_limit', score: 0.8, created_at: '2026-06-03T00:00:00.000Z' }),
    ];

    const { positions: out } = withFlag(undefined, () =>
      selectPositionsForView(positions, 'inferred' as MatchView),
    );

    // OFF: one bucket per sub_dimension_id.
    expect(out).toHaveLength(1);
    expect(out[0].sub_dimension_id).toBe(issue);
    // No axis_uid property at all (not just undefined) -> byte-for-byte shape.
    expect('axis_uid' in out[0]).toBe(false);
    // Latest created_at wins (the proposition row, score 0.8).
    expect(out[0].score).toBe(0.8);
  });

  it('OFF: a plain single-axis candidate emits the same vector as before', () => {
    const positions: Position[] = [
      makePosition({ sub_dimension_id: 'taxes', score: 0.42 }),
    ];
    const { positions: out } = withFlag(undefined, () =>
      selectPositionsForView(positions, 'inferred' as MatchView),
    );
    expect(out).toEqual([{ sub_dimension_id: 'taxes', score: 0.42, confidence: 'high' }]);
  });
});
