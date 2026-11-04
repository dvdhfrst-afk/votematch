import type { Metadata } from "next";
import LegalPage from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The rules of the road for using Havesay. Nonpartisan research, not voting advice.",
};

// REVIEW: operator — confirm effective date before public launch.
const EFFECTIVE_DATE = "April 20, 2026";

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      effectiveDate={EFFECTIVE_DATE}
      intro={
        <p>
          These terms explain what Havesay is, what it is not, and the
          expectations we have of each other when you use the site.
        </p>
      }
    >
      <h2>1. What Havesay is</h2>
      <p>
        Havesay is a <strong>nonpartisan research tool</strong>. We
        organize public information about candidates on your ballot and show
        you how their stated positions compare to yours. Matches are inputs to
        your deliberation, not voting recommendations, endorsements, or party
        instructions. We publish our methodology and matching algorithm
        openly.
      </p>

      <h2>2. Accuracy and your judgment</h2>
      <p>
        Candidates change their minds. Websites get updated. Paraphrases can
        drift. We work hard to keep the underlying sources current and to
        cite them with archived snapshots, but we do not guarantee that every
        position on the site is current or complete. If you see a mistake,
        tell us at <a href="/corrections">/corrections</a>; every
        correction is logged publicly.
      </p>
      <p>
        <strong>Use your own judgment before voting.</strong> Read the linked
        primary sources. Havesay is a starting point, not an answer.
      </p>

      <h2>3. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>
          Scrape, crawl, or mass-download the site at volume, or in a way that
          degrades service for other users. Researchers and civic
          organizations: email us and we will help you get the data you need
          in a sensible format.
        </li>
        <li>
          Automate account or session creation, submit malicious input, or
          attempt to interfere with the site&apos;s operation.
        </li>
        <li>
          Use the site to harass candidates or other users, or to impersonate
          anyone.
        </li>
        <li>
          Reverse-engineer or circumvent security controls.
        </li>
      </ul>

      <h2>4. Intellectual property</h2>
      <ul>
        <li>
          <strong>Our code.</strong> Our application code is (target)
          open-source under a permissive license.{" "}
          {/* REVIEW: operator — confirm final open-source license (MIT vs. Apache-2.0) and repo URL */}
          Until the repository is public, this is an expression of intent
          rather than a grant.
        </li>
        <li>
          <strong>Our content.</strong> Havesay&apos;s own written
          explanations, methodology notes, and original summaries are licensed
          CC-BY 4.0 for non-commercial civic use.{" "}
          {/* REVIEW: operator — confirm license choice (CC-BY vs. CC-BY-NC) for our own content */}
        </li>
        <li>
          <strong>Third-party content.</strong> Candidate websites, state
          filings, and news articles remain the property of their authors.
          Where we reproduce or paraphrase content covered by a share-alike
          license (for example Ballotpedia material under CC-BY-SA), we comply
          with that license; currently that means linking to the
          source and not ingesting the editorial prose. A future decision may
          authorize deeper ingestion of Ballotpedia material under CC-BY-SA
          terms; today we are verify-only.{" "}
          {/* REVIEW: operator — update if/when we change the Ballotpedia ingestion posture */}
        </li>
        <li>
          <strong>Your content.</strong> If you send us feedback or submit a
          correction, you grant us a non-exclusive license to use that content
          to improve the site and to publish your correction on the public
          log (we will use your name only if you provide it).
        </li>
      </ul>

      <h2>5. Disclaimers</h2>
      <p>
        Havesay is provided <strong>as is</strong>. We make honest
        limited warranties appropriate to a nonprofit civic-tech project: we
        will try to keep the site available and accurate, we will correct
        errors we are told about, and we will publish our methodology. We do
        not warrant that the site will be uninterrupted, error-free, or suited
        to any particular purpose beyond the research purpose described here.
      </p>

      <h2>6. Limitation of liability</h2>
      <p>
        To the extent permitted by law, Havesay and its officers,
        employees, and volunteers are not liable for any indirect or
        consequential damages arising from your use of the site, and our total
        liability for any direct claim is capped at US$100. This is standard
        civic-tech language; it is not an attempt to exclude the liability a
        court would refuse to let us exclude.
      </p>

      <h2>7. Your vote is yours</h2>
      <p>
        Nothing on this site is a legal instruction about how to vote, how to
        register, or how to verify your registration. For that, consult your
        county clerk or the Utah Lieutenant Governor&apos;s elections office.
      </p>

      <h2>8. Governing law and venue</h2>
      <p>
        These terms are governed by the laws of the State of Delaware (our
        state of incorporation, pending PBC filing)
        {/* REVIEW: operator — confirm once PBC filing is complete; update if we end up filing elsewhere */}
        without regard to conflict-of-laws principles. Any dispute that cannot
        be resolved informally will be brought in the state or federal courts
        located in Utah, and both parties consent to personal jurisdiction
        there.{" "}
        {/* REVIEW: operator — confirm Utah venue vs. Delaware; counsel may prefer Delaware for the PBC */}
      </p>

      <h2>9. Changes to these terms</h2>
      <p>
        We may update these terms as the project evolves. Material changes
        will be announced on the site and, for subscribers, by email. Your
        continued use after an update means you accept the updated terms.
      </p>

      <h2>10. Contact</h2>
      <p>
        Email{" "}
        <a href="mailto:hello@example.org">hello@example.org</a>{" "}
        {/* REVIEW: operator — confirm the general contact email */}
        with questions about these terms.
      </p>
    </LegalPage>
  );
}
