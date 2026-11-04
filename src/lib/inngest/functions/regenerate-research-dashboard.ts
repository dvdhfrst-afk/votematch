/**
 * regenerateResearchDashboard — Inngest cron, every 30 minutes.
 *
 * Re-runs the dashboard generator so the static
 * 00-inbox/2026-05-beta-spec/html/candidate-review.html stays fresh in the
 * background.  Useful in local dev where filesystem writes persist; in
 * deployed (Vercel) contexts the filesystem is ephemeral so the function
 * effectively becomes a no-op past warm-cache lifetime — the production
 * surface is the live admin page at /admin/candidate-review.
 *
 * The cron uses `concurrency: 1` so a long regen never stacks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "../client";
import {
  fetchDashboardData,
  renderDashboardHTML,
} from "../../dashboards/research-dashboard";

const OUTPUT_REL = "data/candidate-review.html";

export const regenerateResearchDashboard = inngest.createFunction(
  {
    id: "regenerate-research-dashboard",
    concurrency: [{ limit: 1 }],
    triggers: [
      // No cron — the live API + admin route make scheduled regen
      // unnecessary. Keep the function for manual one-off snapshots via
      // sendEvent('dashboard/regenerate.manual').
      { event: "dashboard/regenerate.manual" },
    ],
  },
  async ({ step }: { step: any }) => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      return { skipped: "missing supabase env" };
    }

    const data = await step.run("fetch", async () => {
      const supabase = createClient(url, key, { auth: { persistSession: false } });
      const d = await fetchDashboardData(supabase);
      return {
        generatedAt: d.generatedAt,
        cycleYear: d.cycleYear,
        aggregate: d.aggregate,
        byLevel: d.byLevel,
        offices: d.offices,
        // Convert Map → array for serialization across step boundary
        byState: Array.from(d.byState.entries()),
        rows: d.rows,
        health: d.health,
        subDimensions: d.subDimensions,
      };
    });

    const written = await step.run("render-and-write", async () => {
      const rehydrated = {
        generatedAt: data.generatedAt,
        cycleYear: data.cycleYear,
        aggregate: data.aggregate,
        byLevel: data.byLevel,
        offices: data.offices,
        byState: new Map(data.byState as Array<[string, any]>),
        rows: data.rows,
        health: data.health,
        subDimensions: data.subDimensions,
      };
      const html = renderDashboardHTML(rehydrated as any, { mode: "standalone" });
      // cwd at runtime is the Next app dir
      const out = path.resolve(process.cwd(), OUTPUT_REL);
      try {
        fs.writeFileSync(out, html, "utf-8");
        return { path: out, bytes: html.length, rows: data.rows.length };
      } catch (e) {
        // Filesystem may be read-only in deployed contexts — log and continue.
        return {
          skipped: "filesystem not writable",
          path: out,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    });

    return {
      generatedAt: data.generatedAt,
      cycleYear: data.cycleYear,
      aggregate: data.aggregate,
      written,
    };
  },
);
