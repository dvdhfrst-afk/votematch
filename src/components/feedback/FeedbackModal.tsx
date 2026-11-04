"use client";

import { useState, useEffect, useCallback } from "react";

// Flow: comprehension (the headline metric) first, then the optional secondary
// signals (did you vote / did it change your vote). Per MESSAGING.md the key
// metric is "did you understand your whole ballot?", NOT vote-change. The
// vote-change questions remain only as an optional, internal-only signal the
// voter can skip.
type FeedbackStep =
  | "understand"
  | "voted"
  | "changed"
  | "changed_count"
  | "thanks"
  | "hidden";

type Understood = "yes" | "somewhat" | "no";

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[2]) : null;
}

function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

// Post-election feedback window: show modal only for ~14 days after each
// 2026 election the tool covers. Havesay is national, so we trigger
// the feedback modal for the major rolling state primary waves AND the
// Nov 3 national general. List below is illustrative (representative high-
// volume waves); production should source from `app/data/state-research/
// 2026-primary-calendar.json` or a DB-driven query of `elections.date`.
const ELECTION_DATES_UTC = [
  // Major state primary waves (rolling May-Sept 2026)
  "2026-05-19", // AL, GA, ID, KY, OR, PA
  "2026-06-02", // CA, IA, MT, NJ, NM, SD (incl. CA top-two)
  "2026-06-23", // MD, NY, UT
  "2026-08-04", // KS, MI, MO, VA, WA (incl. WA top-two)
  "2026-08-18", // AK, FL, WY (incl. AK ranked-choice top-four)
  // National general
  "2026-11-03", // U.S. general election
];
const POST_ELECTION_WINDOW_DAYS = 14;

function isInPostElectionWindow(now: Date = new Date()): boolean {
  return ELECTION_DATES_UTC.some((dateStr) => {
    const electionDate = new Date(`${dateStr}T00:00:00Z`);
    const diffDays = (now.getTime() - electionDate.getTime()) / 864e5;
    return diffDays >= 0 && diffDays <= POST_ELECTION_WINDOW_DAYS;
  });
}

export default function FeedbackModal() {
  const [step, setStep] = useState<FeedbackStep>("hidden");
  const [understood, setUnderstood] = useState<Understood | null>(null);
  const [voted, setVoted] = useState<boolean | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const [raceCount, setRaceCount] = useState<number>(1);

  useEffect(() => {
    // Always record the visit so we can distinguish returning users later.
    const dismissed = getCookie("bb_feedback_done");
    const hasVisited = getCookie("bb_visited");
    if (!hasVisited) {
      setCookie("bb_visited", "1", 365);
    }

    // Only show the modal to returning users within the post-election window.
    if (hasVisited && !dismissed && isInPostElectionWindow()) {
      const timer = setTimeout(() => setStep("understand"), 3000);
      return () => clearTimeout(timer);
    }
  }, []);

  const dismiss = useCallback(() => {
    setCookie("bb_feedback_done", "1", 365);
    setStep("hidden");
  }, []);

  // Submit whatever we have. `understood` is the headline metric and is always
  // set by the time we submit; voted/changed are optional secondary signals
  // (null when the voter skipped them).
  const submit = useCallback(
    async (final: {
      understood: Understood | null;
      voted: boolean | null;
      changed: string | null;
      raceCount: number;
    }) => {
      try {
        await fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            understood: final.understood,
            voted: final.voted,
            changed: final.changed,
            raceCount: final.changed === "yes" ? final.raceCount : null,
          }),
        });
      } catch {
        // Silently fail
      }
      setCookie("bb_feedback_done", "1", 365);
      setStep("thanks");
    },
    [],
  );

  if (step === "hidden") return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={dismiss} />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md p-6 sm:p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
        {/* Close button */}
        <button
          type="button"
          onClick={dismiss}
          className="absolute top-4 right-4 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          aria-label="Close"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>

        {/* Q1 (headline metric): Did Havesay help you understand your whole ballot? */}
        {step === "understand" && (
          <div>
            <h2 className="text-xl font-bold text-[var(--color-primary)] mb-4">
              Quick feedback
            </h2>
            <p className="text-[var(--color-text)] font-medium mb-4">
              Did Havesay help you understand your whole ballot?
            </p>
            <div className="flex flex-col gap-2">
              {(
                [
                  ["yes", "Yes"],
                  ["somewhat", "Somewhat"],
                  ["no", "No"],
                ] as [Understood, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setUnderstood(value);
                    setStep("voted");
                  }}
                  className="civic-btn-secondary justify-start"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Q2 (optional secondary): Did you vote? */}
        {step === "voted" && (
          <div>
            <h2 className="text-xl font-bold text-[var(--color-primary)] mb-4">
              Quick feedback
            </h2>
            <p className="text-[var(--color-text)] font-medium mb-1">
              Did you vote in the recent election?
            </p>
            <p className="text-sm text-[var(--color-text-muted)] mb-4">
              Optional.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setVoted(true);
                  setStep("changed");
                }}
                className="civic-btn-primary flex-1"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => {
                  setVoted(false);
                  setStep("changed");
                }}
                className="civic-btn-secondary flex-1"
              >
                No
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setVoted(null);
                setStep("changed");
              }}
              className="mt-4 w-full text-sm text-[var(--color-text-muted)] underline hover:text-[var(--color-primary)]"
            >
              Skip
            </button>
          </div>
        )}

        {/* Q3 (optional secondary, internal signal): Did it change your vote? */}
        {step === "changed" && (
          <div>
            <h2 className="text-xl font-bold text-[var(--color-primary)] mb-4">
              Quick feedback
            </h2>
            <p className="text-[var(--color-text)] font-medium mb-1">
              Did Havesay change how you voted in any race?
            </p>
            <p className="text-sm text-[var(--color-text-muted)] mb-4">
              Optional. This helps us learn, but understanding your ballot is the
              goal, not changing your vote.
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  setChanged("yes");
                  setStep("changed_count");
                }}
                className="civic-btn-secondary justify-start"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() =>
                  submit({ understood, voted, changed: "no", raceCount })
                }
                className="civic-btn-secondary justify-start"
              >
                No
              </button>
              <button
                type="button"
                onClick={() =>
                  submit({ understood, voted, changed: "not_sure", raceCount })
                }
                className="civic-btn-secondary justify-start"
              >
                Not sure
              </button>
            </div>
            <button
              type="button"
              onClick={() =>
                submit({ understood, voted, changed: null, raceCount })
              }
              className="mt-4 w-full text-sm text-[var(--color-text-muted)] underline hover:text-[var(--color-primary)]"
            >
              Skip
            </button>
          </div>
        )}

        {/* Q3a: How many races? */}
        {step === "changed_count" && (
          <div>
            <h2 className="text-xl font-bold text-[var(--color-primary)] mb-4">
              Quick feedback
            </h2>
            <p className="text-[var(--color-text)] font-medium mb-4">
              How many races did it influence?
            </p>
            <input
              type="number"
              min={1}
              max={20}
              value={raceCount}
              onChange={(e) =>
                setRaceCount(Math.max(1, parseInt(e.target.value) || 1))
              }
              className="w-full px-4 py-3 rounded-lg border-2 border-[var(--color-border)] focus:border-[var(--color-primary)] outline-none text-lg text-center"
            />
            <button
              type="button"
              onClick={() =>
                submit({ understood, voted, changed: "yes", raceCount })
              }
              className="civic-btn-primary w-full mt-4"
            >
              Submit
            </button>
          </div>
        )}

        {/* Thanks */}
        {step === "thanks" && (
          <div className="text-center py-4">
            <p className="text-2xl mb-2">Thank you!</p>
            <p className="text-[var(--color-text-secondary)]">
              Your feedback helps us improve Havesay for future elections.
            </p>
            <button
              type="button"
              onClick={dismiss}
              className="civic-btn-primary mt-6"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
