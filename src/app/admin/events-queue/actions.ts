"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Admin events queue — Server Actions
// ---------------------------------------------------------------------------
// Mirror of endorsements-queue/actions.ts but for `candidate_events`. Publish
// gate: CHECK requires reviewed_by_user_id + reviewed_at (no URL requirement
// — events might be in-person only). Trigger
// `trg_candidate_event_reviewer_role` enforces reviewer role in DB.
//
// Note: `candidate_events` has no `rescinded_at` column (schema differs from
// endorsements). The closest equivalent is flipping `published` back to FALSE
// — we call that "unpublish" in the UI. We stamp meta.unpublished_at and
// clear reviewed_at to keep the CHECK constraint satisfied on transition
// (published=FALSE permits null reviewed_at).
// ---------------------------------------------------------------------------

const QUEUE_PATH = "/admin/events-queue";

async function requireEditorOrAdmin(): Promise<string> {
  const user = await getSessionUser();
  if (!user) {
    throw new Error("admin action: no session");
  }

  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from("users")
    .select("id, role")
    .eq("id", user.id)
    .single();

  if (error || !data) {
    throw new Error("admin action: user lookup failed");
  }

  const role = (data as { role?: string }).role;
  if (role !== "editor" && role !== "admin") {
    throw new Error(`admin action: role ${role ?? "null"} not authorized`);
  }

  return user.id;
}

// ---------------------------------------------------------------------------
// approveEvent
// ---------------------------------------------------------------------------

export async function approveEvent(formData: FormData): Promise<void> {
  const userId = await requireEditorOrAdmin();

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("approveEvent: missing id");
  }

  const supabase = await createServiceClient();

  const { data: existing, error: readErr } = await supabase
    .from("candidate_events")
    .select("id, published")
    .eq("id", id)
    .single();

  if (readErr || !existing) {
    throw new Error("approveEvent: event not found");
  }
  if ((existing as { published: boolean }).published) {
    throw new Error("approveEvent: already published");
  }

  const { error: updateErr } = await supabase
    .from("candidate_events")
    .update({
      published: true,
      reviewed_by_user_id: userId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateErr) {
    throw new Error(`approveEvent: ${updateErr.message}`);
  }

  revalidatePath(QUEUE_PATH);
}

// ---------------------------------------------------------------------------
// rejectEvent
// ---------------------------------------------------------------------------

export async function rejectEvent(formData: FormData): Promise<void> {
  const userId = await requireEditorOrAdmin();

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("rejectEvent: missing id");
  }

  const supabase = await createServiceClient();

  const { data: existing, error: readErr } = await supabase
    .from("candidate_events")
    .select("id, meta, published")
    .eq("id", id)
    .single();

  if (readErr || !existing) {
    throw new Error("rejectEvent: event not found");
  }
  const row = existing as {
    id: string;
    meta: Record<string, unknown> | null;
    published: boolean;
  };
  if (row.published) {
    throw new Error("rejectEvent: cannot reject an already-published row; unpublish instead");
  }

  const nowIso = new Date().toISOString();
  const mergedMeta = {
    ...(row.meta ?? {}),
    rejected_at: nowIso,
    rejected_by: userId,
  };

  const { error: updateErr } = await supabase
    .from("candidate_events")
    .update({
      reviewed_by_user_id: userId,
      reviewed_at: nowIso,
      meta: mergedMeta,
    })
    .eq("id", id);

  if (updateErr) {
    throw new Error(`rejectEvent: ${updateErr.message}`);
  }

  revalidatePath(QUEUE_PATH);
}

// ---------------------------------------------------------------------------
// rescindEvent (unpublish)
// ---------------------------------------------------------------------------
// Flip published back to FALSE and stamp meta.unpublished_*. We null out
// reviewed_by_user_id / reviewed_at so the queue isn't mixed with
// soft-rejected rows on the next render (published=FALSE + reviewed_at=NULL
// is the "fresh" state). History of the publish → unpublish round-trip is
// preserved in meta.
// ---------------------------------------------------------------------------

export async function rescindEvent(formData: FormData): Promise<void> {
  const userId = await requireEditorOrAdmin();

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("rescindEvent: missing id");
  }

  const reasonRaw = formData.get("reason");
  const reason =
    typeof reasonRaw === "string" && reasonRaw.trim().length > 0
      ? reasonRaw.trim().slice(0, 500)
      : null;

  const supabase = await createServiceClient();

  const { data: existing, error: readErr } = await supabase
    .from("candidate_events")
    .select("id, meta, published, reviewed_at, reviewed_by_user_id")
    .eq("id", id)
    .single();

  if (readErr || !existing) {
    throw new Error("rescindEvent: event not found");
  }
  const row = existing as {
    id: string;
    meta: Record<string, unknown> | null;
    published: boolean;
    reviewed_at: string | null;
    reviewed_by_user_id: string | null;
  };
  if (!row.published) {
    throw new Error("rescindEvent: event is not currently published");
  }

  const nowIso = new Date().toISOString();
  const mergedMeta = {
    ...(row.meta ?? {}),
    unpublished_at: nowIso,
    unpublished_by: userId,
    unpublished_reason: reason,
    previous_review: {
      reviewed_at: row.reviewed_at,
      reviewed_by_user_id: row.reviewed_by_user_id,
    },
  };

  const { error: updateErr } = await supabase
    .from("candidate_events")
    .update({
      published: false,
      reviewed_at: null,
      reviewed_by_user_id: null,
      meta: mergedMeta,
    })
    .eq("id", id);

  if (updateErr) {
    throw new Error(`rescindEvent: ${updateErr.message}`);
  }

  revalidatePath(QUEUE_PATH);
}
