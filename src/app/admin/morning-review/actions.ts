"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// /admin/morning-review — Server Actions (batch approve)
// ---------------------------------------------------------------------------
// Two batch primitives live here:
//
//   1. batchApproveEndorsementsSamePaperSameDay(formData)
//      Given {endorser_id, endorsement_date}, set published=TRUE on every
//      unpublished, non-rescinded endorsement that matches the pair. This
//      is the "Tribune editorial board 2026-06-15 slate" flow — one click
//      clears every row from that same paper on that same day.
//
//   2. batchResolveFecSameCommittee(formData)
//      Scan fec_match_ambiguous for rows where every candidate_matches
//      entry has the same principal_committee_id. Resolve each to that
//      committee. Rows with >1 distinct committee are left alone for
//      manual review.
//
// Both actions re-verify role ∈ ('editor','admin') with the service-role
// client. Errors throw — Next.js Server Actions contract.
// ---------------------------------------------------------------------------

const MORNING_REVIEW_PATH = "/admin/morning-review";
const ENDORSEMENTS_QUEUE_PATH = "/admin/endorsements-queue";

async function requireEditorOrAdmin(): Promise<string> {
  const user = await getSessionUser();
  if (!user) {
    throw new Error("morning-review action: no session");
  }

  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from("users")
    .select("id, role")
    .eq("id", user.id)
    .single();

  if (error || !data) {
    throw new Error("morning-review action: user lookup failed");
  }

  const role = (data as { role?: string }).role;
  if (role !== "editor" && role !== "admin") {
    throw new Error(
      `morning-review action: role ${role ?? "null"} not authorized`,
    );
  }

  return user.id;
}

// ---------------------------------------------------------------------------
// batchApproveEndorsementsSamePaperSameDay
// ---------------------------------------------------------------------------

export async function batchApproveEndorsementsSamePaperSameDay(
  formData: FormData,
): Promise<void> {
  const userId = await requireEditorOrAdmin();

  const endorserId = formData.get("endorser_id");
  const endorsementDate = formData.get("endorsement_date");
  if (typeof endorserId !== "string" || endorserId.length === 0) {
    throw new Error("batchApproveEndorsements: missing endorser_id");
  }
  if (typeof endorsementDate !== "string" || endorsementDate.length === 0) {
    throw new Error("batchApproveEndorsements: missing endorsement_date");
  }

  const supabase = await createServiceClient();

  // Pre-flight: pull the set we intend to publish. The CHECK constraint on
  // `endorsements` requires endorsement_url to be non-null before publish;
  // filter those out so we don't 500 on a partial batch.
  const { data: candidates, error: readErr } = await supabase
    .from("endorsements")
    .select("id, endorsement_url")
    .eq("endorser_id", endorserId)
    .eq("endorsement_date", endorsementDate)
    .eq("published", false)
    .is("rescinded_at", null);

  if (readErr) {
    throw new Error(`batchApproveEndorsements: read failed: ${readErr.message}`);
  }

  const rows = (candidates ?? []) as Array<{
    id: string;
    endorsement_url: string | null;
  }>;

  const approvable = rows.filter((r) => r.endorsement_url != null);
  if (approvable.length === 0) {
    // Nothing to do — revalidate so the UI drops the stale count banner
    // but don't throw.
    revalidatePath(MORNING_REVIEW_PATH);
    revalidatePath(ENDORSEMENTS_QUEUE_PATH);
    return;
  }

  const approvableIds = approvable.map((r) => r.id);
  const nowIso = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from("endorsements")
    .update({
      published: true,
      reviewed_by_user_id: userId,
      reviewed_at: nowIso,
    })
    .in("id", approvableIds);

  if (updateErr) {
    throw new Error(`batchApproveEndorsements: update failed: ${updateErr.message}`);
  }

  revalidatePath(MORNING_REVIEW_PATH);
  revalidatePath(ENDORSEMENTS_QUEUE_PATH);
}

// ---------------------------------------------------------------------------
// batchResolveFecSameCommittee
// ---------------------------------------------------------------------------

type FecMatch = {
  candidate_id?: string;
  principal_committee_id?: string;
  [key: string]: unknown;
};

export async function batchResolveFecSameCommittee(
  _formData: FormData,
): Promise<void> {
  const userId = await requireEditorOrAdmin();
  const supabase = await createServiceClient();

  const { data, error } = await supabase
    .from("fec_match_ambiguous")
    .select("id, candidate_matches")
    .is("resolved_at", null);

  if (error) {
    throw new Error(`batchResolveFec: read failed: ${error.message}`);
  }

  const rows = (data ?? []) as Array<{
    id: string;
    candidate_matches: unknown;
  }>;

  let resolved = 0;
  for (const row of rows) {
    const matches = Array.isArray(row.candidate_matches)
      ? (row.candidate_matches as FecMatch[])
      : [];
    if (matches.length === 0) continue;

    // Extract distinct principal_committee_ids. If exactly one is present
    // (and non-empty), this row is safe to auto-resolve. Otherwise skip —
    // a human has to pick.
    const committees = new Set<string>();
    for (const m of matches) {
      const cid =
        typeof m.principal_committee_id === "string"
          ? m.principal_committee_id
          : null;
      if (cid && cid.length > 0) committees.add(cid);
    }
    if (committees.size !== 1) continue;

    // Prefer candidate_id when all matches agree; otherwise pick the first.
    const candidates = new Set<string>();
    for (const m of matches) {
      const cid =
        typeof m.candidate_id === "string" ? m.candidate_id : null;
      if (cid && cid.length > 0) candidates.add(cid);
    }
    const resolvedFecId =
      candidates.size === 1
        ? [...candidates][0]
        : typeof matches[0].candidate_id === "string"
          ? matches[0].candidate_id
          : null;
    if (!resolvedFecId) continue;

    const { error: upErr } = await supabase
      .from("fec_match_ambiguous")
      .update({
        resolved_fec_candidate_id: resolvedFecId,
        resolved_at: new Date().toISOString(),
        resolved_by_user_id: userId,
      })
      .eq("id", row.id);

    if (!upErr) resolved += 1;
  }

  revalidatePath(MORNING_REVIEW_PATH);

  // No error on 0 resolved — the UI will just show the same count next
  // refresh. An editor can fall back to manual resolution.
  if (resolved === 0 && rows.length > 0) {
    // Advisory console log so ops can see that the batch action fired but
    // nothing matched the same-committee heuristic. Not a thrown error.
    // eslint-disable-next-line no-console
    console.log(
      `[morning-review] batchResolveFecSameCommittee: 0/${rows.length} rows matched the same-committee heuristic`,
    );
  }
}
