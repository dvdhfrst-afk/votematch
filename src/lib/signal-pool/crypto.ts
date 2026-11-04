/**
 * Signal-pool crypto primitives (work-order Phase 3B, part 1).
 *
 * WHAT THIS IS: the shared, environment-agnostic crypto surface for Havesay's
 * OWN anonymous-credential issuer. Both the server (issuer.ts) and the client
 * (device/credential.ts) import from here so the blind-signature suite, the
 * encodings, and the token-derivation math are defined in exactly ONE place and
 * can never drift between the two sides of the ceremony.
 *
 * LIBRARY CHOICE: @cloudflare/blindrsa-ts (v0.4.6), which implements RFC 9474
 * (RSA Blind Signatures) and is built on the WebCrypto API, so the SAME module
 * runs on the server (Node's global `crypto.subtle`) and in the browser. We use
 * the RANDOMIZED PSS variant: `prepare()` prepends 32 random bytes to the
 * message before blinding, which means even a malicious client cannot force a
 * deterministic (linkable) signature. The unblinded signature verifies with a
 * stock RSA-PSS `verify()`, which keeps redemption cheap.
 *
 * THE UNLINKABILITY GUARANTEE, stated plainly: the server signs a BLINDED
 * message and never sees the unblinded credential. Blinding multiplies the
 * message by a random factor `r^e mod n`; the server's signature over the blind
 * is later multiplied by `r^-1` to yield a valid signature over the real
 * message. Because `r` is chosen fresh and secret on the device, the
 * (blindedMsg, blindSig) pair the server observed at ISSUANCE is
 * information-theoretically independent of the (credential, signature) pair the
 * server sees at REDEMPTION. This is why the evidence table can never join to
 * credentials: the join key does not exist by construction.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { RSABSSA, type BlindRSAParams } from '@cloudflare/blindrsa-ts';

// ---------------------------------------------------------------------------
// Suite selection
// ---------------------------------------------------------------------------

/**
 * The single blind-signature suite used across the whole system. Randomized PSS
 * per RFC 9474 section 5. `supportsRSARAW: false` keeps us on the portable
 * WebCrypto path (Cloudflare Workers can flip this on for a native fast path,
 * but Node + browser use the standard route). Constructed lazily via a getter
 * so importing this module never touches WebCrypto at import time (SSR-safe).
 */
export function getSuite() {
  return RSABSSA.SHA384.PSS.Randomized({ supportsRSARAW: false });
}

/** RSA modulus length for the issuer keypair. 2048 is the RFC 9474 floor. */
export const ISSUER_MODULUS_LENGTH = 2048 as const;

/** Public exponent 65537 (0x010001), the standard RSA choice. */
export const ISSUER_PUBLIC_EXPONENT = Uint8Array.from([0x01, 0x00, 0x01]);

/**
 * A stable descriptor of the suite so a stored/serialized credential can record
 * exactly which algorithm minted it (forward-compatibility if we ever rotate
 * the suite, not just the key). Read from the constructed suite's params.
 */
export function suiteParams(): Pick<BlindRSAParams, 'name' | 'hash' | 'saltLength'> {
  const p = getSuite().params;
  return { name: p.name, hash: p.hash, saltLength: p.saltLength };
}

// ---------------------------------------------------------------------------
// Encodings (base64url <-> bytes). Used everywhere a credential, blinded
// message, or signature crosses the wire or lands in the device store.
// ---------------------------------------------------------------------------

/** Bytes -> base64url (no padding), the wire + storage encoding. */
export function bytesToB64u(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 =
    typeof btoa === 'function'
      ? btoa(bin)
      : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (no padding) -> bytes. */
export function b64uToBytes(b64u: string): Uint8Array {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** UTF-8 string -> bytes. */
export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * A fresh ArrayBuffer copy of some bytes, guaranteed NOT to be a SharedArrayBuffer
 * view. WebCrypto's importKey/sign typings want a `BufferSource` backed by a
 * plain ArrayBuffer; a base64url-decoded Uint8Array can carry an ArrayBufferLike
 * type that the strict lib types reject. This normalizes it.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Import an issuer public key (SPKI base64url) as an RSA-PSS/SHA-384 verify key. */
export async function importIssuerPublicKey(spkiB64u: string): Promise<CryptoKey> {
  return webcrypto().subtle.importKey(
    'spki',
    toArrayBuffer(b64uToBytes(spkiB64u)),
    { name: 'RSA-PSS', hash: 'SHA-384' },
    true,
    ['verify'],
  );
}

// ---------------------------------------------------------------------------
// WebCrypto handle (isomorphic). Server (Node 20+) and browser both expose
// `globalThis.crypto.subtle`; we resolve it lazily and throw a clear error if
// a runtime somehow lacks it, rather than crashing with an opaque undefined.
// ---------------------------------------------------------------------------

export function webcrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error(
      'WebCrypto (globalThis.crypto.subtle) is unavailable in this runtime.',
    );
  }
  return c;
}

/** Cryptographically strong random bytes, isomorphic. */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  webcrypto().getRandomValues(out);
  return out;
}

// ---------------------------------------------------------------------------
// Credential secret + token derivation
// ---------------------------------------------------------------------------

/**
 * NOTE (2026-07-05 unlinkable-redemption rework): the old per-credential secret
 * and its `credentialMessage` domain-separation helper are GONE. A credential is
 * now a stockpile of per-epoch tokens, each over a PUBLIC per-epoch message (see
 * epochTokenMessage below). Nothing is signed over a device secret anymore, so
 * there is no `newCredentialSecret` / `credentialMessage` here to leak.
 *
 * PER-EPOCH TOKEN MESSAGE (the unlinkable-redemption keystone; 2026-07-05 fix).
 *
 * WHY THIS EXISTS: the ORIGINAL design presented the raw credential `secret` +
 * the stable credential `signature` at every contribution. The server then held
 * a master key that re-derived every past/future epoch pseudonym and a stable
 * per-credential join field. That collapsed the unlinkability claim (red-team
 * finding 3, 2026-07-05). The FIX is the Privacy Pass "stockpile of single-show
 * tokens" model (draft-ietf-privacypass-batched-tokens; RFC 9474 finalized
 * tokens): at issuance the device blind-signs ONE token PER EPOCH, each over a
 * DISTINCT, PUBLIC per-epoch message. At redemption the device presents ONLY
 * that epoch's finalized signature over that epoch's public message. The server
 * verifies it as stock RSA-PSS, learns NOTHING that ties to any other epoch or
 * to issuance, and the secret NEVER leaves the device.
 *
 * The message is PUBLIC (just a versioned context label plus the epoch id). It
 * carries no secret, so revealing it at redemption reveals nothing. Possession
 * of a VALID issuer signature over it is the whole proof: an adversary cannot
 * forge epoch e+1's token from epoch e's, because each token is an independent
 * blind-signed artifact requiring the issuer private key. One issuance mints N
 * of these (one per covered epoch); when exhausted the device re-verifies.
 *
 * UNLINKABILITY: RSABSSA.Randomized prepends 32 random bytes in prepare(), and
 * each epoch uses a DIFFERENT message under an INDEPENDENT blind, so two epoch
 * tokens share no field and neither ties back to the issuance transcript. The
 * slot pseudonym + spend nullifier are derived FROM the presented epoch token
 * signature (below), so they rotate per epoch automatically and are likewise
 * mutually unlinkable across epochs.
 */
export const EPOCH_TOKEN_CONTEXT = 'havesay-signal-pool-epoch-token:v1:';

/**
 * The PUBLIC message the device blind-signs for a given epoch and nonce. Both
 * server (verify at redemption) and device (build at issuance + present at
 * redemption) compute this identically. `nonce` is in [0, RATE_LIMIT_PER_EPOCH);
 * with the cap at 1 it is always 0, but it is folded in so a future higher cap
 * yields distinct per-nonce tokens within one epoch.
 *
 * Layout (before suite.prepare): utf8("havesay-signal-pool-epoch-token:v1:E:N:")
 * There is NO secret in this message; that is the point.
 */
export function epochTokenMessage(epochId: number, nonce: number): Uint8Array {
  return utf8ToBytes(`${EPOCH_TOKEN_CONTEXT}${epochId}:${nonce}:`);
}

/**
 * The random-prefix length the Randomized RFC 9474 suite prepends in prepare()
 * (prepareType = 32). A prepared message is `random(PREPARE_PREFIX_LEN) || msg`,
 * so the server strips this many leading bytes to recover the public message and
 * bind the token to its epoch. Kept here (not hard-coded at the call site) so it
 * tracks the suite.
 */
export const PREPARE_PREFIX_LEN = 32 as const;

/**
 * True when `preparedB64u` is `random(PREPARE_PREFIX_LEN) || expectedMessage`,
 * i.e. its suffix (after the random prefix) equals the given public message.
 * Constant-length structural check; the cryptographic proof is the RSA-PSS verify
 * of the signature over these same prepared bytes.
 */
export function preparedSuffixMatches(preparedB64u: string, expected: Uint8Array): boolean {
  const prepared = b64uToBytes(preparedB64u);
  if (prepared.length !== PREPARE_PREFIX_LEN + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (prepared[PREPARE_PREFIX_LEN + i] !== expected[i]) return false;
  }
  return true;
}

/**
 * The per-epoch SPEND NULLIFIER, derived from the PRESENTED epoch token
 * signature (not from any secret). The ledger rejects a repeated (epochId,
 * nullifier), which caps a credential at RATE_LIMIT_PER_EPOCH contributions per
 * epoch WITHOUT the server learning identity and WITHOUT any value that crosses
 * epochs. SHA-256 over a domain-separated label plus the finalized token bytes.
 *
 * Deterministic in the token signature, so a within-epoch re-share (same token)
 * maps to the same nullifier (idempotent). A DIFFERENT epoch presents a
 * DIFFERENT, independently blind-signed token, so its nullifier is fresh and
 * unlinkable. The server can recompute this from what the device sent, so it
 * does not have to trust a device-supplied nullifier.
 */
export const TOKEN_NULLIFIER_LABEL = 'havesay-signal-pool-nullifier:v2:';

export async function deriveTokenNullifierFromSig(
  tokenSignatureB64u: string,
): Promise<string> {
  const label = utf8ToBytes(TOKEN_NULLIFIER_LABEL);
  const sig = b64uToBytes(tokenSignatureB64u);
  const buf = new Uint8Array(label.length + sig.length);
  buf.set(label, 0);
  buf.set(sig, label.length);
  const digest = await webcrypto().subtle.digest('SHA-256', toArrayBuffer(buf));
  return bytesToB64u(new Uint8Array(digest));
}

/**
 * How many unlinkable redemptions one credential is allowed per epoch. The slot
 * model (part 2) uses ONE contribution per epoch in the common case, so 1 is
 * the honest default; we expose it as a constant so the ledger + part-2 slot
 * writer agree on the same cap. Kept small on purpose: a higher cap widens the
 * within-epoch linkage window the architecture memo already discloses.
 */
export const RATE_LIMIT_PER_EPOCH = 1 as const;

/**
 * How many future epoch tokens one issuance mints (the stockpile size). At
 * issuance the device blind-signs this many per-epoch tokens, one for each of
 * the next COVERED_EPOCHS weeks, so it can contribute unlinkably for that span
 * before re-verifying. Overridable via SIGNAL_POOL_COVERED_EPOCHS. Kept modest
 * on purpose: a larger stockpile lets a device contribute longer without
 * re-verifying, but also lets a compromised device spend further into the
 * future. 26 weeks (~6 months, matching the staleness horizon) is the default.
 */
export const DEFAULT_COVERED_EPOCHS = 26 as const;

export function coveredEpochs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SIGNAL_POOL_COVERED_EPOCHS;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n <= 260) return n;
  }
  return DEFAULT_COVERED_EPOCHS;
}
