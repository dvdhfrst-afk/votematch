"use server";

/**
 * Server actions for the right-of-reply dispute portal.
 *
 * Per notes/ballot-bridge-execution-order.md Week 3 item 12. The portal
 * lets a candidate dispute an inferred position vector we published about
 * them. This file holds the persistence side; the UI lives at
 * /for-candidates/profile/[token]/disputes/page.tsx.
 *
 * Auth posture: the for-candidates portal authenticates via magic link
 * (resolveForCandidatesToken). We re-resolve the token here so the action
 * is self-contained; never trust a candidateId passed from the client.
 */
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveForCandidatesToken } from "@/lib/for-candidates/session";
import { loadPortalSubject } from "@/lib/for-candidates/subject";

export interface DisputeFormInput {
  token: string;
  sub_dimension_id: string;
  position_id?: string | null;
  dispute_type:
    | "wrong_score"
    | "wrong_topic"
    | "wrong_source"
    | "no_position"
    | "other";
  suggested_score?: number | null;
  reason?: string | null;
}

export interface DisputeFormResult {
  ok: boolean;
  error?: string;
  dispute_id?: string;
}

/**
 * Submit a candidate dispute against an inferred position. Validates the
 * token, writes to candidate_position_disputes with status='submitted'.
 * Idempotency: we accept duplicate disputes (a candidate may legitimately
 * dispute the same dim again with new info). Triage will dedupe.
 */
export async function submitDisputeAction(
  input: DisputeFormInput,
): Promise<DisputeFormResult> {
  // 1. Token validation. The token came from the URL the candidate is on;
  // we still re-resolve to confirm it's live and resolves to a real
  // candidate (not a pending claim — pending claims can't dispute since
  // there's no candidate row to attach to).
  const resolved = await resolveForCandidatesToken(input.token);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error ?? "Invalid or expired token." };
  }
  if (resolved.target.kind === "pending_claim") {
    return {
      ok: false,
      error:
        "Disputes are unavailable while your candidacy is still being verified.",
    };
  }

  // 2. Light input sanity checks. The DB CHECK constraints are the
  // authoritative validators; this is just so we can return a clean error
  // before hitting Postgres.
  if (
    !input.sub_dimension_id ||
    typeof input.sub_dimension_id !== "string"
  ) {
    return { ok: false, error: "Missing sub_dimension_id." };
  }
  if (input.reason && input.reason.length > 2000) {
    return { ok: false, error: "Reason is over the 2000-character limit." };
  }
  if (
    input.suggested_score != null &&
    (input.suggested_score < 0 || input.suggested_score > 1)
  ) {
    return { ok: false, error: "Suggested score must be between 0 and 1." };
  }

  // 3. Token fingerprint. Raw token never persisted.
  const tokenHash = createHash("sha256").update(input.token).digest("hex");

  // 4. Insert, keyed by the owning identity (office-graph candidacy/person, or
  // legacy candidate).
  const supabase = await createServiceClient();
  const subject = await loadPortalSubject(supabase, resolved.target);
  if (!subject) {
    return { ok: false, error: "Candidate record not found." };
  }
  const identityKeys =
    subject.kind === "candidacy"
      ? { candidacy_id: subject.candidacyId, person_id: subject.personId }
      : { candidate_id: subject.candidateId };

  const { data, error } = await supabase
    .from("candidate_position_disputes")
    .insert({
      ...identityKeys,
      sub_dimension_id: input.sub_dimension_id,
      position_id: input.position_id ?? null,
      dispute_type: input.dispute_type,
      suggested_score: input.suggested_score ?? null,
      reason: input.reason ?? null,
      submitted_via_token_hash: tokenHash,
      // status defaults to 'submitted' in the schema
    })
    .select("id")
    .single();

  if (error) {
    console.error("[submitDisputeAction] insert failed:", error);
    return {
      ok: false,
      error:
        "We couldn't record your dispute right now. Please try again or email support.",
    };
  }

  return { ok: true, dispute_id: data!.id as string };
}
