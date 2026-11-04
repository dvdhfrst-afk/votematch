/**
 * End-to-end proof of the multivariable model on the ECONOMIC SYSTEM issue
 * (the operator's worked example: "capitalism to communism has many steps along the
 * way"), chaining the REAL modules, not hand-rolled math:
 *
 *   voter answers   -> buildVoterAxisVector()        (voter-axis.ts)
 *   candidate rows  -> selectPositionsForView()      (algorithm.ts, flag ON)
 *   per-axis weight -> competenceMaskForAxis()       (axis-weights.ts)
 *                      jurisdictionSalienceForAxis() (axis-weights.ts)
 *                      composeAxisWeights()          (axis-weights.ts)
 *   the score       -> weightedL1Score(..., weights) (algorithm.ts)
 *
 * The headline assertion is the one that justifies the whole multivariable
 * rebuild: two candidates with the IDENTICAL single-axis (capitalism<->communism)
 * score that a one-dimensional model cannot tell apart, which the vector model
 * correctly separates for a Nordic-social-democrat voter.
 *
 * The matcher's overlap floor counts DISTINCT ISSUES (MIN_OVERLAP_FOR_SCORE = 5,
 * red-team M1), so a single-issue match is insufficient_overlap by design. To get
 * a numeric score we pad with four filler issues on which the voter and BOTH
 * candidates agree identically; the padding cannot change the RELATIVE ranking,
 * so the economic axis vector is what separates the two candidates.
 *
 * Run on the Windows host: `npm run test:matcher`. (The cowork sandbox cannot run
 * vitest; a dependency-free numeric proof of the same model lives at
 * scripts/proof-economic-system.mjs.)
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

const SCOPE_ALL: ScopeApplicability = { federal: 'matching', state: 'matching', county: 'matching' };

function makeSubDim(id: string, domain: Domain, name: string): SubDimension {
  return {
    id, domain, name,
    spectrum_low: 'low', spectrum_high: 'high',
    display_order: 0, scope_applicability: SCOPE_ALL,
  };
}

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

// --- The economic-system subspace (mirrors seed-economic-system.ts) ---------
const ECON = 'economic_system';
const ECON_AXES: Array<{ kind: 'sub_dimension' | 'backbone' | 'proposition'; id: string | null }> = [
  { kind: 'sub_dimension', id: null },                 // primary capitalism<->state
  { kind: 'proposition', id: 'taxation_progressivity' },
  { kind: 'proposition', id: 'public_ownership' },
  { kind: 'proposition', id: 'market_regulation' },
  { kind: 'proposition', id: 'social_safety_net' },
  { kind: 'proposition', id: 'labor_power' },
  { kind: 'backbone', id: 'B2' },
  { kind: 'backbone', id: 'B3' },
  { kind: 'backbone', id: 'B5' },
];

// Per-axis scores. STATE_SOCIALIST and NORDIC share the SAME primary (0.70) but
// diverge on the propositions; a 1-D model collapses them.
const STATE_SOCIALIST: Record<string, number> = {
  'sub_dimension:null': 0.70, taxation_progressivity: 0.70, public_ownership: 0.92,
  market_regulation: 0.80, social_safety_net: 0.35, labor_power: 0.60, B2: 0.70, B3: 0.70, B5: 0.75,
};
const NORDIC: Record<string, number> = {
  'sub_dimension:null': 0.70, taxation_progressivity: 0.85, public_ownership: 0.25,
  market_regulation: 0.65, social_safety_net: 0.95, labor_power: 0.85, B2: 0.55, B3: 0.80, B5: 0.55,
};
const VOTER: Record<string, number> = {
  'sub_dimension:null': 0.65, taxation_progressivity: 0.85, public_ownership: 0.30,
  market_regulation: 0.65, social_safety_net: 0.90, labor_power: 0.85, B2: 0.55, B3: 0.80, B5: 0.55,
};

const keyFor = (a: { kind: string; id: string | null }) =>
  a.kind === 'sub_dimension' ? 'sub_dimension:null' : (a.id as string);

// Four filler issues (primary axis only) where voter == both candidates, purely
// to clear the distinct-issue overlap floor without altering the ranking.
const FILLERS = ['f_health', 'f_env', 'f_gov', 'f_infra'];
const FILLER_DOMAINS: Domain[] = ['healthcare', 'environment', 'governance', 'infrastructure'];

const SUBDIMS: SubDimension[] = [
  makeSubDim(ECON, 'economy', ECON),
  ...FILLERS.map((f, i) => makeSubDim(f, FILLER_DOMAINS[i], f)),
];

function evenWeights(): Record<string, number> {
  return { economy: 0.2, healthcare: 0.2, environment: 0.2, governance: 0.2, infrastructure: 0.2 };
}

function buildSide(scores: Record<string, number>) {
  const voterAnswers: VoterAxisAnswer[] = [];
  const candRows: ReturnType<typeof makeCandidatePosition>[] = [];
  for (const a of ECON_AXES) {
    const v = scores[keyFor(a)];
    voterAnswers.push({ sub_dimension_id: ECON, axis_kind: a.kind, axis_id: a.id, score: v });
    candRows.push(makeCandidatePosition(ECON, a.kind, a.id, v));
  }
  for (const f of FILLERS) {
    voterAnswers.push({ sub_dimension_id: f, axis_kind: 'sub_dimension', axis_id: null, score: 0.5 });
    candRows.push(makeCandidatePosition(f, 'sub_dimension', null, 0.5));
  }
  return { voterAnswers, candRows };
}

// Composed weights over the economic axes for a state legislature (holds fiscal +
// economic_regulation at legislative), plus the filler issues at neutral weight.
function legislatureWeights(): Map<string, number> {
  const axisUids: string[] = [];
  const competence = new Map<string, number>();
  const jurisdiction = new Map<string, number>();
  const econReq = [
    { required_authority_domain: 'fiscal', min_authority_mode: 'legislative' as const },
    { required_authority_domain: 'economic_regulation', min_authority_mode: 'legislative' as const },
  ];
  const office = { domains: ['fiscal', 'economic_regulation'], mode: 'legislative' };
  for (const a of ECON_AXES) {
    const uid = axisUid({ sub_dimension_id: ECON, axis_kind: a.kind, axis_id: a.id });
    axisUids.push(uid);
    competence.set(uid, competenceMaskForAxis(econReq, office));
    jurisdiction.set(uid, jurisdictionSalienceForAxis(0.7, []));
  }
  for (const f of FILLERS) {
    const uid = axisUid({ sub_dimension_id: f, axis_kind: 'sub_dimension', axis_id: null });
    axisUids.push(uid);
    competence.set(uid, 1);
    jurisdiction.set(uid, 0.5);
  }
  return composeAxisWeights({
    axes: axisUids,
    competenceByAxisUid: competence,
    jurisdictionSalienceByAxisUid: jurisdiction,
    voterSalienceByAxisUid: new Map(),
  });
}

// ===========================================================================
describe('economic-system: one dimension loses what the vector keeps', () => {
  it('two candidates with the SAME primary score are tied in 1-D but separated in multi-D', () => {
    const weights = legislatureWeights();

    const ss = buildSide(STATE_SOCIALIST);
    const no = buildSide(NORDIC);
    const vo = buildSide(VOTER);

    const voterVec: PositionVector[] = buildVoterAxisVector(vo.voterAnswers);
    const ssVec = withFlag('true', () => selectPositionsForView(ss.candRows as never, 'inferred')).positions;
    const noVec = withFlag('true', () => selectPositionsForView(no.candRows as never, 'inferred')).positions;

    // 1-D baseline: score on the primary axis ALONE (one weight). Both candidates
    // have primary 0.70, voter 0.65, so the 1-D scores are identical.
    const primaryUid = computeAxisUid(ECON, 'sub_dimension', null);
    const oneD = new Map<string, number>([[primaryUid, 1]]);
    const ss1 = withFlag('true', () => weightedL1Score(voterVec, ssVec, evenWeights(), SUBDIMS, oneD)).score;
    const no1 = withFlag('true', () => weightedL1Score(voterVec, noVec, evenWeights(), SUBDIMS, oneD)).score;
    expect(ss1).toBe(no1); // information lost: a single axis cannot separate them

    // multi-D: the full economic axis vector (plus fillers to meet the floor).
    const ssM = withFlag('true', () => weightedL1Score(voterVec, ssVec, evenWeights(), SUBDIMS, weights)).score;
    const noM = withFlag('true', () => weightedL1Score(voterVec, noVec, evenWeights(), SUBDIMS, weights)).score;
    expect(noM).not.toBeNull();
    expect(ssM).not.toBeNull();
    expect(noM as number).toBeGreaterThan(ssM as number); // Nordic voter -> Nordic candidate
  });
});

// ===========================================================================
describe('economic-system: office competence governs scoring, not visibility', () => {
  const econReq = [
    { required_authority_domain: 'fiscal', min_authority_mode: 'legislative' as const },
    { required_authority_domain: 'economic_regulation', min_authority_mode: 'legislative' as const },
  ];
  it('a legislature keeps the economic axis at full weight', () => {
    expect(competenceMaskForAxis(econReq, { domains: ['fiscal', 'economic_regulation'], mode: 'legislative' })).toBe(1);
  });
  it('a veto-only / advisory office down-weights it (indirect), does not drop it', () => {
    expect(competenceMaskForAxis(econReq, { domains: ['fiscal'], mode: 'advisory' })).toBe(INDIRECT_FACTOR);
  });
  it('an office without fiscal or economic authority (school board) drops it from scoring', () => {
    expect(competenceMaskForAxis(econReq, { domains: ['education'], mode: 'legislative' })).toBe(0);
  });
});

// ===========================================================================
describe('economic-system: an abstained axis is excluded, never imputed to 0.5', () => {
  it('dropping one candidate axis reduces the answered-by-both count by exactly one', () => {
    const weights = legislatureWeights();
    const vo = buildSide(VOTER);
    const full = buildSide(NORDIC);
    const abstain = buildSide(NORDIC);
    // Remove the candidate's labor_power row (the candidate took no governing position).
    abstain.candRows = abstain.candRows.filter(
      (r) => !(r.axis_kind === 'proposition' && r.axis_id === 'labor_power'),
    );

    const voterVec = buildVoterAxisVector(vo.voterAnswers);
    const fullVec = withFlag('true', () => selectPositionsForView(full.candRows as never, 'inferred')).positions;
    const dropVec = withFlag('true', () => selectPositionsForView(abstain.candRows as never, 'inferred')).positions;

    const rFull = withFlag('true', () => weightedL1Score(voterVec, fullVec, evenWeights(), SUBDIMS, weights));
    const rDrop = withFlag('true', () => weightedL1Score(voterVec, dropVec, evenWeights(), SUBDIMS, weights));
    expect(rDrop.answered_both_count).toBe(rFull.answered_both_count - 1);
    expect(rDrop.score).not.toBeNull(); // still scores on the remaining axes
  });
});
