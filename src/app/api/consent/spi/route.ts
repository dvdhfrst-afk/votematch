import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/session';

/**
 * Record the user's explicit SPI (Sensitive Personal Information) opt-in.
 *
 * Called by the quick-match consent card before any political-preference
 * data is collected. Writes `spi_consent_at = now()` on the users row and
 * mirrors the ISO timestamp to an httpOnly cookie so returning users skip
 * the gate. See council decision 2026-04-20 / Legal Lens #4.
 *
 * The service-role client is required because the anon-key RLS policy on
 * `users` does not permit self-updates of this column. Same pattern as the
 * session bootstrap in lib/session.ts.
 */
const CONSENT_COOKIE = 'spi_consent_at';
const CONSENT_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days — matches session

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ consented: false, at: null });
  }
  return NextResponse.json({
    consented: !!user.spi_consent_at,
    at: user.spi_consent_at,
  });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { error: 'No active session. Please look up your ballot first.' },
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => null);
  if (!body || body.consent !== true) {
    return NextResponse.json(
      { error: 'Explicit consent required.' },
      { status: 400 },
    );
  }

  // Idempotent: if already consented, don't overwrite the original timestamp —
  // legal wants the first-consent moment preserved.
  const now = user.spi_consent_at ?? new Date().toISOString();

  if (!user.spi_consent_at) {
    const supabase = await createServiceClient();
    const { error } = await supabase
      .from('users')
      .update({ spi_consent_at: now })
      .eq('id', user.id);
    if (error) {
      console.error('Failed to record SPI consent:', error);
      return NextResponse.json(
        { error: 'Failed to record consent.' },
        { status: 500 },
      );
    }
  }

  const res = NextResponse.json({ consented: true, at: now });
  // Mirror to cookie so the client can skip the gate without a round-trip.
  // httpOnly is intentionally FALSE here — the quick-match page reads it
  // from the browser to decide whether to render the consent card.
  res.cookies.set(CONSENT_COOKIE, now, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: CONSENT_COOKIE_MAX_AGE,
  });
  return res;
}
