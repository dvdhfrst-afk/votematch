/**
 * Signal-pool crypto round-trip + unlinkability tests (Phase 3B, part 1;
 * unlinkable-redemption rework 2026-07-05).
 *
 * Covers:
 *   - Per-epoch token round-trip: keygen -> blind(epochMessage) -> blindSign ->
 *     finalize (unblind) -> verify, over the PUBLIC per-epoch message. This is
 *     the new redemption primitive: no secret is involved.
 *   - Unlinkability, asserted structurally: what the server sees at issuance
 *     (blindedMsg, blindSignature) is disjoint from what it sees at redemption
 *     (the finalized token signature); and two DIFFERENT epochs' tokens share no
 *     field, and the nullifiers/pseudonyms derived from them differ.
 *   - Nullifier + slot derivation FROM the token signature (not a secret):
 *     deterministic per signature, differ across signatures, distinct from each
 *     other under domain separation.
 *
 * Runs on Node's global WebCrypto (vitest node env). No DB, no Next.
 */

import { describe, it, expect } from 'vitest';
import {
  getSuite,
  ISSUER_MODULUS_LENGTH,
  ISSUER_PUBLIC_EXPONENT,
  bytesToB64u,
  b64uToBytes,
  epochTokenMessage,
  deriveTokenNullifierFromSig,
} from '../crypto';
import { deriveSlotPseudonymFromSig } from '@/lib/device/pool-contribution';

// A shared keypair for the suite (2048-bit RSA). Generated once per file.
async function makeKeys() {
  const suite = getSuite();
  return suite.generateKey({
    modulusLength: ISSUER_MODULUS_LENGTH,
    publicExponent: ISSUER_PUBLIC_EXPONENT,
  });
}

/**
 * Blind-sign a public per-epoch message end to end. Returns the finalized sig
 * AND the prepared bytes (the signature verifies over prepared = random(32)||msg,
 * exactly as the server does at redemption).
 */
async function mintEpochToken(
  publicKey: CryptoKey,
  privateKey: CryptoKey,
  epochId: number,
  nonce = 0,
): Promise<{ sig: Uint8Array; prepared: Uint8Array }> {
  const suite = getSuite();
  const prepared = suite.prepare(epochTokenMessage(epochId, nonce));
  const { blindedMsg, inv } = await suite.blind(publicKey, prepared);
  const blindSig = await suite.blindSign(privateKey, blindedMsg);
  const sig = await suite.finalize(publicKey, prepared, blindSig, inv);
  return { sig, prepared };
}

describe('per-epoch token round-trip', () => {
  it('blind(epochMessage) -> sign -> unblind -> verify over prepared succeeds', async () => {
    const suite = getSuite();
    const { publicKey, privateKey } = await makeKeys();
    const { sig, prepared } = await mintEpochToken(publicKey, privateKey, 7);
    // The server verifies over the PREPARED bytes (which it receives), then binds
    // the token to the epoch by checking the suffix equals the public message.
    expect(await suite.verify(publicKey, sig, prepared)).toBe(true);
    expect(bytesToB64u(prepared).length).toBeGreaterThan(0);
  });

  it('a token prepared for epoch 7 does NOT verify against epoch 8 prepared bytes', async () => {
    const suite = getSuite();
    const { publicKey, privateKey } = await makeKeys();
    const t7 = await mintEpochToken(publicKey, privateKey, 7);
    const t8 = await mintEpochToken(publicKey, privateKey, 8);
    // epoch 7's signature over epoch 8's prepared bytes must fail.
    expect(await suite.verify(publicKey, t7.sig, t8.prepared)).toBe(false);
  });

  it('a token minted by the wrong key does not verify', async () => {
    const suite = getSuite();
    const good = await makeKeys();
    const bad = await makeKeys();
    const minted = await mintEpochToken(good.publicKey, bad.privateKey, 7).catch(() => null);
    if (minted) {
      expect(await suite.verify(good.publicKey, minted.sig, minted.prepared)).toBe(false);
    } else {
      expect(minted).toBeNull();
    }
  });
});

describe('unlinkability property (structural)', () => {
  it('issuance transcript is disjoint from the redemption transcript', async () => {
    const suite = getSuite();
    const { publicKey, privateKey } = await makeKeys();

    const prepared = suite.prepare(epochTokenMessage(7, 0));
    const { blindedMsg, inv } = await suite.blind(publicKey, prepared);
    const blindSig = await suite.blindSign(privateKey, blindedMsg);
    const signature = await suite.finalize(publicKey, prepared, blindSig, inv);

    const issuanceView = new Set([bytesToB64u(blindedMsg), bytesToB64u(blindSig)]);
    const redemptionSig = bytesToB64u(signature);
    // The finalized token the server sees at redemption is not in the issuance view.
    expect(issuanceView.has(redemptionSig)).toBe(false);
    expect(bytesToB64u(blindSig)).not.toEqual(redemptionSig);
    expect(inv.length).toBeGreaterThan(0);
  });

  it('two epochs of tokens share NO server-visible field', async () => {
    const { publicKey, privateKey } = await makeKeys();
    const sig7 = bytesToB64u((await mintEpochToken(publicKey, privateKey, 7)).sig);
    const sig8 = bytesToB64u((await mintEpochToken(publicKey, privateKey, 8)).sig);
    expect(sig7).not.toEqual(sig8); // the token signatures differ

    // The DERIVED nullifier + slot pseudonym also differ (they are functions of
    // the per-epoch signature alone, so nothing crosses the epoch boundary).
    expect(await deriveTokenNullifierFromSig(sig7)).not.toEqual(
      await deriveTokenNullifierFromSig(sig8),
    );
    expect(await deriveSlotPseudonymFromSig(sig7)).not.toEqual(
      await deriveSlotPseudonymFromSig(sig8),
    );
  });
});

describe('nullifier + slot derivation from the token signature', () => {
  it('nullifier is deterministic per signature and distinct from the slot id', async () => {
    const { publicKey, privateKey } = await makeKeys();
    const sig = bytesToB64u((await mintEpochToken(publicKey, privateKey, 7)).sig);

    const nA = await deriveTokenNullifierFromSig(sig);
    const nB = await deriveTokenNullifierFromSig(sig);
    expect(nA).toEqual(nB); // deterministic (idempotent within-epoch re-share)

    const slot = await deriveSlotPseudonymFromSig(sig);
    // Domain separation: the slot id and the nullifier for the same token differ.
    expect(slot).not.toEqual(nA);
  });

  it('encodings round-trip', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
    expect(b64uToBytes(bytesToB64u(bytes))).toEqual(bytes);
  });
});
