/**
 * Server-side helpers for resolving a /for-candidates token into the
 * candidate or pending-claim it points at.
 *
 * Use this in every route under /for-candidates/profile/[token]/* — it
 * checks the HMAC signature, looks up the row, enforces expiry/consumption,
 * and returns the resolved target.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { verifyForCandidatesToken, hashToken } from './tokens';

/**
 * A magic-link token targets exactly one of three things (enforced by the
 * `cqt_one_target_only` CHECK on candidate_questionnaire_tokens):
 *   - `candidate`     legacy `candidates` row (pre-office-graph data)
 *   - `candidacy`     office-graph `candidacies` row (the 2026 default) +
 *                     its `person_id` so write paths can key positions/sources
 *                     by person without an extra round-trip
 *   - `pending_claim` an unverified self-claim awaiting admin verification
 */
export type ResolvedTokenTarget =
  | { kind: 'candidate'; candidateId: string }
  | { kind: 'candidacy'; candidacyId: string; personId: string }
  | { kind: 'pending_claim'; pendingClaimId: string };

export type ResolvedToken =
  | {
      ok: true;
      tokenRowId: string;
      target: ResolvedTokenTarget;
      sentToEmail: string;
      consumedAt: string | null;
    }
  | { ok: false; error: string; status: 401 | 404 | 410 };

export async function resolveForCandidatesToken(token: string): Promise<ResolvedToken> {
  const structural = verifyForCandidatesToken(token);
  if (!structural.valid) {
    return { ok: false, error: structural.error, status: 401 };
  }

  const supabase = await createServiceClient();
  const fingerprint = hashToken(token);

  const { data, error } = await supabase
    .from('candidate_questionnaire_tokens')
    .select(
      'id, candidate_id, candidacy_id, pending_claim_id, sent_to_email, expires_at, consumed_at',
    )
    .eq('token_fingerprint', fingerprint)
    .maybeSingle();

  if (error) {
    console.error('Token lookup failed:', error);
    return { ok: false, error: 'Token lookup failed', status: 401 };
  }
  if (!data) {
    return { ok: false, error: 'Token not found', status: 404 };
  }

  // We accept consumed tokens for read but ALSO surface the consumed flag
  // so write paths can refuse if they want to enforce one-shot affirmation.
  // The HMAC check above already verified expiry from the payload, but we
  // also verify against the DB row in case the secret rotated.
  if (new Date(data.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'Token expired', status: 410 };
  }

  // Office-graph candidacy is the primary path for current (2026) candidates.
  if (data.candidacy_id) {
    const { data: cdy, error: cdyErr } = await supabase
      .from('candidacies')
      .select('id, person_id')
      .eq('id', data.candidacy_id)
      .maybeSingle();
    if (cdyErr || !cdy?.person_id) {
      console.error('Candidacy lookup failed for token:', cdyErr);
      return { ok: false, error: 'Candidacy record missing', status: 404 };
    }
    return {
      ok: true,
      tokenRowId: data.id,
      target: {
        kind: 'candidacy',
        candidacyId: cdy.id as string,
        personId: cdy.person_id as string,
      },
      sentToEmail: data.sent_to_email,
      consumedAt: data.consumed_at,
    };
  }
  if (data.candidate_id) {
    return {
      ok: true,
      tokenRowId: data.id,
      target: { kind: 'candidate', candidateId: data.candidate_id },
      sentToEmail: data.sent_to_email,
      consumedAt: data.consumed_at,
    };
  }
  if (data.pending_claim_id) {
    return {
      ok: true,
      tokenRowId: data.id,
      target: { kind: 'pending_claim', pendingClaimId: data.pending_claim_id },
      sentToEmail: data.sent_to_email,
      consumedAt: data.consumed_at,
    };
  }
  return { ok: false, error: 'Token has no target', status: 404 };
}

/**
 * Marks a token row consumed (timestamp = now). Idempotent — safe to call
 * multiple times. Used by the affirm route after a successful signature.
 */
export async function markTokenConsumed(tokenRowId: string): Promise<void> {
  const supabase = await createServiceClient();
  await supabase
    .from('candidate_questionnaire_tokens')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', tokenRowId)
    .is('consumed_at', null);
}
