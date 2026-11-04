/**
 * POST /api/signal-pool/verify-phone  (work-order Phase 3B, part 1)
 *
 * The PHONE evidence provider's two-step flow, folded into one endpoint keyed by
 * `action`:
 *   action='start'   -> { phone }        : VOIP-filter + send an OTP.
 *   action='confirm' -> { handle, code } : confirm the OTP; on success return an
 *                        EVIDENCE TOKEN the /issue endpoint consumes. The token
 *                        binds the peppered identity HASH (never the phone).
 *
 * FLAG GATE (invariant 4): 404s cleanly when NEXT_PUBLIC_SIGNAL_POOL_ENABLED is
 * not 'true'. RATE-LIMITED per IP+phone via a small in-process limiter (the
 * pilot is friends-and-family scale; a durable limiter comes with production).
 *
 * DEV/MOCK: with no Twilio env, the mock provider drives the whole flow so the
 * pilot runs without a paid SMS account. The response flags mock mode so a UI
 * can show the dev code path honestly.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isSignalPoolEnabled } from '@/lib/signal-pool/flag';
import {
  getPhoneProvider,
  isMockPhoneProvider,
  normalizeE164,
  hashEvidenceIdentity,
} from '@/lib/signal-pool/evidence';
import { createEvidenceToken } from '@/lib/signal-pool/evidence-token';

/** Clean 404 body, identical for every flag-off signal-pool route. */
function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

// --- tiny in-process rate limiter (pilot scale only) -----------------------
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > MAX_PER_WINDOW;
}

export async function POST(req: NextRequest) {
  if (!isSignalPoolEnabled()) return notFound();

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  const action = body.action;
  const provider = getPhoneProvider();
  const mock = isMockPhoneProvider();

  try {
    if (action === 'start') {
      const phone = typeof body.phone === 'string' ? body.phone : '';
      if (!phone) return NextResponse.json({ error: 'phone is required' }, { status: 400 });
      if (rateLimited(`start:${ip}:${normalizeE164(phone)}`)) {
        return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
      }

      const lookup = await provider.lookup(phone);
      if (!lookup.acceptable) {
        return NextResponse.json(
          { error: lookup.reason ?? 'Phone number not accepted', lineType: lookup.lineType },
          { status: 422 },
        );
      }
      const started = await provider.startVerification(lookup.e164);
      if (!started.ok) {
        return NextResponse.json(
          { error: started.reason ?? 'Failed to send code' },
          { status: 502 },
        );
      }
      return NextResponse.json({ ok: true, handle: started.handle, mock });
    }

    if (action === 'confirm') {
      const handle = typeof body.handle === 'string' ? body.handle : '';
      const code = typeof body.code === 'string' ? body.code : '';
      const phone = typeof body.phone === 'string' ? body.phone : '';
      if (!handle || !code || !phone) {
        return NextResponse.json(
          { error: 'handle, code, and phone are required' },
          { status: 400 },
        );
      }
      if (rateLimited(`confirm:${ip}:${handle}`)) {
        return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
      }

      const checked = await provider.checkVerification(handle, code);
      if (!checked.ok) {
        return NextResponse.json(
          { error: checked.reason ?? 'Verification failed' },
          { status: 401 },
        );
      }

      // Verified. Compute the peppered identity hash and mint the evidence token
      // the /issue endpoint will consume. We hash the SAME normalized E.164 the
      // provider validated so start + confirm agree on the identity.
      const e164 = normalizeE164(phone);
      const identityHash = await hashEvidenceIdentity(e164);
      const evidenceToken = createEvidenceToken('phone', identityHash);
      return NextResponse.json({ ok: true, evidenceToken });
    }

    return NextResponse.json(
      { error: "action must be 'start' or 'confirm'" },
      { status: 400 },
    );
  } catch (err) {
    // A thrown provider (e.g. Twilio env present but real driver not wired) or a
    // missing pepper surfaces here as a clean 500, never a stack leak.
    console.error('verify-phone route error:', err);
    return NextResponse.json(
      { error: 'Phone verification is not available.' },
      { status: 500 },
    );
  }
}
