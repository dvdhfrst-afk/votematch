/**
 * Signal-pool AGGREGATE recompute (work-order Phase 3B, part 2, step 4).
 *
 * Recomputes the PUBLISHED aggregates FROM the live slot rows for the current
 * epoch. Deletion and update need NO special path: recompute-from-slots IS the
 * mechanism. A slot that was deleted is simply absent; a slot that was updated
 * carries its new payload; a slot that has gone stale (its freshness epoch is too
 * old) is dropped. Every property the operator set on the pool falls out of "recompute
 * from whatever slots are present and fresh right now".
 *
 * OUTPUT: per (state, cd, sub_dimension) BUCKET HISTOGRAMS, with:
 *   - k-SUPPRESSION on raw cells: a (state, cd, sub_dimension) cell with fewer
 *     than K distinct contributing slots is suppressed (omitted), so no small
 *     cell can be re-identified. K is config (SIGNAL_POOL_K, default 25).
 *   - STALENESS DECAY: a stance whose freshnessEpoch is older than the current
 *     epoch by more than SIGNAL_POOL_STALE_EPOCHS is excluded from its cell.
 *
 * This module is PURE aggregation over an in-memory slot list. The runnable
 * script (scripts/signal-pool-recompute.ts) reads slots from the DB, calls
 * recomputeAggregates(), and writes the result to the aggregates table. Keeping
 * the math pure makes the k-boundary / decay / delete-then-recompute assertions
 * testable without a DB.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { currentEpochId, epochLengthMs } from './epochs';
import { STANCE_BUCKET_COUNT } from '@/lib/device/pool-contribution';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Default k for cell suppression. 25 distinct slots minimum per raw cell. */
export const DEFAULT_K = 25;

/**
 * Default staleness horizon in epochs. A stance older than this many epochs
 * before the recompute epoch is decayed out. 26 weekly epochs is ~6 months, the
 * architecture memo's "slots older than N months drop out" default.
 */
export const DEFAULT_STALE_EPOCHS = 26;

export function configuredK(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SIGNAL_POOL_K;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_K;
}

export function configuredStaleEpochs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SIGNAL_POOL_STALE_EPOCHS;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return DEFAULT_STALE_EPOCHS;
}

// ---------------------------------------------------------------------------
// DIFFERENCING DEFENSE (red-team finding 6 fix, 2026-07-05)
// ---------------------------------------------------------------------------
// k-suppression alone does NOT defend the PUBLISHED SERIES against cross-epoch
// n=25 -> 24 differencing: a single contributor leaving moves a cell by one, and
// the histogram delta reveals that contributor's exact bucketed stance. Two
// defenses, both applied before publish:
//
// 1. BANDING. Published counts (both n and every histogram cell) are floored to
//    a band width B. So n=25 and n=24 both publish as the same banded value, and
//    a single-contributor departure is invisible unless it crosses a band edge.
//    B defaults to 10 (SIGNAL_POOL_BAND).
//
// 2. HYSTERESIS on the suppression boundary. A cell must reach a HIGHER enter
//    threshold (k_enter = k + hysteresis) to START publishing, and only stops
//    publishing once it drops BELOW k (the exit floor). Between k and k_enter a
//    cell that was already published keeps publishing; a new cell does not start.
//    This stops a cell from flickering published/suppressed each epoch right at
//    the k line, which is exactly what leaks a single crossing. It needs the
//    PRIOR epoch's published cell keys, which the caller supplies.

/** Default band width for published counts. n and histogram cells floor to this. */
export const DEFAULT_BAND = 10;

/** Default hysteresis gap above k required to START publishing a new cell. */
export const DEFAULT_HYSTERESIS = 10;

export function configuredBand(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SIGNAL_POOL_BAND;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  return DEFAULT_BAND;
}

export function configuredHysteresis(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SIGNAL_POOL_HYSTERESIS;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return DEFAULT_HYSTERESIS;
}

/** Floor a count to the band width (10 -> [0,9]->0, [10,19]->10, ...). */
export function bandCount(value: number, band: number): number {
  if (band <= 1) return value;
  return Math.floor(value / band) * band;
}

/** The stable cell key used to carry published-state across epochs. */
export function cellKey(state: string, cd: string, subDimensionId: string): string {
  return `${state} ${cd} ${subDimensionId}`;
}

// ---------------------------------------------------------------------------
// Input + output shapes
// ---------------------------------------------------------------------------

/** One stance inside a slot payload (mirror of the device ContributionStance). */
export interface SlotStance {
  subDimensionId: string;
  bucket: number;
  freshnessEpoch: number;
}

/**
 * One live slot row as the recompute sees it. `slotPseudonym` is the per-epoch
 * pseudonym; it is the identity we count DISTINCT contributors by (so a slot
 * that overwrote itself within the epoch counts once, not twice). Only the
 * fields the recompute needs are listed; the DB row may carry freshness columns
 * the script projects into this shape.
 */
export interface LiveSlot {
  slotPseudonym: string;
  state: string;
  cd: string;
  stances: SlotStance[];
}

/**
 * A published aggregate cell: the bucket histogram for one
 * (state, cd, sub_dimension), plus the distinct-contributor count that cleared
 * suppression. `histogram[b]` is the number of contributors in bucket b.
 */
export interface AggregateCell {
  state: string;
  cd: string;
  subDimensionId: string;
  /**
   * Length STANCE_BUCKET_COUNT. histogram[b] = BANDED contributors in bucket b
   * (each cell floored to the band width, finding 6). Not exact counts.
   */
  histogram: number[];
  /** BANDED distinct contributors for this cell (floored to the band width). */
  n: number;
  /** The exact distinct-contributor count, for internal state only. NOT published. */
  nExact: number;
}

export interface RecomputeResult {
  epochId: number;
  k: number;
  staleEpochs: number;
  band: number;
  hysteresis: number;
  /** Only cells that cleared suppression + hysteresis. Banded. */
  cells: AggregateCell[];
  /** Cells that existed but were suppressed (count only, no payload). */
  suppressedCellCount: number;
  /**
   * The set of cell keys published THIS epoch. Feed this back as
   * `priorPublishedKeys` next epoch so the hysteresis ratchet works. The
   * recompute script persists + reloads it.
   */
  publishedKeys: string[];
}

// ---------------------------------------------------------------------------
// Recompute
// ---------------------------------------------------------------------------

function emptyHistogram(): number[] {
  return new Array(STANCE_BUCKET_COUNT).fill(0);
}

/**
 * Recompute published aggregates from a list of live slots.
 *
 * Steps:
 *   1. Determine the recompute epoch (now).
 *   2. For each slot, for each stance: DECAY out stances whose freshnessEpoch is
 *      older than (recomputeEpoch - staleEpochs). Also drop out-of-range buckets
 *      defensively.
 *   3. Bin surviving stances into (state, cd, subDimensionId) cells, counting
 *      each DISTINCT slotPseudonym once per cell (a within-epoch overwrite is one
 *      contributor, not two).
 *   4. SUPPRESS any cell with fewer than k distinct contributors.
 *
 * Pure: no DB, no clock beyond the injected `now`. Deletion is handled by the
 * CALLER passing a slot list that already excludes deleted rows; there is no
 * delete branch here (that is the point of recompute-from-slots).
 */
export function recomputeAggregates(params: {
  slots: LiveSlot[];
  now?: number;
  env?: Record<string, string | undefined>;
  /**
   * Cell keys published in the PRIOR epoch (finding 6 hysteresis). A cell already
   * in this set may keep publishing while n >= k; a NEW cell must reach k_enter
   * (= k + hysteresis) to start. Defaults to empty (cold start: nothing was
   * published before, so every cell must clear the higher enter threshold).
   */
  priorPublishedKeys?: Iterable<string>;
}): RecomputeResult {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now();
  const k = configuredK(env);
  const staleEpochs = configuredStaleEpochs(env);
  const band = configuredBand(env);
  const hysteresis = configuredHysteresis(env);
  const prior = new Set(params.priorPublishedKeys ?? []);
  const epochId = currentEpochId(now, epochLengthMs(env));
  const freshFloor = epochId - staleEpochs;

  // cellKey -> { histogram, contributors:Set<slotPseudonym>, state, cd, sub }
  const cells = new Map<
    string,
    {
      state: string;
      cd: string;
      subDimensionId: string;
      histogram: number[];
      contributors: Set<string>;
    }
  >();

  for (const slot of params.slots) {
    for (const stance of slot.stances) {
      // Decay: too-old freshness drops out.
      if (stance.freshnessEpoch < freshFloor) continue;
      // Defensive bucket range guard.
      if (
        !Number.isInteger(stance.bucket) ||
        stance.bucket < 0 ||
        stance.bucket >= STANCE_BUCKET_COUNT
      ) {
        continue;
      }
      const key = `${slot.state} ${slot.cd} ${stance.subDimensionId}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          state: slot.state,
          cd: slot.cd,
          subDimensionId: stance.subDimensionId,
          histogram: emptyHistogram(),
          contributors: new Set<string>(),
        };
        cells.set(key, cell);
      }
      // Count each distinct slot pseudonym once per cell. A slot that appears
      // twice (should not, given one row per pseudonym) contributes once.
      if (!cell.contributors.has(slot.slotPseudonym)) {
        cell.histogram[stance.bucket] += 1;
        cell.contributors.add(slot.slotPseudonym);
      }
    }
  }

  const published: AggregateCell[] = [];
  let suppressed = 0;
  const kEnter = k + hysteresis;
  for (const cell of cells.values()) {
    const nExact = cell.contributors.size;
    const key = cellKey(cell.state, cell.cd, cell.subDimensionId);
    // HYSTERESIS: a NEW cell (not published last epoch) must reach the higher
    // enter threshold; an ALREADY-published cell keeps publishing while n >= k
    // (the exit floor). Below k, always suppress.
    const wasPublished = prior.has(key);
    const threshold = wasPublished ? k : kEnter;
    if (nExact < threshold) {
      suppressed += 1;
      continue;
    }
    // BANDING: publish floored counts, never exact, so a single-contributor
    // departure does not move the published series unless it crosses a band edge.
    published.push({
      state: cell.state,
      cd: cell.cd,
      subDimensionId: cell.subDimensionId,
      histogram: cell.histogram.map((c) => bandCount(c, band)),
      n: bandCount(nExact, band),
      nExact,
    });
  }

  // Deterministic ordering for stable writes + testability.
  published.sort((a, b) =>
    a.state !== b.state
      ? a.state < b.state
        ? -1
        : 1
      : a.cd !== b.cd
        ? a.cd < b.cd
          ? -1
          : 1
        : a.subDimensionId < b.subDimensionId
          ? -1
          : a.subDimensionId > b.subDimensionId
            ? 1
            : 0,
  );

  return {
    epochId,
    k,
    staleEpochs,
    band,
    hysteresis,
    cells: published,
    suppressedCellCount: suppressed,
    publishedKeys: published.map((c) => cellKey(c.state, c.cd, c.subDimensionId)),
  };
}
