import Link from "next/link";
import ClaimForm from "./ClaimForm";

export const metadata = {
  title: "For candidates",
  description:
    "Are you on a 2026 ballot? Claim your profile on Havesay and tell voters where you stand, directly, in your own words.",
};

export default function ForCandidatesLanding() {
  return (
    <main className="min-h-screen bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] bg-white">
        <div className="civic-container py-4 flex items-center justify-between">
          <Link
            href="/"
            className="text-xl font-bold text-[var(--color-primary)]"
          >
            Havesay
          </Link>
          <span className="text-sm text-[var(--color-text-muted)]">
            For candidates
          </span>
        </div>
      </header>

      <section className="civic-container py-14 sm:py-20">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-3xl sm:text-5xl font-extrabold text-[var(--color-primary)] mb-4 leading-tight">
            Are you a candidate on a 2026 ballot?
          </h1>
          <p className="text-lg sm:text-xl text-[var(--color-text-secondary)] mb-10">
            Help voters understand your positions. Claim your profile, place
            yourself on 19 issues, and link the sources you stand by, all in
            under 30 minutes.
          </p>

          <div className="bg-white border border-[var(--color-border)] rounded-2xl p-6 sm:p-8 shadow-sm text-left">
            <ClaimForm />
          </div>

          <p className="text-xs text-[var(--color-text-muted)] mt-4">
            Free. No fees, no upsells, no political ads, ever.
          </p>
        </div>
      </section>

      <section className="civic-container pb-20">
        <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6">
          <ValueProp
            num={1}
            title="Voters compare positions, not slogans"
            body="We ask voters 19 questions about where they stand. Then we match them to candidates whose positions line up. If your stated positions are missing, voters see a guess based on press coverage. Claim your profile to make sure they see the real thing."
          />
          <ValueProp
            num={2}
            title="Free. No fees. No ads."
            body="Havesay is voter-funded and nonpartisan. We don't sell candidate features, run political ads, or take money from campaigns. The portal is free this cycle, and forever."
          />
          <ValueProp
            num={3}
            title="Direct attestation = highest source tier"
            body="Anything you submit through the portal is recorded as a tier-1 primary source, the same authority as a personal speech or campaign-website statement. No journalist or AI is interpreting your words."
          />
        </div>
      </section>

      <footer className="border-t border-[var(--color-border)] bg-[var(--color-bg-alt)]">
        <div className="civic-container py-8 text-center text-sm text-[var(--color-text-secondary)] space-x-4">
          <Link href="/methodology" className="underline">
            Methodology
          </Link>
          <Link href="/corrections" className="underline">
            Corrections
          </Link>
          <Link href="/privacy" className="underline">
            Privacy
          </Link>
        </div>
      </footer>
    </main>
  );
}

function ValueProp({
  num,
  title,
  body,
}: {
  num: number;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-white border border-[var(--color-border)] rounded-xl p-5">
      <div className="text-xs font-mono text-[var(--color-text-muted)] mb-2">
        {String(num).padStart(2, "0")}
      </div>
      <h3 className="text-base font-bold text-[var(--color-text)] mb-2">
        {title}
      </h3>
      <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
        {body}
      </p>
    </div>
  );
}
