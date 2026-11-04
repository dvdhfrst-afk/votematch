"use server";

import { execSync } from "node:child_process";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";
import { isWorkerName } from "@/lib/workers";

// ---------------------------------------------------------------------------
// /admin/workers Server Actions
// ---------------------------------------------------------------------------
// Restart a single worker via `pm2 restart <name>`. Defence-in-depth on auth:
// the admin layout already gates by users.role, but Server Actions can be
// invoked from anywhere a session cookie reaches, so we re-check the role.
// ---------------------------------------------------------------------------

export type RestartResult = {
  ok: boolean;
  worker: string;
  message: string;
};

async function requireAdmin(): Promise<void> {
  const user = await getSessionUser();
  if (!user) {
    redirect("/");
  }
  const supabase = await createServiceClient();
  const { data: row } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (row as { role?: string } | null)?.role;
  if (role !== "editor" && role !== "admin") {
    redirect("/");
  }
}

export async function restartWorkerForm(formData: FormData): Promise<void> {
  // Form-action wrapper: returns void so it can be used as <form action>.
  // The page revalidation handles the user feedback (the row updates).
  await restartWorker(formData);
}

export async function restartWorker(formData: FormData): Promise<RestartResult> {
  await requireAdmin();
  const raw = formData.get("worker");
  const worker = typeof raw === "string" ? raw : "";
  if (!isWorkerName(worker)) {
    return {
      ok: false,
      worker,
      message: `Refusing to restart unknown worker name: ${JSON.stringify(worker)}`,
    };
  }
  try {
    // Pass as a single arg to avoid shell interpolation. windowsHide hides
    // any popup console window. 15s is generous — pm2 restart usually <2s.
    const stdout = execSync(`pm2 restart ${worker}`, {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    revalidatePath("/admin/workers");
    return {
      ok: true,
      worker,
      message: stdout.trim().slice(-2000) || "restart issued",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, worker, message: msg.slice(-2000) };
  }
}
