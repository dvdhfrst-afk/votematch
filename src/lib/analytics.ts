import posthog from "posthog-js";

function capture(event: string, properties?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    posthog.capture(event, properties);
  } catch {
    // PostHog not initialized (dev, SSR, no key) -- silently skip
  }
}

// PII rule: never send a voter's address, answers, or chosen domains to analytics.
// trackAddressEntered / trackQuizCompleted were removed 2026-07-05 for exactly
// that reason (they were unwired, but one call site away from leaking).
// Analytics events may carry counts and methods only.

export function trackResultsViewed(raceCount: number) {
  capture("results_viewed", { race_count: raceCount });
}

export function trackCardDownloaded() {
  capture("card_downloaded");
}

export function trackCardShared(method: string) {
  capture("card_shared", { method });
}

export function trackEmailCaptured() {
  capture("email_captured");
}

export function trackFeedbackSubmitted(changedVote: string) {
  capture("feedback_submitted", { changed_vote: changedVote });
}
