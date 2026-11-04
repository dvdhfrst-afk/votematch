import type { Metadata } from "next";
import LegalPage from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Support",
  description:
    "Help keep Havesay free for voters in every state, every race, every cycle.",
};

const EFFECTIVE_DATE = "May 1, 2026";

const SUPPORT_LINK =
  process.env.NEXT_PUBLIC_STRIPE_SUPPORT_LINK ?? "/support";

export default function SupportPage() {
  return (
    <LegalPage
      title="Support Havesay"
      effectiveDate={EFFECTIVE_DATE}
      intro={
        <p>
          Havesay is free for every voter, in every state, for every race
          on the ballot. We keep it that way because civic infrastructure
          shouldn&apos;t come with a paywall. If you&apos;d like to chip in, we
          use your support for the boring-but-load-bearing work that makes the
          tool function across all 50 states.
        </p>
      }
    >
      <p>
        <a
          href={SUPPORT_LINK}
          className="inline-block rounded-md bg-[var(--color-primary)] px-5 py-3 text-base font-medium text-white no-underline hover:opacity-90"
        >
          Back us, pick an amount
        </a>
      </p>

      <h2>What your support funds</h2>
      <p>
        Address validation across all 50 states (plus DC and territories) is not
        free. Every state has different precinct boundaries, geocoders,
        shapefiles, and update cadences. Your support funds the Census-TIGER and
        per-state shapefile pipeline, the geocoding tier, the ingestion
        infrastructure that pulls candidate data from hundreds of sources, and
        the hosting that lets every voter look up every race on their ballot.
      </p>
      <p>
        It is not the AI bit. It is the boring bit. The boring bit has to work
        in every state on the same day.
      </p>

      <h2>A note on tax-deductibility</h2>
      <p>
        Havesay is a Delaware Public Benefit Corporation, not a 501(c)(3)
        charity. <strong>Your support is not tax-deductible.</strong> We
        don&apos;t want to pretend otherwise; Stripe&apos;s terms of service
        don&apos;t allow us to imply deductibility, and you deserve a straight
        answer. If a fiscal-sponsorship arrangement comes through that would
        change this, we&apos;ll update this page and tell anyone who supported
        us before that.
      </p>

      <h2>Where most of our funding actually comes from</h2>
      <p>
        Most of what keeps the tool running comes from B2B candidate dashboards
        (campaigns paying for aggregated issue-priority data from their own
        district, sold to any candidate, any party, at the same price). Not from
        individual support pages. This page is here for the people who want it
        anyway.
      </p>

      <h2>Other ways to help</h2>
      <ul>
        <li>
          <strong>Subscribe to the newsletter.</strong> The build is documented
          in public, race spotlights and methodology updates land weekly. (Link
          on the front page.)
        </li>
        <li>
          <strong>Send Havesay to a candidate you know.</strong> Every
          candidate who completes our questionnaire gets a free embeddable badge
          and helps make their race more transparent for voters.
        </li>
        <li>
          <strong>Send a correction.</strong> Profile errors are real. The form
          is at <a href="/corrections">/corrections</a>; we publish corrections
          within five business days.
        </li>
      </ul>
    </LegalPage>
  );
}
