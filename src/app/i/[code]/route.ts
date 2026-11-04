import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * Invite-link entry point: `ballotbridge.org/i/[code]`.
 *
 *   1. Validate the code against `invites` (must exist + active).
 *   2. Set a `referrer_invite_code` cookie (90-day, HttpOnly, SameSite=Lax).
 *      Attribution happens later, when this visitor's `users` row is first
 *      materialized in `getOrCreateSession` — keeps this hot-path fast and
 *      avoids creating an orphan acceptance row before the user does anything.
 *   3. 302 → `/`.
 *
 * Returns 404 if the code is invalid or inactive. We deliberately don't
 * bounce to `/?ref=invalid` or similar; an invalid invite is just "page not
 * found" so we don't leak inviter-id space via probing.
 */

const REFERRER_COOKIE_NAME = 'referrer_invite_code';
const REFERRER_MAX_AGE = 60 * 60 * 24 * 90; // 90 days

const COOKIE_SECURE = process.env.NODE_ENV === 'production';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;

  // Cheap structural reject — codes are 7 base32 chars, uppercase. No DB
  // round-trip for obviously bogus paths (crawler probes, typos).
  if (!isStructurallyValidCode(code)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const supabase = await createServiceClient();
  const { data: invite } = await supabase
    .from('invites')
    .select('invite_code, active')
    .eq('invite_code', code)
    .eq('active', true)
    .maybeSingle();

  if (!invite) {
    return new NextResponse('Not found', { status: 404 });
  }

  // 302 → root. The cookie carries attribution forward; we don't append
  // ?ref= to the URL because URL params leak into referrer headers and
  // server logs (per the privacy guardrails in CLAUDE.md).
  const url = new URL('/', request.url);
  const response = NextResponse.redirect(url, 302);

  response.cookies.set(REFERRER_COOKIE_NAME, code, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: REFERRER_MAX_AGE,
  });

  return response;
}

function isStructurallyValidCode(code: string): boolean {
  // 7 chars, uppercase Crockford-base32 (no I/L/O/U to avoid visual
  // confusion; matches the generator in invite-actions.ts).
  return /^[0-9A-HJKMNP-TV-Z]{7}$/.test(code);
}
