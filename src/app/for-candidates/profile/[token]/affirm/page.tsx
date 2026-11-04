import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveForCandidatesToken } from "@/lib/for-candidates/session";
import { loadPortalSubject } from "@/lib/for-candidates/subject";
import AffirmForm from "./AffirmForm";

export default async function AffirmPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveForCandidatesToken(token);

  if (!resolved.ok) {
    return <Unavailable message={resolved.error} />;
  }
  if (resolved.target.kind === "pending_claim") {
    return (
      <Unavailable
        message="Affirmation is disabled while we verify your candidacy. Save your draft and we'll email you when it's ready."
        backHref={`/for-candidates/profile/${token}`}
      />
    );
  }

  const supabase = await createServiceClient();
  const subject = await loadPortalSubject(supabase, resolved.target);
  if (!subject) {
    return <Unavailable message="Candidate record not found." />;
  }

  // Surface answer count from the most recent draft so the candidate knows
  // what they're affirming. Keyed by whichever identity owns the draft.
  const draftSel = supabase
    .from("questionnaire_responses")
    .select("response_data, attested_at, submitted_at")
    .order("submitted_at", { ascending: false })
    .limit(1);
  const { data: latest } = await (subject.candidacyId
    ? draftSel.eq("candidacy_id", subject.candidacyId)
    : draftSel.eq("candidate_id", subject.candidateId!)
  ).maybeSingle();

  const responseData = (latest?.response_data ?? {}) as Record<
    string,
    { score?: number | null }
  >;
  const answeredCount = Object.values(responseData).filter(
    (r) => typeof r.score === "number",
  ).length;
  const hasDraft = answeredCount > 0;

  const candName = subject.name;
  const raceLabel = subject.raceLabel;
  const hasPhotoOnFile = Boolean(subject.photoUrl);
  const today = new Date().toISOString().slice(0, 10);

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
          <Link
            href={`/for-candidates/profile/${token}`}
            className="text-sm text-[var(--color-text-secondary)] underline"
          >
            ← Back to editor
          </Link>
        </div>
      </header>

      <div className="civic-container py-8">
        <div className="max-w-xl mx-auto">
          <h1 className="text-2xl sm:text-3xl font-bold text-[var(--color-primary)] mb-2">
            Affirm and publish
          </h1>
          <p className="text-[var(--color-text-secondary)] mb-6">
            Last step. After you affirm, your {answeredCount}{" "}
            {answeredCount === 1 ? "position is" : "positions are"} published
            on your public profile with your name attached.
          </p>

          {!hasDraft ? (
            <div className="civic-card border-amber-300 bg-amber-50">
              <p className="text-amber-900 text-sm font-semibold mb-2">
                No draft to affirm
              </p>
              <p className="text-amber-900 text-sm">
                Go back, set at least one position, and click{" "}
                <em>Save draft to server</em> before returning here.
              </p>
              <Link
                href={`/for-candidates/profile/${token}`}
                className="civic-btn-primary inline-block mt-4 px-5 py-2"
              >
                Back to editor
              </Link>
            </div>
          ) : (
            <div className="civic-card">
              <p className="text-[var(--color-text-secondary)] mb-4">
                I, <strong>{candName}</strong>, confirm these are my
                positions {raceLabel && <>for <em>{raceLabel}</em></>} as
                of <strong>{today}</strong>. I understand voters will see
                them on my Havesay profile with my name attached, and
                that they are recorded as a tier-1 primary source.
              </p>
              <AffirmForm
                token={token}
                expectedName={candName}
                answeredCount={answeredCount}
                hasPhotoOnFile={hasPhotoOnFile}
              />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function Unavailable({
  message,
  backHref,
}: {
  message: string;
  backHref?: string;
}) {
  return (
    <main className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white border border-[var(--color-border)] rounded-xl p-6 text-center">
        <h1 className="text-2xl font-bold text-[var(--color-primary)] mb-3">
          Affirmation unavailable
        </h1>
        <p className="text-[var(--color-text-secondary)] mb-5">{message}</p>
        <Link
          href={backHref ?? "/for-candidates"}
          className="civic-btn-primary inline-block px-6 py-2"
        >
          {backHref ? "Back to editor" : "Get a fresh link"}
        </Link>
      </div>
    </main>
  );
}
