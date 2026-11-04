/**
 * /api/signal-pool/contribute  (work-order Phase 3B, part 2, step 3)
 *
 * POST -> the contribution submission + lifecycle endpoint.
 *   Body: { tokenPresentation, slotPseudonym, op: 'upsert' | 'delete', payload? }
 *   Flow:
 *     1. FLAG GATE (invariant 4): 404 cleanly when the flag is off.
 *     2. REDEEM the token (issuer.redeemToken) so a contribution is authorized
 *        exactly once per credential per epoch (the rate-limit). A repeat is
 *        'already_spent' -> 409 (double-contribution in one epoch rejected).
 *     3. UPSERT or DELETE the slot row, keyed by
 *        (schedule_generation, epoch_id, slot_pseudonym). The slot carries only
 *        the payload jsonb + freshness fields; no device/session identity.
 *
 * GRACEFUL DEGRADATION: when the staged schema is not applied, redeemToken and
 * the slot write both surface 'schema_not_applied' -> 503, so the endpoint is
 * wired and honest but persists nothing until the operator applies the schema.
 *
 * PRIVACY: the request carries the token presentation (personhood proof +
 * nullifier), the slot pseudonym (the row key), and the allowlisted payload. The
 * server never receives a raw score, a fine timestamp, or a device id. The slot
 * pseudonym is unlinkable across epochs and distinct from the spend nullifier.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isSignalPoolEnabled } from '@/lib/signal-pool/flag';
import { redeemToken } from '@/lib/signal-pool/issuer';
import { createServiceClient } from '@/lib/supabase/server';
import {
  CONTRIBUTION_PAYLOAD_KEYS,
  CONTRIBUTION_STANCE_KEYS,
} from '@/lib/device/pool-contribution';

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

/** Postgres "relation does not exist" -> schema-not-applied. */
function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === '42P01' || /does not exist/i.test(err.message ?? '');
}

/**
 * Validate that a payload contains ONLY allowlisted keys (server-side guard,
 * mirroring the device assertPayloadAllowlisted so a hand-crafted request cannot
 * smuggle extra fields into the slot jsonb). Returns null when clean, or an error
 * string. A delete carries no payload, which is valid.
 */
function payloadKeysClean(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  if (typeof payload !== 'object') return 'payload must be an object';
  const obj = payload as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!(CONTRIBUTION_PAYLOAD_KEYS as readonly string[]).includes(k)) {
      return `payload has non-allowlisted key: ${k}`;
    }
  }
  const stances = obj.stances;
  if (stances !== undefined) {
    if (!Array.isArray(stances)) return 'stances must be an array';
    for (const s of stances) {
      if (!s || typeof s !== 'object') return 'stance must be an object';
      for (const k of Object.keys(s as Record<string, unknown>)) {
        if (!(CONTRIBUTION_STANCE_KEYS as readonly string[]).includes(k)) {
          return `stance has non-allowlisted key: ${k}`;
        }
      }
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  if (!isSignalPoolEnabled()) return notFound();

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const tp = body.tokenPresentation;
  const op = body.op === 'delete' ? 'delete' : body.op === 'upsert' ? 'upsert' : null;

  if (!tp || typeof tp !== 'object' || !op) {
    return NextResponse.json(
      { error: 'tokenPresentation and op are required' },
      { status: 400 },
    );
  }
  // PRIVACY (2026-07-05 rework): the presentation carries ONLY the epoch token
  // signature + (epochId, nonce). There is NO secret and NO stable signature to
  // accept. A body that still carries a `secret` is a stale/hostile client; we
  // reject it so the old leak can never be reintroduced by a rolled-back client.
  if ('secret' in tp) {
    return NextResponse.json(
      { error: 'Malformed token presentation: secret must not be sent.' },
      { status: 400 },
    );
  }
  if (
    typeof tp.tokenSignature !== 'string' ||
    typeof tp.preparedMessage !== 'string' ||
    typeof tp.epochId !== 'number' ||
    typeof tp.nonce !== 'number'
  ) {
    return NextResponse.json({ error: 'Malformed token presentation' }, { status: 400 });
  }

  const badKey = payloadKeysClean(op === 'upsert' ? body.payload : undefined);
  if (badKey) {
    return NextResponse.json({ error: badKey }, { status: 400 });
  }
  if (op === 'upsert' && (!body.payload || typeof body.payload !== 'object')) {
    return NextResponse.json({ error: 'upsert requires a payload' }, { status: 400 });
  }

  // 1. Redeem the token: authorizes exactly one contribution per credential per
  //    epoch. This is the personhood + rate-limit gate. The server DERIVES the
  //    slot pseudonym from the verified token signature (below), so the client-
  //    supplied slotPseudonym is NOT trusted as the row key.
  const redeem = await redeemToken({
    epochId: tp.epochId,
    nonce: tp.nonce,
    tokenSignatureB64u: tp.tokenSignature,
    preparedMessageB64u: tp.preparedMessage,
  });

  if (!redeem.ok) {
    switch (redeem.reason) {
      case 'invalid_credential':
        return NextResponse.json({ error: 'Invalid credential.' }, { status: 401 });
      case 'already_spent':
        return NextResponse.json(
          { error: 'Already contributed this epoch.' },
          { status: 409 },
        );
      case 'nonce_out_of_range':
        return NextResponse.json({ error: 'Nonce out of range.' }, { status: 400 });
      case 'epoch_mismatch':
        return NextResponse.json(
          { error: 'Token is not valid for the current epoch.' },
          { status: 409 },
        );
      case 'schema_not_applied':
        return NextResponse.json(
          { error: 'Signal pool storage is not yet provisioned.' },
          { status: 503 },
        );
      default:
        console.error('contribute redeem error:', redeem.detail);
        return NextResponse.json({ error: 'Contribution failed.' }, { status: 500 });
    }
  }

  // The AUTHORITATIVE slot key is the server-derived pseudonym, not the client's.
  const slotPseudonym = redeem.slotPseudonym;

  // 2. Write the slot row keyed by (schedule_generation, epoch_id, slot_pseudonym).
  const generation = Number(process.env.SIGNAL_POOL_SCHEDULE_GENERATION ?? '0') || 0;
  const supabase = await createServiceClient();

  if (op === 'delete') {
    const del = await supabase
      .from('signal_pool_slots')
      .delete()
      .eq('schedule_generation', generation)
      .eq('epoch_id', redeem.epochId)
      .eq('slot_pseudonym', slotPseudonym);
    if (del.error) {
      if (isMissingTable(del.error)) {
        return NextResponse.json(
          { error: 'Signal pool storage is not yet provisioned.' },
          { status: 503 },
        );
      }
      console.error('contribute delete error:', del.error.message);
      return NextResponse.json({ error: 'Contribution failed.' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, op: 'delete', epochId: redeem.epochId });
  }

  // upsert
  const payload = body.payload as {
    state?: string;
    cd?: string;
    stances?: Array<{ freshnessEpoch?: number }>;
  };
  // Derive the newest freshness epoch present, stored as a top-level column so
  // the recompute can prune stale rows without opening the jsonb.
  const freshnessEpoch = Array.isArray(payload.stances)
    ? payload.stances.reduce(
        (max, s) => (typeof s.freshnessEpoch === 'number' ? Math.max(max, s.freshnessEpoch) : max),
        0,
      )
    : 0;

  const up = await supabase
    .from('signal_pool_slots')
    .upsert(
      {
        schedule_generation: generation,
        epoch_id: redeem.epochId,
        slot_pseudonym: slotPseudonym,
        payload: body.payload,
        freshness_epoch: freshnessEpoch,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'schedule_generation,epoch_id,slot_pseudonym' },
    )
    .select('slot_pseudonym')
    .single();

  if (up.error) {
    if (isMissingTable(up.error)) {
      return NextResponse.json(
        { error: 'Signal pool storage is not yet provisioned.' },
        { status: 503 },
      );
    }
    console.error('contribute upsert error:', up.error.message);
    return NextResponse.json({ error: 'Contribution failed.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, op: 'upsert', epochId: redeem.epochId });
}
