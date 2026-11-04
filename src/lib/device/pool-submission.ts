/**
 * Device-side signal-pool SUBMISSION client (work-order Phase 3B, part 2).
 *
 * Turns a stored credential + coarse geography into an authorized contribution
 * and sends it to /api/signal-pool/contribute, with SUBMISSION TIMING JITTER so
 * a contribution's send time reveals nothing about when the voter answered.
 *
 * JITTER APPROACH (honest about PWA limits):
 *   True background scheduling in a PWA is NOT reliable. Service-worker timers do
 *   not survive the SW being evicted, the Background Sync + Periodic Background
 *   Sync APIs are Chromium-only and gated on engagement heuristics, and iOS
 *   Safari offers neither. So we do NOT pretend to fire a send hours later while
 *   the app is closed. Instead we implement SEND-ON-NEXT-OPEN-WITH-JITTER:
 *     1. When the voter opts in (or updates), we RECORD a "due" time = now +
 *        random(0, JITTER_MAX_MS) in the device store (pending contribution).
 *     2. On each app open, maybeFlushPending() checks: is there a pending
 *        contribution whose due time has passed? If so, send it now. If the due
 *        time is still in the future, we ALSO fire a best-effort in-page timer so
 *        that a voter who leaves the tab open gets the send at the due time
 *        without needing to reopen.
 *   Net effect: the send lands at a jittered offset from the opt-in, bounded by
 *   the next app open. This is disclosed in the opt-in copy. When OHTTP relaying
 *   lands (out of scope here), the SAME jittered send simply routes through the
 *   relay URL; the seam is marked below.
 *
 * OHTTP SEAM: `relayUrl` in SubmitOptions is where the Oblivious HTTP relay URL
 * will slot in later. Today it is undefined and we POST directly; when set, the
 * client will encapsulate the request to the relay instead. Integration is
 * explicitly out of scope for part 2; this is the marked insertion point.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import {
  buildTokenPresentation,
  slotPseudonymForPresentation,
  type TokenPresentation,
} from './credential';
import {
  buildContributionPayload,
  assertPayloadAllowlisted,
  newSubsetSeed,
  type ContributionPayload,
  type CoarseGeography,
} from './pool-contribution';
import { loadProfile, updateProfile } from './store';
import type { VoterProfile } from './types';

// ---------------------------------------------------------------------------
// Jitter config
// ---------------------------------------------------------------------------

/** Max jitter window: 6 hours, per the work order ("random 0-6h delay"). */
export const JITTER_MAX_MS = 6 * 60 * 60 * 1000;

/** Random jitter offset in [0, JITTER_MAX_MS]. Isomorphic CSPRNG. */
export function randomJitterMs(max: number = JITTER_MAX_MS): number {
  const buf = new Uint32Array(1);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(buf);
    return Math.floor((buf[0] / 0xffffffff) * max);
  }
  return Math.floor(Math.random() * max);
}

// ---------------------------------------------------------------------------
// Pending-contribution device state (send-on-next-open-with-jitter)
// ---------------------------------------------------------------------------

/**
 * A scheduled-but-not-yet-sent contribution, persisted so a jittered send
 * survives a tab close and fires on next open. Op distinguishes an upsert (share
 * the current payload) from a delete (nuke the slot). `payload` is null for a
 * delete (a delete needs only the token + slot pseudonym, no stances).
 */
export interface PendingContribution {
  op: 'upsert' | 'delete';
  /** Wall-clock ms after which the send is due (opt-in time + jitter). */
  dueAtMs: number;
  /** The literal payload to send on an upsert. Null for a delete. */
  payload: ContributionPayload | null;
  /**
   * The random-subset seed this contribution was built with (finding 4). Stored
   * so the scheduled send ships exactly what the preview showed. Absent for a
   * delete (no payload).
   */
  subsetSeed?: number;
}

/**
 * The signal-pool device state block. Kept as an optional extension on the
 * VoterProfile via the store's generic update path (the profile type already
 * carries `credential`; this adds the opt-in + pending fields the pool needs).
 * We store it under a single key so the privacy nuke can clear it wholesale.
 */
export interface PoolDeviceState {
  /** True when the voter has opted in to contributing. Default absent = off. */
  optedIn: boolean;
  /** The pending (jittered) send, if any. */
  pending?: PendingContribution;
  /** ISO of the last successful send (for honest "last shared" copy). Optional. */
  lastSentAt?: string;
}

// The pool state lives on the profile's `pool` field (typed in types.ts). We
// read/write it through a narrow accessor so callers do not reach into the
// profile shape directly. PoolDeviceState is the authoritative type; the profile
// field is the same shape with `pending.payload` widened to unknown to avoid an
// import cycle, so we cast at this single boundary.
export function readPoolState(profile: VoterProfile): PoolDeviceState {
  return (profile.pool as PoolDeviceState | undefined) ?? { optedIn: false };
}

async function writePoolState(
  next: PoolDeviceState,
  factory?: IDBFactory,
): Promise<VoterProfile> {
  return updateProfile((p) => ({ ...p, pool: next }), factory);
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export interface SubmitOptions {
  /** POST endpoint. Defaults to the same-origin contribute route. */
  endpoint?: string;
  /**
   * OHTTP relay URL. OUT OF SCOPE for part 2 (staged). When set later, the send
   * routes through the relay instead of a direct POST. Undefined today.
   */
  relayUrl?: string;
  /** Injected fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: number;
  factory?: IDBFactory;
  env?: Record<string, string | undefined>;
}

export type SubmitResult =
  | { ok: true; op: 'upsert' | 'delete'; status: number }
  | {
      ok: false;
      reason:
        | 'no_credential'
        | 'stockpile_exhausted'
        | 'flag_off'
        | 'not_found'
        | 'schema_not_applied'
        | 'relay_required'
        | 'error';
      detail?: string;
    };

/**
 * OHTTP / IP FAIL-CLOSED GATE (red-team finding 2, 2026-07-05). OHTTP is still
 * deferred (no relay is built). But a flag-ON deployment MUST NOT submit over a
 * direct connection, because the contribute endpoint would then see the client
 * IP, which re-identifies a household + district. So: when the flag is on, a
 * direct submit is REFUSED unless (a) a relayUrl is supplied, or (b) the explicit
 * dev override SIGNAL_POOL_ALLOW_DIRECT_SUBMIT=true is set. Fail closed with a
 * clear reason so nobody can enable the pool and silently leak IPs.
 */
function directSubmitRefused(opts: SubmitOptions): boolean {
  const env = opts.env ?? (typeof process !== 'undefined' ? process.env : {});
  const flagOn = env.NEXT_PUBLIC_SIGNAL_POOL_ENABLED === 'true';
  if (!flagOn) return false; // flag off: nothing submits anyway.
  if (opts.relayUrl) return false; // routing through a relay: IP is stripped.
  const allowDirect = env.SIGNAL_POOL_ALLOW_DIRECT_SUBMIT === 'true';
  return !allowDirect; // flag on, no relay, no override -> refuse.
}

/**
 * Send ONE contribution now (no jitter wait; the jitter is applied by the
 * scheduling layer below). Builds the token presentation, packages the request,
 * and POSTs. On a delete, `payload` is null. Returns a typed result; the caller
 * maps it to UI.
 *
 * PRIVACY (2026-07-05 rework): the request body is
 *   { tokenPresentation, slotPseudonym, op, payload }
 * where tokenPresentation carries ONLY { keyId, epochId, nonce, tokenSignature }
 * (NO secret, NO stable signature). The slot pseudonym is derived FROM the epoch
 * token signature; the server can recompute it from what we send. Nothing in the
 * body links this contribution to any other epoch or to issuance.
 */
async function sendNow(params: {
  op: 'upsert' | 'delete';
  payload: ContributionPayload | null;
  opts: SubmitOptions;
}): Promise<SubmitResult> {
  const { op, payload, opts } = params;

  // Fail closed on direct submit when the flag is on and no relay is configured.
  if (directSubmitRefused(opts)) {
    return {
      ok: false,
      reason: 'relay_required',
      detail:
        'Signal pool is enabled but no OHTTP relay is configured. Refusing a direct ' +
        'submit to avoid leaking the client IP. Set a relayUrl, or the dev override ' +
        'SIGNAL_POOL_ALLOW_DIRECT_SUBMIT=true.',
    };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? '/api/signal-pool/contribute';

  const token: TokenPresentation | null = await buildTokenPresentation({
    now: opts.now,
    factory: opts.factory,
  });
  if (!token) {
    // Distinguish "never had a credential" from "stockpile does not cover this
    // epoch". A device WITH a credential whose stockpile is exhausted must
    // re-verify; the caller surfaces that differently from "opt in first".
    const { getCredential } = await import('./credential');
    const cred = await getCredential(opts.factory);
    return { ok: false, reason: cred ? 'stockpile_exhausted' : 'no_credential' };
  }

  const slotPseudonym = await slotPseudonymForPresentation(token);

  if (payload) assertPayloadAllowlisted(payload, opts.env);

  const body = JSON.stringify({
    tokenPresentation: token,
    slotPseudonym,
    op,
    payload: op === 'upsert' ? payload : undefined,
  });

  // OHTTP SEAM: when opts.relayUrl is set (future), encapsulate `body` to the
  // relay here instead of a direct fetch. The relay strips the client IP. Until
  // then, directSubmitRefused() above blocks any flag-on direct send.
  const target = opts.relayUrl ? opts.relayUrl : endpoint;

  try {
    const res = await fetchImpl(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (res.status === 503) return { ok: false, reason: 'schema_not_applied' };
    if (!res.ok) return { ok: false, reason: 'error', detail: `HTTP ${res.status}` };
    return { ok: true, op, status: res.status };
  } catch (e) {
    return { ok: false, reason: 'error', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Public API: opt-in / update / stop / nuke, all jittered via device state
// ---------------------------------------------------------------------------

/**
 * Opt in (or refresh the shared payload). Records a jittered pending upsert in
 * device state and returns the built payload so the UI can echo exactly what was
 * scheduled. Does NOT send immediately: the send happens at the jittered due
 * time, on the next open (or via the in-page timer if the tab stays open). The
 * caller flushes via maybeFlushPending().
 */
export async function scheduleContribution(params: {
  geography: CoarseGeography;
  /**
   * Fixed subset seed (finding 4). When omitted a fresh random seed is minted so
   * each contribution rotates which dims it carries. Passing an explicit seed is
   * for the preview UI, so what the voter previews equals what is scheduled.
   */
  subsetSeed?: number;
  opts?: SubmitOptions;
}): Promise<{ payload: ContributionPayload; dueAtMs: number; subsetSeed: number }> {
  const opts = params.opts ?? {};
  const now = opts.now ?? Date.now();
  const { profile } = await loadProfile(opts.factory);
  const subsetSeed = params.subsetSeed ?? newSubsetSeed();
  // RANDOM SUBSET: never the full vector. buildContributionPayload with a seed
  // ships at most configuredSubsetMax dims, chosen deterministically from the
  // seed so the preview and the send agree byte-for-byte.
  const payload = buildContributionPayload({
    answers: profile.answers,
    geography: params.geography,
    env: opts.env,
    subsetSeed,
  });
  assertPayloadAllowlisted(payload, opts.env);
  const dueAtMs = now + randomJitterMs();
  const prev = readPoolState(profile);
  await writePoolState(
    { ...prev, optedIn: true, pending: { op: 'upsert', dueAtMs, payload, subsetSeed } },
    opts.factory,
  );
  return { payload, dueAtMs, subsetSeed };
}

/**
 * Stop contributing (device-side off). Clears the opt-in flag and any pending
 * upsert so nothing further is sent. Does NOT remove already-contributed data
 * from the pool: for that, call nukeContribution(), which schedules a delete.
 */
export async function stopContributing(opts: SubmitOptions = {}): Promise<VoterProfile> {
  const { profile } = await loadProfile(opts.factory);
  const prev = readPoolState(profile);
  return writePoolState({ ...prev, optedIn: false, pending: undefined }, opts.factory);
}

/**
 * "Remove my data from the pool" (nuke). Schedules a jittered DELETE presentation
 * and clears the local opt-in. The actual pool removal happens when the delete
 * lands AND the next epoch recompute runs (recompute-from-slots is the deletion
 * mechanism: a deleted slot row is simply absent from the next recompute). The
 * opt-in copy explains this epoch-boundary batching honestly.
 */
export async function nukeContribution(opts: SubmitOptions = {}): Promise<{ dueAtMs: number }> {
  const now = opts.now ?? Date.now();
  const { profile } = await loadProfile(opts.factory);
  const dueAtMs = now + randomJitterMs();
  const prev = readPoolState(profile);
  await writePoolState(
    { ...prev, optedIn: false, pending: { op: 'delete', dueAtMs, payload: null } },
    opts.factory,
  );
  return { dueAtMs };
}

/**
 * NUKE-BEFORE-ERASE (red-team finding 2, 2026-07-05). The device-wide "delete
 * everything on this device" flow (DeviceDataControls -> eraseProfile) used to
 * drop the credential + opt-in state locally WITHOUT removing the already-
 * contributed slot from the server. That orphaned the slot AND destroyed the only
 * token that could ever remove it, making the contribution permanently
 * unremovable. This function closes that gap: it sends a SYNCHRONOUS, immediate
 * (no jitter) delete for the current epoch's slot using the still-present
 * credential, BEFORE the caller clears local state. Fail-open: erase must always
 * proceed even if the delete cannot be sent (offline, flag on without a relay,
 * exhausted stockpile), so a user is never trapped unable to delete their local
 * data. It returns a typed result the caller can surface, but never throws.
 *
 * Call this FIRST, then erase. It is a no-op (returns { attempted: false }) when
 * there is no credential (nothing was ever contributed from this device) or the
 * pool was never opted into.
 */
export async function nukePoolBeforeErase(
  opts: SubmitOptions = {},
): Promise<{ attempted: boolean; result?: SubmitResult }> {
  const { profile } = await loadProfile(opts.factory);
  // Only attempt if this device actually holds a credential (could have
  // contributed) AND had opted in at some point. No credential = nothing to
  // remove server-side.
  if (!profile.credential) return { attempted: false };
  const state = readPoolState(profile);
  // If they never opted in and there is no pending upsert, there is no slot to
  // remove; still attempt when optedIn OR a pending upsert existed, to be safe.
  const everContributed = state.optedIn || state.pending?.op === 'upsert' || Boolean(state.lastSentAt);
  if (!everContributed) return { attempted: false };

  // Send the delete NOW (no jitter): the credential is about to be destroyed, so
  // we cannot defer. This is the one place we bypass jitter, and it is the safe
  // direction (a removal timing leak is strictly better than an unremovable row).
  const result = await sendNow({ op: 'delete', payload: null, opts });
  return { attempted: true, result };
}

/**
 * Flush a due pending contribution. Call on app open (and optionally on an
 * in-page timer). If there is a pending send whose dueAtMs has passed, send it
 * and clear it on success (recording lastSentAt for an upsert). If the due time
 * is still in the future, this is a no-op that returns { sent: false }.
 *
 * Idempotent: a successful send clears the pending row, so a second flush in the
 * same open does nothing. A failed send leaves the pending row for the next open
 * to retry (the server rate-limit + idempotent slot key make a retry safe).
 */
export async function maybeFlushPending(
  opts: SubmitOptions = {},
): Promise<{ sent: boolean; result?: SubmitResult }> {
  const now = opts.now ?? Date.now();
  const { profile } = await loadProfile(opts.factory);
  const state = readPoolState(profile);
  const pending = state.pending;
  if (!pending) return { sent: false };
  if (now < pending.dueAtMs) return { sent: false };

  const result = await sendNow({ op: pending.op, payload: pending.payload, opts });
  if (result.ok) {
    const next: PoolDeviceState = {
      ...state,
      pending: undefined,
      ...(pending.op === 'upsert' ? { lastSentAt: new Date(now).toISOString() } : {}),
    };
    await writePoolState(next, opts.factory);
    return { sent: true, result };
  }
  // Leave pending in place for a later retry.
  return { sent: false, result };
}
