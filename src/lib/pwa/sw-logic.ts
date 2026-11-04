/**
 * Pure, testable mirror of the service worker's request-classification logic
 * (public/sw.js). The SW itself cannot be imported into vitest (it references
 * `self`, `caches`, `clients`), so the decision logic is duplicated here in a
 * dependency-free form and unit-tested. When you change one, change both.
 *
 * These functions take plain shapes rather than real Request/Response objects
 * so they can be exercised without a browser environment.
 */

import { POSITIONS_BUNDLE_PATH } from './routes';

export type SwStrategy =
  | 'passthrough'
  | 'navigate'
  | 'network-first'
  | 'stale-while-revalidate';

export interface SwRequestLike {
  method: string;
  /** Fetch request mode; 'navigate' for top-level document loads. */
  mode?: string;
  /** Lower-cased header lookups the SW performs. */
  headers: {
    cookie?: string | null;
    authorization?: string | null;
  };
}

const SESSION_COOKIE = 'session_token';

export function hasSessionCookie(cookie: string | null | undefined): boolean {
  if (!cookie) return false;
  return cookie
    .split(/;\s*/)
    .some((c) => c.startsWith(`${SESSION_COOKIE}=`));
}

export function isSupabaseRestGet(
  pathname: string,
  request: SwRequestLike,
): boolean {
  return (
    request.method === 'GET' &&
    pathname.includes('/rest/v1/') &&
    !request.headers.authorization
  );
}

const STATIC_ASSET_RE =
  /\.(?:css|js|woff2?|png|jpg|jpeg|svg|webp|ico)$/;

/**
 * Decide how the SW should handle a request. Must stay byte-for-byte
 * equivalent to `chooseStrategy` in public/sw.js.
 */
export function chooseStrategy(
  pathname: string,
  request: SwRequestLike,
  sameOrigin: boolean,
): SwStrategy {
  if (request.method !== 'GET') return 'passthrough';

  // Personalized requests (session cookie present) are never cached.
  if (sameOrigin && hasSessionCookie(request.headers.cookie)) {
    return 'passthrough';
  }

  if (request.mode === 'navigate') return 'navigate';

  if (sameOrigin && pathname === POSITIONS_BUNDLE_PATH) {
    return 'network-first';
  }

  if (!sameOrigin && isSupabaseRestGet(pathname, request)) {
    return 'stale-while-revalidate';
  }

  if (
    sameOrigin &&
    (pathname.startsWith('/_next/static/') ||
      pathname.startsWith('/icons/') ||
      STATIC_ASSET_RE.test(pathname))
  ) {
    return 'stale-while-revalidate';
  }

  return 'passthrough';
}

export interface SwResponseLike {
  ok: boolean;
  type?: string;
  headers: {
    setCookie?: string | null;
    cacheControl?: string | null;
  };
}

/**
 * A response may be stored only if it is a real, non-personalized response.
 * Must stay equivalent to `isCacheableResponse` in public/sw.js.
 */
export function isCacheableResponse(response: SwResponseLike): boolean {
  if (!response || !response.ok) return false;
  if (response.type === 'opaque') return false;
  if (response.headers.setCookie) return false;
  const cc = (response.headers.cacheControl || '').toLowerCase();
  if (cc.includes('no-store') || cc.includes('private')) return false;
  return true;
}
