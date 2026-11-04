import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveForCandidatesToken } from "@/lib/for-candidates/session";
import { loadPortalSubject } from "@/lib/for-candidates/subject";
import ProfileEditor from "./ProfileEditor";
import FoundOnlineSection, { type FoundPosition } from "./FoundOnlineSection";

/**
 * /for-candidates/profile/[token]
 *
 * Magic-link landing for the candidate self-service portal. Validates the
 * token, resolves the target (real candidate vs. pending claim), loads the
 * 19 sub-dimensions and any prior questionnaire response, and renders the
 * editor.
 */
export default async function ForCandidatesProfilePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveForCandidatesToken(token);

  if (!resolved.ok) {
    return (
      <TokenError
        message={
          resolved.status === 410
            ? "This sign-in link has expired. Request a fresh one from /for-candidates."
            : resolved.error
        }
      />
    );
  }

  const supabase = await createServiceClient();

  // Load the 19 sub-dimensions (active, sorted for stable display).
  const { data: subDimsRaw, error: sdErr } = await supabase
    .from("sub_dimensions")
    .select("id, domain, name, spectrum_low, spectrum_high, display_order")
    .order("domain")
    .order("display_order");

  if (sdErr || !subDimsRaw) {
    console.error("[profile] sub_dimensions fetch failed:", sdErr);
    return <TokenError message="Could not load the question set. Please try again later." />;
  }

  const subDims = subDimsRaw.map((sd) => ({
    id: sd.id as string,
    domain: (sd.domain as string) ?? "other",
    name: (sd.name as string) ?? "",
    spectrum_low: (sd.spectrum_low as string) ?? "",
    spectrum_high: (sd.spectrum_high as string) ?? "",
  }));

  // Normalize the target into one subject (legacy candidate, office-graph
  // candidacy, or pending claim) so the rest of the page is identity-agnostic.
  const subject = await loadPortalSubject(supabase, resolved.target);
  if (!subject) {
    return (
      <TokenError message="Your candidate record could not be found. Contact support@example.org." />
    );
  }

  const candidateId = subject.candidateId;
  const candidacyId = subject.candidacyId;
  const candidateName = subject.name;
  const raceLabel = subject.raceLabel;
  const isPending = subject.isPending;

  // Pre-fill from the most recent questionnaire_responses row, if any. Keyed by
  // whichever identity owns the draft (candidacy_id for office-graph,
  // candidate_id for legacy). Pending claims have no server-side draft.
  let priorResponses: Record<
    string,
    { score?: number | null; explanation?: string; citation?: string }
  > = {};
  if (!isPending && (candidacyId || candidateId)) {
    const draftSel = supabase
      .from("questionnaire_responses")
      .select("response_data")
      .order("submitted_at", { ascending: false })
      .limit(1);
    const { data: prior } = await (candidacyId
      ? draftSel.eq("candidacy_id", candidacyId)
      : draftSel.eq("candidate_id", candidateId!)
    ).maybeSingle();
    if (prior?.response_data && typeof prior.response_data === "object") {
      priorResponses = prior.response_data as Record<
        string,
        { score?: number | null; explanation?: string; citation?: string }
      >;
    }
  }

  // Inferred positions we have derived about this candidate from public
  // sources, for the read-only "What we found online about you" section.
  // Keying mirrors the disputes page: office-graph candidacies read by
  // person_id, legacy candidates by candidate_id. Pending claims have no
  // subject row yet, so they get an empty list (and the empty-state nudge).
  let foundPositions: FoundPosition[] = [];
  if (!isPending) {
    const isCandidacy = subject.kind === "candidacy";
    const foundSel = supabase
      .from("positions")
      .select(
        "id, sub_dimension_id, score, confidence, view_type, source_tier, source_citations, ai_summary, created_at",
      )
      .eq("view_type", "inferred")
      .order("created_at", { ascending: false });
    const { data: foundRaw } =
      isCandidacy && subject.personId
        ? await foundSel.eq("person_id", subject.personId)
        : isCandidacy
          ? { data: [] }
          : candidateId
            ? await foundSel.eq("candidate_id", candidateId)
            : { data: [] };
    foundPositions = (foundRaw ?? []).map((p) => ({
      id: p.id as string,
      sub_dimension_id: p.sub_dimension_id as string,
      score: (p.score as number) ?? 0,
      confidence: (p.confidence as string) ?? "low",
      source_tier: (p.source_tier as string | null) ?? null,
      source_citations:
        (p.source_citations as Array<{
          url?: string;
          title?: string;
          quote?: string | null;
        }>) ?? [],
      ai_summary: (p.ai_summary as string | null) ?? null,
    }));
  }

  // Count potential identity-claim candidates so we can decide whether to
  // surface the "we found N other candidates with your name" CTA. We use a
  // cheap two-step count (people-graph + name fallback). The /related page
  // does the full hydration; here we only need a number.
  //
  // Identity-merge is still legacy-`candidates`-keyed, so this only runs for
  // legacy candidate targets (candidateId set). Office-graph candidacies
  // (candidateId null) consolidate at the people level — person-based merge is
  // a Brief A follow-up (see PORTALS-PLAN deferred list).
  let relatedCount = 0;
  if (candidateId && !isPending) {
    try {
      const { data: ownPeopleRaw } = await supabase
        .from("people")
        .select("id, canonical_key")
        .contains("legacy_candidate_ids", [candidateId]);
      const sharedKeys = [
        ...new Set(
          (ownPeopleRaw ?? [])
            .map((p) => p.canonical_key as string | null)
            .filter((k): k is string => Boolean(k)),
        ),
      ];
      const candIdSet = new Set<string>();
      if (sharedKeys.length > 0) {
        const { data: siblingPeople } = await supabase
          .from("people")
          .select("legacy_candidate_ids")
          .in("canonical_key", sharedKeys);
        for (const p of siblingPeople ?? []) {
          for (const id of (p.legacy_candidate_ids ?? []) as string[]) {
            if (id !== candidateId) candIdSet.add(id);
          }
        }
      }
      const { data: nameMatches } = await supabase
        .from("candidates")
        .select("id")
        .ilike("name", candidateName)
        .neq("id", candidateId)
        .limit(50);
      for (const c of nameMatches ?? []) candIdSet.add(c.id as string);

      // Subtract anything already dismissed/merged so the count reflects
      // actionable suggestions only.
      if (candIdSet.size > 0) {
        const { data: existingClaims } = await supabase
          .from("candidate_identity_claims")
          .select("claimed_candidate_id, status")
          .eq("primary_candidate_id", candidateId)
          .in("claimed_candidate_id", [...candIdSet]);
        for (const cl of existingClaims ?? []) {
          if (
            cl.status === "dismissed" ||
            cl.status === "rejected"
          ) {
            candIdSet.delete(cl.claimed_candidate_id as string);
          }
        }
      }
      relatedCount = candIdSet.size;
    } catch (e) {
      console.warn("[profile] related count probe failed:", e);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--color-bg-alt)]">
      <header className="bg-white border-b border-[var(--color-border)]">
        <div className="civic-container py-4 flex items-center justify-between">
          <Link
            href="/"
            className="text-xl font-bold text-[var(--color-primary)]"
          >
            Havesay
          </Link>
          <span className="text-sm text-[var(--color-text-muted)]">
            Candidate portal
          </span>
        </div>
      </header>

      <div className="civic-container py-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-extrabold text-[var(--color-primary)] mb-1">
            {candidateName || "Your candidate profile"}
          </h1>
          {raceLabel && (
            <p className="text-[var(--color-text-secondary)] mb-2">
              {raceLabel}
            </p>
          )}

          {isPending && (
            <div
              role="status"
              className="my-5 p-4 rounded-lg border border-amber-300 bg-amber-50 text-sm text-amber-900"
            >
              <p className="font-semibold mb-1">Claim pending verification</p>
              <p>
                We didn&apos;t find an existing candidacy for this email. Your
                positions will save as a draft, but won&apos;t be public until a
                Havesay volunteer verifies your candidacy. We&apos;ll
                email you when that&apos;s done.
              </p>
            </div>
          )}

          {relatedCount > 0 && (
            <div className="civic-card mb-4 border-[var(--color-primary)] bg-[var(--color-primary-tint,#eef4ff)]">
              <h2 className="font-semibold text-[var(--color-text)] mb-1">
                We found {relatedCount} other candidate
                {relatedCount === 1 ? "" : "s"} with your name
              </h2>
              <p className="text-sm text-[var(--color-text-secondary)] mb-3">
                These could be prior candidacies of yours, or different
                people who happen to share your name. Tell us which are
                also you so voters see one consolidated profile.
              </p>
              <Link
                href={`/for-candidates/profile/${token}/related`}
                className="civic-btn-primary inline-block px-4 py-2 text-sm"
              >
                Review {relatedCount} match
                {relatedCount === 1 ? "" : "es"}
              </Link>
            </div>
          )}

          <div className="civic-card mb-6">
            <h2 className="font-semibold text-[var(--color-text)] mb-2">
              How this works
            </h2>
            <ul className="text-sm text-[var(--color-text-secondary)] space-y-1.5 list-disc pl-5">
              <li>
                Place yourself on the spectrum for each of the 19 issues.
                Skip any that don&apos;t apply.
              </li>
              <li>
                Add a short explanation (~200 chars) and an optional URL to
                back up each position. Citations boost your tier-1 score.
              </li>
              <li>
                Save your draft as you go — it stays in your browser. When
                ready, hit <strong>Affirm and publish</strong> on the next
                step to publish.
              </li>
            </ul>
          </div>

          {/* Read-only "What we found online about you": informational
              view of AI-inferred positions with source citations. Not the
              counsel-gated dispute flow. Shown for real subjects only;
              pending claims have no subject row to read positions for. */}
          {!isPending && (
            <FoundOnlineSection
              positions={foundPositions}
              subDims={subDims}
            />
          )}

          {/* Right-of-reply entry point — candidates whose inferred positions
              we publish can dispute specific dimensions via this flow.
              Disabled for pending claims (no candidate row yet to attach
              disputes to). See notes/ballot-bridge-execution-order.md
              Week 3 item 12. */}
          {!isPending && (
            <div className="civic-card mb-6 border-l-4 border-amber-300">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex-1 min-w-0">
                  <h2 className="font-semibold text-[var(--color-text)] mb-1">
                    Disagree with something we published about you?
                  </h2>
                  <p className="text-sm text-[var(--color-text-secondary)]">
                    If we&apos;ve inferred a position from your record that
                    doesn&apos;t match what you actually believe, file a
                    dispute. A reviewer looks at every dispute before any
                    voter-visible change ships.
                  </p>
                </div>
                <Link
                  href={`/for-candidates/profile/${token}/disputes`}
                  className="civic-btn-secondary inline-block px-4 py-2 text-sm whitespace-nowrap"
                >
                  Right of reply
                </Link>
              </div>
            </div>
          )}

          <ProfileEditor
            token={token}
            candidateId={candidateId}
            candidacyId={candidacyId}
            pendingClaimId={subject.pendingClaimId}
            candidateName={candidateName}
            subDims={subDims}
            priorResponses={priorResponses}
            isPending={isPending}
          />
        </div>
      </div>
    </main>
  );
}

function TokenError({ message }: { message: string }) {
  return (
    <main className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white border border-[var(--color-border)] rounded-xl p-6 text-center">
        <h1 className="text-2xl font-bold text-[var(--color-primary)] mb-3">
          Sign-in link unavailable
        </h1>
        <p className="text-[var(--color-text-secondary)] mb-5">{message}</p>
        <Link
          href="/for-candidates"
          className="civic-btn-primary inline-block px-6 py-2"
        >
          Get a fresh link
        </Link>
      </div>
    </main>
  );
}
