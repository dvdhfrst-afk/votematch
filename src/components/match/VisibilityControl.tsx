"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { VisibilityLevel } from "@/types/database";
import { setVisibilityLevelAction } from "@/app/actions";
import {
  VISIBILITY_LEVELS,
  DEFAULT_VISIBILITY,
  visibilityMeta,
} from "@/lib/provenance";

/**
 * Brief B — voter VISIBILITY-LEVEL control.
 *
 * The trust model is "show everything, labeled, never hide". This control only
 * lets the voter narrow THEIR OWN view across three trust levels (stated only /
 * stated + record / everything). It persists to
 * users.quick_match_answers.visibility_level via a server action, then refreshes
 * so the server-rendered surface re-applies the level. Optimistic local state
 * keeps the segmented control responsive while the write is in flight.
 *
 * A short, always-available explainer spells out what each level shows so the
 * choice is informed — never a mystery toggle.
 */
export default function VisibilityControl({
  current,
}: {
  current?: VisibilityLevel | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<VisibilityLevel>(
    current ?? DEFAULT_VISIBILITY,
  );
  const [showExplainer, setShowExplainer] = useState(false);

  function choose(level: VisibilityLevel) {
    if (level === selected) return;
    setSelected(level); // optimistic
    startTransition(async () => {
      await setVisibilityLevelAction(level);
      router.refresh();
    });
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-[var(--color-text)]">
            How much do you want to see?
          </h2>
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)] leading-relaxed max-w-prose">
            We never hide a candidate&apos;s positions. This just sets how much
            of the evidence you want shown by default. Everything is labeled by
            where it came from.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowExplainer((v) => !v)}
          className="text-xs font-medium text-[var(--color-primary)] hover:underline shrink-0 min-h-[44px] sm:min-h-0 flex items-center"
          aria-expanded={showExplainer}
        >
          {showExplainer ? "Hide details" : "What do these mean?"}
        </button>
      </div>

      {/* Segmented control */}
      <div
        role="radiogroup"
        aria-label="Position visibility level"
        className="mt-3 inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-0.5 w-full sm:w-auto"
      >
        {VISIBILITY_LEVELS.map((lvl) => {
          const active = lvl.key === selected;
          return (
            <button
              key={lvl.key}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={isPending}
              onClick={() => choose(lvl.key)}
              title={lvl.description}
              className={`flex-1 sm:flex-none min-h-[40px] px-3 text-xs font-semibold rounded-md transition-colors ${
                active
                  ? "bg-[var(--civic-primary)] text-[var(--civic-on-primary)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--civic-primary-soft)]"
              } ${isPending ? "opacity-70 cursor-wait" : ""}`}
            >
              {lvl.label}
            </button>
          );
        })}
      </div>

      {/* Inline description of the current level — always visible, plain words */}
      <p className="mt-2 text-xs text-[var(--color-text-secondary)] leading-relaxed">
        {visibilityMeta(selected).description}
      </p>

      {/* Full explainer of all three levels */}
      {showExplainer && (
        <ul className="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3">
          {VISIBILITY_LEVELS.map((lvl) => (
            <li key={lvl.key} className="text-xs leading-relaxed">
              <span className="font-semibold text-[var(--color-text)]">
                {lvl.label}
              </span>
              <span className="text-[var(--color-text-secondary)]">
                {" "}
                — {lvl.description}
              </span>
            </li>
          ))}
          <li className="text-[11px] text-[var(--color-text-muted)] italic pt-1">
            Tip: positions hidden by a stricter level aren&apos;t deleted — they
            stay one click away.
          </li>
        </ul>
      )}
    </div>
  );
}
