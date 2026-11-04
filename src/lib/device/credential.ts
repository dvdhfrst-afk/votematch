/**
 * Device-side credential construction + storage (work-order Phase 3B, part 1;
 * unlinkable-redemption rework 2026-07-05).
 *
 * This is the CLIENT half of the anonymous-credential ceremony. It runs in the
 * browser and constructs the blinded requests the server signs. The server
 * NEVER sees an unblinded token; blinding / unblinding happen here.
 *
 * WHAT CHANGED (red-team finding 3 fix): the credential is no longer a single
 * (secret, signature) that gets PRESENTED at every contribution. Presenting the
 * secret handed the server a master key to re-derive every epoch's pseudonym and
 * a stable per-credential join field, collapsing unlinkability. The credential
 * is now a STOCKPILE of single-show, per-epoch RFC 9474 tokens (the Privacy Pass
 * batched-token model): one blind-signed token per COVERED epoch, each over a
 * DISTINCT PUBLIC per-epoch message. At contribution the device presents ONLY
 * that epoch's finalized signature. The server verifies it as stock RSA-PSS and
 * learns nothing that links epochs to each other or to issuance. No secret, no
 * stable signature, ever leaves the device.
 *
 * THE CEREMONY (client half), in order:
 *   1. beginCredentialRequest(): for each of the next COVERED_EPOCHS epochs,
 *      build the PUBLIC per-epoch token message, run the suite's prepare() (adds
 *      random salt), and blind it against the issuer public key. Keep the per-
 *      epoch {prepared, inv} on the device; send only the blinded messages to the
 *      server.
 *   2. [server blind-signs EACH blindedMsg -> blindSignatures]
 *   3. finalizeCredential(): unblind each blind signature into a real per-epoch
 *      token signature, verify each locally against the issuer public key (fail
 *      closed if any does not), and persist the token stockpile to the device.
 *
 * At contribution time the device pulls the token for the CURRENT epoch from the
 * stockpile and presents only { epochId, nonce, tokenSignature }. Part 2 consumes
 * the token-presentation interface at the bottom of this file.
 *
 * SSR-SAFE: pure crypto + the existing SSR-guarded device store. Nothing here
 * runs at import time.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import {
  getSuite,
  b64uToBytes,
  bytesToB64u,
  epochTokenMessage,
  deriveTokenNullifierFromSig,
  suiteParams,
  importIssuerPublicKey,
  coveredEpochs,
  RATE_LIMIT_PER_EPOCH,
} from '@/lib/signal-pool/crypto';
import { currentEpochId } from '@/lib/signal-pool/epochs';
import { loadProfile, saveProfile } from './store';
import type { DeviceCredential, EpochToken, VoterProfile } from './types';

// ---------------------------------------------------------------------------
// Ceremony: client half
// ---------------------------------------------------------------------------

/** The device-held per-epoch blinding state, kept between blind + finalize. */
export interface PendingEpochToken {
  /** The epoch this token authorizes. */
  epochId: number;
  /** The nonce (in [0, RATE_LIMIT_PER_EPOCH)); folded into the public message. */
  nonce: number;
  /** The prepared message (base64url): the public per-epoch message + random salt. */
  preparedB64u: string;
  /** The blinding inverse (base64url), needed to unblind. Secret to the device. */
  invB64u: string;
  /** The blinded message (base64url) to POST to the issuer. Safe to send. */
  blindedMsgB64u: string;
}

/** The device-held state between blinding and finalizing. Never leaves the device. */
export interface PendingCredentialRequest {
  /** One pending blind per COVERED epoch. */
  tokens: PendingEpochToken[];
  /** The first epoch covered (inclusive); tokens run [startEpoch, startEpoch+len). */
  startEpoch: number;
}

/**
 * Step 1: begin a credential request against the issuer public key (SPKI,
 * base64url). Blinds ONE PUBLIC per-epoch token message for each of the next
 * COVERED_EPOCHS epochs (nonce 0 each, since RATE_LIMIT_PER_EPOCH is 1). Returns
 * the pending state; only the `blindedMsgB64u` values should be sent to the
 * server (as an ordered array). No secret is generated: each token's message is
 * public, and possession of the issuer signature over it is the whole proof.
 */
export async function beginCredentialRequest(
  issuerPublicKeyB64u: string,
  params?: { now?: number; env?: Record<string, string | undefined> },
): Promise<PendingCredentialRequest> {
  const suite = getSuite();
  const publicKey = await importIssuerPublicKey(issuerPublicKeyB64u);

  const startEpoch = currentEpochId(params?.now ?? Date.now());
  const len = coveredEpochs(params?.env);
  const nonce = 0; // RATE_LIMIT_PER_EPOCH is 1; the only valid nonce.

  const tokens: PendingEpochToken[] = [];
  for (let i = 0; i < len; i++) {
    const epochId = startEpoch + i;
    const prepared = suite.prepare(epochTokenMessage(epochId, nonce));
    const { blindedMsg, inv } = await suite.blind(publicKey, prepared);
    tokens.push({
      epochId,
      nonce,
      preparedB64u: bytesToB64u(prepared),
      invB64u: bytesToB64u(inv),
      blindedMsgB64u: bytesToB64u(blindedMsg),
    });
  }

  return { tokens, startEpoch };
}

/**
 * Step 3: finalize. Unblind EACH server blind signature into a real per-epoch
 * token signature, verify each locally (fail closed on any), and return the
 * finished credential (the token stockpile). Does NOT persist by itself; call
 * storeCredential to persist (kept separate so tests can assert the crypto
 * without touching IndexedDB).
 *
 * `blindSignaturesB64u` MUST be in the SAME ORDER as pending.tokens (the server
 * signs the array in order). A length mismatch or any failed verification throws
 * rather than storing a partial/unverifiable stockpile.
 */
export async function finalizeCredential(params: {
  pending: PendingCredentialRequest;
  blindSignaturesB64u: string[];
  issuerPublicKeyB64u: string;
  keyId: string;
}): Promise<DeviceCredential> {
  const suite = getSuite();
  const publicKey = await importIssuerPublicKey(params.issuerPublicKeyB64u);

  if (params.blindSignaturesB64u.length !== params.pending.tokens.length) {
    throw new Error(
      `blind signature count (${params.blindSignaturesB64u.length}) does not match ` +
        `pending token count (${params.pending.tokens.length}); refusing to store.`,
    );
  }

  const epochTokens: EpochToken[] = [];
  for (let i = 0; i < params.pending.tokens.length; i++) {
    const pt = params.pending.tokens[i];
    const prepared = b64uToBytes(pt.preparedB64u);
    const signature = await suite.finalize(
      publicKey,
      prepared,
      b64uToBytes(params.blindSignaturesB64u[i]),
      b64uToBytes(pt.invB64u),
    );
    // finalize returns a signature over the prepared message; verify with prepared.
    const ok = await suite.verify(publicKey, signature, prepared);
    if (!ok) {
      throw new Error(
        `Epoch ${pt.epochId} token failed local verification; refusing to store the stockpile.`,
      );
    }
    epochTokens.push({
      epochId: pt.epochId,
      nonce: pt.nonce,
      signature: bytesToB64u(signature),
      prepared: pt.preparedB64u,
    });
  }

  const p = suiteParams();
  return {
    tokens: epochTokens,
    keyId: params.keyId,
    issuerPublicKey: params.issuerPublicKeyB64u,
    suite: `${p.name}`,
    issuedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Storage (device store, schema v2)
// ---------------------------------------------------------------------------

/** Persist a finished credential into the VoterProfile. Overwrites any prior one. */
export async function storeCredential(
  credential: DeviceCredential,
  factory?: IDBFactory,
): Promise<VoterProfile> {
  const { profile } = await loadProfile(factory);
  return saveProfile({ ...profile, credential }, factory);
}

/** Read the stored credential, if any. */
export async function getCredential(
  factory?: IDBFactory,
): Promise<DeviceCredential | null> {
  const { profile } = await loadProfile(factory);
  return profile.credential ?? null;
}

/** Remove the stored credential (part of the device "nuke" story). */
export async function clearCredential(factory?: IDBFactory): Promise<VoterProfile> {
  const { profile } = await loadProfile(factory);
  const next = { ...profile };
  delete next.credential;
  return saveProfile(next, factory);
}

/** True when the device holds a credential. */
export async function hasCredential(factory?: IDBFactory): Promise<boolean> {
  return (await getCredential(factory)) !== null;
}

// ---------------------------------------------------------------------------
// Token presentation (the interface PART 2 consumes)
// ---------------------------------------------------------------------------

/**
 * A one-time, per-epoch redemption token the device presents to authorize ONE
 * contribution (slot write) this epoch. Unlinkable to issuance and, across
 * epochs, to itself, because it is an INDEPENDENTLY blind-signed RFC 9474 token
 * over a distinct public per-epoch message.
 *
 * CRITICAL PRIVACY CONTRACT (2026-07-05 fix): this carries NO secret and NO
 * stable per-credential signature. It carries ONLY the epoch's own finalized
 * token signature plus the (epoch, nonce) that name the public message it signs.
 * The server verifies RSA-PSS(tokenSignature, epochTokenMessage(epochId, nonce))
 * and derives the nullifier + slot pseudonym FROM tokenSignature, so nothing the
 * server sees at epoch N can re-derive anything about epoch N+1 or issuance.
 */
export interface TokenPresentation {
  /** The issuer key id that minted the stockpile. Non-secret, non-linking. */
  keyId: string;
  /** The epoch this token is valid for. */
  epochId: number;
  /** The nonce in [0, RATE_LIMIT_PER_EPOCH). Names the public message. */
  nonce: number;
  /**
   * The finalized RFC 9474 token signature for THIS epoch (base64url). The server
   * verifies it as stock RSA-PSS over `preparedMessage`. Presented at most once
   * per epoch; independent of every other epoch's token.
   */
  tokenSignature: string;
  /**
   * The prepared message the signature is over (base64url) = random(32) prefix ||
   * epochTokenMessage(epochId, nonce). The server verifies the signature over
   * these bytes and checks the suffix equals the public epoch message. Carries no
   * secret and does not link across epochs (the prefix is per-token).
   */
  preparedMessage: string;
}

/**
 * Build a TokenPresentation from the stored credential stockpile for the current
 * epoch. `nonce` defaults to 0 (RATE_LIMIT_PER_EPOCH is 1, so 0 is the only
 * valid value today). Returns null when the device holds no credential OR when
 * the stockpile does not cover the current epoch (exhausted -> the device must
 * re-verify to mint a fresh stockpile; the caller surfaces that).
 *
 * PART 2 CALLS THIS. It is the single function part 2 needs to turn a stored
 * credential into an authorized contribution token; everything else in this
 * module is ceremony plumbing part 2 does not touch. It never returns the
 * secret (there is none) or a stable signature.
 */
export async function buildTokenPresentation(params?: {
  nonce?: number;
  now?: number;
  factory?: IDBFactory;
}): Promise<TokenPresentation | null> {
  const nonce = params?.nonce ?? 0;
  if (nonce < 0 || nonce >= RATE_LIMIT_PER_EPOCH) {
    throw new Error(`nonce ${nonce} out of range [0, ${RATE_LIMIT_PER_EPOCH})`);
  }
  const credential = await getCredential(params?.factory);
  if (!credential) return null;

  const epochId = currentEpochId(params?.now ?? Date.now());
  const token = credential.tokens.find((t) => t.epochId === epochId && t.nonce === nonce);
  if (!token) return null; // stockpile does not cover this epoch (exhausted).

  return {
    keyId: credential.keyId,
    epochId,
    nonce,
    tokenSignature: token.signature,
    preparedMessage: token.prepared,
  };
}

/**
 * The slot pseudonym for a token presentation, derived FROM the presented epoch
 * token signature (not from any secret). Server-recomputable, per-epoch, and
 * unlinkable across epochs because each epoch's token signature is independent.
 * Kept here so part 2 has one call to turn a presentation into its slot key.
 */
export async function slotPseudonymForPresentation(
  presentation: TokenPresentation,
): Promise<string> {
  const { deriveSlotPseudonymFromSig } = await import('./pool-contribution');
  return deriveSlotPseudonymFromSig(presentation.tokenSignature);
}
