import { createServiceClient } from "@/lib/supabase/server";
import {
  fetchOfficeReviewData,
  renderOfficeReviewHTML,
} from "@/lib/dashboards/office-review";

// Always render live — admin dashboard, not content.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function OfficeReviewPage() {
  const supabase = await createServiceClient();
  let data;
  let err: string | null = null;
  try {
    data = await fetchOfficeReviewData(supabase);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }

  if (err || !data) {
    return (
      <div style={{ padding: 32, fontFamily: "var(--civic-font-sans)" }}>
        <h1 style={{ fontFamily: "var(--civic-font-display)", fontSize: 26 }}>
          Office Review
        </h1>
        <p style={{ color: "var(--state-error-fg)" }}>
          Failed to load office-review data: {err}
        </p>
      </div>
    );
  }

  const html = renderOfficeReviewHTML(data);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
