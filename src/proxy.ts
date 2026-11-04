import { NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE_NAME = 'session_token';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// `secure: true` was previously hardcoded, which dropped cookies on localhost
// dev / non-TLS proxies. Gate it on NODE_ENV so dev works while prod stays
// strict.
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

export async function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const existingToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (existingToken) {
    // Refresh the cookie expiry on every request
    response.cookies.set(SESSION_COOKIE_NAME, existingToken, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE,
    });
    return response;
  }

  // No session cookie exists — mint a fresh anonymous token and set the cookie.
  // We deliberately DO NOT insert a `users` row here. Council finding #1:
  // every cookie-less request used to INSERT a fresh `users` row, which
  // produced unbounded orphan rows whenever:
  //   - the client blocked cookies entirely
  //   - a CDN / edge layer stripped Set-Cookie
  //   - the request was a <link rel="prefetch"> / bot crawl that never
  //     committed back
  //
  // Instead we generate the token here, hand it to the browser via Set-Cookie,
  // and defer the DB insert to `getOrCreateSession` in `src/lib/session.ts` —
  // which already inserts on first lookup miss. That means a `users` row is
  // only ever created when an authenticated action actually runs against the
  // session, never speculatively from proxy traffic.
  const newToken = crypto.randomUUID();

  response.cookies.set(SESSION_COOKIE_NAME, newToken, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public assets
     */
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
