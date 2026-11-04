/**
 * Signal-pool epochs (work-order Phase 3B, part 1; founder decision D3).
 *
 * An EPOCH is the rotation window for redemption-token nullifiers. Within one
 * epoch a credential's per-nonce nullifier is stable (so a slot overwrite is
 * idempotent); across epochs the nullifier changes (the rotating pseudonym that
 * breaks long-term linkage). Published pool numbers are recomputed per epoch, so
 * the epoch is also the freshness / decay unit.
 *
 * D3 (RESOLVED by the operator, 2026-07-05): WEEKLY epochs, built as a CONFIG parameter
 * (EPOCH_LENGTH). Shortening is safe anytime. LENGTHENING requires the documented
 * boundary-safe cutover below so a rotating pseudonym never spans two epochs.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Epoch length in milliseconds. WEEKLY default (7 days). Overridable via the
 * SIGNAL_POOL_EPOCH_LENGTH_MS env var (integer milliseconds) so the length is a
 * deploy-time knob, not a code change. Anything non-positive or non-numeric
 * falls back to the weekly default.
 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function epochLengthMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SIGNAL_POOL_EPOCH_LENGTH_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return WEEK_MS;
}

/**
 * The fixed anchor from which epoch ids are counted. Epoch 0 begins at this
 * instant (UTC). Chosen as a clean Monday 00:00:00 UTC so weekly epochs line up
 * with calendar weeks. NEVER change this constant once credentials exist in the
 * wild: it is the shared origin both server and device count from. 2026-01-05 is
 * the first Monday of 2026.
 */
export const EPOCH_ANCHOR_MS = Date.UTC(2026, 0, 5, 0, 0, 0, 0);

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * The current epoch id: floor((now - anchor) / length). A monotonically
 * increasing integer. Both the issuer's double-spend ledger and the device's
 * token derivation call this with the same clock + config, so they agree on
 * which window a redemption belongs to.
 *
 * `lengthMs` is injectable for tests and for the lengthening procedure; it
 * defaults to the env-configured length.
 */
export function currentEpochId(
  now: number = Date.now(),
  lengthMs: number = epochLengthMs(),
): number {
  if (now < EPOCH_ANCHOR_MS) return 0;
  return Math.floor((now - EPOCH_ANCHOR_MS) / lengthMs);
}

/** The [startMs, endMs) wall-clock bounds of a given epoch id. */
export function epochBounds(
  epochId: number,
  lengthMs: number = epochLengthMs(),
): { startMs: number; endMs: number } {
  const startMs = EPOCH_ANCHOR_MS + epochId * lengthMs;
  return { startMs, endMs: startMs + lengthMs };
}

/**
 * Milliseconds remaining until the current epoch rolls over. Useful for the
 * boundary-safe lengthening procedure and for the slot writer to know how long
 * a pseudonym stays stable.
 */
export function msUntilNextEpoch(
  now: number = Date.now(),
  lengthMs: number = epochLengthMs(),
): number {
  const id = currentEpochId(now, lengthMs);
  return epochBounds(id, lengthMs).endMs - now;
}

// ---------------------------------------------------------------------------
// Boundary-safe lengthening procedure (D3)
// ---------------------------------------------------------------------------

/*
 * WHY LENGTHENING IS DANGEROUS AND SHORTENING IS NOT
 * --------------------------------------------------
 * Epoch id = floor((now - anchor) / length). The nullifier a device presents is
 * H(secret || epochId || nonce). The double-spend ledger keys on (epochId,
 * nullifier). Correctness requires: the server and the device agree on epochId
 * for any given instant.
 *
 * SHORTENING (e.g. week -> day) is safe to apply at ANY instant. Making the
 * window smaller only splits future time into more windows; every already-spent
 * (epochId, nullifier) row stays valid, and the worst case is that a device
 * computes a slightly older/newer epoch id than the server for a few requests,
 * which the ledger simply treats as a new (unspent) window. No pseudonym is
 * reused across the boundary because the id only ever increases.
 *
 * LENGTHENING (e.g. day -> week) is NOT safe to apply at an arbitrary instant,
 * because floor((now - anchor) / newLength) can map the CURRENT instant back to
 * an epoch id that was ALREADY USED under the old length. That would let a
 * device present a nullifier for an epoch the ledger already recorded as spent
 * (locking it out) or, worse, collide two different real-time windows into one
 * pseudonym (linking contributions that should have rotated apart).
 *
 * THE BOUNDARY-SAFE CUTOVER (apply lengthening ONLY at a shared boundary):
 * 1. Pick the NEW length L2 (> current L1) and a CUTOVER epoch boundary T that
 *    is a common multiple boundary: T must be an exact epoch boundary under BOTH
 *    L1 (T = anchor + k1 * L1) AND the new schedule. The simplest safe choice is
 *    to re-anchor at T: set EPOCH_ANCHOR at T and start L2 counting from 0 there.
 * 2. SCHEDULE the change to take effect at T, in the FUTURE (never retroactive).
 *    Until `now >= T`, keep serving L1. This is what `plannedEpochLength()` does.
 * 3. At T, both server and every device independently observe `now >= T`, switch
 *    to (anchor=T, length=L2), and begin counting epoch ids from 0 again under
 *    the new schedule. Because T was a real epoch boundary under L1, no in-flight
 *    pseudonym straddles the change: the last L1 epoch closed exactly at T.
 * 4. The ledger keeps old (epochId, nullifier) rows under the OLD schedule id
 *    space; new rows use the NEW schedule id space. To keep them from colliding,
 *    tag ledger rows with a `schedule_epoch` generation counter (see the staged
 *    schema: token_spend_ledger.schedule_generation). Incrementing the generation
 *    at each re-anchor guarantees old and new id spaces never alias.
 *
 * In short: lengthen only by scheduling a re-anchor at a future shared boundary
 * and bumping the schedule generation. Never mutate length or anchor live.
 */

/**
 * A scheduled epoch-schedule change (the lengthening cutover). `effectiveAtMs`
 * MUST be a future instant that is an exact epoch boundary under the CURRENT
 * schedule. `generation` increments so ledger rows never alias across the change.
 */
export interface EpochSchedule {
  anchorMs: number;
  lengthMs: number;
  generation: number;
}

/**
 * Resolve the active schedule at `now` given the current schedule and an
 * optional scheduled change. Before `effectiveAtMs` the current schedule holds;
 * at/after it the new schedule holds. This is how a lengthening is rolled out:
 * ship the `next` change with a future, boundary-aligned `effectiveAtMs`, and
 * both server and device flip deterministically at the same instant.
 */
export function activeSchedule(
  current: EpochSchedule,
  now: number = Date.now(),
  next?: { schedule: EpochSchedule; effectiveAtMs: number },
): EpochSchedule {
  if (next && now >= next.effectiveAtMs) return next.schedule;
  return current;
}

/**
 * Validate a proposed lengthening cutover. Returns null when safe, or a reason
 * string when unsafe. Enforces: (a) effective instant is in the future,
 * (b) effective instant is an exact epoch boundary under the CURRENT schedule,
 * (c) the new length is >= the old length (lengthening; shortening does not need
 * this ceremony), (d) the generation strictly increases.
 */
export function validateLengthening(
  current: EpochSchedule,
  next: EpochSchedule,
  effectiveAtMs: number,
  now: number = Date.now(),
): string | null {
  if (effectiveAtMs <= now) return 'effectiveAtMs must be in the future';
  const offset = effectiveAtMs - current.anchorMs;
  if (offset < 0 || offset % current.lengthMs !== 0) {
    return 'effectiveAtMs must fall on an exact epoch boundary under the current schedule';
  }
  if (next.lengthMs < current.lengthMs) {
    return 'lengthening ceremony is only for a longer (or equal) length; shortening is safe live';
  }
  if (next.generation <= current.generation) {
    return 'new schedule generation must strictly increase to prevent ledger id aliasing';
  }
  return null;
}

/**
 * The default schedule from env config: anchor at EPOCH_ANCHOR_MS, weekly (or
 * env-overridden) length, generation 0. Both sides start here; a re-anchor bumps
 * the generation.
 */
export function defaultSchedule(env: Record<string, string | undefined> = process.env): EpochSchedule {
  return { anchorMs: EPOCH_ANCHOR_MS, lengthMs: epochLengthMs(env), generation: 0 };
}

/** Epoch id under an explicit schedule (used once a re-anchor has happened). */
export function epochIdForSchedule(schedule: EpochSchedule, now: number = Date.now()): number {
  if (now < schedule.anchorMs) return 0;
  return Math.floor((now - schedule.anchorMs) / schedule.lengthMs);
}
