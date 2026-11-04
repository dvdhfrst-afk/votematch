import { describe, it, expect } from 'vitest';
import {
  chooseStrategy,
  hasSessionCookie,
  isSupabaseRestGet,
  isCacheableResponse,
  type SwRequestLike,
  type SwResponseLike,
} from '../sw-logic';
import { POSITIONS_BUNDLE_PATH } from '../routes';

function req(overrides: Partial<SwRequestLike> = {}): SwRequestLike {
  return {
    method: overrides.method ?? 'GET',
    mode: overrides.mode ?? 'cors',
    headers: { ...overrides.headers },
  };
}

describe('hasSessionCookie', () => {
  it('detects the session_token cookie', () => {
    expect(hasSessionCookie('session_token=abc123')).toBe(true);
    expect(hasSessionCookie('foo=1; session_token=abc; bar=2')).toBe(true);
  });
  it('is false when absent or empty', () => {
    expect(hasSessionCookie(null)).toBe(false);
    expect(hasSessionCookie('')).toBe(false);
    expect(hasSessionCookie('other=1; theme=dark')).toBe(false);
    // guard against a cookie whose value merely contains the name
    expect(hasSessionCookie('not_session_token=x')).toBe(false);
  });
});

describe('chooseStrategy', () => {
  it('never caches non-GET requests', () => {
    expect(chooseStrategy('/anything', req({ method: 'POST' }), true)).toBe(
      'passthrough',
    );
  });

  it('passes personalized (session-cookie) same-origin requests straight through', () => {
    const r = req({ headers: { cookie: 'session_token=xyz' } });
    expect(chooseStrategy('/guide', r, true)).toBe('passthrough');
    // even the positions bundle is bypassed when the session cookie rides along
    expect(chooseStrategy(POSITIONS_BUNDLE_PATH, r, true)).toBe('passthrough');
  });

  it('does NOT treat a cross-origin cookie as personalizing (only same-origin)', () => {
    // supabase REST is cross-origin; a same-site cookie would not be sent, but
    // even if headers carried one, sameOrigin=false must not force passthrough
    // for public REST GETs.
    const r = req({ headers: { cookie: 'session_token=xyz' } });
    expect(chooseStrategy('/rest/v1/candidates', r, false)).toBe(
      'stale-while-revalidate',
    );
  });

  it('routes navigations to the navigate strategy', () => {
    expect(chooseStrategy('/guide', req({ mode: 'navigate' }), true)).toBe(
      'navigate',
    );
  });

  it('network-first for the positions bundle', () => {
    expect(chooseStrategy(POSITIONS_BUNDLE_PATH, req(), true)).toBe(
      'network-first',
    );
  });

  it('stale-while-revalidate for public supabase REST GETs', () => {
    expect(chooseStrategy('/rest/v1/offices', req(), false)).toBe(
      'stale-while-revalidate',
    );
  });

  it('does not cache authenticated supabase REST reads', () => {
    const r = req({ headers: { authorization: 'Bearer token' } });
    expect(chooseStrategy('/rest/v1/offices', r, false)).toBe('passthrough');
  });

  it('stale-while-revalidate for static build assets and icons', () => {
    expect(chooseStrategy('/_next/static/chunk.js', req(), true)).toBe(
      'stale-while-revalidate',
    );
    expect(chooseStrategy('/icons/icon-192.png', req(), true)).toBe(
      'stale-while-revalidate',
    );
    expect(chooseStrategy('/fonts/geist.woff2', req(), true)).toBe(
      'stale-while-revalidate',
    );
  });

  it('passes unknown same-origin GETs through (no accidental caching)', () => {
    expect(chooseStrategy('/api/retention/subscribe', req(), true)).toBe(
      'passthrough',
    );
  });
});

describe('isSupabaseRestGet', () => {
  it('true only for GET rest/v1 without auth', () => {
    expect(isSupabaseRestGet('/rest/v1/x', req())).toBe(true);
    expect(isSupabaseRestGet('/rest/v1/x', req({ method: 'POST' }))).toBe(false);
    expect(
      isSupabaseRestGet('/rest/v1/x', req({ headers: { authorization: 'Bearer y' } })),
    ).toBe(false);
    expect(isSupabaseRestGet('/other/path', req())).toBe(false);
  });
});

function res(overrides: Partial<SwResponseLike> = {}): SwResponseLike {
  return {
    ok: overrides.ok ?? true,
    type: overrides.type ?? 'basic',
    headers: { ...overrides.headers },
  };
}

describe('isCacheableResponse', () => {
  it('caches ok, non-personalized responses', () => {
    expect(isCacheableResponse(res())).toBe(true);
  });
  it('never caches error responses', () => {
    expect(isCacheableResponse(res({ ok: false }))).toBe(false);
  });
  it('never caches opaque responses', () => {
    expect(isCacheableResponse(res({ type: 'opaque' }))).toBe(false);
  });
  it('never caches responses that set a cookie', () => {
    expect(
      isCacheableResponse(res({ headers: { setCookie: 'session_token=1' } })),
    ).toBe(false);
  });
  it('respects Cache-Control: private / no-store', () => {
    expect(
      isCacheableResponse(res({ headers: { cacheControl: 'private, max-age=0' } })),
    ).toBe(false);
    expect(
      isCacheableResponse(res({ headers: { cacheControl: 'no-store' } })),
    ).toBe(false);
    expect(
      isCacheableResponse(res({ headers: { cacheControl: 'public, max-age=60' } })),
    ).toBe(true);
  });
});
