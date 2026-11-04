"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";
import { inngest } from "@/lib/inngest/client";

// ---------------------------------------------------------------------------
// /admin/corrections-review — Server Actions
// ---------------------------------------------------------------------------
// Three primitives:
//
//   1. reverifyCorrection(formData) — sends a
//      `corrections/flagged.received` event into Inngest so the
//      correction-reverify function re-runs the upstream adapter
//      (or re-fetches the source) and decides whether to accept the
//      voter's claim. Stamps corrections.reverify_triggered_at.
//
//   2. dismissCorrection(formData) — editor explicitly rejects the
//      claim (spam, bad-faith, unactionable). Stamps resolved_at +
//      resolution_status='dismissed'.
//
//   3. resolveCorrection(formData) — editor accepts the claim as
//      correct without re-verification (e.g. they already verified
//      out-of-band). Stamps resolved_at + resolution_status
//      ='verified_corrected'.
//
// All three re-verify role ∈ ('editor','admin') via service-role client.
// Errors throw (Next.js Server Actions contract — no result tuples).
// ---------------------------------------------------------------------------

const CORRECTIONS_REVIEW_PATH = "/admin/corrections-review";
const MORNING_REVIEW_PATH = "/admin/morning-review";

async function requireEditorOrAdmin(): Promise<string> {
  const user = await getSessionUser();
  if (!user) {
    throw new Error("corrections-review action: no session");
  }

  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from("users")
    .select("id, role")
    .eq("id", user.id)
    .single();

  if (error || !data) {
    throw new Error("corrections-review action: user lookup failed");
  }

  const role = (data as { role?: string }).role;
  if (role !== "editor" && role !== "admin") {
    throw new Error(
      `corrections-review action: role ${role ?? "null"} not authorized`,
    );
  }

  return user.id;
}

async function loadCorrection(id: string): Promise<{
  id: string;
  target_type: string | null;
  target_id: string | null;
  candidate_id: string | null;
  position_id: string | null;
  claim_type: string | null;
  resolved_at: string | null;
}> {
  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from("corrections")
    .select(
      "id, target_type, target_id, candidate_id, position_id, claim_type, resolved_at",
    )
    .eq("id", id)
    .single();

  if (error || !data) {
    throw new Error(`corrections-review: correction ${id} not found`);
  }

  return data as {
    id: string;
    target_type: string | null;
    target_id: string | null;
    candidate_id: string | null;
    position_id: string | null;
    claim_type: string | null;
    resolved_at: string | null;
  };
}

function revalidateSurfaces(): void {
  revalidatePath(CORRECTIONS_REVIEW_PATH);
  revalidatePath(MORNING_REVIEW_PATH);
}

// ---------------------------------------------------------------------------
// reverifyCorrection
// ---------------------------------------------------------------------------

export async function reverifyCorrection(formData: FormData): Promise<void> {
  const userId = await requireEditorOrAdmin();

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("reverifyCorrection: missing id");
  }

  const row = await loadCorrection(id);
  if (row.resolved_at) {
    throw new Error("reverifyCorrection: correction already resolved");
  }

  const supabase = await createServiceClient();

  // Stamp the trigger timestamp FIRST. This is our bread-crumb: if the
  // Inngest call below fails, the editor will see "re-verify pending" and
  // can try again (the function itself is idempotent on correction_id).
  const { error: updateErr } = await supabase
    .from("corrections")
    .update({
      reverify_triggered_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateErr) {
    throw new Error(`reverifyCorrection: update failed: ${updateErr.message}`);
  }

  // Fire the event. Inngest takes it from here.
  await inngest.send({
    name: "corrections/flagged.received",
    data: {
      correction_id: id,
      triggered_by_user_id: userId,
    },
  });

  revalidateSurfaces();
}

// ---------------------------------------------------------------------------
// dismissCorrection
// ---------------------------------------------------------------------------

export async function dismissCorrection(formData: FormData): Promise<void> {
  const userId = await requireEditorOrAdmin();

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("dismissCorrection: missing id");
  }

  const row = await loadCorrection(id);
  if (row.resolved_at) {
    throw new Error("dismissCorrection: already resolved");
  }

  const noteRaw = formData.get("note");
  const note =
    typeof noteRaw === "string" && noteRaw.trim().length > 0
      ? noteRaw.trim().slice(0, 1000)
      : "dismissed by editor";

  const supabase = await createServiceClient();
  const { error } = await supabase
    .from("corrections")
    .update({
      resolved_at: new Date().toISOString(),
      resolution_status: "dismissed",
      resolution_note: note,
      // Keep the legacy `status` column in sync for back-compat.
      status: "rejected",
      resolution_notes: note,
    })
    .eq("id", id);

  if (error) {
    throw new Error(`dismissCorrection: update failed: ${error.message}`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[corrections] dismiss ${id} by user ${userId}: ${note.slice(0, 80)}`,
  );

  revalidateSurfaces();
}

// ---------------------------------------------------------------------------
// resolveCorrection — accept voter's claim without running re-verify.
// ---------------------------------------------------------------------------

export async function resolveCorrection(formData: FormData): Promise<void> {
  const userId = await requireEditorOrAdmin();

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("resolveCorrection: missing id");
  }

  const row = await loadCorrection(id);
  if (row.resolved_at) {
    throw new Error("resolveCorrection: already resolved");
  }

  const noteRaw = formData.get("note");
  const note =
    typeof noteRaw === "string" && noteRaw.trim().length > 0
      ? noteRaw.trim().slice(0, 1000)
      : "accepted as-corrected by editor";

  const supabase = await createServiceClient();
  const { error } = await supabase
    .from("corrections")
    .update({
      resolved_at: new Date().toISOString(),
      resolution_status: "verified_corrected",
      resolution_note: note,
      // Legacy status column.
      status: "accepted",
      resolution_notes: note,
    })
    .eq("id", id);

  if (error) {
    throw new Error(`resolveCorrection: update failed: ${error.message}`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[corrections] resolve ${id} by user ${userId}: ${note.slice(0, 80)}`,
  );

  revalidateSurfaces();
}
