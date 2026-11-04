import type { Metadata } from "next";
import LegalPage from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Thank you",
  description:
    "Thanks for supporting Havesay. A note on what we do with this money.",
};

const EFFECTIVE_DATE = "May 1, 2026";

export default function ThanksPage() {
  return (
    <LegalPage
      title="Thank you."
      effectiveDate={EFFECTIVE_DATE}
      intro={
        <p>
          Your support helps keep Havesay free for voters in every state.
          The receipt is in your email. Note that it is{" "}
          <strong>not</strong> a tax-deductible donation receipt. Havesay
          is a Public Benefit Corporation, not a 501(c)(3) charity.
        </p>
      }
    >
      <h2>What this funds</h2>
      <p>
        Address validation, ingestion infrastructure, hosting, and the
        long-tail per-state shapefile work that nobody wants to fund but every
        voter relies on. Once we publish the v1 transparency page, you&apos;ll
        be able to see the line items if you want.
      </p>

      <h2>Want to do more?</h2>
      <p>
        Forwarding the newsletter to one person who cares about voting is worth
        more than any single donation. The build is documented in public; the
        link to subscribe is on the front page.
      </p>

      <p>
        <a
          href="/"
          className="inline-block rounded-md bg-[var(--color-primary)] px-5 py-3 text-base font-medium text-white no-underline hover:opacity-90"
        >
          ← Back to ballotbridge.org
        </a>
      </p>
    </LegalPage>
  );
}
