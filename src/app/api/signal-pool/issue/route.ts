/**
 * /api/signal-pool/issue  (work-order Phase 3B, part 1)
 *
 * GET  -> return the issuer PUBLIC key (SPKI base64url) + keyId, so the device
 *         can construct a blinded credential request. Public, non-secret.
 * POST -> evidence-gated blind signing. Body: { evidenceToken, blindedMsg }.
 *         The evidence token (from verify-phone/confirm) proves a verified,
 *         one-per-identity evidence hash; the endpoint consumes that identity
 *         and blind-signs the device's blinded message. It NEVER sees the
 *         unblinded credential.
 *
 * FLAG GATE (invariant 4): both verbs 404 cleanly when the flag is off.
 *
 * GRACEFUL DEGRADATION: when the staged schema is not applied, issueCredential
 * returns 'schema_not_applied' and we answer 503, so the endpoint exists and is
 * wired but honestly reports it cannot persist yet. When no issuer key is
 * configured, we answer 503 'no_issuer_key' likewise.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isSignalPoolEnabled } from '@/lib/signal-pool/flag';
import { verifyEvidenceToken } from '@/lib/signal-pool/evidence-token';
import { hasIssuerKeys, issueCredential } from '@/lib/signal-pool/issuer';

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

/**
 * GET the issuer public key so the device can blind against it. Returns 503 when
 * no issuer key is configured (the ceremony cannot start without one).
 */
export async function GET() {
  if (!isSignalPoolEnabled()) return notFound();
  if (!hasIssuerKeys()) {
    return NextResponse.json(
      { error: 'Issuer key not configured.' },
      { status: 503 },
    );
  }
  const publicKey = process.env.SIGNAL_POOL_ISSUER_PK ?? '';
  const keyId = process.env.SIGNAL_POOL_ISSUER_KEY_ID ?? 'sp-env';
  return NextResponse.json({
    keyId,
    publicKey,
    suite: 'RSABSSA-SHA384-PSS-Randomized',
  });
}

export async function POST(req: NextRequest) {
  if (!isSignalPoolEnabled()) return notFound();

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const evidenceToken = typeof body.evidenceToken === 'string' ? body.evidenceToken : '';
  // 2026-07-05 rework: the device now blinds ONE token per covered epoch and
  // sends the ordered array. Accept `blindedMsgs: string[]`.
  const blindedMsgs = Array.isArray(body.blindedMsgs)
    ? body.blindedMsgs.filter((m: unknown): m is string => typeof m === 'string' && m.length > 0)
    : [];
  if (!evidenceToken || blindedMsgs.length === 0 || blindedMsgs.length !== (body.blindedMsgs?.length ?? -1)) {
    return NextResponse.json(
      { error: 'evidenceToken and a non-empty blindedMsgs[] (all strings) are required' },
      { status: 400 },
    );
  }

  // 1. Verify the evidence token (server HMAC). A client cannot fabricate an
  //    identity hash; only verify-phone/confirm can mint a valid token.
  const evidence = verifyEvidenceToken(evidenceToken);
  if (!evidence.valid) {
    return NextResponse.json({ error: evidence.error }, { status: 401 });
  }

  // 2. Consume the evidence identity (one credential per identity) and blind-sign
  //    the whole per-epoch stockpile.
  const outcome = await issueCredential({
    evidenceIdentityHash: evidence.identityHash,
    provider: evidence.provider,
    blindedMsgsB64u: blindedMsgs,
  });

  if (outcome.ok) {
    return NextResponse.json({
      ok: true,
      blindSignatures: outcome.blindSignaturesB64u,
      keyId: outcome.keyId,
    });
  }

  switch (outcome.reason) {
    case 'evidence_already_used':
      return NextResponse.json(
        { error: 'This identity has already been issued a credential.' },
        { status: 409 },
      );
    case 'bad_batch':
      return NextResponse.json(
        { error: 'Malformed or oversized token batch.' },
        { status: 400 },
      );
    case 'schema_not_applied':
      return NextResponse.json(
        { error: 'Signal pool storage is not yet provisioned.' },
        { status: 503 },
      );
    case 'no_issuer_key':
      return NextResponse.json({ error: 'Issuer key not configured.' }, { status: 503 });
    default:
      console.error('issue route error:', outcome.detail);
      return NextResponse.json({ error: 'Issuance failed.' }, { status: 500 });
  }
}
