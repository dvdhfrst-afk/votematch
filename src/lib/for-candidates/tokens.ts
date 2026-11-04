/**
 * /for-candidates portal magic-link tokens.
 *
 * Same HMAC-base64url shape as lib/retention/tokens.ts and lib/session.ts:
 *   base64url("for-candidates:{tokenId}:{expiry}:{signature}")
 *
 * tokenId is a UUID — the row id in candidate_questionnaire_tokens. We
 * purposely DON'T encode the candidate_id or the pending_claim_id into the
 * token payload; that mapping lives in the DB row keyed by tokenId. This way
 * a single token verify() call hits exactly one row and we get the candidate
 * vs pending-claim disambiguation + consumed_at + revoke check in one
 * round-trip.
 *
 * Secret: RETENTION_TOKEN_SECRET (the same env var the retention engine uses).
 * Reusing it avoids another secret to rotate; this token type is namespaced
 * by the leading "for-candidates:" so cross-action replay isn't possible.
 */
import crypto from 'crypto';

const FOR_CANDIDATES_EXPIRY_HOURS = 24 * 7; // 7 days

function secret(): string {
  const s = process.env.RETENTION_TOKEN_SECRET;
  if (!s) throw new Error('RETENTION_TOKEN_SECRET env var is required');
  return s;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createForCandidatesToken(tokenId: string): {
  token: string;
  fingerprint: string;
  expiresAt: Date;
} {
  const expiry = Date.now() + FOR_CANDIDATES_EXPIRY_HOURS * 60 * 60 * 1000;
  const payload = `for-candidates:${tokenId}:${expiry}`;
  const signature = sign(payload);
  const token = Buffer.from(`${payload}:${signature}`).toString('base64url');
  return {
    token,
    fingerprint: hashToken(token),
    expiresAt: new Date(expiry),
  };
}

export type ForCandidatesTokenVerifyResult =
  | { valid: true; tokenId: string; expiresAt: Date }
  | { valid: false; error: string };

/**
 * Pure structural verify — no DB lookup. Caller is still responsible for
 * checking the candidate_questionnaire_tokens row (consumed_at, etc.).
 */
export function verifyForCandidatesToken(token: string): ForCandidatesTokenVerifyResult {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    const parts = decoded.split(':');
    if (parts.length < 4) return { valid: false, error: 'Malformed token' };

    const signature = parts.pop()!;
    const expiryStr = parts.pop()!;
    const tokenId = parts.pop()!;
    const action = parts.join(':');

    if (action !== 'for-candidates') {
      return { valid: false, error: 'Invalid action' };
    }
    const expiry = parseInt(expiryStr, 10);
    if (isNaN(expiry) || Date.now() > expiry) {
      return { valid: false, error: 'Token expired' };
    }

    const expected = sign(`for-candidates:${tokenId}:${expiry}`);
    if (signature !== expected) return { valid: false, error: 'Invalid signature' };

    return { valid: true, tokenId, expiresAt: new Date(expiry) };
  } catch {
    return { valid: false, error: 'Failed to decode token' };
  }
}
