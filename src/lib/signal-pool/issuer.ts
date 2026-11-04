/**
 * Signal-pool issuer (work-order Phase 3B, part 1) -- the SERVER side of the
 * anonymous-credential ceremony.
 *
 * Responsibilities:
 *   1. KEY MANAGEMENT: import the issuer keypair from the server environment
 *      (SIGNAL_POOL_ISSUER_SK / _PK, base64url PKCS8 / SPKI), expose the public
 *      key for clients to blind against, and generate a fresh keypair for the
 *      rotation / bootstrap path.
 *   2. BLIND-SIGN: given a blinded message from a device that has already
 *      presented + consumed valid verification evidence, produce a blind
 *      signature. The server NEVER sees the unblinded credential.
 *   3. EVIDENCE CONSUMPTION: one credential per evidence identity, replay-proof,
 *      via the evidence_identities table (peppered HMAC of the identity only).
 *   4. TOKEN REDEMPTION: verify a presented PER-EPOCH TOKEN (finalized signature
 *      over the public per-epoch message) against the issuer public key, then
 *      record the server-derived token nullifier in the per-epoch double-spend
 *      ledger so a credential is rate-limited per epoch WITHOUT the server
 *      learning identity, and WITHOUT any device secret (2026-07-05 rework).
 *
 * GRACEFUL DEGRADATION (work-order requirement): the staged schema is NOT yet
 * applied. Every DB-touching function detects the missing table and returns a
 * typed 'schema_not_applied' outcome instead of throwing, so the endpoints can
 * respond 503 cleanly until the operator applies _draft-signal-pool-schema.sql. The
 * crypto (keygen, blind-sign, verify) works with or without the schema.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { createServiceClient } from '@/lib/supabase/server';
import {
  getSuite,
  ISSUER_MODULUS_LENGTH,
  ISSUER_PUBLIC_EXPONENT,
  b64uToBytes,
  bytesToB64u,
  epochTokenMessage,
  preparedSuffixMatches,
  deriveTokenNullifierFromSig,
  webcrypto,
  toArrayBuffer,
  coveredEpochs,
  RATE_LIMIT_PER_EPOCH,
} from './crypto';
import { currentEpochId } from './epochs';

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

/** RSA-PSS import params matching the RFC 9474 SHA-384 suite. */
const RSA_IMPORT_ALG: RsaHashedImportParams = {
  name: 'RSA-PSS',
  hash: 'SHA-384',
};

/** In-process cache of the imported issuer keys (avoids re-importing per call). */
let cachedPublicKey: CryptoKey | null = null;
let cachedPrivateKey: CryptoKey | null = null;

/** True when both issuer key env vars are present. */
export function hasIssuerKeys(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.SIGNAL_POOL_ISSUER_SK && env.SIGNAL_POOL_ISSUER_PK);
}

/**
 * Import the issuer PUBLIC key (SPKI, base64url) from env for blinding + verify.
 */
export async function getIssuerPublicKey(
  env: Record<string, string | undefined> = process.env,
): Promise<CryptoKey> {
  if (cachedPublicKey) return cachedPublicKey;
  const spki = env.SIGNAL_POOL_ISSUER_PK;
  if (!spki) throw new Error('SIGNAL_POOL_ISSUER_PK is not set.');
  cachedPublicKey = await webcrypto().subtle.importKey(
    'spki',
    toArrayBuffer(b64uToBytes(spki)),
    RSA_IMPORT_ALG,
    true,
    ['verify'],
  );
  return cachedPublicKey;
}

/**
 * Import the issuer PRIVATE key (PKCS8, base64url) from env for blind-signing.
 * Server-only; this value must never be sent to a client.
 */
export async function getIssuerPrivateKey(
  env: Record<string, string | undefined> = process.env,
): Promise<CryptoKey> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const pkcs8 = env.SIGNAL_POOL_ISSUER_SK;
  if (!pkcs8) throw new Error('SIGNAL_POOL_ISSUER_SK is not set.');
  cachedPrivateKey = await webcrypto().subtle.importKey(
    'pkcs8',
    toArrayBuffer(b64uToBytes(pkcs8)),
    RSA_IMPORT_ALG,
    true,
    ['sign'],
  );
  return cachedPrivateKey;
}

/** For tests + rotation: reset the in-process key cache. */
export function _resetIssuerKeyCache(): void {
  cachedPublicKey = null;
  cachedPrivateKey = null;
}

/**
 * Generate a fresh issuer keypair and return it as base64url PKCS8 / SPKI so the
 * operator can set SIGNAL_POOL_ISSUER_SK / _PK. Used by the bootstrap CLI + the
 * key-rotation path. Uses the suite's own generateKey so params match exactly.
 */
export async function generateIssuerKeypairB64u(): Promise<{
  privateKeyB64u: string;
  publicKeyB64u: string;
  keyId: string;
}> {
  const suite = getSuite();
  const kp = await suite.generateKey({
    modulusLength: ISSUER_MODULUS_LENGTH,
    publicExponent: ISSUER_PUBLIC_EXPONENT,
  });
  const spki = await webcrypto().subtle.exportKey('spki', kp.publicKey);
  const pkcs8 = await webcrypto().subtle.exportKey('pkcs8', kp.privateKey);
  const publicKeyB64u = bytesToB64u(new Uint8Array(spki));
  const privateKeyB64u = bytesToB64u(new Uint8Array(pkcs8));
  // Key id: a short fingerprint of the public key. Stable + non-secret.
  const fp = await webcrypto().subtle.digest('SHA-256', spki);
  const keyId = `sp-${bytesToB64u(new Uint8Array(fp)).slice(0, 12)}`;
  return { privateKeyB64u, publicKeyB64u, keyId };
}

// ---------------------------------------------------------------------------
// Blind signing (the core ceremony step)
// ---------------------------------------------------------------------------

/**
 * Blind-sign a device-supplied blinded message. The server sees ONLY the blinded
 * bytes; it cannot recover the token. Returns the blind signature bytes
 * (base64url) that the device unblinds locally.
 *
 * This function does NOT gate on evidence -- the caller (issueCredential) does
 * the evidence-consume-then-sign sequence atomically. Kept separate so it is
 * independently testable in the crypto round-trip test.
 */
export async function blindSign(
  blindedMsgB64u: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const suite = getSuite();
  const privateKey = await getIssuerPrivateKey(env);
  const blindSig = await suite.blindSign(privateKey, b64uToBytes(blindedMsgB64u));
  return bytesToB64u(blindSig);
}

/**
 * Blind-sign a BATCH of blinded messages (the per-epoch token stockpile). One
 * blind signature per input, in order. Enforces a sane batch cap (COVERED_EPOCHS)
 * so a hostile client cannot ask the issuer to sign an unbounded batch.
 */
export async function blindSignBatch(
  blindedMsgsB64u: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const cap = coveredEpochs(env);
  if (!Array.isArray(blindedMsgsB64u) || blindedMsgsB64u.length === 0) {
    throw new Error('blindSignBatch: empty batch');
  }
  if (blindedMsgsB64u.length > cap) {
    throw new Error(`blindSignBatch: batch size ${blindedMsgsB64u.length} exceeds cap ${cap}`);
  }
  const suite = getSuite();
  const privateKey = await getIssuerPrivateKey(env);
  const out: string[] = [];
  for (const b of blindedMsgsB64u) {
    const blindSig = await suite.blindSign(privateKey, b64uToBytes(b));
    out.push(bytesToB64u(blindSig));
  }
  return out;
}

/**
 * Verify a presented PER-EPOCH TOKEN (2026-07-05 rework). The finalized token
 * signature must validate under the issuer public key over the PUBLIC message
 * epochTokenMessage(epochId, nonce). Stock RSA-PSS verify (RFC 9474 finalized
 * signatures verify as ordinary RSA-PSS). NO secret is involved: the message is
 * public, and possession of a valid issuer signature over it is the whole proof.
 */
export async function verifyEpochToken(
  epochId: number,
  nonce: number,
  tokenSignatureB64u: string,
  preparedMessageB64u: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  // Bind the token to its epoch: the prepared message MUST be random(32) ||
  // epochTokenMessage(epochId, nonce). Reject before the expensive verify if the
  // suffix does not match the claimed epoch (blocks presenting some other epoch's
  // valid token under a different epoch label).
  const expected = epochTokenMessage(epochId, nonce);
  if (!preparedSuffixMatches(preparedMessageB64u, expected)) return false;

  const suite = getSuite();
  const publicKey = await getIssuerPublicKey(env);
  // Verify the finalized signature over the EXACT prepared bytes the device
  // presented (the RFC 9474 Randomized signature verifies over prepare(msg)).
  return suite.verify(
    publicKey,
    b64uToBytes(tokenSignatureB64u),
    b64uToBytes(preparedMessageB64u),
  );
}

// ---------------------------------------------------------------------------
// Evidence dedup + issuance (DB-backed, degrades gracefully)
// ---------------------------------------------------------------------------

/** Postgres "relation does not exist" -- the schema-not-applied signal. */
function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === '42P01' || /does not exist/i.test(err.message ?? '');
}

export type IssueOutcome =
  | { ok: true; blindSignaturesB64u: string[]; keyId: string }
  | { ok: false; reason: 'evidence_already_used' }
  | { ok: false; reason: 'schema_not_applied' }
  | { ok: false; reason: 'no_issuer_key' }
  | { ok: false; reason: 'bad_batch' }
  | { ok: false; reason: 'error'; detail: string };

/**
 * THE ISSUANCE CEREMONY (server half). Given (a) an evidence identity HASH that
 * the caller has already verified via the phone plug, and (b) a device-supplied
 * blinded message, this:
 *   1. Records the evidence identity as consumed (one credential per identity).
 *      A duplicate identity is rejected BEFORE signing -> replay-proof.
 *   2. Blind-signs the device's blinded message.
 *   3. Returns the blind signature. The device unblinds + stores locally.
 *
 * Ordering note: we INSERT the evidence row first (unique key -> the DB is the
 * concurrency guard) and only sign if the insert won the race. If signing then
 * fails, the evidence row is left consumed; that is the SAFE direction (a
 * one-time inability to sign costs the user a retry, but never lets one identity
 * mint two credentials). We record which key_id served the identity for the
 * audit trail, with no link to the blind signature.
 */
export async function issueCredential(params: {
  evidenceIdentityHash: string;
  provider: 'phone' | 'voter-file';
  /** The per-epoch stockpile: one blinded message per covered epoch, in order. */
  blindedMsgsB64u: string[];
  env?: Record<string, string | undefined>;
}): Promise<IssueOutcome> {
  const env = params.env ?? process.env;
  if (!hasIssuerKeys(env)) return { ok: false, reason: 'no_issuer_key' };

  // Validate the batch shape BEFORE consuming evidence, so a malformed request
  // does not burn the identity's one-credential allotment.
  const cap = coveredEpochs(env);
  if (
    !Array.isArray(params.blindedMsgsB64u) ||
    params.blindedMsgsB64u.length === 0 ||
    params.blindedMsgsB64u.length > cap ||
    params.blindedMsgsB64u.some((m) => typeof m !== 'string' || m.length === 0)
  ) {
    return { ok: false, reason: 'bad_batch' };
  }

  const keyId = env.SIGNAL_POOL_ISSUER_KEY_ID ?? 'sp-env';
  const supabase = await createServiceClient();

  // 1. Consume the evidence identity (unique key = atomic one-per-identity).
  const insert = await supabase
    .from('evidence_identities')
    .insert({
      identity_hash: params.evidenceIdentityHash,
      provider: params.provider,
      issued_key_id: keyId,
    })
    .select('identity_hash')
    .single();

  if (insert.error) {
    if (isMissingTable(insert.error)) return { ok: false, reason: 'schema_not_applied' };
    // 23505 = unique_violation -> this identity already minted a credential.
    if (insert.error.code === '23505') {
      return { ok: false, reason: 'evidence_already_used' };
    }
    return { ok: false, reason: 'error', detail: insert.error.message };
  }

  // 2. Blind-sign the whole stockpile. (Evidence already consumed; safe direction.)
  try {
    const blindSignaturesB64u = await blindSignBatch(params.blindedMsgsB64u, env);
    return { ok: true, blindSignaturesB64u, keyId };
  } catch (e) {
    return { ok: false, reason: 'error', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Redemption + double-spend ledger (the rate-limit substrate)
// ---------------------------------------------------------------------------

export type RedeemOutcome =
  | { ok: true; epochId: number; nullifier: string; slotPseudonym: string }
  | { ok: false; reason: 'invalid_credential' }
  | { ok: false; reason: 'already_spent' }
  | { ok: false; reason: 'nonce_out_of_range' }
  | { ok: false; reason: 'epoch_mismatch' }
  | { ok: false; reason: 'schema_not_applied' }
  | { ok: false; reason: 'error'; detail: string };

/**
 * Redeem a per-epoch token (2026-07-05 unlinkable-redemption rework). Verify the
 * PER-EPOCH TOKEN signature over the PUBLIC epoch message, bind it to the CURRENT
 * epoch, DERIVE the nullifier + slot pseudonym server-side from the presented
 * signature (never trusting a device-supplied value), and record the nullifier in
 * the epoch ledger. A repeat (schedule_generation, epoch_id, nullifier) is a
 * unique-violation -> 'already_spent' (the rate-limit).
 *
 * WHY THIS IS UNLINKABLE: the token is an INDEPENDENTLY blind-signed RFC 9474
 * artifact for THIS epoch only. The server sees the token signature, the derived
 * nullifier, and the derived slot pseudonym, ALL of which are functions of this
 * epoch's token alone. Nothing here re-derives any OTHER epoch's values, and
 * nothing ties back to issuance (the token was blind-signed). The old design's
 * secret is gone.
 *
 * EPOCH BINDING: the presented epochId MUST equal the server's current epoch. A
 * token is spendable only in its own epoch window. This blocks spending a future
 * stockpile token early or replaying a past one, and it makes the (epoch,
 * nullifier) ledger key meaningful.
 *
 * The endpoint takes the RETURNED slotPseudonym as the authoritative slot key, so
 * a lying client cannot point its (verified) token at someone else's slot row.
 */
export async function redeemToken(params: {
  epochId: number;
  nonce: number;
  tokenSignatureB64u: string;
  preparedMessageB64u: string;
  now?: number;
  env?: Record<string, string | undefined>;
}): Promise<RedeemOutcome> {
  const env = params.env ?? process.env;
  if (params.nonce < 0 || params.nonce >= RATE_LIMIT_PER_EPOCH) {
    return { ok: false, reason: 'nonce_out_of_range' };
  }

  const serverEpoch = currentEpochId(params.now ?? Date.now());
  if (params.epochId !== serverEpoch) {
    return { ok: false, reason: 'epoch_mismatch' };
  }

  const valid = await verifyEpochToken(
    params.epochId,
    params.nonce,
    params.tokenSignatureB64u,
    params.preparedMessageB64u,
    env,
  ).catch(() => false);
  if (!valid) return { ok: false, reason: 'invalid_credential' };

  // Derive the rate-limit nullifier + the slot key from the presented signature.
  // Server-computed, so the device cannot forge a mismatched pair.
  const nullifier = await deriveTokenNullifierFromSig(params.tokenSignatureB64u);
  const { deriveSlotPseudonymFromSig } = await import('@/lib/device/pool-contribution');
  const slotPseudonym = await deriveSlotPseudonymFromSig(params.tokenSignatureB64u);

  const keyId = env.SIGNAL_POOL_ISSUER_KEY_ID ?? 'sp-env';
  const generation = Number(env.SIGNAL_POOL_SCHEDULE_GENERATION ?? '0') || 0;
  const supabase = await createServiceClient();

  const insert = await supabase
    .from('token_spend_ledger')
    .insert({
      schedule_generation: generation,
      epoch_id: serverEpoch,
      nullifier,
      key_id: keyId,
    })
    .select('nullifier')
    .single();

  if (insert.error) {
    if (isMissingTable(insert.error)) return { ok: false, reason: 'schema_not_applied' };
    if (insert.error.code === '23505') return { ok: false, reason: 'already_spent' };
    return { ok: false, reason: 'error', detail: insert.error.message };
  }
  return { ok: true, epochId: serverEpoch, nullifier, slotPseudonym };
}
