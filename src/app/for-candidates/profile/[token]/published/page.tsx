import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { resolveForCandidatesToken } from "@/lib/for-candidates/session";
import { loadPortalSubject } from "@/lib/for-candidates/subject";

export default async function PublishedPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveForCandidatesToken(token);

  if (!resolved.ok || resolved.target.kind === "pending_claim") {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white border border-[var(--color-border)] rounded-xl p-6 text-center">
          <h1 className="text-2xl font-bold text-[var(--color-primary)] mb-3">
            Published
          </h1>
          <p className="text-[var(--color-text-secondary)] mb-5">
            Your positions are live, but we couldn&apos;t look up the public
            link from this page. Check your candidate profile from the main
            site.
          </p>
          <Link
            href="/for-candidates"
            className="civic-btn-primary inline-block px-6 py-2"
          >
            Back to Havesay
          </Link>
        </div>
      </main>
    );
  }

  const supabase = await createServiceClient();
  const subject = await loadPortalSubject(supabase, resolved.target);

  // Count the stated positions we just published, keyed by the owning identity.
  const countSel = supabase
    .from("positions")
    .select("id", { count: "exact", head: true })
    .eq("view_type", "stated")
    .eq("confidence", "candidate_direct");
  const { count: positionCount } = subject?.candidacyId
    ? await countSel.eq("person_id", subject.personId!)
    : subject?.candidateId
      ? await countSel.eq("candidate_id", subject.candidateId)
      : { count: 0 };

  const candidateName = subject?.name || "candidate";
  const profileUrl = subject?.publicProfileId
    ? `/candidate/${subject.publicProfileId}`
    : "/for-candidates";
  const raceLabel = subject?.raceLabel ?? null;

  return (
    <main className="min-h-screen bg-[var(--color-bg-alt)]">
      <header className="bg-white border-b border-[var(--color-border)]">
        <div className="civic-container py-4">
          <Link
            href="/"
            className="text-xl font-bold text-[var(--color-primary)]"
          >
            Havesay
          </Link>
        </div>
      </header>

      <div className="civic-container py-12">
        <div className="max-w-xl mx-auto text-center">
          <h1 className="text-3xl sm:text-4xl font-extrabold text-emerald-700 mb-3">
            You&apos;re published
          </h1>
          <p className="text-[var(--color-text-secondary)] mb-6">
            Thanks, {candidateName}. Your{" "}
            {positionCount ?? 0}{" "}
            {positionCount === 1 ? "position is" : "positions are"} live on
            your Havesay profile{raceLabel && (
              <>
                {" "}
                for <em>{raceLabel}</em>
              </>
            )}
            . Voters comparing positions on these issues will see what you
            stand for, in your own words.
          </p>

          <div className="civic-card text-left mb-6">
            <h2 className="font-semibold text-[var(--color-text)] mb-2">
              Next steps
            </h2>
            <ul className="text-sm text-[var(--color-text-secondary)] space-y-2 list-disc pl-5">
              <li>
                Open your public profile and check it looks the way you
                expected.
              </li>
              <li>
                Share the link on your campaign site or in voter
                communications.
              </li>
              <li>
                Spot something off? Use{" "}
                <Link href="/corrections" className="underline">
                  /corrections
                </Link>{" "}
                or request a fresh sign-in link from /for-candidates to
                revise.
              </li>
            </ul>
          </div>

          <Link
            href={profileUrl}
            className="civic-btn-primary inline-block px-8 py-3 text-base"
          >
            View my public profile
          </Link>
        </div>
      </div>
    </main>
  );
}
