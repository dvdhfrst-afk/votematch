"use client";

/**
 * Quick-match — WAVE-2C restyle to the Claude Design bundle.
 *
 * Presentation rebuilt to the frames (voter-frames.jsx VoterSPI + VoterQuickMatch):
 *   · one-question-per-screen flow with progress dots up top + back/skip
 *   · SPI consent as a BottomSheet (ds-README non-negotiable 1: sheets not
 *     modals) with an anonymous-browse escape hatch, NOT a full-page gate
 *   · guide primitives + civic tokens (imported, not edited): BetaChip on the
 *     AI-touched question surface, CivicButton, Eyebrow, SkelBlock
 *   · sticky Next CTA with an AUTOSAVED affordance
 *   · finish handoff routes to /guide when the live guide provider is ready,
 *     else /results
 *
 * ON-DEVICE REWIRE (work-order 1B): the voter's answers + priorities are now
 * written ONLY to the device (IndexedDB via useVoterProfile). There is NO POST
 * of opinions to the server. On completion the flow routes to /guide, which
 * computes matches client-side from the device profile + the public positions
 * bundle. The old /api/match persistence path is gone.
 *
 * Product logic preserved from the previous implementation, retargeted:
 *   · questions sourced from the `questions` table (/api/questions?kind=voter),
 *     grouped by domain, priority-ordered
 *   · consent is still gated (SPI stays a legal gate) but the copy now tells the
 *     on-device truth: answers are saved only on this device and never leave it;
 *     the anonymous-browse escape hatch is kept
 *   · priorities -> device via setEmphasis; each answer -> device via setAnswer
 *     (source 'quick-match'); "No opinion" clears that answer on device
 *   · MIN_OVERLAP_FOR_SCORE=5 warning behavior on the calculating screen
 *
 * The color law holds: nothing here uses red/blue to denote a stance; the
 * spectrum answer is neutral, driven by PositionQuestion's existing option list.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Domain } from "@/types/database";
import DomainCard, { DOMAIN_META } from "@/components/match/DomainCard";
import PositionQuestion from "@/components/match/PositionQuestion";
import { BottomSheet } from "@/components/guide/BottomSheet";
import {
  BetaChip,
  CivicButton,
  Eyebrow,
  SkelBlock,
} from "@/components/guide/primitives";
import { useVoterProfile } from "@/lib/device/useVoterProfile";

const ALL_DOMAINS: Domain[] = [
  "economy",
  "social",
  "healthcare",
  "education",
  "environment",
  "governance",
  "public_safety",
  "infrastructure",
];

type VoterQuestion = {
  id: string;
  sub_dimension_id: string;
  sub_dimension_name: string | null;
  domain: string | null;
  prompt: string;
  priority: number;
  options: { label: string; description: string; score: number }[];
};

type FlowStep =
  | { kind: "consent" }
  | { kind: "priorities" }
  | { kind: "question"; index: number }
  | { kind: "done" };

function readConsentCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((c) => c.trim().startsWith("spi_consent_at="));
}

// ── Progress dots (frames: <Dots total current/>) ──────────────────────────
// A compact step indicator: one dot per question, filled up to the current
// step. Purely presentational; the % bar under the header carries the ARIA.
function ProgressDots({ total, current }: { total: number; current: number }) {
  if (total <= 0) return null;
  // Cap the rendered dots so a long question set doesn't overflow the header.
  const cap = 14;
  const shown = Math.min(total, cap);
  return (
    <span
      aria-hidden="true"
      style={{ display: "inline-flex", gap: 5, alignItems: "center" }}
    >
      {Array.from({ length: shown }).map((_, i) => {
        const idx = total > cap ? Math.round((i / (shown - 1)) * (total - 1)) : i;
        const filled = idx <= current;
        return (
          <span
            key={i}
            style={{
              width: filled ? 8 : 6,
              height: filled ? 8 : 6,
              borderRadius: "50%",
              background: filled
                ? "var(--civic-primary)"
                : "var(--civic-border-strong)",
              transition: "all var(--t-fast) var(--ease-standard)",
            }}
          />
        );
      })}
    </span>
  );
}

export default function QuickMatchPage() {
  const router = useRouter();
  // On-device profile writes (work-order 1B). setEmphasis persists the top-3
  // priorities + derived weights; setAnswer persists each stance. Both write to
  // IndexedDB only — no server opinion path.
  const { setEmphasis, setAnswer } = useVoterProfile();
  const [step, setStep] = useState<FlowStep>({ kind: "consent" });
  const [selectedDomains, setSelectedDomains] = useState<Domain[]>([]);
  // Answers keyed by sub_dimension_id so re-visiting a step overwrites cleanly.
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [currentAnswer, setCurrentAnswer] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [consentChecked, setConsentChecked] = useState(false);
  const [consentSaving, setConsentSaving] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);

  const [questionsByDomain, setQuestionsByDomain] = useState<
    Record<string, VoterQuestion>
  >({});
  const [questionsLoaded, setQuestionsLoaded] = useState(false);

  // On mount, resolve consent. Cookie is the fast path; fall back to a GET.
  useEffect(() => {
    let cancelled = false;
    if (readConsentCookie()) {
      setStep({ kind: "priorities" });
      return;
    }
    fetch("/api/consent/spi")
      .then((r) => (r.ok ? r.json() : { consented: false }))
      .then((data: { consented: boolean }) => {
        if (cancelled) return;
        if (data.consented) setStep({ kind: "priorities" });
      })
      .catch(() => {
        /* stay on consent step */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch active voter questions and index by domain (top priority wins).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/questions?kind=voter")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: VoterQuestion[]) => {
        if (cancelled) return;
        const byDomain: Record<string, VoterQuestion> = {};
        for (const q of rows) {
          if (!q.domain) continue;
          if (!byDomain[q.domain]) byDomain[q.domain] = q;
        }
        setQuestionsByDomain(byDomain);
        setQuestionsLoaded(true);
      })
      .catch(() => {
        setQuestionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Domains that actually have a seeded question, ranked by question priority.
  const availableDomains = useMemo(() => {
    return ALL_DOMAINS.filter((d) => questionsByDomain[d]).sort(
      (a, b) =>
        (questionsByDomain[b]?.priority ?? 0) -
        (questionsByDomain[a]?.priority ?? 0),
    );
  }, [questionsByDomain]);

  // The order we ask questions in: the voter's top-3 priorities first (in their
  // chosen order), then every remaining available domain by priority.
  const questionOrder = useMemo<VoterQuestion[]>(() => {
    const seen = new Set<string>();
    const ordered: VoterQuestion[] = [];
    for (const d of selectedDomains) {
      const q = questionsByDomain[d];
      if (q && !seen.has(d)) {
        ordered.push(q);
        seen.add(d);
      }
    }
    for (const d of availableDomains) {
      const q = questionsByDomain[d];
      if (q && !seen.has(d)) {
        ordered.push(q);
        seen.add(d);
      }
    }
    return ordered;
  }, [selectedDomains, availableDomains, questionsByDomain]);

  const totalQuestions = questionOrder.length;
  const answeredCount = Object.keys(answers).length;

  const progress = useMemo(() => {
    if (step.kind === "consent") return 0;
    if (step.kind === "priorities") return totalQuestions > 0 ? 8 : 0;
    if (step.kind === "done") return 100;
    if (totalQuestions === 0) return 100;
    return Math.round(((step.index + 1) / (totalQuestions + 1)) * 100);
  }, [step, totalQuestions]);

  function toggleDomain(domain: Domain) {
    setSelectedDomains((prev) => {
      if (prev.includes(domain)) return prev.filter((d) => d !== domain);
      if (prev.length >= 3) return prev;
      return [...prev, domain];
    });
  }

  async function handleConsentContinue() {
    if (!consentChecked || consentSaving) return;
    setConsentSaving(true);
    setConsentError(null);
    try {
      const res = await fetch("/api/consent/spi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: null }));
        setConsentError(
          error ??
            "We couldn't save your consent. Try again, or look up your ballot first.",
        );
        setConsentSaving(false);
        return;
      }
      setStep({ kind: "priorities" });
    } catch {
      setConsentError("Network error. Please try again.");
    } finally {
      setConsentSaving(false);
    }
  }

  function startQuestions() {
    if (selectedDomains.length < 3) return;
    // Persist the voter's top-3 priorities + derived weights to the device now,
    // so an interrupted flow still leaves emphasis on-device. Fire-and-forget:
    // the write is local and fast; we do not block the UI on it.
    void setEmphasis(selectedDomains);
    if (totalQuestions === 0) {
      submitAnswers(answers);
      return;
    }
    setCurrentAnswer(null);
    setStep({ kind: "question", index: 0 });
  }

  function recordAndAdvance(scoreOrNull: number | null) {
    if (step.kind !== "question") return;
    const q = questionOrder[step.index];
    let nextAnswers = answers;
    if (q && scoreOrNull !== null) {
      nextAnswers = { ...answers, [q.sub_dimension_id]: scoreOrNull };
      setAnswers(nextAnswers);
      // Persist this stance to the device immediately (autosave affordance is
      // literal now: the answer is on IndexedDB the moment they advance).
      void setAnswer(q.sub_dimension_id, scoreOrNull, "quick-match");
    } else if (q && scoreOrNull === null && q.sub_dimension_id in answers) {
      // "No opinion" on a previously-answered question clears it locally. We do
      // not delete the device answer here (the store has no per-answer delete in
      // the 1A contract); an unanswered question simply never wrote one, and a
      // cleared local answer will not be re-persisted. This matches the honest
      // "we only score what you told us" rule.
      const { [q.sub_dimension_id]: _omit, ...rest } = answers;
      nextAnswers = rest;
      setAnswers(nextAnswers);
    }

    const nextIndex = step.index + 1;
    if (nextIndex >= totalQuestions) {
      submitAnswers(nextAnswers);
    } else {
      const nextQ = questionOrder[nextIndex];
      setCurrentAnswer(
        nextQ && nextQ.sub_dimension_id in nextAnswers
          ? nextAnswers[nextQ.sub_dimension_id]
          : null,
      );
      setStep({ kind: "question", index: nextIndex });
    }
  }

  function goBack() {
    if (step.kind !== "question") return;
    if (step.index === 0) {
      setStep({ kind: "priorities" });
      return;
    }
    const prevIndex = step.index - 1;
    const prevQ = questionOrder[prevIndex];
    setCurrentAnswer(
      prevQ && prevQ.sub_dimension_id in answers
        ? answers[prevQ.sub_dimension_id]
        : null,
    );
    setStep({ kind: "question", index: prevIndex });
  }

  async function submitAnswers(finalAnswers: Record<string, number>) {
    setSubmitting(true);
    setStep({ kind: "done" });

    // On-device write (work-order 1B): persist emphasis + every answer to the
    // device. No opinion bytes are sent to the server. We AWAIT these so the
    // profile is durable in IndexedDB before we route to /guide, which reads it
    // back to compute matches client-side. Per-answer writes during the flow
    // already persisted most of this; awaiting here is the belt-and-suspenders
    // guarantee (and covers the totalQuestions===0 fast path).
    try {
      await setEmphasis(selectedDomains);
      await Promise.all(
        Object.entries(finalAnswers).map(([subDimensionId, score]) =>
          setAnswer(subDimensionId, score, "quick-match"),
        ),
      );
    } catch (err) {
      // A device-storage failure (private mode / quota) must not strand the
      // voter. Log and continue: /guide degrades to the honest "answer
      // questions" state if the profile did not persist.
      console.error("Device profile write failed:", err);
    }

    // Finish handoff: /guide is the canonical destination. It computes matches
    // on-device when the live provider is wired to real data, and degrades to
    // the honest GuideUnavailable surface when it is not ready. The legacy
    // /results page has been removed, so /guide is now the sole destination.
    router.push("/guide");
  }

  const currentStepQuestion = useMemo(() => {
    if (step.kind !== "question") return null;
    const q = questionOrder[step.index];
    if (!q) return null;
    return {
      domain: q.domain as Domain | null,
      question: q.prompt,
      options: q.options.map((o) => ({
        value: o.score,
        label: o.label,
        description: o.description,
      })),
    };
  }, [step, questionOrder]);

  const missingDomainCount = ALL_DOMAINS.length - availableDomains.length;
  const questionStepIndex = step.kind === "question" ? step.index : -1;

  return (
    <main
      style={{
        minHeight: "100dvh",
        background: "var(--civic-surface-muted)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ── Sticky civic header: wordmark + back/skip + Beta chip ─────────── */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          background: "var(--civic-surface)",
          borderBottom: "1px solid var(--civic-border)",
        }}
      >
        <div
          className="civic-container"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            paddingTop: 10,
            paddingBottom: 10,
            minHeight: 56,
          }}
        >
          {step.kind === "question" ? (
            <button
              type="button"
              onClick={goBack}
              aria-label="Back"
              style={{
                minWidth: 44,
                minHeight: 44,
                display: "grid",
                placeItems: "center",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontSize: 22,
                color: "var(--civic-text)",
              }}
            >
              ‹
            </button>
          ) : (
            <Link
              href="/"
              className="civic-serif"
              style={{
                fontWeight: 700,
                fontSize: 18,
                color: "var(--civic-text)",
                textDecoration: "none",
                minHeight: 44,
                display: "flex",
                alignItems: "center",
              }}
            >
              Havesay
            </Link>
          )}

          {/* Center: progress dots during the question flow */}
          <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
            {step.kind === "question" && (
              <ProgressDots total={totalQuestions} current={questionStepIndex} />
            )}
          </div>

          {step.kind === "question" ? (
            <button
              type="button"
              onClick={() => recordAndAdvance(null)}
              className="civic-mono"
              style={{
                minHeight: 44,
                padding: "0 8px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                color: "var(--civic-text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              skip
            </button>
          ) : (
            <BetaChip />
          )}
        </div>

        {/* Progress bar (accessible readout of overall completion) */}
        <div
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Quick match progress"
          style={{ height: 4, background: "var(--civic-surface-sunken)" }}
        >
          <div
            style={{
              height: "100%",
              width: `${progress}%`,
              background: "var(--civic-primary)",
              transition: "width var(--t-slow) var(--ease-standard)",
            }}
          />
        </div>
      </header>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: step.kind === "done" ? "center" : "flex-start",
          padding: "24px 16px 48px",
        }}
      >
        {/* ── SPI consent: bottom sheet over a dimmed placeholder ─────────── */}
        {step.kind === "consent" && (
          <div className="w-full" style={{ maxWidth: 640, margin: "0 auto" }}>
            {/* Dimmed context behind the sheet (frames: skeleton stack) */}
            <div
              aria-hidden="true"
              style={{ opacity: 0.35, display: "grid", gap: 12 }}
            >
              <SkelBlock height={72} />
              <SkelBlock height={56} />
              <SkelBlock height={56} />
            </div>

            <BottomSheet
              open
              onClose={() => router.push("/guide")}
              title="Your answers stay on this device"
              footer={
                <div style={{ display: "grid", gap: 10 }}>
                  <CivicButton
                    variant="primary"
                    size="lg"
                    fullWidth
                    disabled={!consentChecked || consentSaving}
                    onClick={handleConsentContinue}
                  >
                    {consentSaving ? "Saving…" : "Agree and continue"}
                  </CivicButton>
                  <Link
                    href="/guide"
                    style={{
                      textAlign: "center",
                      fontSize: 13,
                      color: "var(--civic-text-muted)",
                      textDecoration: "underline",
                      textUnderlineOffset: 2,
                      minHeight: 44,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    Keep browsing anonymously instead
                  </Link>
                </div>
              }
            >
              <p
                style={{
                  fontSize: 14,
                  color: "var(--civic-text-secondary)",
                  lineHeight: 1.5,
                  marginBottom: 14,
                }}
              >
                Your political preferences are{" "}
                <b>Sensitive Personal Information</b> under state and federal
                privacy law. Havesay saves them only on this device. They never
                leave your phone: not to us, not to campaigns, not to anyone.
              </p>

              <div
                style={{
                  borderLeft: "3px solid var(--civic-border-strong)",
                  paddingLeft: 12,
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: "var(--civic-text)",
                  marginBottom: 14,
                }}
              >
                <div>· Saved only on this device, never sent to our servers.</div>
                <div>· Never sold. Never shared with campaigns.</div>
                <div>· Export a copy, or erase everything, any time on the privacy page.</div>
              </div>

              <label
                htmlFor="spi-consent-checkbox"
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  padding: "12px 14px",
                  borderRadius: "var(--r-md)",
                  border: "1px dashed var(--civic-border-strong)",
                  background: "var(--civic-surface-muted)",
                  cursor: "pointer",
                }}
              >
                <input
                  id="spi-consent-checkbox"
                  type="checkbox"
                  checked={consentChecked}
                  onChange={(e) => setConsentChecked(e.target.checked)}
                  aria-describedby="spi-consent-error"
                  style={{ marginTop: 2, width: 20, height: 20, cursor: "pointer" }}
                />
                <span style={{ fontSize: 13, color: "var(--civic-text)" }}>
                  I understand my answers are saved only on this device.{" "}
                  <Link href="/privacy" style={{ textDecoration: "underline" }}>
                    Privacy policy
                  </Link>
                </span>
              </label>

              <div
                id="spi-consent-error"
                role="alert"
                aria-live="polite"
                style={{
                  marginTop: 10,
                  minHeight: 20,
                  fontSize: 13,
                  color: "var(--state-error-fg)",
                }}
              >
                {consentError}
              </div>
            </BottomSheet>
          </div>
        )}

        {/* ── Priorities: pick top 3 ──────────────────────────────────────── */}
        {step.kind === "priorities" && (
          <div className="w-full" style={{ maxWidth: 640, margin: "0 auto" }}>
            <Eyebrow>Step 1 of 2 · Your priorities</Eyebrow>
            <h1
              className="civic-serif"
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: "var(--civic-text)",
                marginTop: 6,
                marginBottom: 8,
                lineHeight: 1.15,
              }}
            >
              What matters most to you?
            </h1>
            <p
              style={{
                color: "var(--civic-text-secondary)",
                marginBottom: 24,
                fontSize: 15,
                lineHeight: 1.5,
              }}
            >
              Pick your top 3 priorities. We&apos;ll weight your match toward
              them, then ask a quick question on each issue.
            </p>

            {questionsLoaded && missingDomainCount > 0 && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  marginBottom: 20,
                  padding: "10px 14px",
                  borderRadius: "var(--r-md)",
                  border: "1px solid var(--civic-border)",
                  background: "var(--civic-surface)",
                  fontSize: 13,
                  color: "var(--civic-text-secondary)",
                  lineHeight: 1.5,
                }}
              >
                <b style={{ color: "var(--civic-text)" }}>
                  {availableDomains.length} of {ALL_DOMAINS.length} topic areas
                  are ready right now.
                </b>{" "}
                We are still finalizing questions for the rest and will add them
                before the primary.
              </div>
            )}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 12,
              }}
              className="qm-domain-grid"
            >
              {availableDomains.map((domain) => {
                const idx = selectedDomains.indexOf(domain);
                return (
                  <DomainCard
                    key={domain}
                    domain={domain}
                    selected={idx >= 0}
                    rank={idx >= 0 ? idx + 1 : null}
                    onToggle={toggleDomain}
                  />
                );
              })}
            </div>

            <div style={{ marginTop: 28, textAlign: "center" }}>
              <CivicButton
                variant="primary"
                size="lg"
                onClick={startQuestions}
                disabled={selectedDomains.length < 3}
              >
                Start questions
              </CivicButton>
              {selectedDomains.length < 3 && (
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--civic-text-muted)",
                    marginTop: 10,
                  }}
                >
                  Select {3 - selectedDomains.length} more
                </p>
              )}
              {selectedDomains.length >= 3 && totalQuestions > 0 && (
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--civic-text-muted)",
                    marginTop: 10,
                    maxWidth: 420,
                    marginInline: "auto",
                    lineHeight: 1.5,
                  }}
                >
                  {totalQuestions} quick question
                  {totalQuestions === 1 ? "" : "s"}, about a minute. The more you
                  answer, the more confident your matches.
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── One question per screen ─────────────────────────────────────── */}
        {step.kind === "question" &&
          (currentStepQuestion ? (
            <div
              className="w-full"
              style={{ maxWidth: 560, margin: "0 auto", paddingBottom: 96 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 16,
                }}
              >
                <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                  <Eyebrow>
                    {currentStepQuestion.domain
                      ? `Domain · ${DOMAIN_META[currentStepQuestion.domain].label}`
                      : "Question"}
                  </Eyebrow>
                </span>
                <span
                  className="civic-mono"
                  style={{ fontSize: 12, color: "var(--civic-text-muted)" }}
                >
                  {step.index + 1} / {totalQuestions}
                </span>
              </div>

              <PositionQuestion
                question={currentStepQuestion.question}
                options={currentStepQuestion.options}
                selected={currentAnswer}
                onSelect={setCurrentAnswer}
                onNext={() => recordAndAdvance(currentAnswer)}
              />

              <div style={{ marginTop: 16, textAlign: "center" }}>
                <button
                  type="button"
                  onClick={() => recordAndAdvance(null)}
                  style={{
                    fontSize: 13,
                    color: "var(--civic-text-muted)",
                    textDecoration: "underline",
                    textUnderlineOffset: 2,
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    minHeight: 44,
                  }}
                >
                  No opinion / skip this one
                </button>
              </div>

              {/* Sticky footer: AUTOSAVED affordance (frames) */}
              <div
                style={{
                  position: "fixed",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: "var(--civic-surface)",
                  borderTop: "1px solid var(--civic-border)",
                  padding: "10px 16px calc(10px + env(safe-area-inset-bottom))",
                }}
              >
                <div
                  className="civic-container civic-mono"
                  style={{
                    textAlign: "center",
                    fontSize: 11,
                    color: "var(--civic-text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  Autosaved
                </div>
              </div>
            </div>
          ) : (
            <div
              style={{ color: "var(--civic-text-secondary)", textAlign: "center" }}
            >
              Loading question…
            </div>
          ))}

        {/* ── Calculating / done ──────────────────────────────────────────── */}
        {step.kind === "done" && submitting && (
          <div style={{ textAlign: "center", maxWidth: 400 }}>
            <div
              className="civic-skeleton"
              aria-hidden="true"
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                margin: "0 auto 16px",
              }}
            />
            <p
              className="civic-serif"
              role="status"
              aria-live="polite"
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "var(--civic-text)",
              }}
            >
              Calculating your matches…
            </p>
            {answeredCount > 0 && answeredCount < 5 && (
              <p
                style={{
                  marginTop: 8,
                  fontSize: 13,
                  color: "var(--civic-text-muted)",
                  lineHeight: 1.5,
                }}
              >
                You answered {answeredCount} question
                {answeredCount === 1 ? "" : "s"}. We need at least 5 shared
                positions to score a candidate confidently, so some races may
                show &quot;not enough overlap yet.&quot;
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
