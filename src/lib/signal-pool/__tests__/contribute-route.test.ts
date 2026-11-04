/**
 * /api/signal-pool/contribute endpoint tests (Phase 3B, part 2, step 3;
 * unlinkable-redemption rework 2026-07-05).
 *
 * Covers:
 *   - flag OFF -> 404 (invariant 4).
 *   - schema not applied -> 503 (graceful degradation).
 *   - double contribution in one epoch -> 409 already_spent (the rate-limit).
 *   - a clean upsert -> 200 with the server-derived slot pseudonym.
 *   - a body that still carries a `secret` -> 400 (regression guard: the old
 *     leak can never be reintroduced by a rolled-back client).
 *
 * The issuer redeemToken and the supabase service client are mocked so the route
 * logic is exercised without a live DB or real crypto.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const redeemMock = vi.fn();
vi.mock('../issuer', () => ({
  redeemToken: (...args: unknown[]) => redeemMock(...args),
}));

const upsertResult = { value: { data: { slot_pseudonym: 'x' }, error: null } };
const deleteResult = { value: { error: null } };
const upsertCapture: { payload?: unknown } = {};
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: async () => ({
    from: () => ({
      upsert: (row: Record<string, unknown>) => {
        upsertCapture.payload = row;
        return { select: () => ({ single: async () => upsertResult.value }) };
      },
      delete: () => ({
        eq: () => ({ eq: () => ({ eq: async () => deleteResult.value }) }),
      }),
    }),
  }),
}));

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost:4000/api/signal-pool/contribute', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

// The NEW minimal presentation: NO secret, NO stable signature.
const validBody = {
  tokenPresentation: {
    keyId: 'k',
    epochId: 30,
    nonce: 0,
    tokenSignature: 'tok-sig',
    preparedMessage: 'prepared-bytes-b64u',
  },
  slotPseudonym: 'client-claimed-slot',
  op: 'upsert',
  payload: { v: 1, state: 'UT', cd: '01', stances: [{ subDimensionId: 'sd.a', bucket: 2, freshnessEpoch: 30 }] },
};

describe('contribute route', () => {
  const prev = process.env.NEXT_PUBLIC_SIGNAL_POOL_ENABLED;
  beforeEach(() => {
    redeemMock.mockReset();
    upsertResult.value = { data: { slot_pseudonym: 'x' }, error: null };
    deleteResult.value = { error: null };
    upsertCapture.payload = undefined;
    process.env.NEXT_PUBLIC_SIGNAL_POOL_ENABLED = 'true';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_SIGNAL_POOL_ENABLED;
    else process.env.NEXT_PUBLIC_SIGNAL_POOL_ENABLED = prev;
  });

  it('404s when the flag is off', async () => {
    process.env.NEXT_PUBLIC_SIGNAL_POOL_ENABLED = 'false';
    const { POST } = await import('@/app/api/signal-pool/contribute/route');
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(404);
  });

  it('400s a body that still carries a secret (regression: no-secret invariant)', async () => {
    const { POST } = await import('@/app/api/signal-pool/contribute/route');
    const leaky = {
      ...validBody,
      tokenPresentation: { ...validBody.tokenPresentation, secret: 's' },
    };
    const res = await POST(makeReq(leaky));
    expect(res.status).toBe(400);
    // redeem must not even be reached.
    expect(redeemMock).not.toHaveBeenCalled();
  });

  it('503s when the schema is not applied (redeem reports schema_not_applied)', async () => {
    redeemMock.mockResolvedValue({ ok: false, reason: 'schema_not_applied' });
    const { POST } = await import('@/app/api/signal-pool/contribute/route');
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(503);
  });

  it('409s a double contribution in one epoch (already_spent)', async () => {
    redeemMock.mockResolvedValue({ ok: false, reason: 'already_spent' });
    const { POST } = await import('@/app/api/signal-pool/contribute/route');
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(409);
  });

  it('409s an epoch mismatch', async () => {
    redeemMock.mockResolvedValue({ ok: false, reason: 'epoch_mismatch' });
    const { POST } = await import('@/app/api/signal-pool/contribute/route');
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(409);
  });

  it('200s a clean upsert and writes the SERVER-derived slot pseudonym', async () => {
    redeemMock.mockResolvedValue({
      ok: true,
      epochId: 30,
      nullifier: 'nul',
      slotPseudonym: 'server-derived-slot',
    });
    const { POST } = await import('@/app/api/signal-pool/contribute/route');
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.op).toBe('upsert');
    // The row keyed on the server-derived pseudonym, NOT the client-claimed one.
    expect((upsertCapture.payload as { slot_pseudonym: string }).slot_pseudonym).toBe(
      'server-derived-slot',
    );
  });

  it('400s a payload with a non-allowlisted key (server-side guard)', async () => {
    redeemMock.mockResolvedValue({ ok: true, epochId: 30, nullifier: 'n', slotPseudonym: 's' });
    const { POST } = await import('@/app/api/signal-pool/contribute/route');
    const dirty = { ...validBody, payload: { ...validBody.payload, leaked: 'oops' } };
    const res = await POST(makeReq(dirty));
    expect(res.status).toBe(400);
  });

  it('200s a clean delete with no payload', async () => {
    redeemMock.mockResolvedValue({ ok: true, epochId: 30, nullifier: 'n', slotPseudonym: 's' });
    const { POST } = await import('@/app/api/signal-pool/contribute/route');
    const res = await POST(makeReq({ ...validBody, op: 'delete', payload: undefined }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.op).toBe('delete');
  });
});
