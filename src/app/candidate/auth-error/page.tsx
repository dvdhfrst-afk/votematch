import Link from "next/link";

/**
 * Candidate auth error page. The /api/questionnaire/verify endpoint
 * redirects here when the magic-link token is missing/invalid/mismatched.
 */
export default async function CandidateAuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const code = params.error ?? "unknown";

  const messages: Record<string, { title: string; body: string }> = {
    no_session: {
      title: "Your session isn't active",
      body: "You need to click the magic link from your invitation email to start or edit your questionnaire. If you don't have one, please check with the Havesay team.",
    },
    "Token expired": {
      title: "This link has expired",
      body: "Magic links are valid for 7 days. Request a new invitation and we'll send a fresh link to your filing email.",
    },
    "Invalid signature": {
      title: "This link is invalid",
      body: "The link you used couldn't be verified. If you copied it from an email, try clicking directly rather than copy-paste. Otherwise, request a new invitation.",
    },
    "Malformed token": {
      title: "This link is malformed",
      body: "The link doesn't parse correctly. Request a new invitation — the team will send a fresh one.",
    },
    candidate_mismatch: {
      title: "Link doesn't match this candidate",
      body: "The magic link was issued for a different candidate than the page you're trying to access. Use the original link from your email.",
    },
    candidate_not_found: {
      title: "Candidate not found",
      body: "The candidate profile this link points to doesn't exist in our database. This usually means the candidate was removed or the link is from an old cycle.",
    },
  };

  const m = messages[code] ?? {
    title: "Something went wrong",
    body: `We couldn't verify your session (error: ${code}). Please request a new invitation.`,
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-[var(--color-bg-alt)]">
      <div className="max-w-md w-full civic-card">
        <h1 className="text-2xl font-bold text-[var(--color-primary)] mb-3">
          {m.title}
        </h1>
        <p className="text-[var(--color-text-secondary)] mb-6">{m.body}</p>
        <div className="flex flex-col gap-3">
          <a
            href="mailto:hello@example.org?subject=New%20candidate%20questionnaire%20link"
            className="civic-btn-primary text-center"
          >
            Request a new invitation
          </a>
          <Link
            href="/"
            className="text-sm text-center text-[var(--color-primary)] hover:underline"
          >
            Back to Havesay
          </Link>
        </div>
      </div>
    </main>
  );
}
