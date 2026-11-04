"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Admin endorsement queue — Server Actions
// ---------------------------------------------------------------------------
// These actions mutate `public.endorsements` with the service-role client
// (bypasses RLS). The app-layer auth check lives here; the DB trigger
// `trg_endorsement_reviewer_role` is the second gate (will raise if the
// reviewer's role is not in ('editor','admin'), even if the app is bypassed).
//
// All three actions revalidate `/admin/endorsements-queue` so the list
// refreshes without a full reload.
// ---------------------------------------------------------------------------

const QUEUE_PATH = "/admin/endorsements-queue";

// ---------------------------------------------------------------------------
// Shared auth check
// ---------------------------------------------------------------------------
// Throws on any failure. Form Actions bound via `<form action={...}>` expect
// Promise<void>; throwing here bubbles a 500 which Next.js surfaces via its
// error boundary. For programmatic callers, catch and inspect the message.
// ---------------------------------------------------------------------------

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
// approveEndorsement
// ---------------------------------------------------------------------------

export async function approveEndorsement(formData: FormData): Promise<void> {
  const userId = await requireEditorOrAdmin();

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("approveEndorsement: missing id");
  }

  const supabase = await createServiceClient();

  // Pre-flight: the CHECK constraint requires endorsement_url to be non-null
  // before publish=TRUE. Verify here so we raise a useful error rather than
  // the raw constraint-violation message.
  const { data: existing, error: readErr } = await supabase
    .from("endorsements")
    .select("id, endorsement_url, published, rescinded_at")
    .eq("id", id)
    .single();

  if (readErr || !existing) {
    throw new Error("approveEndorsement: endorsement not found");
  }
  const row = existing as {
    id: string;
    endorsement_url: string | null;
    published: boolean;
    rescinded_at: string | null;
  };
  if (row.published) {
    throw new Error("approveEndorsement: already published");
  }
  if (row.rescinded_at) {
    throw new Error("approveEndorsement: endorsement is rescinded; cannot publish");
  }
  if (!row.endorsement_url) {
    throw new Error("approveEndorsement: endorsement_url required before publish");
  }

  const { error: updateErr } = await supabase
    .from("endorsements")
    .update({
      published: true,
      reviewed_by_user_id: userId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateErr) {
    throw new Error(`approveEndorsement: ${updateErr.message}`);
  }

  revalidatePath(QUEUE_PATH);
}

// ---------------------------------------------------------------------------
// rejectEndorsement
// ---------------------------------------------------------------------------
// Soft-reject: we stamp reviewed_by/reviewed_at + meta.rejected_* but leave
// published=FALSE. Row stays in the DB for audit. A subsequent
// approveEndorsement call would overwrite reviewed_at and flip published=TRUE.
// ---------------------------------------------------------------------------

export async function rejectEndorsement(formData: FormData): Promise<void> {
  const userId = await requireEditorOrAdmin();

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("rejectEndorsement: missing id");
  }

  const supabase = await createServiceClient();

  // Read existing meta so we can merge rather than overwrite.
  const { data: existing, error: readErr } = await supabase
    .from("endorsements")
    .select("id, meta, published")
    .eq("id", id)
    .single();

  if (readErr || !existing) {
    throw new Error("rejectEndorsement: endorsement not found");
  }
  const row = existing as {
    id: string;
    meta: Record<string, unknown> | null;
    published: boolean;
  };
  if (row.published) {
    throw new Error("rejectEndorsement: cannot reject an already-published row; rescind instead");
  }

  const nowIso = new Date().toISOString();
  const mergedMeta = {
    ...(row.meta ?? {}),
    rejected_at: nowIso,
    rejected_by: userId,
  };

  const { error: updateErr } = await supabase
    .from("endorsements")
    .update({
      reviewed_by_user_id: userId,
      reviewed_at: nowIso,
      meta: mergedMeta,
    })
    .eq("id", id);

  if (updateErr) {
    throw new Error(`rejectEndorsement: ${updateErr.message}`);
  }

  revalidatePath(QUEUE_PATH);
}

// ---------------------------------------------------------------------------
// rescindEndorsement
// ---------------------------------------------------------------------------
// For already-published rows. Stamps rescinded_at + optional reason. RLS
// auto-hides rescinded rows from public reads (see RLS policy on
// endorsements).
// ---------------------------------------------------------------------------

export async function rescindEndorsement(formData: FormData): Promise<void> {
  await requireEditorOrAdmin();

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("rescindEndorsement: missing id");
  }

  const reasonRaw = formData.get("reason");
  const reason =
    typeof reasonRaw === "string" && reasonRaw.trim().length > 0
      ? reasonRaw.trim().slice(0, 500)
      : null;

  const supabase = await createServiceClient();

  const { error: updateErr } = await supabase
    .from("endorsements")
    .update({
      rescinded_at: new Date().toISOString(),
      rescinded_reason: reason,
    })
    .eq("id", id)
    .eq("published", true);

  if (updateErr) {
    throw new Error(`rescindEndorsement: ${updateErr.message}`);
  }

  revalidatePath(QUEUE_PATH);
}
