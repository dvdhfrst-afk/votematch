"use server";

// ---------------------------------------------------------------------------
// /admin/labeling?mode=adjudicate: Server Actions for the adjudication surface.
//
// The operator's adjudication picks are HUMAN labels: they append to
// labels-operator.jsonl via the SAME submitLabel action the normal tool uses
// (annotator "operator"), so mergeLabels keeps treating operator as the human
// authority. We do NOT introduce a second write path.
//
// The two agent judgments are served ONLY through revealAgentJudgments, which
// the client calls AFTER a pick lands. They are never included in any payload
// the surface renders before the operator commits a band.
//
// Auth mirrors actions.ts / admin/layout.tsx: hard editor/admin gate in
// production, dev bypass locally. Server Actions are reachable by direct POST,
// so every action re-checks access first.
// ---------------------------------------------------------------------------

import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";
import { getFullContext } from "./actions";
import type { QueuePair } from "./data";
import { adjudicationPairs, agentJudgmentsFor, type AgentJudgments } from "./adjudication";

const DEV_MODE = process.env.NODE_ENV !== "production";

async function requireLabelingAccess(): Promise<void> {
  if (DEV_MODE) return;
  const user = await getSessionUser();
  if (!user) throw new Error("adjudication action: no session");
  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from("users")
    .select("id, role")
    .eq("id", user.id)
    .single();
  if (error || !data) throw new Error("adjudication action: user lookup failed");
  const role = (data as { role?: string }).role;
  if (role !== "editor" && role !== "admin") {
    throw new Error(`adjudication action: role ${role ?? "null"} not authorized`);
  }
}

/**
 * Windowed pair-body fetch for the adjudication cursor. Unlike the normal
 * getPairs, this returns ONLY the pair bodies, never the agent proposals, so
 * moving the cursor cannot leak an agent's judgment ahead of the operator's pick.
 */
export async function getAdjudicationPairs(ids: string[]): Promise<{ pairs: QueuePair[] }> {
  await requireLabelingAccess();
  const clean = (Array.isArray(ids) ? ids : []).map((x) => String(x)).slice(0, 100);
  return { pairs: adjudicationPairs(clean) };
}

/** Lazy expand-to-full-document (reuses the normal action; no agent data). */
export async function getAdjudicationFullContext(pairId: string): Promise<{ text: string | null }> {
  await requireLabelingAccess();
  return getFullContext(pairId);
}

/**
 * Reveal the two agent annotators' band + rationale for a pair. Called by the
 * client AFTER the operator's band has been submitted for that pair.
 */
export async function revealAgentJudgments(pairId: string): Promise<AgentJudgments> {
  await requireLabelingAccess();
  return agentJudgmentsFor(String(pairId ?? ""));
}
