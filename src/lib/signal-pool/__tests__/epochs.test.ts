/**
 * Epoch derivation + boundary-safe lengthening tests (Phase 3B, part 1; D3).
 */

import { describe, it, expect } from 'vitest';
import {
  EPOCH_ANCHOR_MS,
  currentEpochId,
  epochBounds,
  msUntilNextEpoch,
  epochLengthMs,
  defaultSchedule,
  activeSchedule,
  validateLengthening,
  epochIdForSchedule,
  type EpochSchedule,
} from '../epochs';

const WEEK = 7 * 24 * 60 * 60 * 1000;

describe('epoch derivation', () => {
  it('defaults to a weekly length', () => {
    expect(epochLengthMs({})).toBe(WEEK);
  });

  it('honors SIGNAL_POOL_EPOCH_LENGTH_MS override', () => {
    expect(epochLengthMs({ SIGNAL_POOL_EPOCH_LENGTH_MS: '86400000' })).toBe(86400000);
    // Garbage falls back to weekly.
    expect(epochLengthMs({ SIGNAL_POOL_EPOCH_LENGTH_MS: 'nope' })).toBe(WEEK);
    expect(epochLengthMs({ SIGNAL_POOL_EPOCH_LENGTH_MS: '-5' })).toBe(WEEK);
  });

  it('epoch 0 begins at the anchor; ids increase weekly', () => {
    expect(currentEpochId(EPOCH_ANCHOR_MS, WEEK)).toBe(0);
    expect(currentEpochId(EPOCH_ANCHOR_MS + WEEK, WEEK)).toBe(1);
    expect(currentEpochId(EPOCH_ANCHOR_MS + 3 * WEEK + 5, WEEK)).toBe(3);
    // Before the anchor clamps to 0.
    expect(currentEpochId(EPOCH_ANCHOR_MS - 1000, WEEK)).toBe(0);
  });

  it('epochBounds are contiguous and half-open', () => {
    const b0 = epochBounds(0, WEEK);
    const b1 = epochBounds(1, WEEK);
    expect(b0.endMs).toBe(b1.startMs);
    expect(b0.endMs - b0.startMs).toBe(WEEK);
  });

  it('msUntilNextEpoch counts down within a window', () => {
    const mid = EPOCH_ANCHOR_MS + WEEK + 1000;
    expect(msUntilNextEpoch(mid, WEEK)).toBe(WEEK - 1000);
  });
});

describe('boundary-safe lengthening (D3)', () => {
  const current: EpochSchedule = defaultSchedule({});

  it('shortening is always allowed live (validateLengthening only guards lengthening)', () => {
    const shorter: EpochSchedule = { ...current, lengthMs: WEEK / 7, generation: 1 };
    // A shorter length at any future boundary must be flagged as not-a-lengthening.
    const boundary = EPOCH_ANCHOR_MS + 5 * WEEK;
    const reason = validateLengthening(current, shorter, boundary, EPOCH_ANCHOR_MS + WEEK);
    expect(reason).toMatch(/shortening is safe live/);
  });

  it('rejects a cutover that is not on an exact current-schedule boundary', () => {
    const longer: EpochSchedule = { anchorMs: 0, lengthMs: 2 * WEEK, generation: 1 };
    const offBoundary = EPOCH_ANCHOR_MS + 5 * WEEK + 12345;
    const reason = validateLengthening(current, longer, offBoundary, EPOCH_ANCHOR_MS + WEEK);
    expect(reason).toMatch(/exact epoch boundary/);
  });

  it('rejects a cutover in the past', () => {
    const longer: EpochSchedule = { anchorMs: 0, lengthMs: 2 * WEEK, generation: 1 };
    const pastBoundary = EPOCH_ANCHOR_MS + WEEK;
    const reason = validateLengthening(current, longer, pastBoundary, EPOCH_ANCHOR_MS + 5 * WEEK);
    expect(reason).toMatch(/future/);
  });

  it('requires a strictly increasing generation', () => {
    const longer: EpochSchedule = { anchorMs: 0, lengthMs: 2 * WEEK, generation: 0 };
    const boundary = EPOCH_ANCHOR_MS + 5 * WEEK;
    const reason = validateLengthening(current, longer, boundary, EPOCH_ANCHOR_MS + WEEK);
    expect(reason).toMatch(/generation must strictly increase/);
  });

  it('accepts a valid future, boundary-aligned, generation-bumped lengthening', () => {
    const boundary = EPOCH_ANCHOR_MS + 5 * WEEK; // exact boundary under weekly
    const longer: EpochSchedule = { anchorMs: boundary, lengthMs: 2 * WEEK, generation: 1 };
    const reason = validateLengthening(current, longer, boundary, EPOCH_ANCHOR_MS + WEEK);
    expect(reason).toBeNull();
  });

  it('activeSchedule flips deterministically at the effective instant', () => {
    const boundary = EPOCH_ANCHOR_MS + 5 * WEEK;
    const longer: EpochSchedule = { anchorMs: boundary, lengthMs: 2 * WEEK, generation: 1 };
    const next = { schedule: longer, effectiveAtMs: boundary };

    // Before cutover: current schedule.
    expect(activeSchedule(current, boundary - 1, next).generation).toBe(0);
    // At/after cutover: new schedule, re-anchored, generation bumped.
    const after = activeSchedule(current, boundary, next);
    expect(after.generation).toBe(1);
    expect(epochIdForSchedule(after, boundary)).toBe(0); // re-anchor -> counts from 0
    expect(epochIdForSchedule(after, boundary + 2 * WEEK)).toBe(1);
  });
});
