/**
 * Offline unit tests for the G1 entailment-calibration MATH.
 *
 * Pure, deterministic fixtures. No model, no network, no DB. Covers:
 *   - normalizeLabel (3-way + 4-band vocab -> canonical tiers)
 *   - mergeLabels (human overrides agent; majority; conservative tie-break)
 *   - wilsonInterval / zForConfidence (finite-sample bounds)
 *   - calibScore (score scalars)
 *   - computeThresholds (split-conformal search: target met + target unmet)
 *   - scoreToBand, aucClearVsRest
 *   - loadCalibration (fixture file, malformed -> null)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeLabel,
  mergeLabels,
  wilsonInterval,
  zForConfidence,
  calibScore,
  computeThresholds,
  scoreToBand,
  aucClearVsRest,
  loadCalibration,
  isSkipLabel,
  calibrationLabelOf,
  bandToTier,
  assembleCalibrationGrade,
  auditAgreement,
  disputedCoverage,
  committeeReadiness,
  _resetCalibrationCache,
  type RawLabelRecord,
  type ScoredLabel,
  type ConsensusPairRecord,
} from '../entailment-calibration';

// ---------------------------------------------------------------------------
// normalizeLabel
// ---------------------------------------------------------------------------
describe('normalizeLabel', () => {
  it('maps the current 3-way vocabulary', () => {
    expect(normalizeLabel('supported')).toBe('clear');
    expect(normalizeLabel('not_supported')).toBe('reject');
    expect(normalizeLabel('unclear')).toBe('partial');
  });
  it('maps the future 4-band ordinal vocabulary', () => {
    expect(normalizeLabel('clearly supports')).toBe('clear');
    expect(normalizeLabel('partially or ambiguously supports')).toBe('partial');
    expect(normalizeLabel('unrelated')).toBe('reject');
    expect(normalizeLabel('contradicts')).toBe('reject');
  });
  it('is case / separator insensitive and rejects garbage', () => {
    expect(normalizeLabel('  Clearly_Supports ')).toBe('clear');
    expect(normalizeLabel('NOT SUPPORTED')).toBe('reject');
    expect(normalizeLabel('')).toBeNull();
    expect(normalizeLabel('banana')).toBeNull();
    expect(normalizeLabel(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isSkipLabel / calibrationLabelOf ("cannot verify from source" exclusion)
// ---------------------------------------------------------------------------
describe('isSkipLabel', () => {
  it('flags rows with a non-empty skip_reason', () => {
    expect(isSkipLabel({ band: null, skip_reason: 'dead link' })).toBe(true);
    expect(isSkipLabel({ band: 1, band_label: 'clearly_supports', skip_reason: 'paywall' })).toBe(true);
  });
  it('flags band:null rows that carry no usable label string', () => {
    expect(isSkipLabel({ band: null, band_label: null })).toBe(true);
    expect(isSkipLabel({ band: null })).toBe(true);
  });
  it('does NOT flag ordinary band labels', () => {
    expect(isSkipLabel({ band: 1, band_label: 'clearly_supports' })).toBe(false);
    expect(isSkipLabel({ band: 4, band_label: 'contradicts' })).toBe(false);
    expect(isSkipLabel({ label: 'supported' })).toBe(false);
    expect(isSkipLabel(null)).toBe(false);
    expect(isSkipLabel({ band: null, skip_reason: '   ' })).toBe(true); // whitespace-only reason still a skip (band null, no label)
  });
});

describe('calibrationLabelOf', () => {
  it('returns the band_label for ordinary 4-band rows', () => {
    expect(calibrationLabelOf({ band: 1, band_label: 'clearly_supports' })).toBe('clearly_supports');
    expect(calibrationLabelOf({ band: 4, band_label: 'contradicts' })).toBe('contradicts');
  });
  it('falls back to the legacy label field', () => {
    expect(calibrationLabelOf({ label: 'supported' })).toBe('supported');
  });
  it('returns null for skip rows so they are excluded from calibration', () => {
    expect(calibrationLabelOf({ band: null, skip_reason: 'video unscrubable' })).toBeNull();
    expect(calibrationLabelOf({ band: null })).toBeNull();
    expect(calibrationLabelOf(null)).toBeNull();
  });
  it('end to end: mergeLabels drops skip rows via calibrationLabelOf', () => {
    const rows = [
      { key: 'A', band: 1, band_label: 'clearly_supports' },
      { key: 'B', band: null, skip_reason: 'dead link' },
      { key: 'C', band: 4, band_label: 'contradicts' },
    ];
    const records: RawLabelRecord[] = rows
      .map((r) => ({ key: r.key, label: calibrationLabelOf(r), provenance: 'human' as const }))
      .filter((r) => r.label != null);
    const merged = mergeLabels(records);
    expect([...merged.keys()].sort()).toEqual(['A', 'C']); // B (skip) excluded
    expect(merged.get('A')!.tier).toBe('clear');
    expect(merged.get('C')!.tier).toBe('reject');
  });
});

// ---------------------------------------------------------------------------
// mergeLabels
// ---------------------------------------------------------------------------
describe('mergeLabels', () => {
  const rec = (key: string, label: string, provenance: 'human' | 'agent'): RawLabelRecord => ({ key, label, provenance });

  it('human overrides agent', () => {
    const m = mergeLabels([rec('A', 'supported', 'human'), rec('A', 'not_supported', 'agent')]);
    expect(m.get('A')!.tier).toBe('clear');
    expect(m.get('A')!.provenance).toBe('human');
  });
  it('falls back to agent when no human label exists', () => {
    const m = mergeLabels([rec('B', 'unclear', 'agent')]);
    expect(m.get('B')!.tier).toBe('partial');
    expect(m.get('B')!.provenance).toBe('agent');
  });
  it('takes the human majority', () => {
    const m = mergeLabels([
      rec('C', 'supported', 'human'),
      rec('C', 'supported', 'human'),
      rec('C', 'unclear', 'human'),
    ]);
    expect(m.get('C')!.tier).toBe('clear');
    expect(m.get('C')!.agreement).toEqual({ winning: 2, total: 3 });
  });
  it('breaks ties toward the more conservative tier', () => {
    // clear vs partial tie -> partial; partial vs reject tie -> reject.
    expect(mergeLabels([rec('D', 'supported', 'human'), rec('D', 'unclear', 'human')]).get('D')!.tier).toBe('partial');
    expect(mergeLabels([rec('E', 'unclear', 'human'), rec('E', 'not_supported', 'human')]).get('E')!.tier).toBe('reject');
  });
});

// ---------------------------------------------------------------------------
// Committee-consensus calibration assembly (bandToTier, assembleCalibrationGrade,
// auditAgreement, disputedCoverage, committeeReadiness)
// ---------------------------------------------------------------------------
describe('bandToTier', () => {
  it('maps the 4-band ordinal to canonical tiers (3 and 4 both reject)', () => {
    expect(bandToTier(1)).toBe('clear');
    expect(bandToTier(2)).toBe('partial');
    expect(bandToTier(3)).toBe('reject'); // unrelated
    expect(bandToTier(4)).toBe('reject'); // contradicts
    expect(bandToTier(0)).toBeNull();
    expect(bandToTier(null)).toBeNull();
    expect(bandToTier(undefined)).toBeNull();
  });
});

// Fixture builder: a consensus-2026-07.json pair record.
function cp(
  pair_id: string,
  proposal_band: number | null,
  skeptic_band: number | null,
  tier: 'consensus' | 'disputed' | 'incomparable',
  adjudication_reason: 'disputed' | 'audit' | null = null,
): ConsensusPairRecord {
  return {
    pair_id,
    proposal_band,
    skeptic_band,
    agreement: proposal_band != null && proposal_band === skeptic_band,
    tier,
    in_adjudication_queue: tier === 'disputed' || adjudication_reason === 'audit',
    adjudication_reason,
  };
}

// A small committee: 2 plain consensus, 2 audit-consensus, 2 disputed, 1 incomparable.
const COMMITTEE: ConsensusPairRecord[] = [
  cp('c1', 1, 1, 'consensus'),
  cp('c2', 2, 2, 'consensus'),
  cp('a1', 1, 1, 'consensus', 'audit'),
  cp('a2', 3, 3, 'consensus', 'audit'),
  cp('d1', 1, 2, 'disputed', 'disputed'),
  cp('d2', 3, 4, 'disputed', 'disputed'),
  cp('i1', null, 1, 'incomparable'),
];

describe('assembleCalibrationGrade', () => {
  it('with no human labels: only consensus pairs contribute (disputed + incomparable excluded)', () => {
    const g = assembleCalibrationGrade(COMMITTEE, new Map());
    expect([...g.keys()].sort()).toEqual(['a1', 'a2', 'c1', 'c2']);
    expect(g.get('c1')!.provenance).toBe('consensus');
    expect(g.get('c1')!.tier).toBe('clear'); // band 1
    expect(g.get('a2')!.tier).toBe('reject'); // band 3
    expect(g.size).toBe(4);
  });

  it('human labels win over consensus (audit overturn) and add adjudicated disputed pairs', () => {
    const human = new Map<string, number>([
      ['a1', 2], // overturns the consensus band 1 -> becomes human partial
      ['d1', 4], // adjudicates a disputed pair -> human reject
    ]);
    const g = assembleCalibrationGrade(COMMITTEE, human);
    expect(g.get('a1')!.provenance).toBe('human');
    expect(g.get('a1')!.band).toBe(2);
    expect(g.get('a1')!.tier).toBe('partial');
    expect(g.get('d1')!.provenance).toBe('human');
    expect(g.get('d1')!.tier).toBe('reject'); // band 4
    // d2 still disputed with no human -> excluded; i1 incomparable -> excluded.
    expect(g.has('d2')).toBe(false);
    expect(g.has('i1')).toBe(false);
    expect([...g.keys()].sort()).toEqual(['a1', 'a2', 'c1', 'c2', 'd1']);
  });

  it('a human label for a pair absent from the consensus list still lands', () => {
    const g = assembleCalibrationGrade([], new Map([['x', 1]]));
    expect(g.get('x')!.provenance).toBe('human');
    expect(g.get('x')!.tier).toBe('clear');
  });
});

describe('auditAgreement', () => {
  it('counts only adjudicated audit pairs; agreement = human band == consensus band', () => {
    // a1 human 1 (agrees with consensus 1); a2 human 3 (agrees). rate 2/2.
    let a = auditAgreement(COMMITTEE, new Map([['a1', 1], ['a2', 3]]));
    expect(a).toEqual({ audited: 2, agreed: 2, rate: 1 });
    // a1 human 2 (disagrees); a2 not adjudicated. rate 0/1.
    a = auditAgreement(COMMITTEE, new Map([['a1', 2]]));
    expect(a).toEqual({ audited: 1, agreed: 0, rate: 0 });
    // no audit pairs adjudicated -> vacuous 0 rate (readiness treats as not met).
    a = auditAgreement(COMMITTEE, new Map([['c1', 1]]));
    expect(a).toEqual({ audited: 0, agreed: 0, rate: 0 });
  });
});

describe('disputedCoverage', () => {
  it('reports adjudicated/total and allAdjudicated only when every disputed pair is covered', () => {
    expect(disputedCoverage(COMMITTEE, new Map())).toEqual({ disputed: 2, adjudicated: 0, allAdjudicated: false });
    expect(disputedCoverage(COMMITTEE, new Map([['d1', 4]]))).toEqual({ disputed: 2, adjudicated: 1, allAdjudicated: false });
    expect(disputedCoverage(COMMITTEE, new Map([['d1', 4], ['d2', 3]]))).toEqual({ disputed: 2, adjudicated: 2, allAdjudicated: true });
    // No disputed pairs at all -> vacuously all-adjudicated.
    expect(disputedCoverage([cp('c1', 1, 1, 'consensus')], new Map()).allAdjudicated).toBe(true);
  });
});

describe('committeeReadiness', () => {
  const targets = { auditAgreementFloor: 0.9, calibrationGradeFloor: 4 };

  it('is NOT ready until all three conditions hold', () => {
    // Nothing adjudicated: disputed uncovered, audit rate 0. Not ready.
    const r0 = committeeReadiness(COMMITTEE, new Map(), targets);
    expect(r0.allDisputedAdjudicated).toBe(false);
    expect(r0.auditAgreementMet).toBe(false);
    expect(r0.calibrationGradeMet).toBe(true); // 4 consensus grade labels >= floor 4
    expect(r0.ready).toBe(false);
  });

  it('is ready when disputed fully adjudicated, audit agreement clears the floor, and grade meets the floor', () => {
    // Adjudicate both disputed (agreeing with the audit sample) + audit pairs agree.
    const human = new Map<string, number>([
      ['d1', 1],
      ['d2', 3],
      ['a1', 1], // audit agree
      ['a2', 3], // audit agree
    ]);
    const r = committeeReadiness(COMMITTEE, human, targets);
    expect(r.detail.disputed.allAdjudicated).toBe(true);
    expect(r.detail.audit.rate).toBe(1);
    expect(r.auditAgreementMet).toBe(true);
    // calibration-grade = c1,c2 (consensus) + a1,a2,d1,d2 (human) = 6 >= 4.
    expect(r.detail.calibrationGradeTotal).toBe(6);
    expect(r.detail.humanCount).toBe(4);
    expect(r.detail.consensusCount).toBe(2);
    expect(r.ready).toBe(true);
  });

  it('audit agreement below the floor blocks readiness even with disputes adjudicated', () => {
    const human = new Map<string, number>([['d1', 1], ['d2', 3], ['a1', 2], ['a2', 3]]); // a1 disagrees -> 1/2 = 50%
    const r = committeeReadiness(COMMITTEE, human, targets);
    expect(r.allDisputedAdjudicated).toBe(true);
    expect(r.auditAgreementMet).toBe(false);
    expect(r.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wilsonInterval / zForConfidence
// ---------------------------------------------------------------------------
describe('wilsonInterval', () => {
  it('matches the known 8/10 @95% interval', () => {
    const { lo, hi } = wilsonInterval(8, 10, 1.959964);
    expect(lo).toBeCloseTo(0.49, 2);
    expect(hi).toBeCloseTo(0.943, 2);
  });
  it('perfect proportion still has a finite-sample lower bound < 1', () => {
    // k=n=10 -> lo = n/(n+z^2) ~ 0.7225.
    const { lo, hi } = wilsonInterval(10, 10);
    expect(lo).toBeCloseTo(0.7225, 3);
    expect(hi).toBeCloseTo(1, 6);
  });
  it('n=0 returns the vacuous [0,1]', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 1, p: 0 });
  });
});

describe('zForConfidence', () => {
  it('returns standard multipliers', () => {
    expect(zForConfidence(0.95)).toBeCloseTo(1.959964, 5);
    expect(zForConfidence(0.9)).toBeCloseTo(1.644854, 5);
    expect(zForConfidence(0.42)).toBeCloseTo(1.959964, 5); // fallback
  });
});

// ---------------------------------------------------------------------------
// calibScore
// ---------------------------------------------------------------------------
describe('calibScore', () => {
  const r = { score: 0.2, scores: { entail: 0.2, contradict: 0.1, neutral: 0.7 } };
  it('entail uses the raw score', () => {
    expect(calibScore(r, 'entail')).toBeCloseTo(0.2, 6);
  });
  it('support_mass = entail + 0.5*neutral', () => {
    expect(calibScore(r, 'support_mass')).toBeCloseTo(0.55, 6);
  });
  it('support_margin = entail + 0.5*neutral - contradict', () => {
    expect(calibScore(r, 'support_margin')).toBeCloseTo(0.45, 6);
  });
  it('entail_minus_contradict maps [-1,1] to [0,1]', () => {
    expect(calibScore(r, 'entail_minus_contradict')).toBeCloseTo((0.2 - 0.1 + 1) / 2, 6);
  });
  it('falls back to score when the distribution is absent', () => {
    expect(calibScore({ score: 0.3 }, 'support_mass')).toBeCloseTo(0.3, 6);
  });
});

// ---------------------------------------------------------------------------
// computeThresholds
// ---------------------------------------------------------------------------
function make(n: number, score: number, tier: ScoredLabel['tier']): ScoredLabel[] {
  return Array.from({ length: n }, () => ({ score, tier }));
}

describe('computeThresholds', () => {
  it('finds a precision-guaranteed upper and a loss-bounded lower with a real middle band', () => {
    // 100 clear @0.9 ; (90 partial + 10 clear) @0.5 ; 100 reject @0.1.
    const data: ScoredLabel[] = [
      ...make(100, 0.9, 'clear'),
      ...make(90, 0.5, 'partial'),
      ...make(10, 0.5, 'clear'),
      ...make(100, 0.1, 'reject'),
    ];
    const r = computeThresholds(data, { voterVisiblePrecision: 0.95, confidence: 0.95, abstainClearLoss: 0.05 });
    expect(r.thresholds.upper).toBeCloseTo(0.9, 6);
    expect(r.thresholds.lower).toBeCloseTo(0.5, 6);
    expect(r.meetsUpperTarget).toBe(true);
    expect(r.meetsLowerTarget).toBe(true);
    expect(r.bands.voter_visible.n).toBe(100);
    expect(r.bands.voter_visible.precision).toBeCloseTo(1, 6);
    expect(r.bands.candidate_confirm.n).toBe(100);
    expect(r.bands.abstain.n).toBe(100);
  });

  it('reports meetsUpperTarget=false when N is too small to certify the precision', () => {
    // 5 perfect clears cannot certify 95% (Wilson lower bound ~0.565).
    const data: ScoredLabel[] = [...make(5, 0.9, 'clear'), ...make(5, 0.1, 'reject')];
    const r = computeThresholds(data);
    expect(r.meetsUpperTarget).toBe(false);
    // Best-available cut is still the high-precision one.
    expect(r.thresholds.upper).toBeCloseTo(0.9, 6);
  });

  it('never lets the abstain cut exceed the voter-visible cut', () => {
    const data: ScoredLabel[] = [...make(3, 0.8, 'clear'), ...make(3, 0.2, 'reject')];
    const r = computeThresholds(data);
    expect(r.thresholds.lower).toBeLessThanOrEqual(r.thresholds.upper);
  });
});

// ---------------------------------------------------------------------------
// scoreToBand / aucClearVsRest
// ---------------------------------------------------------------------------
describe('scoreToBand', () => {
  const th = { upper: 0.9, lower: 0.5 };
  it('routes on the two thresholds', () => {
    expect(scoreToBand(0.95, th)).toBe('voter_visible');
    expect(scoreToBand(0.9, th)).toBe('voter_visible');
    expect(scoreToBand(0.7, th)).toBe('candidate_confirm');
    expect(scoreToBand(0.5, th)).toBe('candidate_confirm');
    expect(scoreToBand(0.3, th)).toBe('abstain');
  });
});

describe('aucClearVsRest', () => {
  it('is 1.0 for perfect separation and 0.0 when reversed', () => {
    const good: ScoredLabel[] = [...make(5, 0.9, 'clear'), ...make(5, 0.1, 'reject')];
    expect(aucClearVsRest(good)).toBeCloseTo(1, 6);
    const bad: ScoredLabel[] = [...make(5, 0.1, 'clear'), ...make(5, 0.9, 'reject')];
    expect(aucClearVsRest(bad)).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// loadCalibration
// ---------------------------------------------------------------------------
describe('loadCalibration', () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* best effort */
      }
    }
    paths.length = 0;
    _resetCalibrationCache();
  });

  it('loads valid thresholds from a fixture file', () => {
    const p = join(tmpdir(), `calib-ok-${Date.now()}.json`);
    paths.push(p);
    writeFileSync(p, JSON.stringify({ thresholds: { upper: 0.8, lower: 0.3 }, score_kind: 'entail', backend_model: 'onnx:test' }));
    const c = loadCalibration(p);
    expect(c).not.toBeNull();
    expect(c!.thresholds).toEqual({ upper: 0.8, lower: 0.3 });
    expect(c!.score_kind).toBe('entail');
  });

  it('returns null for a missing file (gate falls back to defaults)', () => {
    expect(loadCalibration(join(tmpdir(), 'definitely-missing-calib.json'))).toBeNull();
  });

  it('returns null when lower > upper (invalid ordering)', () => {
    const p = join(tmpdir(), `calib-bad-${Date.now()}.json`);
    paths.push(p);
    writeFileSync(p, JSON.stringify({ thresholds: { upper: 0.2, lower: 0.9 } }));
    expect(loadCalibration(p)).toBeNull();
  });
});
