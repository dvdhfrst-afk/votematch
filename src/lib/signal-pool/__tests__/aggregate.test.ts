/**
 * Signal-pool AGGREGATE recompute tests (Phase 3B, part 2, step 4; differencing
 * defense rework 2026-07-05).
 *
 * Covers: k-suppression boundaries, staleness decay, distinct-contributor
 * counting, delete-then-recompute, AND the finding-6 differencing defenses:
 * banding of published counts + hysteresis on the suppression boundary.
 *
 * NOTE: most k-boundary tests set SIGNAL_POOL_BAND=1 and SIGNAL_POOL_HYSTERESIS=0
 * to isolate the raw suppression logic; the banding + hysteresis defenses get
 * their own dedicated describe blocks.
 */

import { describe, it, expect } from 'vitest';
import {
  recomputeAggregates,
  configuredK,
  configuredStaleEpochs,
  configuredBand,
  configuredHysteresis,
  bandCount,
  DEFAULT_K,
  DEFAULT_STALE_EPOCHS,
  DEFAULT_BAND,
  DEFAULT_HYSTERESIS,
  type LiveSlot,
} from '../aggregate';
import { EPOCH_ANCHOR_MS } from '../epochs';
import { STANCE_BUCKET_COUNT } from '@/lib/device/pool-contribution';

const WEEK = 7 * 24 * 60 * 60 * 1000;
const NOW = EPOCH_ANCHOR_MS + 30 * WEEK + 10;
const CURRENT_EPOCH = 30;
// Base env for raw k-boundary tests: no banding, no hysteresis.
const RAW = { SIGNAL_POOL_BAND: '1', SIGNAL_POOL_HYSTERESIS: '0' };

function slotsInCell(
  n: number,
  cell: { state: string; cd: string; sub: string; bucket: number },
  freshnessEpoch = CURRENT_EPOCH,
): LiveSlot[] {
  return Array.from({ length: n }, (_, i) => ({
    slotPseudonym: `${cell.state}-${cell.cd}-${cell.sub}-${i}`,
    state: cell.state,
    cd: cell.cd,
    stances: [{ subDimensionId: cell.sub, bucket: cell.bucket, freshnessEpoch }],
  }));
}

describe('config', () => {
  it('defaults k, stale epochs, band, hysteresis', () => {
    expect(configuredK({})).toBe(DEFAULT_K);
    expect(configuredStaleEpochs({})).toBe(DEFAULT_STALE_EPOCHS);
    expect(configuredBand({})).toBe(DEFAULT_BAND);
    expect(configuredHysteresis({})).toBe(DEFAULT_HYSTERESIS);
  });
  it('honors env overrides', () => {
    expect(configuredK({ SIGNAL_POOL_K: '5' })).toBe(5);
    expect(configuredStaleEpochs({ SIGNAL_POOL_STALE_EPOCHS: '2' })).toBe(2);
    expect(configuredBand({ SIGNAL_POOL_BAND: '5' })).toBe(5);
    expect(configuredHysteresis({ SIGNAL_POOL_HYSTERESIS: '3' })).toBe(3);
    expect(configuredK({ SIGNAL_POOL_K: '0' })).toBe(DEFAULT_K);
  });
});

describe('k-suppression boundaries (raw: band=1, hysteresis=0)', () => {
  const env = { ...RAW, SIGNAL_POOL_K: '25' };

  it('suppresses a cell with n = k - 1', () => {
    const slots = slotsInCell(24, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 2 });
    const r = recomputeAggregates({ slots, now: NOW, env });
    expect(r.cells).toHaveLength(0);
    expect(r.suppressedCellCount).toBe(1);
  });

  it('publishes a cell at exactly n = k', () => {
    const slots = slotsInCell(25, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 2 });
    const r = recomputeAggregates({ slots, now: NOW, env });
    expect(r.cells).toHaveLength(1);
    expect(r.cells[0].n).toBe(25);
    expect(r.cells[0].histogram[2]).toBe(25);
    expect(r.cells[0].histogram).toHaveLength(STANCE_BUCKET_COUNT);
  });

  it('counts distinct contributors only once per cell', () => {
    const slots = slotsInCell(25, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 1 });
    slots.push({ ...slots[0] });
    const r = recomputeAggregates({ slots, now: NOW, env });
    expect(r.cells[0].n).toBe(25);
  });
});

describe('staleness decay (raw)', () => {
  const env = { ...RAW, SIGNAL_POOL_K: '3', SIGNAL_POOL_STALE_EPOCHS: '4' };

  it('drops stances older than the horizon', () => {
    const fresh = slotsInCell(3, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 2 }, 27);
    const stale = slotsInCell(3, { state: 'UT', cd: '02', sub: 'sd.a', bucket: 2 }, 20);
    const r = recomputeAggregates({ slots: [...fresh, ...stale], now: NOW, env });
    expect(r.cells).toHaveLength(1);
    expect(r.cells[0].cd).toBe('01');
  });

  it('keeps a stance exactly on the horizon boundary', () => {
    const onBoundary = slotsInCell(3, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 0 }, 26);
    const r = recomputeAggregates({ slots: onBoundary, now: NOW, env });
    expect(r.cells).toHaveLength(1);
  });
});

describe('delete-then-recompute is the deletion mechanism (raw)', () => {
  const env = { ...RAW, SIGNAL_POOL_K: '3' };

  it('excludes a removed slot on the next recompute (no special delete path)', () => {
    const slots = slotsInCell(3, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 4 });
    // Pass the cell as prior-published so it publishes at exactly k=3 (hysteresis
    // off means k_enter == k anyway, but this is explicit).
    const before = recomputeAggregates({ slots, now: NOW, env });
    expect(before.cells[0].n).toBe(3);

    const afterSlots = slots.slice(1); // one fewer -> n = 2 < k
    const after = recomputeAggregates({ slots: afterSlots, now: NOW, env });
    expect(after.cells).toHaveLength(0);
    expect(after.suppressedCellCount).toBe(1);
  });
});

describe('out-of-range buckets are dropped defensively (raw)', () => {
  it('ignores a stance with an invalid bucket', () => {
    const env = { ...RAW, SIGNAL_POOL_K: '2' };
    const good = slotsInCell(2, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 3 });
    const bad: LiveSlot = {
      slotPseudonym: 'bad-1',
      state: 'UT',
      cd: '01',
      stances: [{ subDimensionId: 'sd.a', bucket: 99, freshnessEpoch: CURRENT_EPOCH }],
    };
    const r = recomputeAggregates({ slots: [...good, bad], now: NOW, env });
    expect(r.cells[0].n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DIFFERENCING DEFENSE (finding 6)
// ---------------------------------------------------------------------------

describe('banding hides single-contributor deltas (finding 6)', () => {
  it('bandCount floors to the band width', () => {
    expect(bandCount(24, 10)).toBe(20);
    expect(bandCount(25, 10)).toBe(20);
    expect(bandCount(29, 10)).toBe(20);
    expect(bandCount(30, 10)).toBe(30);
    expect(bandCount(7, 1)).toBe(7); // band 1 == no banding
  });

  it('n=25 and n=24 publish the SAME banded n, so a single departure is invisible', () => {
    const env = { SIGNAL_POOL_K: '20', SIGNAL_POOL_BAND: '10', SIGNAL_POOL_HYSTERESIS: '0' };
    const key = ['UT 01 sd.a'];
    const at25 = recomputeAggregates({
      slots: slotsInCell(25, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 2 }),
      now: NOW,
      env,
      priorPublishedKeys: key,
    });
    const at24 = recomputeAggregates({
      slots: slotsInCell(24, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 2 }),
      now: NOW,
      env,
      priorPublishedKeys: key,
    });
    // Both floor to 20: the published series does not move on a single departure.
    expect(at25.cells[0].n).toBe(20);
    expect(at24.cells[0].n).toBe(20);
    expect(at25.cells[0].histogram[2]).toBe(20);
    expect(at24.cells[0].histogram[2]).toBe(20);
    // The EXACT count is retained internally but never published as `n`.
    expect(at25.cells[0].nExact).toBe(25);
  });
});

describe('hysteresis on the suppression boundary (finding 6)', () => {
  const env = { SIGNAL_POOL_K: '20', SIGNAL_POOL_HYSTERESIS: '10', SIGNAL_POOL_BAND: '1' };
  // k = 20, k_enter = 30.

  it('a NEW cell must reach k_enter (k + hysteresis) to start publishing', () => {
    // n = 25 is >= k (20) but < k_enter (30). With no prior publication it stays
    // suppressed, so a cell hovering just over k does not flicker into existence.
    const slots = slotsInCell(25, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 1 });
    const cold = recomputeAggregates({ slots, now: NOW, env, priorPublishedKeys: [] });
    expect(cold.cells).toHaveLength(0);
    expect(cold.suppressedCellCount).toBe(1);
  });

  it('an ALREADY-published cell keeps publishing down to k (not k_enter)', () => {
    const slots = slotsInCell(25, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 1 });
    // It was published last epoch -> keeps publishing at n=25 (>= k=20).
    const warm = recomputeAggregates({
      slots,
      now: NOW,
      env,
      priorPublishedKeys: ['UT 01 sd.a'],
    });
    expect(warm.cells).toHaveLength(1);
    expect(warm.publishedKeys).toEqual(['UT 01 sd.a']);
  });

  it('a published cell that drops below k is suppressed (exits the ratchet)', () => {
    const slots = slotsInCell(19, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 1 });
    const out = recomputeAggregates({
      slots,
      now: NOW,
      env,
      priorPublishedKeys: ['UT 01 sd.a'],
    });
    expect(out.cells).toHaveLength(0);
  });

  it('a cell at k_enter starts publishing cold', () => {
    const slots = slotsInCell(30, { state: 'UT', cd: '01', sub: 'sd.a', bucket: 1 });
    const started = recomputeAggregates({ slots, now: NOW, env, priorPublishedKeys: [] });
    expect(started.cells).toHaveLength(1);
  });
});
