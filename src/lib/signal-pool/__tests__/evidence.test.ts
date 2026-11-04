/**
 * Evidence provider + evidence-token + dedup tests (Phase 3B, part 1).
 *
 * The DB-level one-credential-per-identity guarantee is enforced by the UNIQUE
 * primary key on evidence_identities(provider, identity_hash) in the staged
 * schema (issueCredential surfaces a 23505 as 'evidence_already_used'); that
 * path needs the live DB and is exercised in integration, not here. What we CAN
 * assert without a DB:
 *   - the identity HASH is deterministic per normalized identity + pepper, and
 *     differs when the pepper differs (so the dedup key is stable and peppered);
 *   - the mock phone provider drives start/confirm and rejects VOIP + bad codes;
 *   - the evidence token round-trips, binds the identity hash, and rejects
 *     tampering / expiry (a client cannot forge its own identity hash).
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeE164,
  hashEvidenceIdentity,
  createMockPhoneProvider,
  getPhoneProvider,
} from '../evidence';
import { createEvidenceToken, verifyEvidenceToken } from '../evidence-token';

const PEPPER_ENV = { SIGNAL_POOL_EVIDENCE_PEPPER: 'test-pepper-abc' };
const TOKEN_ENV = { SIGNAL_POOL_EVIDENCE_TOKEN_SECRET: 'test-token-secret-xyz' };

describe('identity normalization + hashing (the dedup key)', () => {
  it('normalizes to E.164', () => {
    expect(normalizeE164('(801) 555-0100')).toBe('+18015550100');
    expect(normalizeE164('8015550100')).toBe('+18015550100');
    expect(normalizeE164('+18015550100')).toBe('+18015550100');
    expect(normalizeE164('1-801-555-0100')).toBe('+18015550100');
  });

  it('hashes deterministically per (identity, pepper)', async () => {
    const a = await hashEvidenceIdentity('+18015550100', PEPPER_ENV);
    const b = await hashEvidenceIdentity('+18015550100', PEPPER_ENV);
    expect(a).toEqual(b);
    // Different identity -> different hash.
    const c = await hashEvidenceIdentity('+18015550101', PEPPER_ENV);
    expect(a).not.toEqual(c);
  });

  it('pepper changes the hash (non-correlatable across systems)', async () => {
    const a = await hashEvidenceIdentity('+18015550100', PEPPER_ENV);
    const b = await hashEvidenceIdentity('+18015550100', {
      SIGNAL_POOL_EVIDENCE_PEPPER: 'different-pepper',
    });
    expect(a).not.toEqual(b);
  });

  it('refuses to hash without a pepper', async () => {
    await expect(hashEvidenceIdentity('+18015550100', {})).rejects.toThrow(/PEPPER/);
  });

  it('the same phone hashes to the SAME dedup key (blocks a second credential)', async () => {
    // This is the property the DB unique key relies on: normalize + hash is a
    // stable function of the phone, so a repeat signup collides on identity_hash.
    const first = await hashEvidenceIdentity(normalizeE164('801-555-0100'), PEPPER_ENV);
    const second = await hashEvidenceIdentity(normalizeE164('(801) 555.0100'), PEPPER_ENV);
    expect(first).toEqual(second);
  });
});

describe('mock phone provider', () => {
  it('rejects VOIP numbers at lookup', async () => {
    const p = createMockPhoneProvider();
    const res = await p.lookup('+19995550100');
    expect(res.acceptable).toBe(false);
    expect(res.lineType).toBe('voip');
  });

  it('accepts a normal mobile and completes start -> confirm', async () => {
    const p = createMockPhoneProvider();
    const look = await p.lookup('801-555-0100');
    expect(look.acceptable).toBe(true);
    const started = await p.startVerification(look.e164);
    expect(started.ok).toBe(true);
    // The mock code is the last 6 digits of the E.164 digits.
    const code = look.e164.replace(/\D/g, '').slice(-6).padStart(6, '0');
    const good = await p.checkVerification(started.handle, code);
    expect(good.ok).toBe(true);
  });

  it('rejects a wrong code and a reused handle', async () => {
    const p = createMockPhoneProvider();
    const started = await p.startVerification('+18015550100');
    const bad = await p.checkVerification(started.handle, '000000');
    expect(bad.ok).toBe(false);
    // Correct code then consumes the handle; a second confirm fails.
    const code = '5550100'.slice(-6);
    await p.checkVerification(started.handle, code);
    const reused = await p.checkVerification(started.handle, code);
    expect(reused.ok).toBe(false);
  });
});

describe('mock hard-fence (finding 5): flag-on must refuse the mock', () => {
  it('returns the mock when the flag is OFF (dev/tests)', () => {
    const p = getPhoneProvider({});
    expect(p.name).toBe('mock');
  });

  it('THROWS when the flag is ON and no real provider + no override', () => {
    expect(() =>
      getPhoneProvider({ NEXT_PUBLIC_SIGNAL_POOL_ENABLED: 'true' }),
    ).toThrow(/real phone provider|Refusing/i);
  });

  it('allows the mock flag-on ONLY with the explicit dev override', () => {
    const p = getPhoneProvider({
      NEXT_PUBLIC_SIGNAL_POOL_ENABLED: 'true',
      SIGNAL_POOL_ALLOW_MOCK_PHONE: 'true',
    });
    expect(p.name).toBe('mock');
  });

  it('throws when Twilio env is present but the real driver is unwired (never silent mock)', () => {
    expect(() =>
      getPhoneProvider({
        TWILIO_ACCOUNT_SID: 'x',
        TWILIO_AUTH_TOKEN: 'y',
        TWILIO_VERIFY_SERVICE_SID: 'z',
      }),
    ).toThrow(/not wired/i);
  });
});

describe('evidence token (carries the verified identity hash to /issue)', () => {
  it('round-trips and binds provider + identity hash', async () => {
    const hash = await hashEvidenceIdentity('+18015550100', PEPPER_ENV);
    const token = createEvidenceToken('phone', hash, TOKEN_ENV);
    const res = verifyEvidenceToken(token, TOKEN_ENV);
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.provider).toBe('phone');
      expect(res.identityHash).toBe(hash);
    }
  });

  it('rejects a tampered token', async () => {
    const hash = await hashEvidenceIdentity('+18015550100', PEPPER_ENV);
    const token = createEvidenceToken('phone', hash, TOKEN_ENV);
    // Flip a character in the middle of the token.
    const tampered = token.slice(0, 10) + (token[10] === 'A' ? 'B' : 'A') + token.slice(11);
    const res = verifyEvidenceToken(tampered, TOKEN_ENV);
    expect(res.valid).toBe(false);
  });

  it('rejects a token signed with a different secret', async () => {
    const hash = await hashEvidenceIdentity('+18015550100', PEPPER_ENV);
    const token = createEvidenceToken('phone', hash, TOKEN_ENV);
    const res = verifyEvidenceToken(token, {
      SIGNAL_POOL_EVIDENCE_TOKEN_SECRET: 'attacker-secret',
    });
    expect(res.valid).toBe(false);
  });

  it('rejects an expired token', async () => {
    // Mint a token that is already expired by pre-dating the clock is not
    // possible via the API; instead assert a malformed/expired guard exists by
    // hand-crafting a payload with a past expiry and a valid HMAC over it.
    const crypto = await import('crypto');
    const past = Date.now() - 1000;
    const payload = `phone:abc:${past}`;
    const sig = crypto
      .createHmac('sha256', TOKEN_ENV.SIGNAL_POOL_EVIDENCE_TOKEN_SECRET)
      .update(payload)
      .digest('base64url');
    const token = Buffer.from(`${payload}:${sig}`).toString('base64url');
    const res = verifyEvidenceToken(token, TOKEN_ENV);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.error).toMatch(/expired/);
  });
});
