"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { resolveForCandidatesToken, markTokenConsumed } from "@/lib/for-candidates/session";

/**
 * Resolve the people.id (if any) currently linked to a candidates.id via the
 * legacy_candidate_ids GIN index. Returns null when no linked people row
 * exists yet (e.g. ingestion path that wrote `candidates` but not yet
 * promoted into `people`).
 */
async function resolvePersonForCandidate(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  candidateId: string,
): Promise<{ id: string; canonical_key: string | null } | null> {
  // GIN array containment lookup. `[candidateId]` matches any people row that
  // has candidateId in its legacy_candidate_ids[].
  const { data, error } = await supabase
    .from("people")
    .select("id, canonical_key")
    .contains("legacy_candidate_ids", [candidateId])
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[resolvePersonForCandidate] error:", error.message);
    return null;
  }
  if (!data) return null;
  return {
    id: data.id as string,
    canonical_key: (data.canonical_key as string | null) ?? null,
  };
}

export type SaveDraftInput = {
  token: string;
  responses: Record<
    string,
    { score: number | null; explanation: string; citation: string }
  >;
};

export type SaveDraftResult =
  | { ok: true; questionnaireResponseId: string }
  | { ok: false; error: string };

/**
 * Persists the candidate's draft answers as a `questionnaire_responses` row.
 * Does NOT write `positions` and does NOT set `attested_at` — that happens
 * in the affirm flow. We always insert a fresh row (append-only audit) so
 * candidates can see history if they request it later.
 *
 * Auth: token validated by resolveForCandidatesToken (HMAC + DB row check).
 */
export async function saveDraftAction(
  input: SaveDraftInput,
): Promise<SaveDraftResult> {
  const resolved = await resolveForCandidatesToken(input.token);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  if (resolved.target.kind === "pending_claim") {
    // No candidate/candidacy row yet to attach a draft to. Stash drafts in
    // localStorage on the client side until an admin verifies + links the
    // claim. The portal renders this case but disables save-to-server.
    return {
      ok: false,
      error:
        "Your candidacy is still being verified. Drafts are saved in your browser and will be applied once a Havesay volunteer links your record.",
    };
  }

  const supabase = await createServiceClient();

  // Strip any rows where the candidate didn't pick a score AND didn't write
  // anything. Empty drafts shouldn't pollute the audit table.
  const cleaned: Record<
    string,
    { score: number | null; explanation: string; citation: string }
  > = {};
  for (const [subDimId, r] of Object.entries(input.responses)) {
    const score = typeof r.score === "number" ? r.score : null;
    const explanation = (r.explanation ?? "").trim().slice(0, 600);
    const citation = (r.citation ?? "").trim().slice(0, 500);
    if (score === null && !explanation && !citation) continue;
    cleaned[subDimId] = { score, explanation, citation };
  }

  if (Object.keys(cleaned).length === 0) {
    return { ok: false, error: "No answers to save yet." };
  }

  // Build the identity-keyed insert payload. Office-graph candidacies key by
  // candidacy_id + person_id (candidate_id/race_id null); legacy candidates
  // key by candidate_id + race_id, exactly as before.
  const submittedAt = new Date().toISOString();
  const base = {
    response_data: cleaned,
    attestation:
      "Draft saved via /for-candidates portal. Not yet affirmed; not public.",
    submitted_at: submittedAt,
    updated_at: submittedAt,
    attested_at: null,
    attested_signature_text: null,
  };

  let insertPayload: Record<string, unknown>;
  if (resolved.target.kind === "candidacy") {
    insertPayload = {
      ...base,
      candidacy_id: resolved.target.candidacyId,
      person_id: resolved.target.personId,
    };
  } else {
    // legacy candidate — need race_id (legacy NOT NULL semantics preserved).
    const { data: cand, error: candErr } = await supabase
      .from("candidates")
      .select("id, race_id")
      .eq("id", resolved.target.candidateId)
      .maybeSingle();
    if (candErr || !cand) {
      return { ok: false, error: "Candidate record not found" };
    }
    insertPayload = {
      ...base,
      candidate_id: cand.id,
      race_id: cand.race_id,
    };
  }

  const { data: qr, error: qrErr } = await supabase
    .from("questionnaire_responses")
    .insert(insertPayload)
    .select("id")
    .single();

  if (qrErr || !qr) {
    console.error("[saveDraftAction] insert failed:", qrErr);
    return { ok: false, error: qrErr?.message ?? "Failed to save draft" };
  }

  // Touch consumed_at on the token? No — drafts can be saved repeatedly. We
  // only mark consumed at affirm time so the token stays usable across
  // multiple save passes within the 7-day window.
  void markTokenConsumed; // intentional: only used in affirm route

  return { ok: true, questionnaireResponseId: qr.id as string };
}

// ============================================================
// Identity claim — "I am also this other candidate"
// ============================================================

export type ClaimAdditionalCandidateInput = {
  token: string;
  claimedCandidateId: string;
  /**
   * Required confirmation that the candidate retyped: their own name on file.
   * Mirrors the affirm flow's name-match gate so the claim is auditable.
   */
  retypedName: string;
  /**
   * Required checkbox: "I confirm I am also this candidate". The form layer
   * gates on this; the action also verifies it server-side.
   */
  confirmed: boolean;
};

export type ClaimAdditionalCandidateResult =
  | { ok: true; claimId: string; status: "pending" }
  | { ok: false; error: string };

/**
 * Records an "I am also this candidate" attestation from the logged-in
 * candidate against another candidates.id row.
 *
 * Anti-abuse: the claimed candidate must share at least one identity signal
 * with the primary — same canonical_key (via people row) OR same state
 * (via races / candidacies). This stops candidate A from claiming an
 * unrelated candidate B and merging records.
 *
 * Does NOT merge people rows. Inserts a candidate_identity_claims row in
 * pending state; downstream merge processor handles the actual merge.
 */
export async function claimAdditionalCandidateAction(
  input: ClaimAdditionalCandidateInput,
): Promise<ClaimAdditionalCandidateResult> {
  const resolved = await resolveForCandidatesToken(input.token);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (resolved.target.kind === "candidacy") {
    // Identity-merge across records is still legacy-`candidates`-keyed.
    // Office-graph candidacies consolidate at the `people` level instead;
    // person-based merge is a follow-up (PORTALS-PLAN Brief A deferred list).
    return {
      ok: false,
      error:
        "Merging duplicate records isn't available for office-graph profiles yet. Email support@example.org if you have duplicate listings.",
    };
  }
  if (resolved.target.kind !== "candidate") {
    return {
      ok: false,
      error:
        "Identity claims are disabled until your candidacy is verified. Save your draft and we'll email you when it's ready.",
    };
  }

  const primaryCandidateId = resolved.target.candidateId;
  const claimedCandidateId = input.claimedCandidateId.trim();

  if (!claimedCandidateId) {
    return { ok: false, error: "Missing claimed candidate id." };
  }
  if (claimedCandidateId === primaryCandidateId) {
    return {
      ok: false,
      error: "You can't claim your own primary candidate row.",
    };
  }
  if (!input.confirmed) {
    return {
      ok: false,
      error:
        "Please confirm the attestation checkbox before submitting the claim.",
    };
  }

  const supabase = await createServiceClient();

  // Resolve primary candidate (need name for retype gate + race for state).
  const { data: primary, error: primaryErr } = await supabase
    .from("candidates")
    .select("id, name, race:races(id, level, district)")
    .eq("id", primaryCandidateId)
    .maybeSingle();
  if (primaryErr || !primary) {
    return { ok: false, error: "Primary candidate not found." };
  }

  // Soft name match — same canonicalization as affirm flow.
  const retyped = (input.retypedName ?? "").trim();
  if (!retyped || retyped.length < 2) {
    return { ok: false, error: "Please retype your name to confirm." };
  }
  if (canonicalizeName(retyped) !== canonicalizeName(primary.name as string)) {
    return {
      ok: false,
      error:
        "The name you typed doesn't match the name on file. Please retype your full name as it appears on the ballot.",
    };
  }

  // Resolve claimed candidate.
  const { data: claimed, error: claimedErr } = await supabase
    .from("candidates")
    .select("id, name, race:races(id, level, district)")
    .eq("id", claimedCandidateId)
    .maybeSingle();
  if (claimedErr || !claimed) {
    return { ok: false, error: "Claimed candidate not found." };
  }

  // Anti-abuse: require at least one identity signal in common.
  const primaryPerson = await resolvePersonForCandidate(
    supabase,
    primaryCandidateId,
  );
  const claimedPerson = await resolvePersonForCandidate(
    supabase,
    claimedCandidateId,
  );

  let signalReason: string | null = null;
  if (
    primaryPerson?.canonical_key &&
    claimedPerson?.canonical_key &&
    primaryPerson.canonical_key === claimedPerson.canonical_key
  ) {
    signalReason = `shared canonical_key=${primaryPerson.canonical_key}`;
  } else {
    // Fall back to: same state inferred from races.district. This is loose
    // (district codes vary by level) so we only allow it when the primary
    // and claimed names also share canonical form, to avoid bona-fide
    // strangers in the same state being claimable.
    const sameNameKey =
      canonicalizeName(primary.name as string) ===
      canonicalizeName(claimed.name as string);
    const primaryRace = arrayOrSingle(primary.race);
    const claimedRace = arrayOrSingle(claimed.race);
    const primaryState = stateFromDistrict(
      (primaryRace?.district as string | null) ?? null,
    );
    const claimedState = stateFromDistrict(
      (claimedRace?.district as string | null) ?? null,
    );
    if (
      sameNameKey &&
      primaryState &&
      claimedState &&
      primaryState === claimedState
    ) {
      signalReason = `same name + same state=${primaryState}`;
    } else if (sameNameKey) {
      // Cross-state same-name match. Allow but note the weaker signal.
      signalReason = "same canonicalized name (cross-state)";
    }
  }

  if (!signalReason) {
    return {
      ok: false,
      error:
        "We can't link these two candidates — they don't share a name, person, or state. If you believe this is an error, contact support@example.org with both candidate IDs.",
    };
  }

  // Find the most recent attested questionnaire_responses row to anchor
  // the claim to. If none exists yet, that's fine — the claim still records;
  // attesting_questionnaire_response_id is nullable.
  const { data: latestQr } = await supabase
    .from("questionnaire_responses")
    .select("id")
    .eq("candidate_id", primaryCandidateId)
    .not("attested_at", "is", null)
    .order("attested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const insertPayload = {
    primary_candidate_id: primaryCandidateId,
    primary_person_id: primaryPerson?.id ?? null,
    claimed_candidate_id: claimedCandidateId,
    claimed_person_id: claimedPerson?.id ?? null,
    attesting_questionnaire_response_id: latestQr?.id ?? null,
    status: "pending" as const,
    notes: `Self-claimed via /for-candidates portal. Signal: ${signalReason}. Signature='${retyped.slice(0, 80)}'.`,
    meta: {
      signal_reason: signalReason,
      retyped_signature: retyped.slice(0, 120),
      primary_name: primary.name,
      claimed_name: claimed.name,
    },
  };

  const { data: row, error: insertErr } = await supabase
    .from("candidate_identity_claims")
    .upsert(insertPayload, {
      onConflict: "primary_candidate_id,claimed_candidate_id",
    })
    .select("id, status")
    .single();

  if (insertErr || !row) {
    console.error("[claimAdditionalCandidate] insert failed:", insertErr);
    return {
      ok: false,
      error: insertErr?.message ?? "Could not record the claim.",
    };
  }

  void markTokenConsumed; // shared import; consumed only on affirm path.

  return {
    ok: true,
    claimId: row.id as string,
    status: (row.status as "pending") ?? "pending",
  };
}

export type DismissCandidateClaimInput = {
  token: string;
  claimedCandidateId: string;
};

/**
 * Records a "no, that's not me" dismissal. Stored as status='dismissed' so
 * the related-candidates page can hide the pair on subsequent visits without
 * losing the audit trail. No name retype required — dismissals are low-risk.
 */
export async function dismissCandidateClaimAction(
  input: DismissCandidateClaimInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const resolved = await resolveForCandidatesToken(input.token);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (resolved.target.kind !== "candidate") {
    return {
      ok: false,
      error: "Available after your candidacy is verified.",
    };
  }
  const primaryCandidateId = resolved.target.candidateId;
  const claimedCandidateId = input.claimedCandidateId.trim();
  if (
    !claimedCandidateId ||
    claimedCandidateId === primaryCandidateId
  ) {
    return { ok: false, error: "Invalid candidate id." };
  }

  const supabase = await createServiceClient();
  const { error } = await supabase
    .from("candidate_identity_claims")
    .upsert(
      {
        primary_candidate_id: primaryCandidateId,
        claimed_candidate_id: claimedCandidateId,
        status: "dismissed",
        notes: "Candidate clicked 'No, different person' in /related view.",
      },
      { onConflict: "primary_candidate_id,claimed_candidate_id" },
    );

  if (error) {
    console.error("[dismissCandidateClaim] error:", error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

// ----------------------------------------------------------------
// helpers
// ----------------------------------------------------------------
function canonicalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function arrayOrSingle<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * Best-effort state extraction from a race.district string. UT-shaped
 * district codes embed a 2-letter state prefix; many others encode state at
 * a higher level (race.level='federal' + race.name) so this is a soft signal
 * only. Returns null when ambiguous — caller falls back to the
 * "cross-state same-name" branch.
 */
function stateFromDistrict(district: string | null): string | null {
  if (!district) return null;
  const m = district.match(/\b([A-Z]{2})\b/);
  return m ? m[1] : null;
}
