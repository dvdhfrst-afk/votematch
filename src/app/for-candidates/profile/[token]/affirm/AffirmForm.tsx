"use client";

import { useState, useTransition } from "react";
import { affirmAction } from "./actions";

export default function AffirmForm({
  token,
  expectedName,
  answeredCount,
  hasPhotoOnFile,
}: {
  token: string;
  expectedName: string;
  answeredCount: number;
  /**
   * Whether we have a photo URL on file for this candidate. When false the
   * opt-in checkbox is hidden — there's nothing to opt in TO yet.
   */
  hasPhotoOnFile: boolean;
}) {
  const [retypedName, setRetypedName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  // Default unchecked per Issue E. Candidates explicitly opt in.
  const [photoVisible, setPhotoVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!confirmed) {
      setError("Please check the confirmation box.");
      return;
    }
    if (retypedName.trim().length < 2) {
      setError("Please retype your full name.");
      return;
    }
    startTransition(async () => {
      const result = await affirmAction({
        token,
        retypedName,
        photoVisible: hasPhotoOnFile ? photoVisible : false,
      });
      if (!result.ok) {
        setError(result.error);
      }
      // On success, affirmAction redirects — no further client work.
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Retype your full name to affirm
        </span>
        <input
          type="text"
          value={retypedName}
          onChange={(e) => setRetypedName(e.target.value)}
          placeholder={expectedName}
          autoComplete="off"
          className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] focus:border-[var(--color-primary)] outline-none bg-white text-base"
        />
      </label>

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-1"
        />
        <span className="text-sm text-[var(--color-text-secondary)]">
          I confirm these {answeredCount}{" "}
          {answeredCount === 1 ? "position" : "positions"} are accurate. I
          understand they&apos;ll be public with my name and a timestamp, and
          that voters will use them in match comparisons.
        </span>
      </label>

      {/* Issue E: photo opt-in. Default unchecked. Hidden when we have no
          photo URL on file — there's nothing to opt into in that case and
          asking would be misleading. */}
      {hasPhotoOnFile && (
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={photoVisible}
            onChange={(e) => setPhotoVisible(e.target.checked)}
            className="mt-1"
          />
          <span className="text-sm text-[var(--color-text-secondary)]">
            Show my photo on my Havesay profile and in voter ballot
            views. (Optional. If left unchecked, voters will see your
            initials instead.)
          </span>
        </label>
      )}

      {error && <p className="text-sm text-red-700 font-medium">{error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="civic-btn-primary w-full text-base py-3"
      >
        {pending ? "Publishing…" : "Affirm and publish"}
      </button>
    </form>
  );
}
