import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveForCandidatesToken } from "@/lib/for-candidates/session";
import { loadPortalSubject } from "@/lib/for-candidates/subject";
import DisputesList from "./DisputesList";

/**
 * /for-candidates/profile/[token]/disputes
 *
 * Right-of-reply portal — per notes/ballot-bridge-execution-order.md
 * Week 3 item 12 and the council legal reviewer's "single biggest
 * defamation risk reducer" finding.
 *
 * Surfaces every INFERRED position we currently publish about this
 * candidate and provides a one-click dispute action per dimension. The
 * candidate has a token-authenticated path to push back without filing
 * a separate ticket. Disputes land in candidate_position_disputes for
 * human review (status='submitted').
 *
 * IMPORTANT: this page is built but NOT YET PUBLICLY DEPLOYED. Per the
 * brief's "code, not deployed" posture — the entry route exists in code
 * so the demo can walk through it, but no link to it ships in production
 * navigation until counsel has reviewed the legal-reply language.
 */
export default async function DisputesPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveForCandidatesToken(token);

  if (!resolved.ok) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md text-center space-y-2">
          <h1 className="text-xl font-bold text-[var(--color-text)]">
            Sign-in link unavailable
          </h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            {resolved.error ??
              "This link has expired. Request a new one from /for-candidates."}
          </p>
        </div>
      </main>
    );
  }

  if (resolved.target.kind === "pending_claim") {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md text-center space-y-2">
          <h1 className="text-xl font-bold text-[var(--color-text)]">
            Disputes not available yet
          </h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            We&apos;re still verifying your candidacy. Once that&apos;s done,
            disputes for any inferred positions we publish about you will
            unlock here.
          </p>
          <Link
            href={`/for-candidates/profile/${token}`}
            className="inline-block mt-2 text-sm text-[var(--color-primary)] underline"
          >
            Back to your profile
          </Link>
        </div>
      </main>
    );
  }

  const supabase = await createServiceClient();
  const subject = await loadPortalSubject(supabase, resolved.target);
  if (!subject) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md text-center space-y-2">
          <h1 className="text-xl font-bold text-[var(--color-text)]">
            Record not found
          </h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Contact support@example.org.
          </p>
        </div>
      </main>
    );
  }

  // Office-graph candidacies read inferred positions/disputes by person_id;
  // legacy candidates by candidate_id.
  const isCandidacy = subject.kind === "candidacy";
  const candidateName = (subject.name || "Candidate").trim();
  const raceLabel = subject.raceLabel;

  // Sub-dim catalog for label display.
  const { data: subDimsRaw } = await supabase
    .from("sub_dimensions")
    .select("id, domain, name, spectrum_low, spectrum_high, display_order")
    .order("domain")
    .order("display_order");
  const subDims = (subDimsRaw ?? []).map((sd) => ({
    id: sd.id as string,
    domain: (sd.domain as string) ?? "",
    name: (sd.name as string) ?? "",
    spectrum_low: (sd.spectrum_low as string) ?? "",
    spectrum_high: (sd.spectrum_high as string) ?? "",
  }));

  // The actual inferred positions we publish for this candidate. We
  // deliberately filter to view_type='inferred' — stated positions are
  // their own words, so disputing them is a different workflow (edit
  // your own profile instead).
  const posSel = supabase
    .from("positions")
    .select(
      "id, sub_dimension_id, score, confidence, view_type, source_citations, ai_summary, created_at",
    )
    .eq("view_type", "inferred")
    .order("created_at", { ascending: false });
  const { data: positionsRaw } =
    isCandidacy && subject.personId
      ? await posSel.eq("person_id", subject.personId)
      : isCandidacy
        ? { data: [] }
        : await posSel.eq("candidate_id", subject.candidateId!);
  const positions = positionsRaw ?? [];

  // Existing disputes (so the candidate doesn't double-submit). Keyed by the
  // same identity the dispute action writes.
  const dispSel = supabase
    .from("candidate_position_disputes")
    .select("id, sub_dimension_id, dispute_type, status, created_at")
    .order("created_at", { ascending: false });
  const { data: existingRaw } = isCandidacy
    ? await dispSel.eq("candidacy_id", subject.candidacyId!)
    : await dispSel.eq("candidate_id", subject.candidateId!);
  const existingDisputes = (existingRaw ?? []).map((d) => ({
    id: d.id as string,
    sub_dimension_id: d.sub_dimension_id as string,
    dispute_type: d.dispute_type as string,
    status: d.status as string,
    created_at: d.created_at as string,
  }));

  return (
    <main className="min-h-screen bg-[var(--color-bg-alt)] pb-16">
      <header className="bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="civic-container py-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <Link
              href={`/for-candidates/profile/${token}`}
              className="text-xs text-[var(--color-text-muted)] hover:underline"
            >
              ← Back to your profile
            </Link>
            <h1 className="text-2xl font-bold text-[var(--color-text)] mt-1">
              Right of reply
            </h1>
          </div>
          <div className="text-sm text-[var(--color-text-secondary)] text-right">
            <div className="font-semibold">{candidateName}</div>
            {raceLabel && <div className="text-xs">{raceLabel}</div>}
          </div>
        </div>
      </header>

      <div className="civic-container py-8 max-w-3xl">
        <p className="text-sm text-[var(--color-text-secondary)] mb-2">
          Below is every <em>inferred</em> position vector Havesay
          currently publishes about you — the score we computed from a
          combination of public sources, votes, statements, and (where
          applicable) language-model synthesis. <strong>If anything is
          wrong, dispute it.</strong> A real person will review your
          dispute before any change ships to voters.
        </p>
        <p className="text-xs text-[var(--color-text-muted)] mb-6">
          What this is NOT: a place to edit your stated positions. To
          enter your own positions directly,{" "}
          <Link
            href={`/for-candidates/profile/${token}`}
            className="underline"
          >
            use the questionnaire
          </Link>
          .
        </p>

        {positions.length === 0 ? (
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-6 text-center">
            <p className="text-sm text-[var(--color-text-secondary)]">
              We don&apos;t currently publish any inferred positions for you.
            </p>
            <p className="text-xs text-[var(--color-text-muted)] mt-1">
              Nothing to dispute. If you believe we&apos;ve published
              something about you elsewhere, email{" "}
              <a
                href="mailto:legal@example.org"
                className="underline"
              >
                legal@example.org
              </a>
              .
            </p>
          </div>
        ) : (
          <DisputesList
            token={token}
            positions={positions.map((p) => ({
              id: p.id as string,
              sub_dimension_id: p.sub_dimension_id as string,
              score: p.score as number,
              confidence: (p.confidence as string) ?? "low",
              view_type: (p.view_type as string) ?? "inferred",
              source_citations:
                (p.source_citations as Array<{ url: string; title: string; date?: string }>) ??
                [],
              ai_summary: (p.ai_summary as string | null) ?? null,
              created_at: p.created_at as string,
            }))}
            subDims={subDims}
            existingDisputes={existingDisputes}
          />
        )}
      </div>
    </main>
  );
}
