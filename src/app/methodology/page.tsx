import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { gateMode } from "@/lib/ingest/entailment-gate";
import { PRODUCT_NAME } from "@/lib/brand";

/**
 * Public methodology page.
 *
 * Written for a newsroom editor's scrutiny: it names the method, the editorial
 * standard, the trust gate, and the limits, so an accusation of bias has a
 * specific documented answer rather than "trust us". Rewritten 2026-07-14 to
 * match V2 reality: weighted-L1 matching (not RMSE), the entailment gate and its
 * four-band routing, two-view stated-over-inferred, on-device matching, the
 * statement-selection editorial standard, the reviewer-bias instrument, and what
 * we explicitly do NOT do.
 *
 * Rules honored here: no em-dashes or en-dashes; no unverifiable claims; counts
 * only via a dynamic query with a dated "as of" line or a clearly dated snapshot.
 */

type Facts = {
  publishedCandidates: number | null;
  gate: "enforce" | "shadow" | "off";
  asOf: string;
};

async function loadFacts(): Promise<Facts> {
  const asOf = new Date().toISOString().slice(0, 10);
  const gate = gateMode();
  try {
    const supabase = await createClient();
    const { count } = await supabase
      .from("candidates")
      .select("id", { count: "exact", head: true })
      .eq("published", true);
    return { publishedCandidates: count ?? null, gate, asOf };
  } catch {
    return { publishedCandidates: null, gate, asOf };
  }
}

export default async function MethodologyPage() {
  const facts = await loadFacts();

  const gateSummary =
    facts.gate === "enforce"
      ? "Enforcing: AI-inferred readings display only when they pass the source-entailment check."
      : facts.gate === "shadow"
        ? "Measuring (shadow): the entailment check runs and is logged, but AI-inferred readings are held back from display until it is calibrated and enforced."
        : "Off (development only).";

  return (
    <main className="min-h-screen bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)]">
        <div className="civic-container py-4">
          <Link href="/" className="text-xl font-bold text-[var(--color-primary)]">
            {PRODUCT_NAME}
          </Link>
        </div>
      </header>

      <article className="civic-container py-10 max-w-3xl mx-auto prose-container">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-[var(--color-primary)] mb-2">
          How this works
        </h1>
        <p className="text-lg text-[var(--color-text-secondary)] mb-6">
          The full method behind our ballot guide: how we choose the issues, how
          we read a candidate&apos;s positions, how we compute a match, and the
          things we deliberately refuse to do. Written to be audited, not just
          trusted.
        </p>

        {/* Dynamic, dated status line. Numbers on this page come from a live
            query or a clearly dated snapshot, never from a hand-typed figure. */}
        <div className="mb-8 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4 text-sm">
          <p className="text-[var(--color-text-secondary)]">
            <strong className="text-[var(--color-text)]">Source-entailment gate:</strong>{" "}
            {gateSummary}
          </p>
          <p className="text-[var(--color-text-muted)] mt-2">
            {facts.publishedCandidates !== null ? (
              <>
                Published candidate profiles: <strong>{facts.publishedCandidates}</strong>.{" "}
              </>
            ) : null}
            Figures on this page are queried live or dated. As of {facts.asOf}.
          </p>
        </div>

        <Section title="What we are trying to do" id="goal">
          <p>
            <strong>Cover every race on every ballot, top to bottom.</strong>{" "}
            Federal, state, county, municipal, school board, special districts.
            The races nobody else covers well are the point: state legislature,
            county, school board, and the offices below the national
            aggregators&apos; top-cities line. We may not reach 100% before a
            given election, but we would rather tell you exactly where we are
            short than quietly drop an office.
          </p>
          <p>
            Voters use the guide free and anonymously. Matching never requires an
            account or any verification. See{" "}
            <Link href="#on-device">matches are computed on your device</Link> and{" "}
            <Link href="#not-do">what we do not do</Link>.
          </p>
        </Section>

        <Section title="How we choose the issues (the statement standard)" id="statements">
          <p>
            A voting-advice tool is only as fair as the statements it puts on the
            questionnaire. The most-cited finding in this field (Walgrave,
            Nuytemans &amp; Pepermans 2009) is blunt: <em>which</em> statements you
            include changes which candidates come out on top. So statement
            selection is an editorial decision we hold to a written standard,
            modeled on the most trusted voting-advice application in the world,
            Germany&apos;s{" "}
            <ExternalLink href="https://en.wikipedia.org/wiki/Wahl-O-Mat">
              Wahl-O-Mat
            </ExternalLink>
            .
          </p>
          <p>Every issue statement must be:</p>
          <ul>
            <li>
              <strong>Office-scoped.</strong> A statement only appears for offices
              that can actually act on it. We do not ask school-board candidates
              about immigration. Scope is derived from what the office controls,
              not from what is in the news.
            </li>
            <li>
              <strong>One proposition, neutral verbs, no negations.</strong> One
              idea per card, phrased so neither a yes nor a no is the
              &ldquo;right&rdquo; answer. Wording effects hit voters with less
              political background roughly three times harder, so plain,
              single-proposition language is a fairness requirement, not a style
              preference.
            </li>
            <li>
              <strong>Two-sided and balanced.</strong> Each card shows both poles
              of the issue before you answer, and the deck is balanced across
              them. You can agree, disagree, or explicitly skip. Skipping is a
              real option, never coerced onto a side.
            </li>
            <li>
              <strong>Importance-weighted, not just agree/disagree.</strong> You
              can flag an issue as important, which weights it more heavily in your
              own match. This is Wahl-O-Mat&apos;s validated mechanism: a pure
              agree/disagree scale is fragile, and letting voters weight what they
              care about is the established fix.
            </li>
          </ul>
          <p>
            If you think an issue belongs on our list and is not there, or a
            statement reads as loaded,{" "}
            <Link href="/corrections">tell us</Link>. The taxonomy is revised cycle
            by cycle, and the reason for each change is logged.
          </p>
        </Section>

        <Section title="Two views of a candidate: stated over inferred" id="two-views">
          <p>
            For each issue we may show up to two separate readings of where a
            candidate stands:
          </p>
          <ul>
            <li>
              <strong>Stated</strong> is the candidate&apos;s own words: their
              campaign materials, a questionnaire they filled out, or a direct
              quote reproduced in reporting. Nothing paraphrased.
            </li>
            <li>
              <strong>Inferred</strong> is our AI-assisted read of their public
              record: voting record, public statements captured by reporting, and
              secondary analysis. It is always labeled as AI-collected, and every
              inferred claim carries its source receipt.
            </li>
          </ul>
          <p>
            <strong>Stated always outranks inferred.</strong> When a candidate has
            told us in their own words, that is what leads. Inferred readings are
            shown only when they clear the entailment gate below, and always with
            the AI-collected label and a tap-to-source receipt. When stated and
            inferred disagree, that gap is itself the information, and we surface it
            rather than average it away.
          </p>
        </Section>

        <Section title="The source-entailment gate (four bands, with receipts)" id="gate">
          <p>
            The failure that quietly wrecks AI-read positions is not an invented
            quote. It is a <em>real</em> quote that does not actually support the
            stance placed on it. Our own audit found this happens on the large
            majority of naive inferred positions. So every inferred reading is
            checked by a source-entailment gate before it can be shown.
          </p>
          <p>
            The gate reads the cited quote <em>in its surrounding context</em> and
            asks whether the context actually supports the stance. That judgment
            routes each reading into one of four bands, matching the labels our
            human reviewers use on the golden reference set:
          </p>
          <ul>
            <li>
              <strong>Clearly supports</strong> becomes voter-visible.
            </li>
            <li>
              <strong>Partially or ambiguously supports</strong> goes to the
              candidate-confirmation queue, not to voters, until the candidate
              confirms or corrects it.
            </li>
            <li>
              <strong>Unrelated</strong> is dropped.
            </li>
            <li>
              <strong>Contradicts</strong> is dropped and flagged.
            </li>
          </ul>
          <p>
            The gate <strong>fails to abstain, never to a guess</strong>: a reading
            it cannot check is treated as not shown, never as supported. It runs a
            locally served natural-language-inference model, never a metered
            per-token API and never a model under a non-commercial license.
          </p>
          <p>
            <strong>Current status, stated plainly.</strong> {gateSummary} While
            the gate is in shadow, surfaces like our newsroom widget show only the
            two provenance tiers that do not depend on it, the candidate&apos;s own
            words and the official voting record, and say so where a candidate has
            neither. When the gate is enforced, entailment-passed inferred readings
            widen back into view, still labeled and still with receipts. We publish
            which mode is live rather than implying more certainty than we have.
          </p>
        </Section>

        <Section title="Provenance tiers" id="provenance">
          <p>
            Every position we show is labeled by where it came from, using a fixed
            set of tiers, strongest to weakest. The label is never colored
            good-versus-bad; it tells you the kind of evidence, so you can weigh it
            yourself.
          </p>
          <ul>
            <li>
              <strong>Candidate-stated.</strong> The candidate&apos;s own current
              words, from their materials, questionnaire, or official statements.
            </li>
            <li>
              <strong>Voting record.</strong> Drawn from official roll-call records.
              What they did in office, not what they said.
            </li>
            <li>
              <strong>Media-reported.</strong> Paraphrased from reputable coverage
              or interviews. Read the source for the original context.
            </li>
            <li>
              <strong>AI-inferred.</strong> Our model&apos;s read of the broader
              public record. Shown only after the entailment gate, always labeled,
              always with a receipt.
            </li>
          </ul>
          <p>
            Separately, each office on the ballot carries a catalog-provenance note
            (state-verified, compiled, or template) describing how confident we are
            about the office itself, distinct from what we know about any
            candidate.
          </p>
        </Section>

        <Section title="The match algorithm, in plain English" id="algorithm">
          <p>
            You answer a short set of office-scoped issue cards and, optionally,
            flag which ones matter most to you. We compare your answers to each
            candidate&apos;s positions on the same issues.
          </p>
          <p>
            The match is a <strong>weighted L1 (Manhattan) distance</strong>. In
            plain terms: for each issue you both have a position on, we take the
            gap between your two answers on a 0.0 to 1.0 scale, weight it by how
            much you said you care about that issue&apos;s domain, average the
            weighted gaps, and turn the result into a score:
          </p>
          <p>
            <code className="text-sm bg-[var(--color-bg-muted)] px-1.5 py-0.5 rounded">
              score = 100 &times; (1 &minus; (sum of weight &times; gap) / (sum of weight))
            </code>
          </p>
          <p>
            This is the field-consensus approach, the same family used by
            Kieskompas, euandi, and Wahl-O-Mat. We chose it deliberately over two
            alternatives:
          </p>
          <ul>
            <li>
              <strong>Not cosine similarity.</strong> Cosine measures the angle
              between two position vectors, not the distance. Answers at (0.1, 0.1)
              and (1.0, 1.0) look identical under cosine but are very different
              positions. We measure distance.
            </li>
            <li>
              <strong>Not a squared-error score.</strong> A Manhattan (L1) distance
              treats a given disagreement the same whether it stands alone or among
              others, which keeps the score decomposable: your match explains
              cleanly as a sum of per-issue contributions, with no hidden
              non-linearity. Every drill-down shows exactly which issue moved the
              number and by how much.
            </li>
          </ul>
          <p>
            If a candidate has no position on an issue you answered, we{" "}
            <strong>exclude</strong> that issue from the score rather than guess.
            Below a minimum overlap we do not publish a number at all: a match
            resting on one or two coincidental issues is not a real match, and we
            say so instead of showing a misleading percentage.
          </p>
        </Section>

        <Section title="Matches are computed on your device" id="on-device">
          <p>
            Your answers to the issue cards stay on your device. The guide
            downloads the <em>public</em> ballot data (races, candidates, and their
            gate-visible positions) and computes your match{" "}
            <strong>in your browser</strong>. Your opinions are not sent to our
            servers to produce a match, and the newsroom widget keeps your answers
            in the page only, never posting them back.
          </p>
          <p>
            The only thing your address is used for is resolving which races are on
            your ballot, the same lookup any ballot tool performs, and we do not
            store it unless you choose to save it. If you opt in to an email
            reminder, that email is the only thing we keep, and only with your
            consent.
          </p>
        </Section>

        <Section title="What we do not do" id="not-do">
          <p>
            The way voter guides get corrupted is well documented, so some limits
            are permanent, not subject to a business decision:
          </p>
          <ul>
            <li>
              <strong>No paid placement near the match.</strong> No campaign, party,
              or political action committee can pay to appear in, above, or
              alongside your match results. This is the exact pay-to-play pattern
              that has discredited slate mailers, and it is prohibited permanently.
            </li>
            <li>
              <strong>No paid influence on ranking.</strong> Match order is the math
              above and nothing else. There is no way to buy a higher match, a
              badge, or a sort position. Candidates are presented as record and
              receipts, never as glamour.
            </li>
            <li>
              <strong>We never sell voter data, and voters never pay.</strong> The
              product is free for voters forever. Your issue answers are on your
              device; we do not compile or sell them.
            </li>
            <li>
              <strong>No AI-generated candidate video or audio.</strong> Candidate
              cards use real, verbatim quotes with receipts. AI stays backstage
              (classification, summarization, the entailment check), never
              impersonating a candidate.
            </li>
          </ul>
          <p>
            If we ever offer candidates a paid feature, the terms are published and
            identical for every candidate in a race. Equal published terms are the
            legal firewall against an in-kind contribution, and we treat them as a
            hard rule.
          </p>
        </Section>

        <Section title="Keeping the reviewers honest (bias instrument)" id="reviewer-bias">
          <p>
            The entailment gate is calibrated against a golden reference set that
            humans label by hand, four bands per statement-and-quote pair, with a
            written rationale. Two safeguards keep that human layer honest:
          </p>
          <ul>
            <li>
              <strong>Inter-reviewer agreement is tracked.</strong> The same pairs
              are labeled by more than one reviewer, and we measure how often they
              agree. Low-agreement items are exactly the ambiguous ones the gate is
              built to abstain on.
            </li>
            <li>
              <strong>Reviewer political lean is measured, not assumed away.</strong>{" "}
              Reviewers complete a short self-placement drawn from the long-running
              American National Election Studies (ANES) battery, so we can check
              whether a label track correlates with reviewer lean and correct for
              it. Reviewers are profiled, not anonymous, for this reason.
            </li>
          </ul>
          <p>
            This program is being built out as the golden set grows; we will
            publish the agreement rates and the bias analysis rather than assert a
            clean bill of health.
          </p>
        </Section>

        <Section title="What the tool is bad at" id="limits">
          <p>
            <strong>Predicting votes.</strong> The research on voting-advice
            applications finds modest effects on actual vote choice and larger
            effects on political knowledge. Use us to understand your ballot, not
            to be told how to vote.
          </p>
          <p>
            <strong>Measuring intensity and direction.</strong> We measure how close
            your positions are (proximity). Some voters reason directionally,
            preferring a candidate who strongly shares their side over one who
            mildly agrees. We do not model that yet.
          </p>
          <p>
            <strong>Character, competence, electability.</strong> None of these are
            measured. The match is policy alignment on the issues we track, and
            nothing more.
          </p>
        </Section>

        <Section title="Corrections and freshness" id="corrections">
          <p>
            Every candidate position traces to a cited source, and anything we get
            wrong can be reported. Our commitments on a correction: acknowledge
            within 24 hours, investigate within 72 hours, and publish a correction
            or an explanation within 7 days. Every correction is logged publicly at{" "}
            <Link href="/corrections">/corrections</Link>.
          </p>
          <p>
            Stale civic data is wrong civic data. Filings open, candidates
            withdraw, and results are certified on a schedule. We refresh federal
            and statewide data most aggressively, legislative and county data on a
            slower cadence, and municipal and special-district data best-effort,
            and we surface a per-office verification timestamp rather than pretend
            to a freshness we do not have. Where a roster is not yet automated, the
            card says so and points you to the county or municipal clerk as the
            authoritative source.
          </p>
        </Section>

        <Section title="Transparency commitments">
          <p>We publish:</p>
          <ul>
            <li>This methodology page, kept current with the product.</li>
            <li>The matching algorithm (open source).</li>
            <li>Which entailment-gate mode is live (shown above).</li>
            <li>
              A <Link href="/corrections">public corrections log</Link>: every
              flagged issue and our response.
            </li>
            <li>The reviewer-agreement and bias analysis as the golden set grows.</li>
          </ul>
          <p>
            Every losing campaign accuses every match tool of bias; that is the
            baseline condition of the field. The real question is whether the work
            can be <em>audited</em> or only complained about. We are betting on
            auditable.
          </p>
        </Section>

        <Section title="Further reading">
          <ul>
            <li>
              <ExternalLink href="https://en.wikipedia.org/wiki/Voting_advice_application">
                Voting Advice Application
              </ExternalLink>{" "}
              (overview)
            </li>
            <li>
              Walgrave, Nuytemans &amp; Pepermans (2009),{" "}
              <em>&ldquo;The Effect of Statement Selection on VAA Advice&rdquo;</em>
            </li>
            <li>
              Louwerse &amp; Rosema (2014),{" "}
              <em>&ldquo;The design effects of voting advice applications&rdquo;</em>,{" "}
              <ExternalLink href="https://link.springer.com/article/10.1057/ap.2013.30">
                Acta Politica
              </ExternalLink>
            </li>
            <li>
              <ExternalLink href="https://electionstudies.org/">
                American National Election Studies (ANES)
              </ExternalLink>{" "}
              (reviewer self-placement battery)
            </li>
          </ul>
        </Section>

        <div className="mt-12 p-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-alt)]">
          <h3 className="text-lg font-semibold text-[var(--color-primary)] mb-2">
            Questions or objections?
          </h3>
          <p className="text-sm text-[var(--color-text-secondary)] mb-4">
            If you think we got a candidate&apos;s position wrong, or that our
            method is flawed, tell us. We publish every correction.
          </p>
          <Link href="/corrections" className="civic-btn-primary inline-block">
            Submit a correction
          </Link>
        </div>

        <footer className="mt-12 pt-8 border-t border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">
          <p>Last substantive revision: 2026-07-14.</p>
        </footer>
      </article>
    </main>
  );
}

function Section({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    // `scroll-mt` pushes the anchor target below any sticky header so a deep-link
    // like `/methodology#gate` does not scroll the title under the app nav.
    <section id={id} className="mb-10 scroll-mt-24">
      <h2 className="text-2xl font-bold text-[var(--color-primary)] mb-3">
        {title}
      </h2>
      <div className="space-y-3 text-[var(--color-text-secondary)] leading-relaxed [&_p]:text-base [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:space-y-2 [&_li]:text-base [&_a]:text-[var(--color-primary)] [&_a:hover]:underline">
        {children}
      </div>
    </section>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[var(--color-primary)] hover:underline"
    >
      {children}
    </a>
  );
}
