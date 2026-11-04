/**
 * HMAC-signed tokens for subscribe verification + unsubscribe links.
 * Same pattern as session.ts magic-link tokens but parameterized by action.
 */
import crypto from 'crypto';

const VERIFY_EXPIRY_HOURS = 72;
const UNSUBSCRIBE_EXPIRY_HOURS = 365 * 24; // Basically forever — unsubscribe must always work.

function secret(): string {
  const s = process.env.RETENTION_TOKEN_SECRET;
  if (!s) throw new Error('RETENTION_TOKEN_SECRET env var is required');
  return s;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export type TokenAction = 'verify' | 'unsubscribe';

export function createToken(action: TokenAction, subscriberId: string): string {
  const expiryHours = action === 'verify' ? VERIFY_EXPIRY_HOURS : UNSUBSCRIBE_EXPIRY_HOURS;
  const expiry = Date.now() + expiryHours * 60 * 60 * 1000;
  const payload = `${action}:${subscriberId}:${expiry}`;
  const signature = sign(payload);
  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}

export type TokenVerifyResult =
  | { valid: true; action: TokenAction; subscriberId: string }
  | { valid: false; error: string };

export function verifyToken(token: string): TokenVerifyResult {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    const parts = decoded.split(':');
    if (parts.length < 4) return { valid: false, error: 'Malformed token' };

    const signature = parts.pop()!;
    const expiry = parseInt(parts.pop()!, 10);
    const subscriberId = parts.pop()!;
    const action = parts.join(':') as TokenAction;

    if (action !== 'verify' && action !== 'unsubscribe') {
      return { valid: false, error: 'Invalid action' };
    }
    if (isNaN(expiry) || Date.now() > expiry) {
      return { valid: false, error: 'Token expired' };
    }

    const expected = sign(`${action}:${subscriberId}:${expiry}`);
    if (signature !== expected) return { valid: false, error: 'Invalid signature' };

    return { valid: true, action, subscriberId };
  } catch {
    return { valid: false, error: 'Failed to decode token' };
  }
}
