"use server";

import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import {
  resolveForCandidatesToken,
  markTokenConsumed,
} from "@/lib/for-candidates/session";
import { loadPortalSubject } from "@/lib/for-candidates/subject";

// Trust model (locked): candidate self-stated positions are tier-1 STATED,
// confidence candidate_direct, with source_citations. These constants pin the
// exact provenance tuple so a position written here can never be mistaken for
// an ML-inferred or media-paraphrased one.
const STATED_VIEW_TYPE = "stated";
const STATED_SOURCE_TIER = "candidate_stated_current";
const STATED_CONFIDENCE = "candidate_direct";

export type AffirmInput = {
  token: string;
  retypedName: string;
  /**
   * Issue E: candidate-portal opt-in for showing the photo on voter-facing
   * surfaces. Default false (unchecked) at the form layer. Stored on the
   * questionnaire_responses row alongside the rest of the affirmation; the
   * v_voter_candidates view reads the most recent attested row to decide
   * whether to surface the photo.
   */
  photoVisible?: boolean;
};

export type AffirmResult = { ok: true } | { ok: false; error: string };

/**
 * Affirmation step.
 *
 * Updates the candidate's most recent draft questionnaire_responses row with
 * `attested_at` + `attested_signature_text`, writes one stated-view position
 * row per Likert pick (confidence='candidate_direct'), upserts a tier-1
 * candidate_sources row pointing at the questionnaire, sets candidates.published
 * = true, and marks the token consumed. Then redirects to /published.
 *
 * No Inngest fan-out — this is the synchronous user-visible attestation flow.
 * Downstream classifiers (inferred view, summary generation) pick the new
 * tier-1 source up on the next batch run.
 */
export async function affirmAction(input: AffirmInput): Promise<AffirmResult> {
  const resolved = await resolveForCandidatesToken(input.token);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  if (resolved.target.kind === "pending_claim") {
    return {
      ok: false,
      error:
        "Your candidacy is still being verified. Affirmation is disabled until a Havesay volunteer links your record.",
    };
  }

  const retyped = input.retypedName.trim();
  if (!retyped || retyped.length < 2) {
    return { ok: false, error: "Please retype your name to affirm." };
  }

  const supabase = await createServiceClient();

  // Normalize the target (legacy candidate OR office-graph candidacy) into one
  // subject so the write keying below is identity-agnostic.
  const subject = await loadPortalSubject(supabase, resolved.target);
  if (!subject) return { ok: false, error: "Candidate record not found." };

  const isCandidacy = subject.kind === "candidacy";
  const candidateId = subject.candidateId; // null for office-graph
  const personId = subject.personId; // required for office-graph writes
  const candidacyId = subject.candidacyId;

  if (isCandidacy && !personId) {
    return {
      ok: false,
      error:
        "We couldn't resolve the person record for this candidacy. Please contact support@example.org.",
    };
  }

  // Soft name match — strip diacritics + non-alpha, lowercase, then exact compare.
  // Avoids forcing a candidate to type punctuation or middle initials exactly.
  if (canonical(retyped) !== canonical(subject.name)) {
    return {
      ok: false,
      error:
        "The name you typed doesn't match the name on file. Please type your full name as it appears on the ballot.",
    };
  }

  // Find most recent draft to attest, keyed by whichever identity owns it.
  // If none exists (the candidate hit affirm without ever clicking save), bail
  // rather than guess.
  const draftQuery = supabase
    .from("questionnaire_responses")
    .select("id, response_data, attested_at, submitted_at")
    .order("submitted_at", { ascending: false })
    .limit(1);
  const { data: latest, error: latestErr } = await (isCandidacy
    ? draftQuery.eq("candidacy_id", candidacyId!)
    : draftQuery.eq("candidate_id", candidateId!)
  ).maybeSingle();

  if (latestErr) {
    console.error("[affirm] failed to fetch latest response:", latestErr);
    return { ok: false, error: "Could not load your draft." };
  }
  if (!latest) {
    return {
      ok: false,
      error: "No draft to affirm. Save your answers on the previous step first.",
    };
  }

  const submittedAt = new Date().toISOString();

  // 1. Stamp attested_at on the questionnaire_responses row. photo_visible
  //    persists the candidate's opt-in (Issue E). Default false; the form
  //    sends explicit boolean.
  const photoVisible = input.photoVisible === true;
  const { error: stampErr } = await supabase
    .from("questionnaire_responses")
    .update({
      attested_at: submittedAt,
      attested_signature_text: retyped,
      attestation: `Affirmed by ${retyped} via Havesay candidate portal at ${submittedAt}.`,
      photo_visible: photoVisible,
      updated_at: submittedAt,
    })
    .eq("id", latest.id);
  if (stampErr) {
    console.error("[affirm] stamp attested_at failed:", stampErr);
    return { ok: false, error: "Could not record affirmation." };
  }

  // 2. Audit row + tier-1 source. Same shape as /api/questionnaire so the
  //    downstream pipeline treats it identically. The source is keyed by the
  //    same identity that owns the positions (person for office-graph, legacy
  //    candidate otherwise) so the voter read path joins it correctly.
  const subjectKey = isCandidacy
    ? `person/${personId}`
    : `candidate/${candidateId}`;
  const sourceUrl = `candidate_portal://${subjectKey}/questionnaire/${latest.id}`;

  const responseData = (latest.response_data ?? {}) as Record<
    string,
    { score?: number | null; explanation?: string; citation?: string }
  >;

  const { data: auditRow, error: auditErr } = await supabase
    .from("extraction_audit")
    .insert({
      extractor_name: "candidate_for_candidates_portal",
      source_url: sourceUrl,
      source_fetched_at: submittedAt,
      model: "candidate_direct",
      prompt_version: "for_candidates_v1",
      confidence_score: 1.0,
      raw_response: JSON.stringify(responseData).slice(0, 8000),
      validation_status: "auto_passed",
      validator_notes: `Affirmed via /for-candidates portal. Signature='${retyped.slice(0, 80)}'.`,
    })
    .select("id")
    .single();

  if (auditErr || !auditRow) {
    console.error("[affirm] extraction_audit insert failed:", auditErr);
    return { ok: false, error: "Could not record audit row." };
  }

  // Office-graph sources upsert on the person-keyed partial unique index
  // (cs_person_source_url_key); legacy sources on the candidate-keyed unique.
  const sourceRow = {
    source_type: "questionnaire",
    raw_data: JSON.stringify(responseData),
    url: sourceUrl,
    title: `Candidate self-attested positions (${submittedAt.slice(0, 10)})`,
    fetched_at: submittedAt,
    authenticity_tier: 1,
    outlet_ideology: "primary",
    published_at: submittedAt,
    extraction_audit_id: auditRow.id,
    ...(isCandidacy
      ? { person_id: personId }
      : { candidate_id: candidateId }),
  };
  const { error: srcErr } = await supabase
    .from("candidate_sources")
    .upsert(sourceRow, {
      onConflict: isCandidacy
        ? "person_id,source_type,url"
        : "candidate_id,source_type,url",
    });
  if (srcErr) {
    console.error("[affirm] candidate_sources upsert failed:", srcErr);
    // Non-fatal — keep going so the positions still land.
  }

  // 3. Stated-view positions for every Likert pick. Skip rows with no score.
  //    Office-graph positions key by person_id (what the voter read path uses);
  //    legacy positions key by candidate_id. Provenance pinned to tier-1 stated.
  let positionsWritten = 0;
  for (const [subDimId, r] of Object.entries(responseData)) {
    const score = typeof r.score === "number" ? r.score : null;
    if (score === null) continue;
    const explanation = (r.explanation ?? "").trim();
    const citation = (r.citation ?? "").trim();
    const hasHttpCitation = /^https?:\/\//i.test(citation);
    const source_citations = [
      {
        url: hasHttpCitation ? citation : sourceUrl,
        title: hasHttpCitation
          ? citation
          : `Candidate self-attested positions (${submittedAt.slice(0, 10)})`,
        date: submittedAt,
      },
    ];
    const { error: posErr } = await supabase.from("positions").insert({
      ...(isCandidacy ? { person_id: personId } : { candidate_id: candidateId }),
      sub_dimension_id: subDimId,
      score,
      confidence: STATED_CONFIDENCE,
      view_type: STATED_VIEW_TYPE,
      source_tier: STATED_SOURCE_TIER,
      source_citations,
      nuance_notes: explanation || null,
      extraction_audit_id: auditRow.id,
    });
    if (posErr) {
      console.error(
        `[affirm] insert position ${subDimId} failed:`,
        posErr.message,
      );
      continue;
    }
    positionsWritten++;
  }

  // 4. Mark published. Office-graph: flip candidacies.profile_claimed (the
  //    candidacy's voter visibility is driven by status, which is already
  //    'active'). Legacy: flip candidates.published + questionnaire_status.
  if (isCandidacy) {
    const { error: claimErr } = await supabase
      .from("candidacies")
      .update({ profile_claimed: true, profile_claimed_at: submittedAt })
      .eq("id", candidacyId!);
    if (claimErr) {
      console.error("[affirm] could not flip candidacies.profile_claimed:", claimErr);
    }
  } else {
    const { error: pubErr } = await supabase
      .from("candidates")
      .update({ published: true, questionnaire_status: "responded" })
      .eq("id", candidateId!);
    if (pubErr) {
      console.error("[affirm] could not flip candidates.published:", pubErr);
      // Non-fatal — admin can flip manually if it failed.
    }
  }

  // 5. Mark token consumed.
  await markTokenConsumed(resolved.tokenRowId);

  console.log(
    `[for-candidates affirm] subject=${subjectKey} positions_written=${positionsWritten}`,
  );

  // The redirect throws inside server actions — must come last.
  redirect(`/for-candidates/profile/${input.token}/published`);
}

function canonical(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}
