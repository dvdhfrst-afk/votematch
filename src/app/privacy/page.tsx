import type { Metadata } from "next";
import LegalPage from "@/components/legal/LegalPage";
import DeviceDataControls from "@/components/device/DeviceDataControls";
import PoolOptIn from "@/components/device/PoolOptIn";
import { isSignalPoolEnabled } from "@/lib/signal-pool/flag";
import { resolveCoarseGeography } from "@/lib/signal-pool/geography";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Havesay collects, stores, and handles the information you give us. Plain language; drafted for counsel review.",
};

// REVIEW: operator — confirm effective date before public launch.
const EFFECTIVE_DATE = "April 20, 2026";

export default async function PrivacyPage() {
  // Signal pool (Phase 3B, part 2): resolve coarse geography server-side ONLY
  // when the flag is on. The PoolOptIn control self-gates on the flag and renders
  // null otherwise, so nothing below appears until the operator flips the flag.
  const poolGeography = isSignalPoolEnabled() ? await resolveCoarseGeography() : null;
  const showPool = isSignalPoolEnabled();

  return (
    <LegalPage
      title="Privacy Policy"
      effectiveDate={EFFECTIVE_DATE}
      intro={
        <p>
          This policy describes what Havesay collects, why, and what you
          can do about it. We try to keep the site useful with the least data
          we can. If anything here is unclear, write to us and we will fix the
          wording.
        </p>
      }
    >
      <h2>1. Who we are</h2>
      <p>
        Havesay is a nonpartisan civic-research project that matches
        voters across all 50 U.S. states (plus DC and the territories) to
        candidates on their actual ballot. We are a Public Benefit Corporation
        in formation (Delaware){" "}
        {/* REVIEW: operator — confirm final entity name and state of incorporation */}
        with operations based in the United States.
      </p>

      <h2>2. What we collect</h2>
      <ul>
        <li>
          <strong>Address</strong> you enter for ballot lookup. We send it to
          the U.S. Census Geocoder (and, as a fallback, OpenStreetMap
          Nominatim) to find your precinct, then we discard the raw text once
          the lookup completes. We keep a salted hash of normalized addresses
          in a <code>geocode_cache</code> table so we do not re-query the same
          address unnecessarily.
        </li>
        <li>
          <strong>Quick-match answers.</strong> The onboarding questions and any
          follow-up answers you provide. These express political preferences, so
          we treat them as Sensitive Personal Information (see section 6).{" "}
          <strong>
            Your answers are saved only on your device and never sent to our
            servers.
          </strong>{" "}
          Matching runs on your device against public candidate data; we never
          receive what you answered.
        </li>
        <li>
          <strong>Session token.</strong> An opaque random identifier stored in
          an httpOnly cookie so we can remember your answers and your ballot
          between pages without asking you to sign in.
        </li>
        <li>
          <strong>Optional subscription data.</strong> If you opt in to email
          updates we store your email address, your state, and the interest
          tags you selected. That is it, no name required.
        </li>
        <li>
          <strong>Analytics events</strong> via PostHog (page views, quick-match
          completion, booth checklist opened). We have disabled session recording and we
          do not collect IP addresses beyond what is needed to geolocate
          traffic at the country level.
        </li>
        <li>
          <strong>Error reports</strong> via Sentry when the site fails. These
          contain stack traces and a request path, not form contents.
        </li>
        <li>
          <strong>Feedback you send us.</strong> If you use the feedback modal
          or email us, we keep what you write so we can respond.
        </li>
      </ul>

      <h2>3. Where it lives</h2>
      <p>
        Application data is stored in Supabase (a managed PostgreSQL service)
        in a <strong>US region</strong>. Storage and compute for our snapshot
        archive are in the same region. We do not sell or rent any of this
        data.
      </p>

      <h2>4. How long we keep it</h2>
      <ul>
        <li>
          <strong>Session-scoped data</strong> (cookie, unsaved quick-match
          answers, transient ballot lookup) is cleared when your session ends
          unless you subscribe. Inactive anonymous sessions are purged on a
          rolling basis.{" "}
          {/* REVIEW: operator — confirm the exact dormant-session purge window (blueprint-v6 suggests 30 days). */}
        </li>
        <li>
          <strong>Subscribed emails and interest tags</strong> are kept until
          you unsubscribe. Unsubscribing removes you from the send list
          immediately; your record is retained only long enough to honor the
          unsubscribe and is then deleted.{" "}
          {/* REVIEW: operator — confirm retention window post-unsubscribe for compliance (e.g., 30 days). */}
        </li>
        <li>
          <strong>Geocode cache hashes</strong> are stored as a salted hash of
          the normalized address plus the resolved precinct. They are
          retained for approximately{" "}
          <em>
            [REVIEW: operator, confirm specific retention window, e.g., 180 days]
          </em>{" "}
          {/* REVIEW: operator — pick a specific day count for geocode_cache retention */}
          so repeat lookups are fast, then deleted.
        </li>
        <li>
          <strong>Analytics and error logs</strong> follow PostHog and Sentry
          defaults (typically 90 days){" "}
          {/* REVIEW: operator — confirm exact PostHog + Sentry retention windows selected in dashboards */}
          and are not used to build user profiles.
        </li>
      </ul>

      <h2>5. Sub-processors</h2>
      <p>
        We use these vendors to run the site. Each only receives the data it
        needs to do its job:
      </p>
      <ul>
        <li>
          <strong>Supabase</strong>: PostgreSQL database, authentication
          infrastructure, object storage for our source-snapshot archive. US
          region.
        </li>
        <li>
          <strong>Anthropic (Claude Batch API)</strong>: batch
          classification and summarization of candidate-authored public
          material. We do not send your personal data to Claude. Your
          quick-match answers are compared to pre-computed candidate position
          vectors on our own servers; the match math does not call any LLM.
        </li>
        <li>
          <strong>Resend</strong>: transactional and digest email (only
          if you subscribe).
        </li>
        <li>
          <strong>PostHog</strong>: product analytics.
        </li>
        <li>
          <strong>Sentry</strong>: error monitoring.
        </li>
        <li>
          <strong>Vercel</strong>: hosting and edge routing.
        </li>
      </ul>

      <h2>6. Political preferences as Sensitive Personal Information</h2>
      <p>
        Your quick-match answers reveal political views. We treat them as
        Sensitive Personal Information under U.S. state privacy laws (including
        the California, Colorado, Connecticut, Utah, Virginia, Texas, and
        similar statutes in additional states with consumer-privacy laws now in
        effect).{" "}
        {/* REVIEW: operator / counsel — current count of state-privacy-law states with SPI provisions changes frequently; confirm list with counsel before launch and on each annual review. As of May 2026 the working list includes CA, CO, CT, UT, VA, TX, OR, MT, TN, IA, IN, FL, DE, NJ, NH, KY, MD, MN, RI, NE — verify each. */}
        Specifically:
      </p>
      <ul>
        <li>You opt in before the first question.</li>
        <li>We never sell this data.</li>
        <li>We never share it with third parties for advertising.</li>
        <li>
          We never use it to train models. Claude&apos;s batch work runs on
          public candidate statements, not on you.
        </li>
        <li>
          It is saved only on your device. We do not store your quick-match
          answers on our servers. If you subscribe to email updates, the only
          thing we keep is your email plus the interest tags you pick, never your
          answers.
        </li>
      </ul>

      <h2>7. Your rights</h2>
      <p>
        Regardless of where you live, you can:
      </p>
      <ul>
        <li>
          <strong>Access</strong> what we have about you: email{" "}
          <a href="mailto:privacy@example.org">privacy@example.org</a>.{" "}
          {/* REVIEW: operator — confirm the contact email before publishing */}
        </li>
        <li>
          <strong>Correct</strong> factual errors about a candidate via the
          public <a href="/corrections">corrections log</a>; correct your own
          subscription data by emailing the address above.
        </li>
        <li>
          <strong>Delete</strong> your subscription and quick-match answers at
          any time by using the unsubscribe link in any email we send you, or
          by emailing{" "}
          <a href="mailto:privacy@example.org">privacy@example.org</a>.
        </li>
        <li>
          <strong>Port</strong> a copy of your quick-match answers yourself,
          right below, since they live on your device.
        </li>
      </ul>

      {/* On-device data controls (work-order 1B): export + erase the answers
          that live in this browser. Client component; server never sees them. */}
      <DeviceDataControls />

      {/* Signal pool opt-in (Phase 3B, part 2). Only shown when the feature flag
          is on. Off by default, so this whole block is skipped in production
          until the operator flips NEXT_PUBLIC_SIGNAL_POOL_ENABLED. */}
      {showPool && (
        <>
          <h2>7a. Contributing to the anonymous pool (optional)</h2>
          <p>
            Separately from your on-device answers, you can choose to add what you
            have told us to an encrypted, anonymous pool of what voters across the
            country are saying. This is entirely optional and off unless you turn
            it on. When you contribute:
          </p>
          <ul>
            <li>
              It travels without your name, your address, or anything that ties it
              back to you or this device.
            </li>
            <li>
              We coarsen every stance into one of five broad bands, so the pool
              never holds your exact answer, only the general direction.
            </li>
            <li>
              The most specific location it carries is your state and congressional
              district. Never your address or precinct.
            </li>
            <li>
              We add a small random delay before sending, so the timing cannot be
              tied back to when you answered.
            </li>
            <li>
              You can stop contributing, or remove your data from the pool, at any
              time. Removal takes effect at the next weekly rebuild of the published
              numbers, batched on purpose so a removal cannot be timed back to you.
            </li>
          </ul>
          <p>
            Before you turn it on, you can see the exact, literal data that would
            leave your device, annotated in plain language.
          </p>
          <PoolOptIn geography={poolGeography} />
        </>
      )}

      <h2>8. Cookies</h2>
      <ul>
        <li>
          <strong>Session cookie</strong> (httpOnly, SameSite=Lax): stores a
          random session token. Required to keep your quick-match state.
        </li>
        <li>
          <strong>Analytics cookie</strong> (PostHog): you can opt out from
          the banner or your browser&apos;s Do-Not-Track signal. We honor
          opt-outs.
        </li>
        <li>
          <strong>No advertising cookies.</strong> We do not run ads and do not
          share data with ad networks.
        </li>
      </ul>

      <h2>9. Children</h2>
      <p>
        Havesay is not directed at children under 13. We do not
        knowingly collect personal information from children under 13. If you
        believe we have, email{" "}
        <a href="mailto:privacy@example.org">privacy@example.org</a>{" "}
        and we will delete it.
      </p>

      <h2>10. Security</h2>
      <p>
        We use TLS in transit, PostgreSQL row-level security to isolate user
        data, and an <code>x-session-token</code> header rather than exposing
        long-lived credentials to the browser. No system is perfectly secure;
        we will notify affected users promptly if we discover a breach that
        impacts them.
      </p>

      <h2>11. Changes to this policy</h2>
      <p>
        If we change this policy materially, we will update the effective
        date, and, for subscribers, send a notice with a plain-English
        summary of what changed.
      </p>

      <h2>12. Contact</h2>
      <p>
        Email{" "}
        <a href="mailto:privacy@example.org">privacy@example.org</a>{" "}
        {/* REVIEW: operator — confirm this is the right inbox; add postal address if state law requires */}
        for any privacy question or request.
      </p>
    </LegalPage>
  );
}
