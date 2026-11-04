import { describe, it, expect } from 'vitest';
import {
  isSelfStated,
  isRenderablePosition,
  shouldShowGatheringState,
  type GatePosition,
} from '../display-gate';

const pos = (
  view_type: string,
  confidence: string,
): GatePosition => ({ view_type, confidence });

describe('isSelfStated', () => {
  it('is true only for stated + candidate_direct', () => {
    expect(isSelfStated(pos('stated', 'candidate_direct'))).toBe(true);
  });
  it('is false for inferred candidate_direct (view must be stated)', () => {
    expect(isSelfStated(pos('inferred', 'candidate_direct'))).toBe(false);
  });
  it('is false for stated high (not candidate_direct)', () => {
    expect(isSelfStated(pos('stated', 'high'))).toBe(false);
  });
});

describe('isRenderablePosition', () => {
  it('renders self-stated words', () => {
    expect(isRenderablePosition(pos('stated', 'candidate_direct'))).toBe(true);
  });
  it('renders high-confidence inferred', () => {
    expect(isRenderablePosition(pos('inferred', 'high'))).toBe(true);
  });
  it('renders medium-confidence inferred', () => {
    expect(isRenderablePosition(pos('inferred', 'medium'))).toBe(true);
  });
  it('does NOT render low-confidence (thin/single weak citation)', () => {
    expect(isRenderablePosition(pos('inferred', 'low'))).toBe(false);
  });
  it('does NOT render no_data / insufficient_overlap', () => {
    expect(isRenderablePosition(pos('inferred', 'no_data'))).toBe(false);
    expect(isRenderablePosition(pos('inferred', 'insufficient_overlap'))).toBe(false);
  });
});

describe('shouldShowGatheringState', () => {
  it('Tier A never shows the gathering stub', () => {
    expect(shouldShowGatheringState('A', [])).toBe(false);
    expect(shouldShowGatheringState('A', [pos('inferred', 'low')])).toBe(false);
  });

  it('Tier B never shows the gathering stub', () => {
    expect(shouldShowGatheringState('B', [])).toBe(false);
  });

  it('Tier C with NO positions shows the gathering stub (honest empty state)', () => {
    expect(shouldShowGatheringState('C', [])).toBe(true);
  });

  it('Tier C with only low-confidence positions still shows the gathering stub', () => {
    // (In the page these low rows are already dropped from candidate.positions
    // before the gate runs; even if present, they are not renderable.)
    expect(shouldShowGatheringState('C', [pos('inferred', 'low')])).toBe(true);
  });

  it('Tier C WITH a high-confidence inferred position renders positions (the AZ bug fix)', () => {
    // e.g. an AZ candidate whose entailment-passed positions are high-conf but
    // whose candidate_tier_view source_count is small -> Tier C.
    expect(
      shouldShowGatheringState('C', [
        pos('inferred', 'high'),
        pos('inferred', 'medium'),
      ]),
    ).toBe(false);
  });

  it('Tier C WITH a self-stated position renders positions (attestation carve-out)', () => {
    expect(
      shouldShowGatheringState('C', [pos('stated', 'candidate_direct')]),
    ).toBe(false);
  });

  it('Tier C with a mix falls through when at least one is renderable', () => {
    expect(
      shouldShowGatheringState('C', [
        pos('inferred', 'low'),
        pos('inferred', 'high'),
      ]),
    ).toBe(false);
  });
});
