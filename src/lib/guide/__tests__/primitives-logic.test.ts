/**
 * Logic-level tests for the WAVE-1 display primitives.
 *
 * The vitest environment here is `node` (no jsdom / React Testing Library in
 * this repo), so we cannot mount the JSX. Instead we test the pure helpers the
 * primitives export and depend on — the parts that carry real branching logic
 * (freshness-state derivation, match-verdict mapping, tier derivation). The
 * remaining primitives (ScopeChip/BetaChip/skeletons) are pure presentational
 * markup with no branching beyond count pluralization, covered by typecheck.
 */
import { describe, it, expect } from 'vitest';
import {
  freshnessFromMonths,
  verdictFromDelta,
  type FreshnessState,
  type MatchVerdict,
} from '@/components/guide/primitives';

describe('freshnessFromMonths (FreshnessChip TTL, Round-2 policy)', () => {
  it('<=6 months is fresh', () => {
    expect(freshnessFromMonths(0)).toBe<FreshnessState>('fresh');
    expect(freshnessFromMonths(4)).toBe('fresh');
    expect(freshnessFromMonths(6)).toBe('fresh');
  });

  it('6-18 months is aging (confidence drops a tier upstream)', () => {
    expect(freshnessFromMonths(7)).toBe<FreshnessState>('aging');
    expect(freshnessFromMonths(11)).toBe('aging');
    expect(freshnessFromMonths(18)).toBe('aging');
  });

  it('>18 months is stale (needs refresh)', () => {
    expect(freshnessFromMonths(19)).toBe<FreshnessState>('stale');
    expect(freshnessFromMonths(22)).toBe('stale');
    expect(freshnessFromMonths(120)).toBe('stale');
  });
});

describe('verdictFromDelta (MatchChip F2)', () => {
  it('null delta reads as unknown / no-data', () => {
    expect(verdictFromDelta(null)).toBe<MatchVerdict>('unknown');
  });

  it('small deltas are agreement, large deltas are disagreement', () => {
    expect(verdictFromDelta(0.05)).toBe('strong-agree');
    expect(verdictFromDelta(0.2)).toBe('agree');
    expect(verdictFromDelta(0.4)).toBe('partial');
    expect(verdictFromDelta(0.6)).toBe('disagree');
    expect(verdictFromDelta(0.9)).toBe('strong-disagree');
  });

  it('is monotonic: bigger distance never reads as a stronger match', () => {
    const order: MatchVerdict[] = [
      'strong-agree',
      'agree',
      'partial',
      'disagree',
      'strong-disagree',
    ];
    const deltas = [0, 0.15, 0.35, 0.5, 0.8, 1];
    const verdicts = deltas.map(verdictFromDelta);
    const rank = (v: MatchVerdict) => order.indexOf(v);
    for (let i = 1; i < verdicts.length; i++) {
      expect(rank(verdicts[i])).toBeGreaterThanOrEqual(rank(verdicts[i - 1]));
    }
  });
});
