"use client";

import { useState } from "react";

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
  "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | {
      kind: "sent";
      matched: boolean;
      // Dev-mode fallback: when Resend isn't configured the API echoes the
      // link back so we can show it inline (skipped in production).
      devLink?: string | null;
    }
  | { kind: "error"; message: string };

export default function ClaimForm() {
  const [email, setEmail] = useState("");
  const [showOptional, setShowOptional] = useState(false);
  const [name, setName] = useState("");
  const [office, setOffice] = useState("");
  const [state, setState] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitState.kind === "submitting") return;

    if (!email.trim() || !email.includes("@")) {
      setSubmitState({ kind: "error", message: "Please enter a valid email." });
      return;
    }

    setSubmitState({ kind: "submitting" });
    try {
      const res = await fetch("/api/for-candidates/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim() || undefined,
          office: office.trim() || undefined,
          state: state.trim() || undefined,
        }),
      });

      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        matched?: boolean;
        error?: string;
        devLink?: string | null;
      };

      if (!res.ok || !body.ok) {
        setSubmitState({
          kind: "error",
          message: body.error ?? `Request failed (HTTP ${res.status}).`,
        });
        return;
      }

      setSubmitState({
        kind: "sent",
        matched: body.matched === true,
        devLink: body.devLink ?? null,
      });
    } catch (err) {
      setSubmitState({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Network error. Try again.",
      });
    }
  }

  if (submitState.kind === "sent") {
    return (
      <div>
        <h2 className="text-xl font-bold text-emerald-700 mb-2">
          Check your email
        </h2>
        <p className="text-[var(--color-text-secondary)] mb-3">
          We sent a sign-in link to <strong>{email}</strong>. It&apos;s good
          for 7 days.
        </p>
        {submitState.matched ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            We found a candidacy on file for that email. The link will open
            your profile editor.
          </p>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">
            We didn&apos;t find an existing candidacy for that email.
            We&apos;ve recorded your claim and a Havesay volunteer will
            verify it before your profile goes public. The link still opens
            your draft editor in the meantime.
          </p>
        )}
        {submitState.devLink && (
          <div className="mt-5 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs">
            <p className="font-semibold text-amber-900 mb-1">
              Dev mode (Resend not configured)
            </p>
            <a
              href={submitState.devLink}
              className="break-all underline text-amber-900"
            >
              {submitState.devLink}
            </a>
          </div>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="email"
          className="block text-sm font-semibold text-[var(--color-text)] mb-1"
        >
          Your campaign or contact email
        </label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full px-3 py-3 rounded-lg border border-[var(--color-border)] focus:border-[var(--color-primary)] outline-none bg-white text-base"
        />
        <p className="text-xs text-[var(--color-text-muted)] mt-1">
          We&apos;ll send a one-time sign-in link. We never share your email.
        </p>
      </div>

      {!showOptional && (
        <button
          type="button"
          onClick={() => setShowOptional(true)}
          className="text-sm text-[var(--color-primary)] underline"
        >
          Email not on file? Add your name and office
        </button>
      )}

      {showOptional && (
        <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
          <p className="text-xs text-[var(--color-text-muted)]">
            Use these fields if your campaign email isn&apos;t the one we have
            on file. We&apos;ll create a pending claim and verify it before
            your profile is public.
          </p>
          <div>
            <label
              htmlFor="name"
              className="block text-sm font-semibold text-[var(--color-text)] mb-1"
            >
              Your name (as it appears on the ballot)
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Q. Smith"
              className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] focus:border-[var(--color-primary)] outline-none bg-white text-sm"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label
                htmlFor="office"
                className="block text-sm font-semibold text-[var(--color-text)] mb-1"
              >
                Office you&apos;re running for
              </label>
              <input
                id="office"
                type="text"
                value={office}
                onChange={(e) => setOffice(e.target.value)}
                placeholder="e.g., U.S. House District 4"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] focus:border-[var(--color-primary)] outline-none bg-white text-sm"
              />
            </div>
            <div>
              <label
                htmlFor="state"
                className="block text-sm font-semibold text-[var(--color-text)] mb-1"
              >
                State
              </label>
              <select
                id="state"
                value={state}
                onChange={(e) => setState(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] focus:border-[var(--color-primary)] outline-none bg-white text-sm"
              >
                <option value="">—</option>
                {US_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {submitState.kind === "error" && (
        <p className="text-sm text-red-700 font-medium">{submitState.message}</p>
      )}

      <button
        type="submit"
        disabled={submitState.kind === "submitting"}
        className="civic-btn-primary w-full text-base py-3"
      >
        {submitState.kind === "submitting"
          ? "Sending link…"
          : "Claim your profile"}
      </button>
    </form>
  );
}
