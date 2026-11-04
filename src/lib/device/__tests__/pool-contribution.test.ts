/**
 * Signal-pool CONTRIBUTION payload + slot-pseudonym tests (Phase 3B, part 2).
 *
 * Covers:
 *   - slot pseudonym derivation is DISTINCT from the spend nullifier and ROTATES
 *     across epochs (privacy invariant: slot ids and spend nullifiers never
 *     collide or cross-link).
 *   - payload shape is the no-PII allowlist (the privacy regression guard): the
 *     built payload carries ONLY allowlisted keys, no raw score, no fine
 *     timestamp, no device/session id.
 *   - quantization (5 buckets) + freshness epoch derivation.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContributionPayload,
  assertPayloadAllowlisted,
  quantizeStance,
  freshnessEpochFor,
  deriveSlotPseudonymFromSig,
  configuredSubsetMax,
  newSubsetSeed,
  CONTRIBUTION_PAYLOAD_KEYS,
  CONTRIBUTION_STANCE_KEYS,
  STANCE_BUCKET_COUNT,
  SLOT_PSEUDONYM_LABEL,
} from '../pool-contribution';
import { deriveTokenNullifierFromSig } from '@/lib/signal-pool/crypto';
import { EPOCH_ANCHOR_MS } from '@/lib/signal-pool/epochs';
import type { DeviceAnswer } from '../types';

const WEEK = 7 * 24 * 60 * 60 * 1000;

function ans(subDimensionId: string, score: number, answeredAt: string): DeviceAnswer {
  return { subDimensionId, score, answeredAt, source: 'quick-match' };
}

describe('slot pseudonym derivation (from the epoch token signature, 2026-07-05)', () => {
  // Two DIFFERENT epoch-token signatures stand in for two epochs' tokens.
  const sig7 = 'c2lnLWZvci1lcG9jaC03LXNpZ25hdHVyZS1ieXRlcw';
  const sig8 = 'c2lnLWZvci1lcG9jaC04LXNpZ25hdHVyZS1ieXRlcw';

  it('is deterministic in the token signature', async () => {
    const a = await deriveSlotPseudonymFromSig(sig7);
    const b = await deriveSlotPseudonymFromSig(sig7);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('ROTATES across epochs (different token sig -> different pseudonym)', async () => {
    const a = await deriveSlotPseudonymFromSig(sig7);
    const b = await deriveSlotPseudonymFromSig(sig8);
    expect(a).not.toBe(b);
  });

  it('is DISTINCT from the spend nullifier for the SAME token signature', async () => {
    const slot = await deriveSlotPseudonymFromSig(sig7);
    const nullifier = await deriveTokenNullifierFromSig(sig7);
    // Domain separation guarantees these never coincide.
    expect(slot).not.toBe(nullifier);
  });

  it('uses a distinct domain label from the nullifier', () => {
    expect(SLOT_PSEUDONYM_LABEL).toContain('slot');
    expect(SLOT_PSEUDONYM_LABEL).not.toContain('nullifier');
  });

  it('does NOT derive from any device secret (regression: no secret input)', () => {
    // The function signature accepts ONLY a token signature. A caller cannot pass
    // a device secret + epoch (the old, broken derivation), which is enforced by
    // the type system; this test pins the intent for future readers.
    expect(deriveSlotPseudonymFromSig.length).toBe(1);
  });
});

describe('quantization + freshness', () => {
  it('quantizes 0..1 into 5 equal-width buckets, 1.0 in the top bucket', () => {
    expect(quantizeStance(0)).toBe(0);
    expect(quantizeStance(0.1)).toBe(0);
    expect(quantizeStance(0.2)).toBe(1);
    expect(quantizeStance(0.5)).toBe(2);
    expect(quantizeStance(0.85)).toBe(4);
    expect(quantizeStance(1)).toBe(STANCE_BUCKET_COUNT - 1);
  });

  it('clamps malformed scores into range', () => {
    expect(quantizeStance(-1)).toBe(0);
    expect(quantizeStance(2)).toBe(STANCE_BUCKET_COUNT - 1);
    expect(quantizeStance(NaN)).toBe(0);
  });

  it('derives a weekly freshness epoch from answeredAt', () => {
    const at = new Date(EPOCH_ANCHOR_MS + 3 * WEEK + 1000).toISOString();
    expect(freshnessEpochFor(at, {})).toBe(3);
    // Invalid timestamp -> epoch 0 (maximally stale, the safe direction).
    expect(freshnessEpochFor('not-a-date', {})).toBe(0);
  });
});

describe('payload allowlist (privacy regression guard)', () => {
  const answers: Record<string, DeviceAnswer> = {
    'sd.b': ans('sd.b', 0.9, new Date(EPOCH_ANCHOR_MS + 2 * WEEK).toISOString()),
    'sd.a': ans('sd.a', 0.1, new Date(EPOCH_ANCHOR_MS + 1 * WEEK).toISOString()),
  };
  const geography = { state: 'ut', cd: '01' };

  it('builds a payload with ONLY allowlisted top-level keys', () => {
    const payload = buildContributionPayload({ answers, geography, env: {} });
    expect(Object.keys(payload).sort()).toEqual([...CONTRIBUTION_PAYLOAD_KEYS].sort());
  });

  it('each stance carries ONLY allowlisted keys (no score, no answeredAt)', () => {
    const payload = buildContributionPayload({ answers, geography, env: {} });
    for (const s of payload.stances) {
      expect(Object.keys(s).sort()).toEqual([...CONTRIBUTION_STANCE_KEYS].sort());
      // The forbidden fields must be ABSENT, not just undefined.
      expect('score' in s).toBe(false);
      expect('answeredAt' in s).toBe(false);
    }
  });

  it('uppercases state and sorts stances deterministically', () => {
    const payload = buildContributionPayload({ answers, geography, env: {} });
    expect(payload.state).toBe('UT');
    expect(payload.stances.map((s) => s.subDimensionId)).toEqual(['sd.a', 'sd.b']);
  });

  it('carries no device/session identifier anywhere in the serialized JSON', () => {
    const payload = buildContributionPayload({ answers, geography, env: {} });
    const json = JSON.stringify(payload);
    expect(json).not.toMatch(/localId|session|credential|secret|nullifier|nonce/i);
  });

  it('assertPayloadAllowlisted throws on a smuggled key', () => {
    const payload = buildContributionPayload({ answers, geography, env: {} });
    const dirty = { ...payload, leaked: 'oops' } as unknown as typeof payload;
    expect(() => assertPayloadAllowlisted(dirty)).toThrow(/non-allowlisted/);
  });

  it('assertPayloadAllowlisted throws on a smuggled stance key', () => {
    const payload = buildContributionPayload({ answers, geography, env: {} });
    const dirty = {
      ...payload,
      stances: [{ ...payload.stances[0], score: 0.9 }],
    } as unknown as typeof payload;
    expect(() => assertPayloadAllowlisted(dirty)).toThrow(/non-allowlisted/);
  });
});

describe('random-subset contribution (finding 4 fix, 2026-07-05)', () => {
  // Build a wide answer set (more than any subset cap) so the cap actually bites.
  const wide: Record<string, DeviceAnswer> = {};
  for (let i = 0; i < 20; i++) {
    const id = `sd.${String(i).padStart(2, '0')}`;
    wide[id] = ans(id, i / 20, new Date(EPOCH_ANCHOR_MS + WEEK).toISOString());
  }
  const geography = { state: 'UT', cd: '01' };
  const env = { SIGNAL_POOL_SUBSET_MAX: '4' };

  it('without a seed, returns the FULL vector (internal/test use only)', () => {
    const p = buildContributionPayload({ answers: wide, geography, env });
    expect(p.stances).toHaveLength(20);
  });

  it('with a seed, ships AT MOST the subset cap', () => {
    const p = buildContributionPayload({ answers: wide, geography, env, subsetSeed: 12345 });
    expect(p.stances.length).toBeLessThanOrEqual(4);
    expect(p.stances.length).toBeGreaterThan(0);
  });

  it('is deterministic for a fixed seed (preview matches send)', () => {
    const a = buildContributionPayload({ answers: wide, geography, env, subsetSeed: 999 });
    const b = buildContributionPayload({ answers: wide, geography, env, subsetSeed: 999 });
    expect(a).toEqual(b);
  });

  it('rotates coverage: different seeds cover different dims, union grows', () => {
    const seen = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const p = buildContributionPayload({ answers: wide, geography, env, subsetSeed: seed });
      for (const s of p.stances) seen.add(s.subDimensionId);
    }
    // Over several rotations the union covers well more than one subset's worth,
    // so the pool fills in over time even though each send is capped.
    expect(seen.size).toBeGreaterThan(4);
  });

  it('assertPayloadAllowlisted REJECTS a full-vector payload (cap enforced at the boundary)', () => {
    const full = buildContributionPayload({ answers: wide, geography, env }); // 20 stances
    expect(() => assertPayloadAllowlisted(full, env)).toThrow(/subset cap/i);
  });

  it('assertPayloadAllowlisted accepts a capped subset payload', () => {
    const sub = buildContributionPayload({ answers: wide, geography, env, subsetSeed: 42 });
    expect(() => assertPayloadAllowlisted(sub, env)).not.toThrow();
  });

  it('configuredSubsetMax honors the env override + hard ceiling', () => {
    expect(configuredSubsetMax({ SIGNAL_POOL_SUBSET_MAX: '3' })).toBe(3);
    expect(configuredSubsetMax({ SIGNAL_POOL_SUBSET_MAX: '999' })).toBe(8); // ceiling
    expect(newSubsetSeed()).toBeGreaterThanOrEqual(0);
  });
});
