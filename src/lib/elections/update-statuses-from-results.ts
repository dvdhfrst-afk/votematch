/**
 * Results → candidacy.status pipeline
 *
 * Today the candidacies.status enum supports won_primary / lost_primary /
 * won_general / lost_general / advanced_to_runoff / withdrew / disqualified /
 * active / pending_verification — but nothing writes the post-results values.
 * The 53 SoS results adapters populate `election_results` rows with
 * `is_winner` / `is_runoff_advancer` flags + a `reporting_level`; this
 * service reads from there and flips `candidacies.status` accordingly.
 *
 * Design (per the integration map in the council exploration):
 *   • Standalone service callable from an Inngest cron or a one-off script.
 *   • Idempotent — re-running with the same election_results yields the
 *     same statuses. Re-runs only update rows whose target status differs.
 *   • Provenance via candidacies.meta {status_update_run_id, status_updated_at,
 *     status_update_source}.
 *   • Loser detection: only mark `lost_*` when reporting_level is
 *     state_certified or final — never on unofficial returns.
 *
 * Pair this with the upsertCandidacy() fix in
 *   app/src/lib/adapters/state-sos/shared/candidacies-insert.ts
 * which now preserves terminal statuses on re-ingest instead of clobbering
 * them back to 'active'.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ────────────────────────────────────────────────────────────────────────────
// Type maps
// ────────────────────────────────────────────────────────────────────────────

const PRIMARY_TYPES = new Set([
  "primary",
  "special_primary",
  "primary_runoff",
  "runoff",
]);

const GENERAL_TYPES = new Set([
  "general",
  "special_general",
  "nonpartisan_general",
]);

// Reporting levels considered "final enough" to mark a candidate as having lost.
// Anything below (unofficial_partial, ap_called) is too soft to write a
// terminal status.
const CERTIFIED_LEVELS = new Set([
  "state_certified",
  "final",
  "official",
]);

export type ResultsUpdateOutcome = {
  examined: number;          // election_results rows considered
  updated: number;           // candidacies whose status actually changed
  unchanged: number;         // already had the correct status (idempotent re-runs)
  skippedNoCandidacy: number; // election_results rows without a candidacy_id FK
  skippedUnofficial: number; // results not yet certified
  skippedUnknownType: number; // election_type we don't have a rule for (e.g. retention)
  errors: Array<{ candidacy_id: string; error: string }>;
};

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

export async function updateCandidacyStatusesFromResults(
  supabase: SupabaseClient,
  opts: {
    /** Only consider election_results modified at-or-after this ISO timestamp.
     * Default: 4 hours ago (matches a 30-min cron with headroom). */
    sinceIso?: string;
    /** Limit to a single election (e.g. for event-driven triggers). */
    electionId?: string;
    /** Source label written to candidacies.meta for provenance. */
    sourceLabel?: string;
    /** Dry-run — compute the would-be updates and return them, but don't write. */
    dryRun?: boolean;
  } = {},
): Promise<ResultsUpdateOutcome> {
  const sinceIso =
    opts.sinceIso ?? new Date(Date.now() - 4 * 3600e3).toISOString();
  const sourceLabel = opts.sourceLabel ?? "results-status-pipeline";

  const out: ResultsUpdateOutcome = {
    examined: 0,
    updated: 0,
    unchanged: 0,
    skippedNoCandidacy: 0,
    skippedUnofficial: 0,
    skippedUnknownType: 0,
    errors: [],
  };

  // ── 1. Fetch recent election_results + their election_type
  type Res = {
    id: string;
    election_id: string;
    candidacy_id: string | null;
    is_winner: boolean;
    is_runoff_advancer: boolean;
    reporting_level: string;
    updated_at?: string | null;
    election: { election_type: string } | null;
  };

  let q = supabase
    .from("election_results")
    .select(
      `id, election_id, candidacy_id, is_winner, is_runoff_advancer, reporting_level, updated_at,
       election:elections(election_type)`,
    )
    .gte("updated_at", sinceIso);
  if (opts.electionId) q = q.eq("election_id", opts.electionId);

  // .order('id') for deterministic 10K cap. Re-runs pick up the rest because
  // updated_at filtering changes the working set.
  const { data: results, error } = await q.order('id').range(0, 9999);
  if (error) {
    // The election_results table may be empty or absent in early-dev environments.
    if (/relation .* does not exist/i.test(error.message)) {
      return out;
    }
    throw error;
  }

  const rows = (results as unknown as Res[]) || [];
  out.examined = rows.length;

  // ── 2. Compute target status per candidacy_id (newest result wins ties)
  type Decision = {
    candidacy_id: string;
    target: string;
    electionType: string;
    reportingLevel: string;
  };
  const decisions = new Map<string, Decision>();

  for (const r of rows) {
    if (!r.candidacy_id) {
      out.skippedNoCandidacy += 1;
      continue;
    }
    const et = r.election?.election_type || "";
    const isPrimary = PRIMARY_TYPES.has(et);
    const isGeneral = GENERAL_TYPES.has(et);
    if (!isPrimary && !isGeneral) {
      out.skippedUnknownType += 1;
      continue;
    }

    let target: string | null = null;
    if (r.is_runoff_advancer) {
      target = "advanced_to_runoff";
    } else if (r.is_winner) {
      target = isPrimary ? "won_primary" : "won_general";
    } else if (CERTIFIED_LEVELS.has(r.reporting_level)) {
      target = isPrimary ? "lost_primary" : "lost_general";
    } else {
      out.skippedUnofficial += 1;
      continue;
    }

    // Conflict policy if the same candidacy appears in multiple result rows
    // (e.g. partial then certified): the "stronger" terminal wins.
    // Priority: won_general > won_primary > advanced_to_runoff > lost_*.
    const PRIORITY: Record<string, number> = {
      won_general: 5,
      won_primary: 4,
      advanced_to_runoff: 3,
      lost_general: 2,
      lost_primary: 1,
    };
    const prev = decisions.get(r.candidacy_id);
    if (!prev || (PRIORITY[target] || 0) > (PRIORITY[prev.target] || 0)) {
      decisions.set(r.candidacy_id, {
        candidacy_id: r.candidacy_id,
        target,
        electionType: et,
        reportingLevel: r.reporting_level,
      });
    }
  }

  if (decisions.size === 0) return out;

  // ── 3. Fetch current status for the candidacies in scope
  const ids = [...decisions.keys()];
  type CandRow = { id: string; status: string; meta: Record<string, unknown> | null };
  const current = new Map<string, CandRow>();
  const BATCH = 200;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const { data, error: cErr } = await supabase
      .from("candidacies")
      .select("id, status, meta")
      .in("id", slice);
    if (cErr) throw cErr;
    for (const r of (data as CandRow[]) || []) current.set(r.id, r);
  }

  // ── 4. Write updates (one row at a time to keep meta merge correct)
  const nowIso = new Date().toISOString();
  for (const d of decisions.values()) {
    const cur = current.get(d.candidacy_id);
    if (!cur) continue;
    if (cur.status === d.target) {
      out.unchanged += 1;
      continue;
    }
    if (opts.dryRun) {
      out.updated += 1;
      continue;
    }
    const nextMeta = {
      ...(cur.meta || {}),
      status_update_run_id: sourceLabel,
      status_updated_at: nowIso,
      status_update_source: sourceLabel,
      status_update_election_type: d.electionType,
      status_update_reporting_level: d.reportingLevel,
      previous_status: cur.status,
    };
    const { error: uErr } = await supabase
      .from("candidacies")
      .update({ status: d.target, meta: nextMeta })
      .eq("id", d.candidacy_id);
    if (uErr) {
      out.errors.push({ candidacy_id: d.candidacy_id, error: uErr.message });
      continue;
    }
    out.updated += 1;
  }

  return out;
}
