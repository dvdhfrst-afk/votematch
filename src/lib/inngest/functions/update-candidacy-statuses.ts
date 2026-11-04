/**
 * updateCandidacyStatuses — Inngest cron, hourly during the 2026 cycle.
 *
 * Reads recent election_results rows (last 4h) and flips candidacies.status
 * to won_primary / lost_primary / advanced_to_runoff / won_general / lost_general
 * per the rules in src/lib/elections/update-statuses-from-results.ts.
 *
 * Standalone scheduled function (Option A from the integration map) so it's
 * decoupled from the SoS adapters' lifecycle.
 */

import { createClient } from "@supabase/supabase-js";
import { inngest } from "../client";
import { resolveResultCandidacies } from "../../elections/resolve-result-candidacies";
import { updateCandidacyStatusesFromResults } from "../../elections/update-statuses-from-results";

export const updateCandidacyStatuses = inngest.createFunction(
  {
    id: "update-candidacy-statuses",
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: "20 * * * *" }, // :20 each hour — staggered off the SoS waves
      { event: "elections/update-statuses.manual" }, // for manual fires
    ],
  },
  async ({ step }: { step: any }) => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return { skipped: "missing supabase env" };

    // Step 1: resolve any election_results rows whose candidacy_id is still
    // null (SoS reported_name didn't trivially match a person.canonical_name).
    // Without this, the status updater can't flip those candidacies.
    const resolved = await step.run("resolve-unmatched-results", async () => {
      const supabase = createClient(url, key, { auth: { persistSession: false } });
      return await resolveResultCandidacies(supabase);
    });

    // Step 2: read election_results and flip candidacies.status per the
    // win/loss/runoff rules.
    const updates = await step.run("apply-status-updates", async () => {
      const supabase = createClient(url, key, { auth: { persistSession: false } });
      return await updateCandidacyStatusesFromResults(supabase, {
        sourceLabel: "inngest:update-candidacy-statuses",
      });
    });

    return { resolved, updates };
  },
);
