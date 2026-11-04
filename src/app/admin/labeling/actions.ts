"use server";

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";
import { isBandN, bandByN } from "./bands";
import {
  GOLDEN_DIR,
  ANNOTATORS_FILE,
  labelsFile,
  slugAnnotator,
  pairsByIds,
  proposalsForIds,
  fullContextForPair,
  annotatorProfile,
  type QueuePair,
  type AnnotatorProfile,
} from "./data";
import {
  deriveAnesPartyId7,
  isPartyIdQ1,
  isPartyIdQ2Lean,
  isPartyIdQ2Strength,
  type PartyIdQ1,
  type PartyIdQ2Lean,
  type PartyIdQ2Strength,
} from "./party-id";

// ---------------------------------------------------------------------------
// /admin/labeling: Server Actions (file-backed golden set)
// ---------------------------------------------------------------------------
// Labels append to data/golden/labels-<annotator>.jsonl. One line per label;
// re-labelling a pair just appends a newer line (last-wins on read). This keeps
// a full audit trail and makes concurrent single-user writes trivially safe.
//
// v2: the write path is O(1) (append + an in-memory per-annotator count that is
// seeded once from disk, never a full re-parse per write), and the client pulls
// pair bodies in small windows via getPairs() instead of receiving the whole
// queue up front.
//
// Auth mirrors /admin/layout.tsx: hard editor/admin gate in production, dev
// bypass locally so the operator can label on a dev box without magic-link auth.
// (Server Actions are reachable by direct POST, so we re-check here too.)
// ---------------------------------------------------------------------------

const DEV_MODE = process.env.NODE_ENV !== "production";

async function requireLabelingAccess(): Promise<void> {
  if (DEV_MODE) return;
  const user = await getSessionUser();
  if (!user) throw new Error("labeling action: no session");
  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from("users")
    .select("id, role")
    .eq("id", user.id)
    .single();
  if (error || !data) throw new Error("labeling action: user lookup failed");
  const role = (data as { role?: string }).role;
  if (role !== "editor" && role !== "admin") {
    throw new Error(`labeling action: role ${role ?? "null"} not authorized`);
  }
}

// --- O(1) per-annotator resolved-pair count (seeded once from disk) ---------
const _countCache = new Map<string, Set<string>>();

function resolvedSet(annotatorSlug: string): Set<string> {
  let s = _countCache.get(annotatorSlug);
  if (s) return s;
  s = new Set<string>();
  const path = labelsFile(annotatorSlug);
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { pair_id?: string };
        if (r.pair_id) s.add(r.pair_id);
      } catch {
        /* skip */
      }
    }
  }
  _countCache.set(annotatorSlug, s);
  return s;
}

export interface SubmitLabelInput {
  pair_id: string;
  /** 1..4 for an ordinal band, or null for a "cannot verify from source" skip. */
  band: number | null;
  /** required (non-empty) when band is null. */
  skip_reason?: string;
  rationale?: string;
  annotator: string;
}

export interface SubmitLabelResult {
  ok: boolean;
  total: number; // distinct pairs this annotator has resolved (labeled or skipped)
  error?: string;
}

export async function submitLabel(
  input: SubmitLabelInput,
): Promise<SubmitLabelResult> {
  await requireLabelingAccess();

  const annotator = slugAnnotator(String(input.annotator ?? ""));
  if (!annotator) return { ok: false, total: 0, error: "missing annotator name" };

  const pairId = String(input.pair_id ?? "").trim();
  if (!pairId) return { ok: false, total: 0, error: "missing pair_id" };

  const rationale =
    typeof input.rationale === "string" ? input.rationale.trim().slice(0, 2000) : "";

  const isSkip = input.band === null || input.band === undefined;

  let record: Record<string, unknown>;
  if (isSkip) {
    const reason =
      typeof input.skip_reason === "string" ? input.skip_reason.trim().slice(0, 200) : "";
    if (!reason) {
      return { ok: false, total: resolvedSet(annotator).size, error: "skip requires a reason" };
    }
    record = {
      pair_id: pairId,
      band: null,
      band_label: null,
      skip_reason: reason,
      rationale,
      annotator,
      timestamp: new Date().toISOString(),
    };
  } else {
    if (!isBandN(input.band)) {
      return { ok: false, total: resolvedSet(annotator).size, error: `invalid band ${input.band}` };
    }
    const band = bandByN(input.band)!;
    record = {
      pair_id: pairId,
      band: band.n,
      band_label: band.key,
      rationale,
      annotator,
      timestamp: new Date().toISOString(),
    };
  }

  mkdirSync(GOLDEN_DIR, { recursive: true });
  appendFileSync(labelsFile(annotator), JSON.stringify(record) + "\n", "utf8");
  resolvedSet(annotator).add(pairId); // O(1) count update

  return { ok: true, total: resolvedSet(annotator).size };
}

export interface AnnotatorProgressItem {
  pair_id: string;
  band: number | null;
  skip_reason?: string;
}

export interface AnnotatorProgress {
  labeled: AnnotatorProgressItem[];
}

/** Which pairs this annotator has already resolved (for resume + progress). */
export async function getAnnotatorProgress(
  annotatorName: string,
): Promise<AnnotatorProgress> {
  await requireLabelingAccess();
  const annotator = slugAnnotator(String(annotatorName ?? ""));
  if (!annotator) return { labeled: [] };
  // Latest record per pair (last line wins).
  const path = labelsFile(annotator);
  const latest = new Map<string, AnnotatorProgressItem>();
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { pair_id?: string; band?: number | null; skip_reason?: string };
        if (!r.pair_id) continue;
        latest.set(r.pair_id, {
          pair_id: r.pair_id,
          band: r.band ?? null,
          ...(r.skip_reason ? { skip_reason: r.skip_reason } : {}),
        });
      } catch {
        /* skip */
      }
    }
  }
  return { labeled: [...latest.values()] };
}

// ---------------------------------------------------------------------------
// Windowed pair access (v2 performance): the client asks for a handful of
// pair_ids around the cursor; we return just those bodies + their proposals.
// ---------------------------------------------------------------------------
export interface ProposalView {
  band: number;
  band_label: string;
  rationale: string;
}

export interface GetPairsResult {
  pairs: QueuePair[];
  proposals: Record<string, ProposalView>;
}

export async function getPairs(ids: string[]): Promise<GetPairsResult> {
  await requireLabelingAccess();
  const clean = (Array.isArray(ids) ? ids : []).map((x) => String(x)).slice(0, 100);
  const pairs = pairsByIds(clean);
  const proposals: Record<string, ProposalView> = {};
  for (const [pid, rec] of proposalsForIds(clean)) {
    if (rec.band == null) continue;
    proposals[pid] = { band: rec.band, band_label: rec.band_label ?? "", rationale: rec.rationale };
  }
  return { pairs, proposals };
}

/** Lazy expand-to-full-document: the whole source page with «quote» marked. */
export async function getFullContext(pairId: string): Promise<{ text: string | null }> {
  await requireLabelingAccess();
  return { text: fullContextForPair(String(pairId ?? "")) };
}

// ---------------------------------------------------------------------------
// Annotator profile (optional bias-check groundwork). Skippable, one screen,
// never blocks labeling. Stored in data/golden/annotators.jsonl, last wins.
//
// Party identification uses the ANES (American National Election Studies)
// branching party-ID battery, not a self-invented scale. See party-id.ts
// for the full citation and the two raw questions plus the derived 7-point code.
// ---------------------------------------------------------------------------
export interface SaveProfileInput {
  annotator: string;
  party_id_q1?: PartyIdQ1 | null;
  party_id_q2_strength?: PartyIdQ2Strength | null;
  party_id_q2_lean?: PartyIdQ2Lean | null;
  age_band?: string | null;
  state?: string | null;
}

export async function saveAnnotatorProfile(
  input: SaveProfileInput,
): Promise<{ ok: boolean; error?: string }> {
  await requireLabelingAccess();
  const annotator = slugAnnotator(String(input.annotator ?? ""));
  if (!annotator) return { ok: false, error: "missing annotator name" };

  const q1 = isPartyIdQ1(input.party_id_q1) ? input.party_id_q1 : null;
  const q2Strength = isPartyIdQ2Strength(input.party_id_q2_strength) ? input.party_id_q2_strength : null;
  const q2Lean = isPartyIdQ2Lean(input.party_id_q2_lean) ? input.party_id_q2_lean : null;

  // NOTE: `political_lean` (the old 1-5 slider) is deliberately never written
  // here. Existing rows that still carry it are left alone on read; see the
  // @deprecated note on AnnotatorProfile.political_lean in data.ts.
  const record: AnnotatorProfile = {
    annotator,
    party_id_q1: q1,
    party_id_q2_strength: q2Strength,
    party_id_q2_lean: q2Lean,
    party_id_7: deriveAnesPartyId7(q1, q2Strength, q2Lean),
    age_band: input.age_band ? String(input.age_band).slice(0, 20) : null,
    state: input.state ? String(input.state).slice(0, 40) : null,
    timestamp: new Date().toISOString(),
  };
  mkdirSync(GOLDEN_DIR, { recursive: true });
  appendFileSync(ANNOTATORS_FILE, JSON.stringify(record) + "\n", "utf8");
  return { ok: true };
}

/** Whether this annotator already has a stored profile (to skip the prompt). */
export async function getAnnotatorProfile(
  annotatorName: string,
): Promise<{ present: boolean; profile: AnnotatorProfile | null }> {
  await requireLabelingAccess();
  const annotator = slugAnnotator(String(annotatorName ?? ""));
  if (!annotator) return { present: false, profile: null };
  const profile = annotatorProfile(annotator);
  return { present: !!profile, profile };
}
