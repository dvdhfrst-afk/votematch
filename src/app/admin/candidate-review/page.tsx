import { createServiceClient } from "@/lib/supabase/server";
import {
  fetchDashboardData,
  renderDashboardHTML,
} from "@/lib/dashboards/research-dashboard";

// Always render live — no caching. The admin route is a dashboard, not content.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CandidateReviewPage() {
  const supabase = await createServiceClient();
  let data;
  let err: string | null = null;
  try {
    data = await fetchDashboardData(supabase);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }

  if (err || !data) {
    return (
      <div style={{ padding: 32, fontFamily: "var(--font-sans)" }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 26 }}>
          Candidate Research Progress
        </h1>
        <p style={{ color: "var(--state-error-fg)" }}>
          Failed to load dashboard data: {err}
        </p>
      </div>
    );
  }

  const html = renderDashboardHTML(data, { mode: "embed" });
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
