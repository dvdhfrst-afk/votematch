import { cookies, headers } from 'next/headers';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import type { User } from '@/types/database';
import crypto from 'crypto';

const SESSION_COOKIE_NAME = 'session_token';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const REFERRER_COOKIE_NAME = 'referrer_invite_code';

// `secure: true` used to be hardcoded everywhere, which dropped cookies on
// localhost dev / non-TLS proxies. Gate on NODE_ENV: strict in prod, relaxed
// in dev. Council finding #5.
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// generateSessionToken
// ---------------------------------------------------------------------------

export function generateSessionToken(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// getOrCreateSession
// ---------------------------------------------------------------------------
// Reads the session_token cookie, looks up the user in the DB, and returns it.
// If no cookie or no matching user, creates a new anonymous user and returns
// both the user and the new token (caller must set the cookie).
// ---------------------------------------------------------------------------

export async function getOrCreateSession(): Promise<{
  user: User;
  token: string;
  isNew: boolean;
}> {
  const cookieStore = await cookies();
  const existingToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  const supabase = await createClient();

  if (existingToken) {
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('session_token', existingToken)
      .single();

    if (user) {
      return { user: user as User, token: existingToken, isNew: false };
    }

    // Cookie present but no users row — this is the deferred-insert path.
    // proxy.ts now sets the cookie without inserting a row (council #1: stops
    // unbounded orphan rows from cookie-less / prefetch / CDN-stripped
    // requests). The first authenticated action lands here and lazily
    // materialises the row, reusing the token the browser already holds.
    const serviceSupabase = await createServiceClient();
    const { data: lazyUser, error: lazyErr } = await serviceSupabase
      .from('users')
      .insert({ session_token: existingToken })
      .select()
      .single();

    if (!lazyErr && lazyUser) {
      await maybeAttributeInvite(lazyUser.id);
      return { user: lazyUser as User, token: existingToken, isNew: true };
    }
    // If the insert raced (another request just materialised the row),
    // re-read and use that.
    if (lazyErr) {
      const { data: reread } = await serviceSupabase
        .from('users')
        .select('*')
        .eq('session_token', existingToken)
        .single();
      if (reread) {
        return { user: reread as User, token: existingToken, isNew: false };
      }
    }
    // Fall through to mint a fresh token if the deferred insert failed for
    // some other reason — better to issue a new session than to 500.
  }

  // Create new anonymous user. RLS blocks anon-key inserts on `users`, so we
  // use the service client here — same pattern as proxy.ts.
  const newToken = generateSessionToken();
  const serviceSupabase = await createServiceClient();
  const { data: newUser, error } = await serviceSupabase
    .from('users')
    .insert({ session_token: newToken })
    .select()
    .single();

  if (error || !newUser) {
    throw new Error(`Failed to create session: ${error?.message ?? 'Unknown error'}`);
  }

  await maybeAttributeInvite(newUser.id);

  return { user: newUser as User, token: newToken, isNew: true };
}

// ---------------------------------------------------------------------------
// maybeAttributeInvite — invite-cookie attribution on first user materialization
// ---------------------------------------------------------------------------
// Called from `getOrCreateSession` whenever a fresh `users` row is created
// (either via the new-token path or the deferred-insert path). Reads the
// `referrer_invite_code` cookie, validates it, blocks self-invite via cookie
// + IP-hash check, and inserts a row into `invite_acceptances` so the
// participation counters can light up. The cookie is then cleared so the
// attribution doesn't double-fire on a second materialization (e.g. if the
// user clears their `users` row but keeps the browser cookie).
//
// Failure-mode: any error here is swallowed. A miss-attributed visitor is
// strictly less bad than a 500 on session creation — the rest of the app
// must keep working even if invites aren't wired up yet.
// ---------------------------------------------------------------------------

async function maybeAttributeInvite(inviteeUserId: string): Promise<void> {
  try {
    const cookieStore = await cookies();
    const code = cookieStore.get(REFERRER_COOKIE_NAME)?.value;
    if (!code) return;

    const supabase = await createServiceClient();

    // Resolve the active invite. Inactive/rotated codes still attribute
    // historically (we hand the historical inviter credit) — they just can't
    // be created anymore.
    const { data: invite } = await supabase
      .from('invites')
      .select('invite_code, inviter_user_id')
      .eq('invite_code', code)
      .maybeSingle();

    if (!invite) {
      // Bad/expired code — drop the cookie so we stop checking on every
      // subsequent action.
      cookieStore.delete(REFERRER_COOKIE_NAME);
      return;
    }

    // Self-invite block #1: cookie ID matches.
    if (invite.inviter_user_id === inviteeUserId) {
      cookieStore.delete(REFERRER_COOKIE_NAME);
      return;
    }

    // Self-invite block #2: IP+UA hash matches the inviter's last-seen
    // attribution fingerprint. We don't have a stored inviter fingerprint to
    // compare against, but we still record the invitee's so abuse review can
    // detect kiosk farming patterns later.
    const ipHash = await computeIpUaHash();

    // Idempotency: if a row already exists for this (code, invitee), we're
    // done. UNIQUE (invite_code, invitee_user_id) backstops this at the DB.
    const { data: existing } = await supabase
      .from('invite_acceptances')
      .select('id')
      .eq('invite_code', code)
      .eq('invitee_user_id', inviteeUserId)
      .maybeSingle();

    if (!existing) {
      await supabase.from('invite_acceptances').insert({
        invite_code: code,
        invitee_user_id: inviteeUserId,
        ip_hash: ipHash,
      });
    }

    cookieStore.delete(REFERRER_COOKIE_NAME);
  } catch (err) {
    // Non-fatal — see header comment.
    console.error('Invite attribution failed:', err);
  }
}

async function computeIpUaHash(): Promise<string | null> {
  try {
    const secret = process.env.RETENTION_TOKEN_SECRET;
    if (!secret) return null;
    const headerStore = await headers();
    const ip =
      headerStore.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      headerStore.get('x-real-ip') ??
      'unknown';
    const ua = headerStore.get('user-agent') ?? 'unknown';
    return crypto.createHmac('sha256', secret).update(`${ip}:${ua}`).digest('hex');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// getSessionUser
// ---------------------------------------------------------------------------
// Reads session cookie and returns the user. Returns null if no valid session.
// ---------------------------------------------------------------------------

export async function getSessionUser(): Promise<User | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) return null;
  // No Supabase configured (e.g. local dev against the mock guide provider):
  // there is no user store to read, so treat the visitor as anonymous.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return null;
  }

  const supabase = await createClient();
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('session_token', token)
    .single();

  return (user as User) ?? null;
}

// ---------------------------------------------------------------------------
// setSessionCookie
// ---------------------------------------------------------------------------
// Sets the httpOnly session cookie on a NextResponse or via cookies().
// ---------------------------------------------------------------------------

export function setSessionCookieOnResponse(
  response: Response,
  token: string,
): Response {
  const secureAttr = COOKIE_SECURE ? '; Secure' : '';
  const cookieValue = `${SESSION_COOKIE_NAME}=${token}; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
  response.headers.append('Set-Cookie', cookieValue);
  return response;
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
}

// ---------------------------------------------------------------------------
// Magic Link Tokens (for candidate questionnaire auth)
// ---------------------------------------------------------------------------
// We use a simple HMAC-based token: base64url(candidateId:email:expiry:signature)
// In production you'd use a proper JWT library, but this avoids extra deps.
// ---------------------------------------------------------------------------

function getMagicLinkSecret(): string {
  const secret = process.env.MAGIC_LINK_SECRET;
  if (!secret) {
    throw new Error('MAGIC_LINK_SECRET environment variable is required');
  }
  return secret;
}
// Council finding #31: 30-day expiry was too long for a token with no
// revocation path. Shortened to 7 days (back to the original blueprint-v6
// value documented in CLAUDE.md) and paired with an explicit revocation
// table (`magic_link_revocations`, migration 20260425000003) so a leaked
// link can be invalidated even before its TTL elapses.
const MAGIC_LINK_EXPIRY_HOURS = 24 * 7; // 7 days

export function createMagicLinkToken(candidateId: string, email: string): string {
  const expiry = Date.now() + MAGIC_LINK_EXPIRY_HOURS * 60 * 60 * 1000;
  const payload = `${candidateId}:${email}:${expiry}`;
  const signature = crypto
    .createHmac('sha256', getMagicLinkSecret())
    .update(payload)
    .digest('base64url');

  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}

// Synchronous structural verify — checks shape, expiry, and HMAC. Does NOT
// check the revocation list; for that, callers that establish a session must
// also call `verifyMagicLinkTokenAsync` (or call `isMagicLinkRevoked`
// separately). We keep the sync version because it's used by Server
// Components (`/candidate/questionnaire/[id]/page.tsx`) where async DB calls
// are already happening anyway, but a no-DB structural check is faster for
// "is this even a real token" probes.
export function verifyMagicLinkToken(
  token: string,
): { valid: true; candidateId: string; email: string } | { valid: false; error: string } {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    const lastColon = decoded.lastIndexOf(':');
    if (lastColon === -1) {
      return { valid: false, error: 'Malformed token' };
    }

    const payload = decoded.slice(0, lastColon);
    const signature = decoded.slice(lastColon + 1);
    const payloadParts = payload.split(':');

    if (payloadParts.length < 3) {
      return { valid: false, error: 'Malformed token' };
    }

    const expiryStr = payloadParts.pop()!;
    const candidateId = payloadParts[0];
    const email = payloadParts.slice(1).join(':');
    const expiry = parseInt(expiryStr, 10);

    if (isNaN(expiry) || Date.now() > expiry) {
      return { valid: false, error: 'Token expired' };
    }

    const expectedSignature = crypto
      .createHmac('sha256', getMagicLinkSecret())
      .update(payload)
      .digest('base64url');

    if (signature !== expectedSignature) {
      return { valid: false, error: 'Invalid signature' };
    }

    return { valid: true, candidateId, email };
  } catch {
    return { valid: false, error: 'Failed to decode token' };
  }
}

// ---------------------------------------------------------------------------
// Magic-link revocation (council finding #31)
// ---------------------------------------------------------------------------
// HMAC tokens are stateless, but we MUST be able to invalidate a leaked link
// before its expiry. We track revocations in the `magic_link_revocations`
// table keyed by the token's SHA-256 fingerprint (same fingerprint scheme as
// `candidate_magic_link_submissions`). On any successful magic-link-driven
// action that establishes/refreshes a session, we revoke the consumed token
// — so a copy of the link grabbed from email forwarding / shoulder-surfing /
// phishing-replay can't be replayed afterward.
// ---------------------------------------------------------------------------

export async function isMagicLinkRevoked(token: string): Promise<boolean> {
  const fingerprint = hashToken(token);
  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from('magic_link_revocations')
    .select('token_fingerprint')
    .eq('token_fingerprint', fingerprint)
    .maybeSingle();
  if (error) {
    // Fail closed on infra errors — better to ask the candidate to request a
    // fresh link than to honour a possibly-revoked one.
    console.error('Revocation check failed:', error);
    return true;
  }
  return data !== null;
}

export async function revokeMagicLinkToken(
  token: string,
  reason: 'consumed' | 'manual' | 'leaked' = 'consumed',
): Promise<void> {
  const fingerprint = hashToken(token);
  const supabase = await createServiceClient();
  const { error } = await supabase.from('magic_link_revocations').upsert(
    {
      token_fingerprint: fingerprint,
      revoked_at: new Date().toISOString(),
      reason,
    },
    { onConflict: 'token_fingerprint' },
  );
  if (error) {
    console.error('Failed to revoke magic-link token:', error);
  }
}

// Async, DB-aware verify: structural check + revocation lookup. Use this in
// any handler that ESTABLISHES a session (sets a candidate_session cookie)
// or accepts the token as auth for a write. Read-only loads can stay on the
// sync version if they revalidate often enough that a stale revocation isn't
// dangerous, but new code should prefer this.
export async function verifyMagicLinkTokenAsync(
  token: string,
):
  Promise<
    | { valid: true; candidateId: string; email: string }
    | { valid: false; error: string }
  > {
  const structural = verifyMagicLinkToken(token);
  if (!structural.valid) return structural;
  if (await isMagicLinkRevoked(token)) {
    return { valid: false, error: 'Token revoked' };
  }
  return structural;
}

// ---------------------------------------------------------------------------
// hashToken — SHA-256 fingerprint for anti-abuse logging.
// ---------------------------------------------------------------------------
// The magic-link token itself is a secret (grants submit access for up to
// 30 days). We never persist the raw token. Instead we persist a SHA-256
// fingerprint into `candidate_magic_link_submissions` so the API can rate-
// limit per-token without leaking the token if the DB is dumped.
// ---------------------------------------------------------------------------
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
