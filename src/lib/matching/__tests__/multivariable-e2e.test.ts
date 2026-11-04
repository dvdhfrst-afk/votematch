/**
 * End-to-end proof of the multivariable match (doc 09), chaining the REAL
 * modules built this session, not hand-constructed shortcuts:
 *
 *   voter answers   -> buildVoterAxisVector()          (voter-axis.ts)
 *   candidate rows  -> selectPositionsForView()        (algorithm.ts, flag ON)
 *   per-axis weight -> competenceMaskForAxis()         (axis-weights.ts)
 *                      jurisdictionSalienceForAxis()   (axis-weights.ts)
 *                      composeAxisWeights()            (axis-weights.ts)
 *   the score       -> weightedL1Score(..., axisWeights)  (algorithm.ts)
 *
 * Both sides key on the SAME computeAxisUid format, so they overlap. This file
 * proves the three things that turn the storage schema into a working match:
 *   1. a real numeric score comes out, with the distinct-ISSUE overlap floor met;
 *   2. competence masking DROPS an out-of-scope axis (the sheriff-on-education
 *      case) from the weight map;
 *   3. jurisdiction salience RAISES a Western Water axis above a baseline axis.
 *
 * Note: like the rest of the matcher suite this reads MATCHING_MULTIVARIABLE from
 * process.env at call time. The cowork sandbox cannot run vitest (Windows-built
 * node_modules + a stale mount); run `npm run test:matcher` on the Windows host.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  weightedL1Score,
  selectPositionsForView,
  type PositionVector,
} from '../algorithm';
import { buildVoterAxisVector, type VoterAxisAnswer } from '../voter-axis';
import {
  competenceMaskForAxis,
  jurisdictionSalienceForAxis,
  composeAxisWeights,
  axisUid,
  INDIRECT_FACTOR,
} from '../axis-weights';
import { computeAxisUid } from '@/lib/positioning/axis-set';
import type { Domain, ScopeApplicability, SubDimension } from '@/types/database';

// ---------------------------------------------------------------------------
// Flag + fixture helpers (mirror multivariable.test.ts)
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

const DOMAINS: Domain[] = [
  'economy', 'social', 'healthcare', 'education',
  'environment', 'governance', 'public_safety', 'infrastructure',
];

const SCOPE_ALL: ScopeApplicability = { federal: 'matching', state: 'matching', county: 'matching' };

function makeSubDim(id: string, domain: Domain): SubDimension {
  return {
    id, domain, name: `Dim ${id}`,
    spectrum_low: 'low', spectrum_high: 'high',
    display_order: 0, scope_applicability: SCOPE_ALL,
  };
}

function evenWeights(): Record<string, number> {
  const w: Record<string, number> = {};
  for (const d of DOMAINS) w[d] = 1 / DOMAINS.length;
  return w;
}

/** A minimal candidate positions row, shaped for selectPositionsForView. */
function makeCandidatePosition(
  subDim: string,
  axisKind: 'sub_dimension' | 'backbone' | 'proposition',
  axisId: string | null,
  score: number,
) {
  return {
    sub_dimension_id: subDim,
    axis_kind: axisKind,
    axis_id: axisId,
    score,
    confidence: 'high',
    view_type: 'inferred',
    source_citations: [{ url: 'https://example.org/src', title: 's', date: '2026-01-01' }],
    created_at: '2026-06-01T00:00:00Z',
  };
}

// Six issues, each with three axes (primary + one backbone + one proposition).
// Six clears the distinct-issue overlap floor (MIN_OVERLAP_FOR_SCORE = 5).
const ISSUES = Array.from({ length: 6 }, (_, i) => `sd-${i}`);
const SUBDIMS: SubDimension[] = ISSUES.map((id, i) => makeSubDim(id, DOMAINS[i % DOMAINS.length]));

function axesForIssue(subDim: string): Array<{ axis_kind: 'sub_dimension' | 'backbone' | 'proposition'; axis_id: string | null }> {
  return [
    { axis_kind: 'sub_dimension', axis_id: null },   // the primary directional axis
    { axis_kind: 'backbone', axis_id: 'B1' },         // a shared backbone axis
    { axis_kind: 'proposition', axis_id: `${subDim}-p0` }, // an issue-specific axis
  ];
}

// ===========================================================================
// 1. Competence masking drops an out-of-scope axis (pure, exact)
// ===========================================================================

describe('competence mask (doc 09 Part 3.2)', () => {
  const eduReq = [{ required_authority_domain: 'education', min_authority_mode: 'legislative' as const }];

  it('drops an education axis for an office that lacks the domain (sheriff)', () => {
    expect(competenceMaskForAxis(eduReq, { domains: ['public_safety', 'justice'], mode: 'executive' })).toBe(0);
  });
  it('keeps an education axis for an office that holds it directly (school board)', () => {
    expect(competenceMaskForAxis(eduReq, { domains: ['education'], mode: 'legislative' })).toBe(1);
  });
  it('down-weights (indirect) when the office holds the domain only at a weak mode', () => {
    expect(competenceMaskForAxis(eduReq, { domains: ['education'], mode: 'advisory' })).toBe(INDIRECT_FACTOR);
  });
});

// ===========================================================================
// 2. Jurisdiction salience raises a Western Water axis (pure, exact)
// ===========================================================================

describe('jurisdiction salience (doc 09 Part 3.3)', () => {
  it('a Western Water cluster raises water salience above the neutral baseline', () => {
    const utahWater = jurisdictionSalienceForAxis(0.5, [0.95]); // Utah is in the cluster
    const maineWater = jurisdictionSalienceForAxis(0.5, []);    // Maine is not
    expect(utahWater).toBeCloseTo(0.95, 5);
    expect(maineWater).toBeCloseTo(0.5, 5);
    expect(utahWater).toBeGreaterThan(maineWater);
  });
});

// ===========================================================================
// 3. composeAxisWeights: masked axis dropped, salient axis weighted higher
// ===========================================================================

describe('composeAxisWeights (doc 09 Part 3.4)', () => {
  it('drops the masked axis and ranks the salient axis above a baseline axis', () => {
    const water = axisUid({ sub_dimension_id: 'sd-0', axis_kind: 'sub_dimension', axis_id: null });
    const base = axisUid({ sub_dimension_id: 'sd-1', axis_kind: 'sub_dimension', axis_id: null });
    const masked = axisUid({ sub_dimension_id: 'sd-5', axis_kind: 'sub_dimension', axis_id: null });

    const weights = composeAxisWeights({
      axes: [water, base, masked],
      competenceByAxisUid: new Map([[masked, 0]]), // masked out; water/base default to 1
      jurisdictionSalienceByAxisUid: new Map([[water, 0.95], [base, 0.5], [masked, 0.5]]),
      voterSalienceByAxisUid: new Map(),
    });

    expect(weights.has(masked)).toBe(false);                 // competence==0 -> dropped
    expect(weights.get(water)!).toBeGreaterThan(weights.get(base)!); // salience raised water
    const sum = [...weights.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);                            // normalized
  });
});

// ===========================================================================
// 4. End-to-end: voter builder + candidate selection + weights + engine
// ===========================================================================

describe('end-to-end multivariable match', () => {
  // Build the voter answers and the candidate rows over the SAME axis set.
  const voterAnswers: VoterAxisAnswer[] = [];
  const candidateRows: ReturnType<typeof makeCandidatePosition>[] = [];
  const allAxisUids: string[] = [];

  for (const issue of ISSUES) {
    for (const a of axesForIssue(issue)) {
      // Voter and candidate agree exactly in this base fixture (score 0.7).
      voterAnswers.push({
        sub_dimension_id: issue, axis_kind: a.axis_kind, axis_id: a.axis_id, score: 0.7,
      });
      candidateRows.push(makeCandidatePosition(issue, a.axis_kind, a.axis_id, 0.7));
      allAxisUids.push(computeAxisUid(issue, a.axis_kind, a.axis_id));
    }
  }

  // Uniform weights over every axis (competence 1, salience neutral, voter 1).
  function uniformWeights(): Map<string, number> {
    return composeAxisWeights({
      axes: allAxisUids,
      competenceByAxisUid: new Map(),
      jurisdictionSalienceByAxisUid: new Map(),
      voterSalienceByAxisUid: new Map(),
    });
  }

  it('voter + candidate share axis_uid keys, so the flag-ON match overlaps and scores', () => {
    const voterVec: PositionVector[] = buildVoterAxisVector(voterAnswers);
    const { positions: candVec } = withFlag('true', () =>
      selectPositionsForView(candidateRows as never, 'inferred'),
    );

    const r = withFlag('true', () =>
      weightedL1Score(voterVec, candVec, evenWeights(), SUBDIMS, uniformWeights()),
    );

    // Agreement on every axis across 6 distinct issues -> a real perfect score,
    // not insufficient_overlap. Proves the keys line up and the floor is met.
    expect(r.score).not.toBeNull();
    expect(typeof r.score).toBe('number');
    expect(r.score).toBe(100);
  });

  it('opposite positions score low (the engine still discriminates on the axis vector)', () => {
    const voterVec = buildVoterAxisVector(
      voterAnswers.map((a) => ({ ...a, score: 0 })),
    );
    const oppCandidate = candidateRows.map((p) => ({ ...p, score: 1 }));
    const { positions: candVec } = withFlag('true', () =>
      selectPositionsForView(oppCandidate as never, 'inferred'),
    );
    const r = withFlag('true', () =>
      weightedL1Score(voterVec, candVec, evenWeights(), SUBDIMS, uniformWeights()),
    );
    expect(r.score).toBe(0);
  });

  it('with the flag OFF the voter axis_uid keys are ignored (no regression risk)', () => {
    // OFF path keys on sub_dimension_id, so the three axes of an issue collapse to
    // one bucket; this just confirms the build does not depend on flag-ON to run.
    const voterVec = buildVoterAxisVector(voterAnswers);
    const { positions: candVec } = withFlag(undefined, () =>
      selectPositionsForView(candidateRows as never, 'inferred'),
    );
    const r = withFlag(undefined, () =>
      weightedL1Score(voterVec, candVec, evenWeights(), SUBDIMS),
    );
    // The candidate collapses to 6 sub_dim buckets; the voter vector carries
    // axis_uid but OFF keys on sub_dimension_id, so they still meet on the 6 issues.
    expect(r.score).not.toBeNull();
  });
});
