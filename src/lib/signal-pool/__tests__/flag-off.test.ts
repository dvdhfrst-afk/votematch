/**
 * Flag-off behavior tests (Phase 3B, part 1; invariant 4).
 *
 * With NEXT_PUBLIC_SIGNAL_POOL_ENABLED unset (the default), every signal-pool
 * endpoint must 404 cleanly, and the flag helper must read false. We import the
 * route handlers directly and invoke them with a NextRequest, asserting 404 with
 * no side effects (no DB, no crypto reached).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { isSignalPoolEnabled } from '../flag';

describe('flag helper', () => {
  it('is false unless the flag is exactly "true"', () => {
    expect(isSignalPoolEnabled({})).toBe(false);
    expect(isSignalPoolEnabled({ NEXT_PUBLIC_SIGNAL_POOL_ENABLED: 'false' })).toBe(false);
    expect(isSignalPoolEnabled({ NEXT_PUBLIC_SIGNAL_POOL_ENABLED: '1' })).toBe(false);
    expect(isSignalPoolEnabled({ NEXT_PUBLIC_SIGNAL_POOL_ENABLED: 'TRUE' })).toBe(false);
    expect(isSignalPoolEnabled({ NEXT_PUBLIC_SIGNAL_POOL_ENABLED: 'true' })).toBe(true);
  });
});

describe('endpoints 404 when the flag is off', () => {
  const prev = process.env.NEXT_PUBLIC_SIGNAL_POOL_ENABLED;
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SIGNAL_POOL_ENABLED;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_SIGNAL_POOL_ENABLED;
    else process.env.NEXT_PUBLIC_SIGNAL_POOL_ENABLED = prev;
  });

  it('verify-phone POST -> 404', async () => {
    const { POST } = await import('@/app/api/signal-pool/verify-phone/route');
    const req = new NextRequest('http://localhost:4000/api/signal-pool/verify-phone', {
      method: 'POST',
      body: JSON.stringify({ action: 'start', phone: '8015550100' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('issue GET -> 404', async () => {
    const { GET } = await import('@/app/api/signal-pool/issue/route');
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it('issue POST -> 404', async () => {
    const { POST } = await import('@/app/api/signal-pool/issue/route');
    const req = new NextRequest('http://localhost:4000/api/signal-pool/issue', {
      method: 'POST',
      body: JSON.stringify({ evidenceToken: 'x', blindedMsg: 'y' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('contribute POST -> 404', async () => {
    const { POST } = await import('@/app/api/signal-pool/contribute/route');
    const req = new NextRequest('http://localhost:4000/api/signal-pool/contribute', {
      method: 'POST',
      body: JSON.stringify({ tokenPresentation: {}, slotPseudonym: 's', op: 'upsert' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });
});
