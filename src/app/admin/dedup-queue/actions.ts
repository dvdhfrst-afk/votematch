"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// /admin/dedup-queue — Server Actions
// ---------------------------------------------------------------------------
// Four primitives, all editor/admin-gated:
//
//   1. resolveDedupMerge(formData)  → resolution='merge'      + target_person_id
//      "All these `people` rows are the same human. Merge them into <id>."
//      v1 only records the editor's verdict — the actual data-level merge
//      (rewrite candidacies/positions/sources foreign keys, then delete
//      the duplicate `people` rows) is run by `scripts/apply-dedup-merges.ts`
//      against rows where resolution='merge' AND merge_applied_at IS NULL.
//      Keeping the verdict reversible (no immediate cascade) protects
//      against fat-fingers in the UI.
//
//   2. resolveDedupSplit(formData)  → resolution='split'
//      "These are different humans. Leave them as-is."
//      Closes the row; no downstream action.
//
//   3. resolveDedupDefer(formData)  → resolution='defer'
//      "Need more evidence. Revisit later."
//      Stamps reviewed_by + reviewed_at so the row drops off the queue;
//      reset by setting resolution=NULL via SQL when more evidence comes in.
//
//   4. reopenDedup(formData)        → resolution=NULL + reviewed_at=NULL
//      Undo button. Re-opens a previously resolved row.
//
// All actions revalidate both the dedup queue page AND morning-review so
// the count badge there refreshes immediately.
// ---------------------------------------------------------------------------

const DEDUP_QUEUE_PATH = "/admin/dedup-queue";
const MORNING_REVIEW_PATH = "/admin/morning-review";

async function requireEditorOrAdmin(): Promise<string> {
  const user = await getSessionUser();
  if (!user) {
    throw new Error("dedup-queue action: no session");
  }
  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from("users")
    .select("id, role")
    .eq("id", user.id)
    .single();
  if (error || !data) {
    throw new Error("dedup-queue action: user lookup failed");
  }
  const role = (data as { role?: string }).role;
  if (role !== "editor" && role !== "admin") {
    throw new Error(`dedup-queue action: role ${role ?? "null"} not authorized`);
  }
  return user.id;
}

function readNote(formData: FormData, fallback: string): string {
  const raw = formData.get("note");
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim().slice(0, 1000);
  }
  return fallback;
}

function readId(formData: FormData): string {
  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("dedup-queue action: missing id");
  }
  return id;
}

function revalidateSurfaces(): void {
  revalidatePath(DEDUP_QUEUE_PATH);
  revalidatePath(MORNING_REVIEW_PATH);
}

// ---------------------------------------------------------------------------
// resolveDedupMerge
// ---------------------------------------------------------------------------

export async function resolveDedupMerge(formData: FormData): Promise<void> {
  const userId = await requireEditorOrAdmin();
  const id = readId(formData);

  const targetRaw = formData.get("target_person_id");
  if (typeof targetRaw !== "string" || targetRaw.length === 0) {
    throw new Error("resolveDedupMerge: missing target_person_id");
  }

  // Sanity-check: the target must be one of the people in the cluster.
  // We don't want an editor merging into a random uuid.
  const supabase = await createServiceClient();
  const { data: existing, error: readErr } = await supabase
    .from("dedup_review_queue")
    .select("id, candidate_people, reviewed_at")
    .eq("id", id)
    .single();

  if (readErr || !existing) {
    throw new Error("resolveDedupMerge: cluster not found");
  }
  const row = existing as {
    id: string;
    candidate_people: Array<{ id?: string }>;
    reviewed_at: string | null;
  };
  if (row.reviewed_at) {
    throw new Error("resolveDedupMerge: cluster already resolved");
  }
  const validTargets = new Set(
    (row.candidate_people ?? [])
      .map((p) => (typeof p.id === "string" ? p.id : null))
      .filter((x): x is string => !!x),
  );
  if (!validTargets.has(targetRaw)) {
    throw new Error(
      `resolveDedupMerge: target_person_id ${targetRaw} is not part of this cluster`,
    );
  }

  const note = readNote(formData, "merge confirmed by editor");
  const { error: updateErr } = await supabase
    .from("dedup_review_queue")
    .update({
      reviewed_by_user_id: userId,
      reviewed_at: new Date().toISOString(),
      resolution: "merge",
      resolution_target_person_id: targetRaw,
      resolution_note: note,
    })
    .eq("id", id);

  if (updateErr) {
    throw new Error(`resolveDedupMerge: ${updateErr.message}`);
  }

  revalidateSurfaces();
}

// ---------------------------------------------------------------------------
// resolveDedupSplit
// ---------------------------------------------------------------------------

export async function resolveDedupSplit(formData: FormData): Promise<void> {
  const userId = await requireEditorOrAdmin();
  const id = readId(formData);

  const supabase = await createServiceClient();
  const { data: existing, error: readErr } = await supabase
    .from("dedup_review_queue")
    .select("id, reviewed_at")
    .eq("id", id)
    .single();
  if (readErr || !existing) {
    throw new Error("resolveDedupSplit: cluster not found");
  }
  if ((existing as { reviewed_at: string | null }).reviewed_at) {
    throw new Error("resolveDedupSplit: cluster already resolved");
  }

  const note = readNote(formData, "split confirmed: distinct people");
  const { error: updateErr } = await supabase
    .from("dedup_review_queue")
    .update({
      reviewed_by_user_id: userId,
      reviewed_at: new Date().toISOString(),
      resolution: "split",
      resolution_target_person_id: null,
      resolution_note: note,
    })
    .eq("id", id);

  if (updateErr) {
    throw new Error(`resolveDedupSplit: ${updateErr.message}`);
  }

  revalidateSurfaces();
}

// ---------------------------------------------------------------------------
// resolveDedupDefer
// ---------------------------------------------------------------------------

export async function resolveDedupDefer(formData: FormData): Promise<void> {
  const userId = await requireEditorOrAdmin();
  const id = readId(formData);

  const supabase = await createServiceClient();
  const { data: existing, error: readErr } = await supabase
    .from("dedup_review_queue")
    .select("id, reviewed_at")
    .eq("id", id)
    .single();
  if (readErr || !existing) {
    throw new Error("resolveDedupDefer: cluster not found");
  }
  if ((existing as { reviewed_at: string | null }).reviewed_at) {
    throw new Error("resolveDedupDefer: cluster already resolved");
  }

  const note = readNote(formData, "deferred: insufficient evidence to decide");
  const { error: updateErr } = await supabase
    .from("dedup_review_queue")
    .update({
      reviewed_by_user_id: userId,
      reviewed_at: new Date().toISOString(),
      resolution: "defer",
      resolution_target_person_id: null,
      resolution_note: note,
    })
    .eq("id", id);

  if (updateErr) {
    throw new Error(`resolveDedupDefer: ${updateErr.message}`);
  }

  revalidateSurfaces();
}

// ---------------------------------------------------------------------------
// reopenDedup — undo a previous resolution
// ---------------------------------------------------------------------------

export async function reopenDedup(formData: FormData): Promise<void> {
  await requireEditorOrAdmin();
  const id = readId(formData);

  const supabase = await createServiceClient();
  const { error: updateErr } = await supabase
    .from("dedup_review_queue")
    .update({
      reviewed_by_user_id: null,
      reviewed_at: null,
      resolution: null,
      resolution_target_person_id: null,
      resolution_note: null,
    })
    .eq("id", id);

  if (updateErr) {
    throw new Error(`reopenDedup: ${updateErr.message}`);
  }

  revalidateSurfaces();
}
