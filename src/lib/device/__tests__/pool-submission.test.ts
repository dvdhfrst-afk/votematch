/**
 * Signal-pool SUBMISSION client tests (Phase 3B, part 2; unlinkable-redemption +
 * nuke-before-erase + random-subset + relay-fail-closed rework 2026-07-05).
 *
 * Covers:
 *   - preview-matches-payload: what scheduleContribution stores + returns (with a
 *     fixed subset seed) is byte-identical to what maybeFlushPending sends.
 *   - the SEND BODY carries NO secret and NO stable signature, only the per-epoch
 *     tokenSignature + server-recomputable slotPseudonym (finding 3).
 *   - jitter, stop, nuke, delete.
 *   - nukePoolBeforeErase sends a delete before the credential is destroyed
 *     (finding 2).
 *   - directSubmitRefused: flag-on + no relay + no override => fail closed
 *     (finding 2/IP).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scheduleContribution,
  maybeFlushPending,
  stopContributing,
  nukeContribution,
  nukePoolBeforeErase,
  readPoolState,
  randomJitterMs,
  JITTER_MAX_MS,
} from '../pool-submission';
import { buildContributionPayload } from '../pool-contribution';
import {
  beginCredentialRequest,
  finalizeCredential,
  storeCredential,
} from '../credential';
import {
  getSuite,
  ISSUER_MODULUS_LENGTH,
  ISSUER_PUBLIC_EXPONENT,
  bytesToB64u,
  b64uToBytes,
} from '@/lib/signal-pool/crypto';
import { EPOCH_ANCHOR_MS } from '@/lib/signal-pool/epochs';
import { loadProfile, setAnswer } from '../store';
import { makeShimFactory, resetShimData } from './idb-shim';

const WEEK = 7 * 24 * 60 * 60 * 1000;
const geography = { state: 'ut', cd: '02' };
// A dev override so sendNow does not fail-closed on direct submit in these tests.
const ENV = { SIGNAL_POOL_ALLOW_DIRECT_SUBMIT: 'true', SIGNAL_POOL_COVERED_EPOCHS: '6' };

// Seed a stockpile covering the epoch at `now` (default: a known fixed instant).
async function seedCredential(factory: IDBFactory, now: number): Promise<void> {
  const suite = getSuite();
  const kp = await suite.generateKey({
    modulusLength: ISSUER_MODULUS_LENGTH,
    publicExponent: ISSUER_PUBLIC_EXPONENT,
  });
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  const publicKeyB64u = bytesToB64u(new Uint8Array(spki));

  const pending = await beginCredentialRequest(publicKeyB64u, { now, env: ENV });
  const blindSigs: string[] = [];
  for (const t of pending.tokens) {
    const s = await suite.blindSign(kp.privateKey, b64uToBytes(t.blindedMsgB64u));
    blindSigs.push(bytesToB64u(s));
  }
  const cred = await finalizeCredential({
    pending,
    blindSignaturesB64u: blindSigs,
    issuerPublicKeyB64u: publicKeyB64u,
    keyId: 'sp-test',
  });
  await storeCredential(cred, factory);
}

describe('submission jitter', () => {
  it('randomJitterMs stays within [0, max]', () => {
    for (let i = 0; i < 200; i++) {
      const j = randomJitterMs();
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(JITTER_MAX_MS);
    }
    expect(randomJitterMs(1000)).toBeLessThanOrEqual(1000);
  });
});

describe('schedule + flush lifecycle', () => {
  let factory: IDBFactory;
  // A fixed instant inside epoch 3 so the seeded stockpile covers "now".
  const now = EPOCH_ANCHOR_MS + 3 * WEEK + 1000;

  beforeEach(async () => {
    resetShimData();
    factory = makeShimFactory();
    await setAnswer('sd.a', 0.1, 'quick-match', factory);
    await setAnswer('sd.b', 0.9, 'quick-match', factory);
    await seedCredential(factory, now);
  });

  it('preview matches the payload that would be sent (same subset seed)', async () => {
    const { payload, subsetSeed } = await scheduleContribution({
      geography,
      opts: { now, factory, env: ENV },
    });
    const { profile } = await loadProfile(factory);
    const state = readPoolState(profile);
    expect(state.optedIn).toBe(true);
    expect(state.pending?.op).toBe('upsert');
    expect(state.pending?.payload).toEqual(payload);
    expect(state.pending?.subsetSeed).toBe(subsetSeed);

    // Rebuilding with the SAME seed reproduces the payload byte-for-byte.
    const rebuilt = buildContributionPayload({
      answers: profile.answers,
      geography,
      subsetSeed,
    });
    expect(payload).toEqual(rebuilt);
  });

  it('schedules the send within the jitter window', async () => {
    const { dueAtMs } = await scheduleContribution({ geography, opts: { now, factory, env: ENV } });
    expect(dueAtMs).toBeGreaterThanOrEqual(now);
    expect(dueAtMs).toBeLessThanOrEqual(now + JITTER_MAX_MS);
  });

  it('does not send before the due time', async () => {
    await scheduleContribution({ geography, opts: { now, factory, env: ENV } });
    const { profile } = await loadProfile(factory);
    const due = readPoolState(profile).pending!.dueAtMs;
    if (due > now) {
      const res = await maybeFlushPending({
        now,
        factory,
        env: ENV,
        fetchImpl: async () => new Response(null, { status: 200 }),
      });
      expect(res.sent).toBe(false);
    }
  });

  it('sends a due upsert with NO secret and a token signature (finding 3)', async () => {
    let sentBody: unknown = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const { payload } = await scheduleContribution({ geography, opts: { now, factory, env: ENV } });
    const res = await maybeFlushPending({ now: now + JITTER_MAX_MS + 1, factory, env: ENV, fetchImpl });
    expect(res.sent).toBe(true);
    expect(res.result?.ok).toBe(true);

    const body = sentBody as {
      op: string;
      slotPseudonym: string;
      payload: unknown;
      tokenPresentation: Record<string, unknown>;
    };
    expect(body.op).toBe('upsert');
    expect(typeof body.slotPseudonym).toBe('string');
    expect(body.payload).toEqual(payload);
    // CRITICAL SECURITY ASSERTIONS: the presentation is the new minimal shape.
    expect(body.tokenPresentation).toBeTruthy();
    expect('secret' in body.tokenPresentation).toBe(false);
    expect('signature' in body.tokenPresentation).toBe(false);
    expect('nullifier' in body.tokenPresentation).toBe(false);
    expect(typeof body.tokenPresentation.tokenSignature).toBe('string');
    expect(typeof body.tokenPresentation.epochId).toBe('number');
    // No secret anywhere in the serialized body.
    expect(JSON.stringify(body)).not.toMatch(/"secret"/);

    const { profile } = await loadProfile(factory);
    const state = readPoolState(profile);
    expect(state.pending).toBeUndefined();
    expect(state.lastSentAt).toBeTruthy();
  });

  it('stop clears opt-in and pending', async () => {
    await scheduleContribution({ geography, opts: { now, factory, env: ENV } });
    await stopContributing({ factory });
    const { profile } = await loadProfile(factory);
    const state = readPoolState(profile);
    expect(state.optedIn).toBe(false);
    expect(state.pending).toBeUndefined();
  });

  it('nuke schedules a delete presentation', async () => {
    await scheduleContribution({ geography, opts: { now, factory, env: ENV } });
    await nukeContribution({ now, factory });
    const { profile } = await loadProfile(factory);
    const state = readPoolState(profile);
    expect(state.optedIn).toBe(false);
    expect(state.pending?.op).toBe('delete');
    expect(state.pending?.payload).toBeNull();
  });

  it('a due delete sends op=delete with no payload', async () => {
    let sentBody: { op?: string; payload?: unknown } = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await nukeContribution({ now, factory });
    const res = await maybeFlushPending({ now: now + JITTER_MAX_MS + 1, factory, env: ENV, fetchImpl });
    expect(res.sent).toBe(true);
    expect(sentBody.op).toBe('delete');
    expect(sentBody.payload).toBeUndefined();
  });
});

describe('nuke-before-erase (finding 2)', () => {
  let factory: IDBFactory;
  const now = EPOCH_ANCHOR_MS + 3 * WEEK + 1000;

  beforeEach(async () => {
    resetShimData();
    factory = makeShimFactory();
    await setAnswer('sd.a', 0.1, 'quick-match', factory);
    await seedCredential(factory, now);
  });

  it('sends a server-side delete when the device had opted in', async () => {
    let sentBody: { op?: string } = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    // Opt in (records optedIn = true) then run the erase-precursor.
    await scheduleContribution({ geography, opts: { now, factory, env: ENV } });
    const res = await nukePoolBeforeErase({ now, factory, env: ENV, fetchImpl });
    expect(res.attempted).toBe(true);
    expect(res.result?.ok).toBe(true);
    expect(sentBody.op).toBe('delete');
  });

  it('is a no-op when the device holds no credential', async () => {
    resetShimData();
    const bare = makeShimFactory();
    await setAnswer('sd.a', 0.1, 'quick-match', bare);
    const res = await nukePoolBeforeErase({ now, factory: bare, env: ENV });
    expect(res.attempted).toBe(false);
  });
});

describe('OHTTP fail-closed (finding 2 / IP)', () => {
  let factory: IDBFactory;
  const now = EPOCH_ANCHOR_MS + 3 * WEEK + 1000;

  beforeEach(async () => {
    resetShimData();
    factory = makeShimFactory();
    await setAnswer('sd.a', 0.1, 'quick-match', factory);
    await seedCredential(factory, now);
  });

  it('REFUSES a direct submit when the flag is on and no relay + no override', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    // Flag ON, no relay, no allow-direct override => must fail closed.
    const flagOnEnv = { NEXT_PUBLIC_SIGNAL_POOL_ENABLED: 'true' };
    await scheduleContribution({ geography, opts: { now, factory, env: flagOnEnv } });
    const res = await maybeFlushPending({ now: now + JITTER_MAX_MS + 1, factory, env: flagOnEnv, fetchImpl });
    expect(res.result?.ok).toBe(false);
    expect(res.result && !res.result.ok && res.result.reason).toBe('relay_required');
    expect(called).toBe(false); // nothing was actually sent over the network.
  });

  it('ALLOWS a submit when a relayUrl is provided (IP is stripped by the relay)', async () => {
    let target = '';
    const fetchImpl = (async (url: string) => {
      target = url;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const flagOnEnv = { NEXT_PUBLIC_SIGNAL_POOL_ENABLED: 'true' };
    await scheduleContribution({
      geography,
      opts: { now, factory, env: flagOnEnv, relayUrl: 'https://relay.example/ohttp' },
    });
    const res = await maybeFlushPending({
      now: now + JITTER_MAX_MS + 1,
      factory,
      env: flagOnEnv,
      relayUrl: 'https://relay.example/ohttp',
      fetchImpl,
    });
    expect(res.sent).toBe(true);
    expect(target).toBe('https://relay.example/ohttp');
  });
});
