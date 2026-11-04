"use client";

import { useEffect, useState } from "react";

/**
 * Stated / Inferred / Both toggle for the candidate profile positions grid.
 *
 * Council decision 007 §5.2. Defaults to `both` (side-by-side comparison is
 * the distinguishing feature of the two-view product — don't hide it behind
 * a click). The choice persists to localStorage under `bb_view_toggle` so
 * the setting survives page reloads within the same browser.
 *
 * Emits the selection to the parent via `onChange` and also sets the
 * `?view=` query-string param on the current URL so the state is shareable
 * and back/forward nav works. The candidate profile page reads this value
 * and filters which panels render inside each `TwoViewPositionCard`.
 *
 * Gated by `NEXT_PUBLIC_ENABLE_TWO_VIEW` at the caller site — when the flag
 * is off, the caller shouldn't render this component at all.
 */

export type ViewToggleValue = "stated" | "inferred" | "both";

const STORAGE_KEY = "bb_view_toggle";
const QUERY_PARAM = "view";

const OPTIONS: Array<{
  value: ViewToggleValue;
  label: string;
  hint: string;
}> = [
  {
    value: "both",
    label: "Both (side-by-side)",
    hint: "Compare stated and inferred views on the same card.",
  },
  {
    value: "stated",
    label: "Stated (candidate's words)",
    hint: "Only the candidate's own campaign materials and direct quotes.",
  },
  {
    value: "inferred",
    label: "Inferred (record & coverage)",
    hint: "Our analysis of the candidate's record, votes, and reporting.",
  },
];

function readInitial(defaultValue: ViewToggleValue): ViewToggleValue {
  if (typeof window === "undefined") return defaultValue;

  // URL takes precedence (shareable link), then localStorage, then default.
  try {
    const params = new URLSearchParams(window.location.search);
    const q = params.get(QUERY_PARAM);
    if (q === "stated" || q === "inferred" || q === "both") return q;
  } catch {
    // URLSearchParams can throw on malformed input — fall through.
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "stated" || stored === "inferred" || stored === "both") {
      return stored;
    }
  } catch {
    // localStorage disabled / SecurityError — fall through.
  }

  return defaultValue;
}

export default function ViewToggle({
  value: controlledValue,
  onChange,
  defaultValue = "both",
}: {
  /** When provided, component runs as a controlled input. */
  value?: ViewToggleValue;
  /** Called whenever the user picks a different view. */
  onChange?: (next: ViewToggleValue) => void;
  /** Initial value when uncontrolled. Defaults to `both`. */
  defaultValue?: ViewToggleValue;
}) {
  // We intentionally start with `defaultValue` on the server so SSR renders
  // deterministically; the `useEffect` below re-reads the persisted choice
  // on mount. Without this guard, hydration would mismatch for any user
  // whose stored preference differs from the default.
  const [internal, setInternal] = useState<ViewToggleValue>(defaultValue);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const next = readInitial(defaultValue);
    setInternal(next);
    setHydrated(true);
    // If the URL or storage value doesn't match the current default, emit
    // once so the parent page reflects the persisted state immediately.
    if (next !== defaultValue) {
      onChange?.(next);
    }
    // We intentionally only run this on mount — readInitial touches
    // window.location and localStorage which are stable within a mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const effective = controlledValue ?? internal;

  function handleChange(next: ViewToggleValue) {
    if (controlledValue === undefined) setInternal(next);

    // Persist. Fail silently — we don't want a blocked third-party cookie
    // setting to break the UI.
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }

    // Reflect in the URL so refresh and share both work. `replaceState`
    // avoids a new history entry per click (which would trash the Back
    // button).
    try {
      const url = new URL(window.location.href);
      url.searchParams.set(QUERY_PARAM, next);
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* ignore */
    }

    onChange?.(next);
  }

  return (
    <fieldset
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
      aria-label="Choose which view(s) to show"
      // Avoid a layout flash on hydrate — the fieldset is always visible,
      // but controls become interactive once we've resolved the stored value.
      data-hydrated={hydrated ? "true" : "false"}
    >
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        Show
      </legend>
      <div className="flex flex-wrap gap-2 mt-1">
        {OPTIONS.map((opt) => {
          const isActive = effective === opt.value;
          return (
            <label
              key={opt.value}
              className={`flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer text-sm transition-colors ${
                isActive
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5"
                  : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
              }`}
              title={opt.hint}
            >
              <input
                type="radio"
                name="bb-view-toggle"
                value={opt.value}
                checked={isActive}
                onChange={() => handleChange(opt.value)}
                className="mt-1 accent-[var(--color-primary)]"
              />
              <span>
                <span className="font-medium text-[var(--color-text)] block">
                  {opt.label}
                </span>
                <span className="block text-xs text-[var(--color-text-muted)] mt-0.5">
                  {opt.hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
