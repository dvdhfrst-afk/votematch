import SubscribeCTA from "@/components/retention/SubscribeCTA";

export const metadata = {
  title: "Stay informed",
  description:
    "Monthly civic digest: federal votes, public-comment windows, and election reminders. No daily pings.",
};

export default function SubscribePage() {
  return (
    <main className="min-h-screen bg-[var(--color-bg)] py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <header className="text-center mb-8">
          <a
            href="/"
            className="text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            ← Back to Havesay
          </a>
          <h1 className="text-3xl sm:text-4xl font-semibold text-[var(--color-text)] mt-4">
            Stay informed between elections
          </h1>
          <p className="text-[var(--color-text-secondary)] mt-3 max-w-md mx-auto">
            One concise civic digest a month. Federal votes on issues you care about,
            public-comment windows, upcoming elections, nothing else.
          </p>
        </header>

        <SubscribeCTA />

        <section className="mt-12 space-y-4 text-sm text-[var(--color-text-secondary)]">
          <h2 className="font-semibold text-[var(--color-text)]">How this works</h2>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              You pick your state and up to five issues. We personalize from there.
            </li>
            <li>
              Each digest summarizes what&apos;s moved in the last period on the issues
              you flagged: federal votes, public-comment windows, state rulemakings,
              ballot measures, municipal meetings (where data is available).
            </li>
            <li>
              Every claim links to its original source. See{" "}
              <a href="/corrections" className="underline">corrections</a> if you spot an error.
            </li>
            <li>
              One-click unsubscribe in every email. The link never expires.
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}
