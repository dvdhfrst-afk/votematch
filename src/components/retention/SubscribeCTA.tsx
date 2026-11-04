"use client";

import { useState, useTransition } from "react";
import { subscribeAction } from "@/app/retention-actions";

const INTEREST_OPTIONS = [
  { value: "environment", label: "Environment & climate" },
  { value: "health", label: "Healthcare" },
  { value: "education", label: "Education" },
  { value: "taxes", label: "Taxes & budget" },
  { value: "labor", label: "Labor & workplace" },
  { value: "transportation", label: "Transportation" },
  { value: "civil_rights", label: "Civil rights" },
  { value: "public_safety", label: "Public safety" },
  { value: "housing", label: "Housing" },
  { value: "energy", label: "Energy" },
  { value: "elections", label: "Elections" },
];

type Props = {
  /** Optional match ID to link the subscription back to a quick-match result. */
  matchId?: string | null;
  /** Default state inferred from the user's ballot lookup; users can override. */
  defaultState?: string;
};

export default function SubscribeCTA({ matchId, defaultState = "" }: Props) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState(defaultState);
  const [tags, setTags] = useState<string[]>([]);
  const [frequency, setFrequency] = useState<"monthly" | "biweekly" | "weekly">("monthly");
  const [spiConsent, setSpiConsent] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggleTag(tag: string) {
    setTags((curr) =>
      curr.includes(tag) ? curr.filter((t) => t !== tag) : [...curr, tag],
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    if (!state || state.length !== 2) {
      setError("Select your state.");
      return;
    }
    if (!spiConsent) {
      setError("Please confirm consent to process your political preferences.");
      return;
    }

    startTransition(async () => {
      const formData = new FormData();
      formData.set("email", email.trim());
      formData.set("state", state);
      formData.set("interest_tags", tags.join(","));
      formData.set("digest_frequency", frequency);
      formData.set("spi_consent", "on");
      if (matchId) formData.set("match_id", matchId);

      try {
        const result = await subscribeAction(formData);
        if (!result.ok) {
          setError(result.error ?? "Subscription failed.");
          return;
        }
        setSubmitted(true);
      } catch {
        setError("Network error — try again.");
      }
    });
  }

  if (submitted) {
    return (
      <div className="w-full max-w-lg mx-auto rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center">
        <p className="text-emerald-800 font-semibold text-lg">Check your email</p>
        <p className="text-emerald-700 text-sm mt-2">
          We sent a confirmation link. Click it to activate your subscription. You&apos;ll get
          updates on federal votes, public-comment windows, and election reminders — nothing else.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg mx-auto">
      <div className="text-center mb-4">
        <h3 className="text-xl font-semibold text-[var(--color-text)]">
          Stay on top of your issues between elections
        </h3>
        <p className="text-[var(--color-text-secondary)] text-sm mt-1">
          Monthly digest, no daily pings. Always a one-click unsubscribe.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="sub-email" className="block text-sm font-medium mb-1">
            Email
          </label>
          <input
            id="sub-email"
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }}
            placeholder="you@example.com"
            className="w-full px-4 py-3 rounded-lg border-2 border-[var(--color-border)] focus:border-[var(--color-primary)] outline-none bg-white"
            disabled={isPending}
            required
          />
        </div>

        <div>
          <label htmlFor="sub-state" className="block text-sm font-medium mb-1">
            State
          </label>
          <select
            id="sub-state"
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="w-full px-4 py-3 rounded-lg border-2 border-[var(--color-border)] bg-white"
            disabled={isPending}
            required
          >
            <option value="">Select…</option>
            {US_STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">
            Issues you care about (pick up to five)
          </label>
          <div className="flex flex-wrap gap-2">
            {INTEREST_OPTIONS.map((opt) => {
              const selected = tags.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => toggleTag(opt.value)}
                  disabled={isPending || (!selected && tags.length >= 5)}
                  className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                    selected
                      ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                      : "bg-white text-[var(--color-text)] border-[var(--color-border)]"
                  } disabled:opacity-50`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label htmlFor="sub-freq" className="block text-sm font-medium mb-1">
            Frequency
          </label>
          <select
            id="sub-freq"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as "monthly" | "biweekly" | "weekly")}
            className="w-full px-4 py-3 rounded-lg border-2 border-[var(--color-border)] bg-white"
            disabled={isPending}
          >
            <option value="monthly">Monthly (recommended)</option>
            <option value="biweekly">Every two weeks</option>
            <option value="weekly">Weekly</option>
          </select>
        </div>

        <label className="flex gap-3 items-start cursor-pointer select-none">
          <input
            type="checkbox"
            checked={spiConsent}
            onChange={(e) => setSpiConsent(e.target.checked)}
            disabled={isPending}
            className="mt-1 h-4 w-4"
            required
          />
          <span className="text-sm text-[var(--color-text-secondary)]">
            I consent to Havesay processing my political preferences as sensitive
            personal information to generate my candidate matches and digest content.
            Required by law in many states.
          </span>
        </label>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={isPending || !spiConsent}
          className="civic-btn-primary w-full rounded-lg py-3 disabled:opacity-50"
        >
          {isPending ? "Subscribing…" : "Subscribe"}
        </button>

        <p className="text-xs text-[var(--color-text-secondary)] text-center">
          Double opt-in. We&apos;ll email a confirmation link before sending anything else.
        </p>
      </form>
    </div>
  );
}

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY",
  "LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND",
  "OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
];
