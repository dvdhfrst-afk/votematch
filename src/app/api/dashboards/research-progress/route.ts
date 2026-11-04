/**
 * GET /api/dashboards/research-progress
 *
 * Returns the rendered embed-mode HTML for the research-progress dashboard.
 * The public shell at /candidate-review.html fetches this on load and
 * injects it — same-origin, so no CORS dance. Admin-gated in production
 * (dev-bypass in development, matching the /admin/* convention).
 *
 * Cache headers: 60s fresh + 5 min stale-while-revalidate so refreshes feel
 * snappy without hammering the DB.
 */

import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import {
  fetchDashboardData,
  renderDashboardHTML,
} from "@/lib/dashboards/research-dashboard";

export const dynamic = "force-dynamic";

const DEV_MODE = process.env.NODE_ENV !== "production";

export async function GET() {
  // Auth — match /admin/* layout behavior: dev-bypass locally, role-gated in prod.
  if (!DEV_MODE) {
    const user = await getSessionUser();
    if (!user) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
    const sb = await createServiceClient();
    const { data: row } = await sb
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single();
    const role = (row as { role?: string } | null)?.role;
    if (role !== "editor" && role !== "admin") {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  try {
    const supabase = await createServiceClient();
    const data = await fetchDashboardData(supabase);
    const html = renderDashboardHTML(data, { mode: "embed" });
    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // 60s fresh, then serve stale up to 5 min while revalidating.
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new NextResponse(
      `<div style="padding:32px;font-family:system-ui;color:#8b2e2e">Failed to load dashboard data: ${msg.replace(/[<>]/g, "")}</div>`,
      { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}
