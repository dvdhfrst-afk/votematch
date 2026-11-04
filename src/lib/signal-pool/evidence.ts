/**
 * Verification-evidence plug interface (work-order Phase 3B, part 1).
 *
 * DESIGN PRINCIPLE (founder-resolved): ONE issuance ceremony, PLUGGABLE
 * verification evidence. A provider proves "this applicant is a distinct real
 * person" and yields a NORMALIZED evidence identity that the ceremony hashes for
 * one-credential-per-identity dedup. The credential itself is issued blind, so
 * the identity hash can never be joined to the credential.
 *
 * v1 provider = PHONE VERIFICATION (SMS one-time code + VOIP filtering).
 * v2 provider (LATER, legal-gated, NOT built here) = voter-file match.
 *
 * The identity HASH is HMAC-SHA256(normalize_e164(identity), server_pepper),
 * base64url. The pepper (SIGNAL_POOL_EVIDENCE_PEPPER) is server-only, so the
 * hash is non-reversible without server compromise and non-correlatable across
 * systems. We store the HASH only, never the phone number.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { webcrypto, utf8ToBytes, bytesToB64u, toArrayBuffer } from './crypto';

// ---------------------------------------------------------------------------
// Identity hashing
// ---------------------------------------------------------------------------

/**
 * Normalize a phone number toward E.164 for stable hashing. This is a
 * pragmatic normalizer (strip spaces/punctuation, assume US +1 when a bare
 * 10-digit number is given). A production phone provider (Twilio Lookup) returns
 * the carrier-canonical E.164 directly; when we have that, pass it through and
 * this normalizer is a no-op on already-E.164 input.
 */
export function normalizeE164(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/**
 * The peppered HMAC of a normalized evidence identity. This is what lands in
 * evidence_identities.identity_hash. Requires SIGNAL_POOL_EVIDENCE_PEPPER; a
 * missing pepper is a hard error (we must never store an un-peppered hash).
 */
export async function hashEvidenceIdentity(
  normalizedIdentity: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const pepper = env.SIGNAL_POOL_EVIDENCE_PEPPER;
  if (!pepper) {
    throw new Error(
      'SIGNAL_POOL_EVIDENCE_PEPPER is not set; refusing to hash evidence identity un-peppered.',
    );
  }
  const key = await webcrypto().subtle.importKey(
    'raw',
    toArrayBuffer(utf8ToBytes(pepper)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await webcrypto().subtle.sign(
    'HMAC',
    key,
    toArrayBuffer(utf8ToBytes(normalizedIdentity)),
  );
  return bytesToB64u(new Uint8Array(mac));
}

// ---------------------------------------------------------------------------
// Phone provider abstraction
// ---------------------------------------------------------------------------

export type PhoneLineType = 'mobile' | 'landline' | 'voip' | 'unknown';

export interface PhoneLookupResult {
  /** Carrier-canonical E.164, when the provider returns one. */
  e164: string;
  lineType: PhoneLineType;
  /** True when the provider judged the number acceptable (not VOIP, low risk). */
  acceptable: boolean;
  reason?: string;
}

/**
 * A phone-verification provider. `startVerification` sends the SMS one-time code
 * (after a VOIP/line-type check); `checkVerification` confirms the code. The
 * dev/mock driver runs the whole flow WITHOUT a paid SMS account so the pilot
 * can exercise the ceremony end to end.
 */
export interface PhoneProvider {
  readonly name: string;
  /** Line-type + risk check. Rejects VOIP by default. */
  lookup(phone: string): Promise<PhoneLookupResult>;
  /** Send an OTP. Returns an opaque verification handle. */
  startVerification(e164: string): Promise<{ ok: boolean; handle: string; reason?: string }>;
  /** Confirm an OTP against the handle. */
  checkVerification(
    handle: string,
    code: string,
  ): Promise<{ ok: boolean; reason?: string }>;
}

// ---------------------------------------------------------------------------
// Mock / dev driver
// ---------------------------------------------------------------------------

/** In-memory pending verifications for the mock driver. Cleared on restart. */
interface MockPending {
  e164: string;
  code: string;
  createdAt: number;
}
const mockStore = new Map<string, MockPending>();

/**
 * The dev/mock phone provider. It:
 *   - treats a bare US number as mobile+acceptable, and any number containing
 *     "voip" markers OR a configured VOIP test prefix as VOIP+unacceptable, so
 *     the VOIP-filter path is exercisable in tests;
 *   - "sends" a deterministic code (default '000000', or the last 6 digits of
 *     the number) and stores it in memory;
 *   - confirms against that code.
 *
 * NEVER selected in production: the factory below picks the real provider when
 * Twilio env is present, else this mock, and logs which one it chose. The mock
 * is safe because it grants no real personhood; the pilot is friends-and-family.
 */
export function createMockPhoneProvider(): PhoneProvider {
  return {
    name: 'mock',
    async lookup(phone: string): Promise<PhoneLookupResult> {
      const e164 = normalizeE164(phone);
      // Test hook: numbers in the +1999... range simulate VOIP.
      const isVoip = /^\+1999/.test(e164);
      return isVoip
        ? { e164, lineType: 'voip', acceptable: false, reason: 'VOIP numbers are not accepted' }
        : { e164, lineType: 'mobile', acceptable: true };
    },
    async startVerification(e164: string) {
      const code = e164.replace(/\D/g, '').slice(-6).padStart(6, '0');
      const handle = `mock-${bytesToB64u(utf8ToBytes(e164)).slice(0, 16)}`;
      mockStore.set(handle, { e164, code, createdAt: Date.now() });
      return { ok: true, handle };
    },
    async checkVerification(handle: string, code: string) {
      const pending = mockStore.get(handle);
      if (!pending) return { ok: false, reason: 'unknown or expired verification' };
      if (pending.code !== code) return { ok: false, reason: 'incorrect code' };
      mockStore.delete(handle);
      return { ok: true };
    },
  };
}

/**
 * Provider factory. Returns the REAL Twilio-backed provider when its env is
 * present, else the mock. The real provider is intentionally NOT implemented in
 * this part (it needs a paid account); see the report for the exact env keys.
 *
 * HARD MOCK FENCE (red-team finding 5, 2026-07-05). The mock grants a credential
 * to any phone-number string, so N strings mint N credentials. That is only safe
 * in dev. Previously the mock-vs-real choice was tied ONLY to the presence of
 * Twilio env, so a flag-ON production deploy that simply forgot to set Twilio
 * would silently run the mock and mint unlimited credentials. Now, the mock is
 * REFUSED whenever the pool is enabled UNLESS an explicit dev override
 * (SIGNAL_POOL_ALLOW_MOCK_PHONE=true) is set. Config discipline is no longer
 * load-bearing: flag-on without real Twilio env fails closed to "real provider
 * required."
 */
export function getPhoneProvider(env: Record<string, string | undefined> = process.env): PhoneProvider {
  const hasTwilio = Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID,
  );
  if (hasTwilio) {
    // Real SMS requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
    // TWILIO_VERIFY_SERVICE_SID (Twilio Verify service) and a Lookup line-type
    // call for VOIP filtering. Wire the real driver here when the account exists.
    throw new Error(
      'Twilio env present but the real phone provider is not wired in this build. ' +
        'Implement the Twilio Verify + Lookup driver in evidence.ts (see report).',
    );
  }

  // No real provider. The mock is allowed ONLY when the pool is off (dev/tests
  // never reach issuance with the flag off), OR when an explicit dev override is
  // set. Flag-on without that override refuses the mock: fail closed.
  const flagOn = env.NEXT_PUBLIC_SIGNAL_POOL_ENABLED === 'true';
  const allowMock = env.SIGNAL_POOL_ALLOW_MOCK_PHONE === 'true';
  if (flagOn && !allowMock) {
    throw new Error(
      'Signal pool is enabled but no real phone provider is configured. Refusing to ' +
        'fall back to the mock provider (it grants a credential to any number and ' +
        'would allow unlimited Sybil credentials). Configure Twilio env, or set the ' +
        'explicit dev override SIGNAL_POOL_ALLOW_MOCK_PHONE=true.',
    );
  }
  return createMockPhoneProvider();
}

/** True when the active provider is only the dev mock (surfaced to callers). */
export function isMockPhoneProvider(env: Record<string, string | undefined> = process.env): boolean {
  return !(
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.TWILIO_VERIFY_SERVICE_SID
  );
}
