"use client";

import { useState, useTransition } from "react";

export default function EmailOptIn() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }

    startTransition(async () => {
      try {
        const res = await fetch("/api/email-optin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim() }),
        });
        if (!res.ok) throw new Error();
        setSubmitted(true);
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  }

  if (submitted) {
    return (
      <div className="text-center py-4">
        <p className="text-emerald-700 font-semibold text-lg">
          You&apos;re on the list!
        </p>
        <p className="text-[var(--color-text-secondary)] text-sm mt-1">
          We&apos;ll send your ballot when it&apos;s ready.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md mx-auto">
      <p className="text-[var(--color-text)] font-semibold text-center mb-3">
        Want your November ballot when it&apos;s ready?
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (error) setError(null);
          }}
          placeholder="you@example.com"
          aria-label="Email address"
          className={`flex-1 px-4 py-3 rounded-lg border-2 outline-none transition-colors
            ${
              error
                ? "border-red-400"
                : "border-[var(--color-border)] focus:border-[var(--color-primary)]"
            }
            bg-white text-[var(--color-text)]`}
          disabled={isPending}
        />
        <button
          type="submit"
          disabled={isPending}
          className="civic-btn-primary rounded-lg px-6 py-3"
        >
          {isPending ? "Saving..." : "Notify Me"}
        </button>
      </form>
      {error && (
        <p className="text-red-600 text-sm mt-1 text-center">{error}</p>
      )}
    </div>
  );
}
