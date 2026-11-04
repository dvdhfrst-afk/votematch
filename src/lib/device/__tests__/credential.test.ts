/**
 * Device credential ceremony + storage tests (Phase 3B, part 1; unlinkable-
 * redemption rework 2026-07-05).
 *
 * Exercises the CLIENT half end to end against a real issuer keypair:
 *   beginCredentialRequest (BATCH of per-epoch blinds) -> [server blindSign each]
 *   -> finalizeCredential (stockpile) -> storeCredential -> getCredential ->
 *   buildTokenPresentation (pulls the CURRENT epoch's token, NO secret).
 * Plus the schema-v2 store round-trip, the nuke path, and the CRITICAL security
 * properties: no secret in the presentation, and cross-epoch UNLINKABILITY of the
 * server-visible fields.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSuite,
  ISSUER_MODULUS_LENGTH,
  ISSUER_PUBLIC_EXPONENT,
  bytesToB64u,
  b64uToBytes,
} from '@/lib/signal-pool/crypto';
import { EPOCH_ANCHOR_MS } from '@/lib/signal-pool/epochs';
import {
  beginCredentialRequest,
  finalizeCredential,
  storeCredential,
  getCredential,
  clearCredential,
  hasCredential,
  buildTokenPresentation,
  slotPseudonymForPresentation,
} from '../credential';
import { deriveTokenNullifierFromSig } from '@/lib/signal-pool/crypto';
import { loadProfile, saveProfile, emptyProfile, migrateProfile } from '../store';
import { makeShimFactory, resetShimData } from './idb-shim';

const WEEK = 7 * 24 * 60 * 60 * 1000;
// A small covered-epochs env so the stockpile is cheap to blind-sign in tests.
const ENV = { SIGNAL_POOL_COVERED_EPOCHS: '4' };

async function makeIssuer() {
  const suite = getSuite();
  const kp = await suite.generateKey({
    modulusLength: ISSUER_MODULUS_LENGTH,
    publicExponent: ISSUER_PUBLIC_EXPONENT,
  });
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  return { kp, publicKeyB64u: bytesToB64u(new Uint8Array(spki)) };
}

/** An RSA public key's modulus n, for comparing two keys. */
async function modulusOf(key: CryptoKey): Promise<bigint> {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return BigInt('0x' + Buffer.from(jwk.n as string, 'base64url').toString('hex'));
}

/** Blind-sign every pending token in a request, in order (the server's job). */
async function serverBlindSignAll(
  kp: CryptoKeyPair,
  pending: Awaited<ReturnType<typeof beginCredentialRequest>>,
): Promise<string[]> {
  const suite = getSuite();
  const sigs: string[] = [];
  for (const t of pending.tokens) {
    const s = await suite.blindSign(kp.privateKey, b64uToBytes(t.blindedMsgB64u));
    sigs.push(bytesToB64u(s));
  }
  return sigs;
}

describe('device credential ceremony (client half)', () => {
  it('runs begin (batch) -> blindSign each -> finalize into a per-epoch stockpile', async () => {
    const { kp, publicKeyB64u } = await makeIssuer();
    const now = EPOCH_ANCHOR_MS + 2 * WEEK;

    const pending = await beginCredentialRequest(publicKeyB64u, { now, env: ENV });
    expect(pending.tokens).toHaveLength(4); // COVERED_EPOCHS
    expect(pending.startEpoch).toBe(2);
    for (const t of pending.tokens) expect(t.blindedMsgB64u.length).toBeGreaterThan(0);

    const blindSigs = await serverBlindSignAll(kp, pending);
    const cred = await finalizeCredential({
      pending,
      blindSignaturesB64u: blindSigs,
      issuerPublicKeyB64u: publicKeyB64u,
      keyId: 'sp-test',
    });
    // A stockpile of per-epoch tokens, NO secret field anywhere.
    expect(cred.tokens.map((t) => t.epochId)).toEqual([2, 3, 4, 5]);
    expect((cred as unknown as { secret?: string }).secret).toBeUndefined();
    for (const t of cred.tokens) expect(t.signature.length).toBeGreaterThan(0);
  });

  it('finalize throws if ANY token was signed by the wrong key (fail closed)', async () => {
    // A blinded message is an integer below the RIGHT key's modulus, and
    // blindSign rejects one at or above its own modulus (RSASP1 range check)
    // before finalize ever runs. Make the key with the larger modulus the WRONG
    // one, so every blind is in range and this test always reaches finalize's
    // own fail-closed check.
    const [a, b] = await Promise.all([makeIssuer(), makeIssuer()]);
    const [right, wrong] =
      (await modulusOf(a.kp.publicKey)) < (await modulusOf(b.kp.publicKey)) ? [a, b] : [b, a];
    const publicKeyB64u = right.publicKeyB64u;
    const now = EPOCH_ANCHOR_MS;
    const pending = await beginCredentialRequest(publicKeyB64u, { now, env: ENV });
    // Sign every blind with the WRONG key.
    const wrongSigs = await serverBlindSignAll(wrong.kp, pending);
    await expect(
      finalizeCredential({
        pending,
        blindSignaturesB64u: wrongSigs,
        issuerPublicKeyB64u: publicKeyB64u,
        keyId: 'sp-test',
      }),
    ).rejects.toThrow();
  });

  it('finalize throws on a signature-count mismatch', async () => {
    const { kp, publicKeyB64u } = await makeIssuer();
    const pending = await beginCredentialRequest(publicKeyB64u, { now: EPOCH_ANCHOR_MS, env: ENV });
    const blindSigs = await serverBlindSignAll(kp, pending);
    await expect(
      finalizeCredential({
        pending,
        blindSignaturesB64u: blindSigs.slice(0, 2), // too few
        issuerPublicKeyB64u: publicKeyB64u,
        keyId: 'sp-test',
      }),
    ).rejects.toThrow();
  });
});

describe('credential storage (schema v2)', () => {
  beforeEach(() => resetShimData());

  async function seedStockpile(factory: IDBFactory, now: number) {
    const { kp, publicKeyB64u } = await makeIssuer();
    const pending = await beginCredentialRequest(publicKeyB64u, { now, env: ENV });
    const blindSigs = await serverBlindSignAll(kp, pending);
    const cred = await finalizeCredential({
      pending,
      blindSignaturesB64u: blindSigs,
      issuerPublicKeyB64u: publicKeyB64u,
      keyId: 'sp-test',
    });
    await storeCredential(cred, factory);
    return cred;
  }

  it('stores, reads back, and builds a token presentation with NO secret', async () => {
    const factory = makeShimFactory();
    const startNow = EPOCH_ANCHOR_MS + 3 * WEEK; // epoch 3
    const cred = await seedStockpile(factory, startNow);

    expect(await hasCredential(factory)).toBe(true);
    const read = await getCredential(factory);
    expect(read?.tokens.length).toBe(4);
    expect((read as unknown as { secret?: string }).secret).toBeUndefined();

    // Presentation for the current epoch (3). Carries the epoch token signature,
    // NOT a secret and NOT a stable per-credential signature.
    const tok = await buildTokenPresentation({ now: startNow, factory });
    expect(tok).not.toBeNull();
    expect(tok!.epochId).toBe(3);
    expect(tok!.nonce).toBe(0);
    expect(tok!.tokenSignature.length).toBeGreaterThan(0);
    // CRITICAL: no secret field on the presentation (would re-link every epoch).
    expect('secret' in (tok as object)).toBe(false);
    // The presented signature is exactly the stockpiled epoch-3 token.
    const epoch3 = cred.tokens.find((t) => t.epochId === 3)!;
    expect(tok!.tokenSignature).toBe(epoch3.signature);
  });

  it('returns null once the stockpile no longer covers the current epoch (exhausted)', async () => {
    const factory = makeShimFactory();
    const startNow = EPOCH_ANCHOR_MS + 3 * WEEK; // covers epochs 3..6
    await seedStockpile(factory, startNow);
    // Jump PAST the covered window (epoch 3+4 = 7): stockpile exhausted.
    const later = EPOCH_ANCHOR_MS + 7 * WEEK;
    expect(await buildTokenPresentation({ now: later, factory })).toBeNull();
  });

  it('CROSS-EPOCH UNLINKABILITY: epoch N and N+1 presentations share no linkable field', async () => {
    const factory = makeShimFactory();
    const startNow = EPOCH_ANCHOR_MS + 3 * WEEK; // covers 3..6
    await seedStockpile(factory, startNow);

    const tokN = await buildTokenPresentation({ now: EPOCH_ANCHOR_MS + 3 * WEEK, factory });
    const tokN1 = await buildTokenPresentation({ now: EPOCH_ANCHOR_MS + 4 * WEEK, factory });
    expect(tokN!.epochId).toBe(3);
    expect(tokN1!.epochId).toBe(4);

    // The server sees: tokenSignature, and the DERIVED slotPseudonym + nullifier.
    // NONE of these may match across the two epochs (that would be a join key).
    expect(tokN!.tokenSignature).not.toBe(tokN1!.tokenSignature);

    const slotN = await slotPseudonymForPresentation(tokN!);
    const slotN1 = await slotPseudonymForPresentation(tokN1!);
    expect(slotN).not.toBe(slotN1);

    const nullN = await deriveTokenNullifierFromSig(tokN!.tokenSignature);
    const nullN1 = await deriveTokenNullifierFromSig(tokN1!.tokenSignature);
    expect(nullN).not.toBe(nullN1);

    // And the ONLY shared field, keyId, is not per-device (it names the issuer
    // key, shared by everyone), so it is not a linking handle.
    expect(tokN!.keyId).toBe(tokN1!.keyId);
  });

  it('nuke (clearCredential) removes the credential; token build returns null', async () => {
    const factory = makeShimFactory();
    await seedStockpile(factory, EPOCH_ANCHOR_MS + 3 * WEEK);
    await clearCredential(factory);
    expect(await hasCredential(factory)).toBe(false);
    expect(await buildTokenPresentation({ now: EPOCH_ANCHOR_MS + 3 * WEEK, factory })).toBeNull();
  });

  it('migrateProfile bumps a v1 profile to v2 and preserves an existing credential', () => {
    const v1 = { ...emptyProfile('2026-07-01T00:00:00.000Z'), schemaVersion: 1 };
    delete (v1 as { credential?: unknown }).credential;
    const migrated = migrateProfile(v1);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.credential).toBeUndefined();

    // A v2 profile WITH a stockpile credential preserves it through migration.
    const withCred = {
      ...emptyProfile('2026-07-01T00:00:00.000Z'),
      credential: {
        tokens: [{ epochId: 3, nonce: 0, signature: 'sig' }],
        keyId: 'sp-test',
        issuerPublicKey: 'pk',
        suite: 'RSA-PSS',
        issuedAt: '2026-07-01T00:00:00.000Z',
      },
    };
    const migrated2 = migrateProfile(withCred);
    expect(migrated2.credential?.tokens[0].signature).toBe('sig');
  });

  it('empty profile is at schema v2 and has no credential', async () => {
    const factory = makeShimFactory();
    const { profile } = await loadProfile(factory);
    expect(profile.schemaVersion).toBe(2);
    expect(profile.credential).toBeUndefined();
    const saved = await saveProfile(profile, factory);
    expect(saved.schemaVersion).toBe(2);
  });
});
