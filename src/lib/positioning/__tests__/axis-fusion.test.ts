/**
 * Unit tests for the deterministic axis-fusion module (doc 07 section 2.6).
 *
 * Vitest is configured with `globals: false` (see vitest.config.ts), so we
 * import describe/it/expect explicitly. The positioning test path is added to
 * the vitest `include` allow-list so `npm test` picks this up.
 *
 * Coverage (per the build brief):
 *   - the four canonical cases (many agreeing distinct sources -> strong + high
 *     strength; single mild mention -> moderate + low strength; many disagreeing
 *     -> middle + low strength; one strong tier-1 -> strong band, low strength)
 *   - the sum(w)==0 -> null guard
 *   - abstains_governing excluded from fusion
 *   - the per-domain diversity cap stops self-published flooding
 *   - slow decay for is_action vs fast decay for statements
 */
import { describe, it, expect } from 'vitest';
import {
  fuseDirection,
  fuseAxis,
  positionStrength,
  perSignalWeight,
  bandFor,
  ageInMonths,
  clamp01,
  roundToBand,
  MAX_SINGLE_SOURCE_SHARE,
  type PerSignalRecord,
} from '../axis-fusion';

// A fixed "now" so every age/decay computation is deterministic.
const NOW = '2026-06-14T00:00:00.000Z';

/** Build a graded signal with sensible defaults; override what each test cares about. */
function sig(overrides: Partial<PerSignalRecord> = {}): PerSignalRecord {
  return {
    position_kind: 'graded',
    direction: 0.9,
    authenticity_tier: 1,
    source_type: 'campaign_website',
    source_domain: 'example-campaign.com',
    actor: 'candidate_self',
    recency: '2026-05-01',
    is_action: false,
    inputs_hash: undefined,
    calibration_version: 'rubric-v1',
    ...overrides,
  };
}

// ===========================================================================
// Band derivation (sanity for the cutoffs the canonical cases assert against)
// ===========================================================================

describe('bandFor', () => {
  it('is symmetric about 0.50 and respects the dead-band', () => {
    expect(bandFor(0.5)).toBe('neutral');
    expect(bandFor(0.51)).toBe('neutral'); // inside the 0.02 dead-band
    expect(bandFor(0.6)).toBe('lean');
    expect(bandFor(0.4)).toBe('lean');
    expect(bandFor(0.75)).toBe('support');
    expect(bandFor(0.25)).toBe('support');
    expect(bandFor(0.9)).toBe('strong');
    expect(bandFor(0.05)).toBe('strong');
  });
});

describe('clamp01 / roundToBand', () => {
  it('clamps out-of-range and NaN, snaps to 3 decimals', () => {
    expect(clamp01(1.4)).toBe(1);
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(roundToBand(0.123456)).toBe(0.123);
    expect(roundToBand(1.7)).toBe(1);
  });
});

// ===========================================================================
// Canonical case 1: many agreeing distinct sources -> strong + high strength
// ===========================================================================

describe('canonical case 1: many agreeing distinct sources', () => {
  // Six distinct (actor, domain) groups, all near 0.92, all recent, tier 1/2.
  const signals: PerSignalRecord[] = [
    sig({ direction: 0.92, source_domain: 'janeforsenate.com', actor: 'candidate_self' }),
    sig({ direction: 0.9, source_domain: 'tribune.example', actor: 'named_outlet:tribune', authenticity_tier: 2, source_type: 'news' }),
    sig({ direction: 0.93, source_domain: 'gazette.example', actor: 'named_outlet:gazette', authenticity_tier: 2, source_type: 'news' }),
    sig({ direction: 0.91, source_domain: 'debate.example', actor: 'named_outlet:debate', authenticity_tier: 2, source_type: 'debate' }),
    sig({ direction: 0.9, source_domain: 'oped.example', actor: 'candidate_self', source_type: 'op_ed' }),
    sig({ direction: 0.94, source_domain: 'press.example', actor: 'candidate_self', source_type: 'press_release' }),
  ];

  it('fuses to a strong band', () => {
    const dir = fuseDirection(signals, NOW)!;
    expect(dir).toBeGreaterThanOrEqual(0.85);
    expect(bandFor(dir)).toBe('strong');
  });

  it('yields high position_strength (saturated count, high concordance)', () => {
    const s = positionStrength(signals, NOW);
    expect(s.signal_count).toBe(6); // six distinct groups -> count_factor saturates
    expect(s.signal_concordance).toBeGreaterThan(0.95); // tight agreement
    expect(s.position_strength!).toBeGreaterThan(0.85);
    expect(s.may_be_outdated).toBe(false);
  });
});

// ===========================================================================
// Canonical case 2: a single mild mention -> moderate + LOW strength
// ===========================================================================

describe('canonical case 2: single mild mention', () => {
  const signals: PerSignalRecord[] = [
    sig({ direction: 0.62 }), // one mild lean-high signal
  ];

  it('fuses to the (mild) direction it was given', () => {
    const dir = fuseDirection(signals, NOW)!;
    expect(dir).toBeCloseTo(0.62, 5);
    expect(bandFor(dir)).toBe('lean');
  });

  it('has LOW strength: concordance is 0 for n<2 and count_factor is tiny', () => {
    const s = positionStrength(signals, NOW);
    expect(s.signal_count).toBe(1);
    expect(s.signal_concordance).toBe(0); // M5: 0 for fewer than 2
    // count_factor = 1/6 ~ 0.167, concordance 0, tier_factor 1.0
    // strength ~ 0.45*0.167 + 0.40*0 + 0.15*1.0 ~ 0.225
    expect(s.position_strength!).toBeLessThan(0.35);
  });
});

// ===========================================================================
// Canonical case 3: many DISAGREEING signals -> middle + low strength
// ===========================================================================

describe('canonical case 3: many disagreeing signals', () => {
  // Distinct sources but directions spread across the whole spectrum.
  const signals: PerSignalRecord[] = [
    sig({ direction: 0.05, source_domain: 'a.example', actor: 'named_outlet:a', authenticity_tier: 2, source_type: 'news' }),
    sig({ direction: 0.95, source_domain: 'b.example', actor: 'named_outlet:b', authenticity_tier: 2, source_type: 'news' }),
    sig({ direction: 0.1, source_domain: 'c.example', actor: 'named_outlet:c', authenticity_tier: 2, source_type: 'news' }),
    sig({ direction: 0.9, source_domain: 'd.example', actor: 'named_outlet:d', authenticity_tier: 2, source_type: 'news' }),
  ];

  // The agreeing case from canonical case 1, for a direct strength comparison.
  const agreeing: PerSignalRecord[] = [
    sig({ direction: 0.05, source_domain: 'a.example', actor: 'named_outlet:a', authenticity_tier: 2, source_type: 'news' }),
    sig({ direction: 0.07, source_domain: 'b.example', actor: 'named_outlet:b', authenticity_tier: 2, source_type: 'news' }),
    sig({ direction: 0.06, source_domain: 'c.example', actor: 'named_outlet:c', authenticity_tier: 2, source_type: 'news' }),
    sig({ direction: 0.08, source_domain: 'd.example', actor: 'named_outlet:d', authenticity_tier: 2, source_type: 'news' }),
  ];

  it('fuses near the middle of the spectrum', () => {
    const dir = fuseDirection(signals, NOW)!;
    expect(dir).toBeGreaterThan(0.35);
    expect(dir).toBeLessThan(0.65);
  });

  it('has collapsed concordance and lower strength than the same sources agreeing', () => {
    const disagree = positionStrength(signals, NOW);
    const agree = positionStrength(agreeing, NOW);
    // Same count_factor and tier_factor on both sets, so the ONLY thing that
    // moves strength is concordance. The wide spread collapses it.
    expect(disagree.signal_concordance!).toBeLessThan(0.6); // big stddev -> low concordance
    expect(agree.signal_concordance!).toBeGreaterThan(0.95); // tight agreement
    // Disagreement must read as a strictly weaker (less reliable) position than
    // the identical-evidence-volume agreeing case.
    expect(disagree.position_strength!).toBeLessThan(agree.position_strength!);
  });
});

// ===========================================================================
// Canonical case 4: one strong tier-1 statement, nothing else
//   -> strong BAND, but low strength (thin corroboration)
// ===========================================================================

describe('canonical case 4: one strong tier-1 statement only', () => {
  const signals: PerSignalRecord[] = [
    sig({ direction: 0.96, authenticity_tier: 1, source_type: 'op_ed' }),
  ];

  it('lands in the strong band', () => {
    const dir = fuseDirection(signals, NOW)!;
    expect(bandFor(dir)).toBe('strong');
  });

  it('but reports only low strength (count 1, concordance 0)', () => {
    const s = positionStrength(signals, NOW);
    expect(s.signal_count).toBe(1);
    expect(s.signal_concordance).toBe(0);
    expect(s.position_strength!).toBeLessThan(0.35);
  });
});

// ===========================================================================
// sum(w) == 0 -> null guard (M5)
// ===========================================================================

describe('sum(w)==0 -> null guard (M5)', () => {
  it('returns null when there are no signals at all', () => {
    expect(fuseDirection([], NOW)).toBeNull();
  });

  it('returns null when every signal is an abstention (no graded signals)', () => {
    const signals: PerSignalRecord[] = [
      sig({ position_kind: 'abstains_governing', direction: null }),
      sig({ position_kind: 'abstains_governing', direction: null, source_domain: 'b.example' }),
    ];
    expect(fuseDirection(signals, NOW)).toBeNull();
  });

  it('an ancient statement decays to a tiny weight but still places when it is the only signal', () => {
    // A statement from the year 1900: recency_weight ~ 0.5^(~1517 months / 18),
    // an extremely small but non-zero float (~1e-26). It does not underflow to
    // exactly 0, so a lone ancient signal still places its direction (it is all
    // we have). The true sum(w)==0 -> null guard is exercised by the empty and
    // all-abstention cases above, which produce a genuinely empty graded set.
    const signals: PerSignalRecord[] = [sig({ direction: 0.9, recency: '1900-01-01' })];
    expect(fuseDirection(signals, NOW)).toBe(0.9);
  });

  it('fuseAxis surfaces null direction with abstains_governing kind when abstentions were the only input', () => {
    const signals: PerSignalRecord[] = [
      sig({ position_kind: 'abstains_governing', direction: null }),
    ];
    const r = fuseAxis(signals, NOW);
    expect(r.direction).toBeNull();
    expect(r.band).toBeNull();
    expect(r.position_kind).toBe('abstains_governing');
  });
});

// ===========================================================================
// abstains_governing excluded from fusion (C1)
// ===========================================================================

describe('abstains_governing is excluded from fusion (C1)', () => {
  it('an abstention does not pull a graded direction toward 0.50', () => {
    const withAbstention: PerSignalRecord[] = [
      sig({ direction: 0.9, source_domain: 'a.example', actor: 'candidate_self' }),
      sig({ position_kind: 'abstains_governing', direction: null, source_domain: 'b.example', actor: 'candidate_self' }),
    ];
    const withoutAbstention: PerSignalRecord[] = [
      sig({ direction: 0.9, source_domain: 'a.example', actor: 'candidate_self' }),
    ];
    // The abstention must be invisible to the math: identical fused direction.
    expect(fuseDirection(withAbstention, NOW)).toBe(fuseDirection(withoutAbstention, NOW));
  });

  it('abstentions do not count toward signal_count', () => {
    const signals: PerSignalRecord[] = [
      sig({ direction: 0.9, source_domain: 'a.example' }),
      sig({ position_kind: 'abstains_governing', direction: null, source_domain: 'b.example' }),
      sig({ position_kind: 'abstains_governing', direction: null, source_domain: 'c.example' }),
    ];
    const s = positionStrength(signals, NOW);
    expect(s.signal_count).toBe(1); // only the one graded signal's group
  });

  it('a purely balanced signal set fuses to 0.50 and reports balanced', () => {
    const signals: PerSignalRecord[] = [
      sig({ position_kind: 'balanced', direction: 0.5, source_domain: 'a.example' }),
      sig({ position_kind: 'balanced', direction: 0.5, source_domain: 'b.example', actor: 'named_outlet:b' }),
    ];
    const r = fuseAxis(signals, NOW);
    expect(r.direction).toBe(0.5);
    expect(r.position_kind).toBe('balanced');
    expect(r.band).toBe('neutral');
  });
});

// ===========================================================================
// Per-domain diversity cap stops self-published flooding (M1)
// ===========================================================================

describe('per-domain diversity cap (M1)', () => {
  it('forty self-reposts from one domain cannot outvote one opposing distinct source', () => {
    // One campaign domain floods 40 strong-high (0.95) signals; a single distinct
    // outlet says strong-low (0.05). Without the cap, the flood would dominate and
    // pull the fused direction to ~0.93. With the cap, the flooding domain is held
    // to MAX_SINGLE_SOURCE_SHARE of the weight, so it cannot run away.
    const flood: PerSignalRecord[] = Array.from({ length: 40 }, (_, i) =>
      sig({
        direction: 0.95,
        source_domain: 'flood-campaign.com',
        actor: 'candidate_self',
        // Distinct hashes so dedup does NOT collapse them; the cap (not dedup) must do the work.
        inputs_hash: `flood-${i}`,
      }),
    );
    const opposing = sig({
      direction: 0.05,
      source_domain: 'independent-outlet.example',
      actor: 'named_outlet:independent',
      authenticity_tier: 2,
      source_type: 'news',
    });

    const fused = fuseDirection([...flood, opposing], NOW)!;
    // The flooding domain is capped at 0.4 of total weight, so its 0.95 cannot
    // dominate: the fused direction is pulled well below a naive flood-weighted mean.
    expect(fused).toBeLessThan(0.75);

    // And the flooding domain still counts as ONE distinct outlet for strength.
    const s = positionStrength([...flood, opposing], NOW);
    expect(s.signal_count).toBe(2); // flood-campaign + independent-outlet
  });

  it('exact-duplicate hashes within a group are deduped to one before weighting', () => {
    const dupes: PerSignalRecord[] = [
      sig({ direction: 0.9, source_domain: 'x.example', actor: 'candidate_self', inputs_hash: 'same' }),
      sig({ direction: 0.9, source_domain: 'x.example', actor: 'candidate_self', inputs_hash: 'same' }),
      sig({ direction: 0.9, source_domain: 'x.example', actor: 'candidate_self', inputs_hash: 'same' }),
    ];
    const single: PerSignalRecord[] = [
      sig({ direction: 0.9, source_domain: 'x.example', actor: 'candidate_self', inputs_hash: 'same' }),
    ];
    // After dedup the three identical signals behave exactly like one.
    expect(fuseDirection(dupes, NOW)).toBe(fuseDirection(single, NOW));
    expect(positionStrength(dupes, NOW).signal_count).toBe(1);
  });

  it('the combined weight of any single group never exceeds the cap of the total', () => {
    // 10 signals from one domain + 1 from another. Verify the cap invariant via
    // fuseDirection's behavior: the lone opposing 0.0 signal must move the result
    // by at least (1 - MAX_SINGLE_SOURCE_SHARE) worth of pull relative to the flood.
    const flood = Array.from({ length: 10 }, (_, i) =>
      sig({ direction: 1.0, source_domain: 'one.example', actor: 'candidate_self', inputs_hash: `h${i}` }),
    );
    const lone = sig({ direction: 0.0, source_domain: 'two.example', actor: 'named_outlet:two', authenticity_tier: 2, source_type: 'news' });
    const fused = fuseDirection([...flood, lone], NOW)!;
    // Floor: the flood is capped at MAX_SINGLE_SOURCE_SHARE, the lone gets the rest,
    // so the fused value sits at most around MAX_SINGLE_SOURCE_SHARE * 1.0.
    expect(fused).toBeLessThanOrEqual(MAX_SINGLE_SOURCE_SHARE + 0.02);
  });
});

// ===========================================================================
// Slow decay for is_action vs fast for statements (M2)
// ===========================================================================

describe('recency decay: actions slow, statements fast (M2)', () => {
  it('a 36-month-old action retains far more weight than a 36-month-old statement', () => {
    const old = '2023-06-14'; // ~36 months before NOW
    const statementW = perSignalWeight(sig({ direction: 0.9, recency: old, is_action: false }), NOW);
    const actionW = perSignalWeight(
      sig({ direction: 0.9, recency: old, is_action: true, source_type: 'voting_record', authenticity_tier: 3 }),
      NOW,
    );
    // Statement half-life 18mo -> ~0.5^2 = 0.25 of its recency factor.
    // Action half-life 60mo -> ~0.5^0.6 = 0.66 of its recency factor.
    // Even though the action's tier_weight (0.9) differs from the statement's
    // (1.0), the action must end up heavier because its decay is far gentler.
    expect(actionW).toBeGreaterThan(statementW);
  });

  it('a recent statement outweighs the same-age statement when one is much older', () => {
    const recent = perSignalWeight(sig({ direction: 0.9, recency: '2026-05-01' }), NOW);
    const ancient = perSignalWeight(sig({ direction: 0.9, recency: '2020-01-01' }), NOW);
    expect(recent).toBeGreaterThan(ancient);
  });

  it('an action-only position that is old is flagged may_be_outdated but keeps usable strength', () => {
    const signals: PerSignalRecord[] = [
      sig({ direction: 0.85, recency: '2022-01-01', is_action: true, source_type: 'voting_record', authenticity_tier: 3, source_domain: 'congress.gov', actor: 'gov_record' }),
      sig({ direction: 0.88, recency: '2022-06-01', is_action: true, source_type: 'voting_record', authenticity_tier: 3, source_domain: 'openstates.org', actor: 'gov_record_state' }),
    ];
    const s = positionStrength(signals, NOW);
    expect(s.may_be_outdated).toBe(true); // newest signal > 18 months old
    expect(s.position_strength!).toBeGreaterThan(0); // halved by staleness, not zeroed
  });
});

// ===========================================================================
// ageInMonths helper edge cases
// ===========================================================================

describe('ageInMonths', () => {
  it('clamps future dates to 0 and parses ISO dates', () => {
    expect(ageInMonths('2027-01-01', NOW)).toBe(0);
    expect(ageInMonths(NOW, NOW)).toBe(0);
    expect(ageInMonths('2025-06-14', NOW)).toBeCloseTo(12, 0);
  });
});

// ===========================================================================
// Determinism: same inputs + same now -> identical output
// ===========================================================================

describe('determinism', () => {
  it('produces byte-identical results across repeated calls', () => {
    const signals: PerSignalRecord[] = [
      sig({ direction: 0.7, source_domain: 'a.example' }),
      sig({ direction: 0.8, source_domain: 'b.example', actor: 'named_outlet:b', authenticity_tier: 2, source_type: 'news' }),
    ];
    const a = fuseAxis(signals, NOW);
    const b = fuseAxis(signals, NOW);
    expect(a).toEqual(b);
  });
});
