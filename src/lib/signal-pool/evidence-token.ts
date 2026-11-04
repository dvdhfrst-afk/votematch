/**
 * Evidence tokens (work-order Phase 3B, part 1).
 *
 * WHY: the ceremony is two HTTP calls. verify-phone/confirm proves the applicant
 * controls a phone and computes its evidence identity HASH; issue then blind-
 * signs. Something must carry "this identity hash was just verified" from the
 * first call to the second WITHOUT re-doing SMS and WITHOUT trusting the client
 * to assert its own identity hash. An EVIDENCE TOKEN is a short-lived, server-
 * HMAC-signed assertion binding (provider, identity_hash, expiry). The issue
 * endpoint verifies the HMAC, so a client can never fabricate an evidence hash.
 *
 * The token carries ONLY the peppered identity HASH (never the phone), and it is
 * severed from the credential by the blind signature, so it is never a join key.
 *
 * Same HMAC construction as retention/tokens.ts, parameterized for this use.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import crypto from 'crypto';

/** Short lifetime: the applicant should go straight from confirm to issue. */
const EVIDENCE_TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function secret(env: Record<string, string | undefined> = process.env): string {
  const s = env.SIGNAL_POOL_EVIDENCE_TOKEN_SECRET;
  if (!s) throw new Error('SIGNAL_POOL_EVIDENCE_TOKEN_SECRET env var is required');
  return s;
}

function sign(payload: string, env?: Record<string, string | undefined>): string {
  return crypto.createHmac('sha256', secret(env)).update(payload).digest('base64url');
}

export type EvidenceProvider = 'phone' | 'voter-file';

/** Mint an evidence token binding a verified identity hash. */
export function createEvidenceToken(
  provider: EvidenceProvider,
  identityHash: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const expiry = Date.now() + EVIDENCE_TOKEN_EXPIRY_MS;
  // identityHash is base64url (no ':'), so ':' is a safe field separator.
  const payload = `${provider}:${identityHash}:${expiry}`;
  const signature = sign(payload, env);
  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}

export type EvidenceTokenResult =
  | { valid: true; provider: EvidenceProvider; identityHash: string }
  | { valid: false; error: string };

/** Verify + decode an evidence token. Rejects tampered or expired tokens. */
export function verifyEvidenceToken(
  token: string,
  env: Record<string, string | undefined> = process.env,
): EvidenceTokenResult {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    const parts = decoded.split(':');
    if (parts.length !== 4) return { valid: false, error: 'Malformed token' };
    const [provider, identityHash, expiryStr, signature] = parts;
    if (provider !== 'phone' && provider !== 'voter-file') {
      return { valid: false, error: 'Invalid provider' };
    }
    const expiry = parseInt(expiryStr, 10);
    if (Number.isNaN(expiry) || Date.now() > expiry) {
      return { valid: false, error: 'Token expired' };
    }
    const expected = sign(`${provider}:${identityHash}:${expiry}`, env);
    // Constant-time compare to avoid a timing oracle on the HMAC.
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { valid: false, error: 'Invalid signature' };
    }
    return { valid: true, provider, identityHash };
  } catch {
    return { valid: false, error: 'Failed to decode token' };
  }
}
