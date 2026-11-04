"use client";

import { useState, useTransition } from "react";
import {
  claimAdditionalCandidateAction,
  dismissCandidateClaimAction,
} from "../actions";

type CandidateRow = {
  id: string;
  name: string;
  party: string | null;
  photo_url: string | null;
  race_label: string | null;
  state_or_district: string | null;
};

type LocalState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "submitting" }
  | { kind: "success"; status: "pending" | "merged" }
  | { kind: "dismissed" }
  | { kind: "error"; message: string };

export default function RelatedCandidatesList({
  token,
  primaryName,
  suggestions,
}: {
  token: string;
  primaryName: string;
  suggestions: CandidateRow[];
}) {
  return (
    <ul className="space-y-3">
      {suggestions.map((c) => (
        <SuggestionCard
          key={c.id}
          token={token}
          primaryName={primaryName}
          candidate={c}
        />
      ))}
    </ul>
  );
}

function SuggestionCard({
  token,
  primaryName,
  candidate,
}: {
  token: string;
  primaryName: string;
  candidate: CandidateRow;
}) {
  const [state, setState] = useState<LocalState>({ kind: "idle" });
  const [retypedName, setRetypedName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();

  function onYesClick() {
    setState({ kind: "confirming" });
  }

  function onCancelConfirm() {
    setRetypedName("");
    setConfirmed(false);
    setState({ kind: "idle" });
  }

  function onSubmitClaim() {
    setState({ kind: "submitting" });
    startTransition(async () => {
      const result = await claimAdditionalCandidateAction({
        token,
        claimedCandidateId: candidate.id,
        retypedName,
        confirmed,
      });
      if (!result.ok) {
        setState({ kind: "error", message: result.error });
        return;
      }
      setState({ kind: "success", status: result.status });
    });
  }

  function onDismiss() {
    setState({ kind: "submitting" });
    startTransition(async () => {
      const result = await dismissCandidateClaimAction({
        token,
        claimedCandidateId: candidate.id,
      });
      if (!result.ok) {
        setState({ kind: "error", message: result.error });
        return;
      }
      setState({ kind: "dismissed" });
    });
  }

  // Terminal states render compact rows.
  if (state.kind === "success") {
    return (
      <li className="civic-card border-emerald-300 bg-emerald-50">
        <p className="font-semibold text-[var(--color-text)]">
          {candidate.name}
        </p>
        {candidate.race_label && (
          <p className="text-sm text-[var(--color-text-secondary)]">
            {candidate.race_label}
          </p>
        )}
        <p className="text-xs text-emerald-900 mt-2">
          Claim recorded. Awaiting merge by a Havesay volunteer.
        </p>
      </li>
    );
  }
  if (state.kind === "dismissed") {
    return (
      <li className="civic-card opacity-60">
        <p className="font-semibold text-[var(--color-text)]">
          {candidate.name}
        </p>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">
          Dismissed — won&apos;t be shown again.
        </p>
      </li>
    );
  }

  return (
    <li className="civic-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[var(--color-text)] truncate">
            {candidate.name}
          </p>
          {candidate.race_label && (
            <p className="text-sm text-[var(--color-text-secondary)] truncate">
              {candidate.race_label}
            </p>
          )}
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            {[
              candidate.party,
              candidate.state_or_district,
              `id: ${candidate.id.slice(0, 8)}…`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {candidate.photo_url && (
          // Photo opt-in is per-candidate; we don't enforce here because
          // these are non-public-side admin-style decisions for the candidate.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={candidate.photo_url}
            alt=""
            className="w-12 h-12 rounded-full object-cover bg-gray-100"
          />
        )}
      </div>

      {state.kind === "idle" && (
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={onYesClick}
            className="civic-btn-primary px-4 py-2 text-sm"
          >
            Yes, also me
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={pending}
            className="civic-btn-secondary px-4 py-2 text-sm"
          >
            No, different person
          </button>
        </div>
      )}

      {(state.kind === "confirming" ||
        state.kind === "submitting" ||
        state.kind === "error") && (
        <div className="mt-3 pt-3 border-t border-[var(--color-border)] space-y-3">
          <p className="text-sm text-[var(--color-text-secondary)]">
            To confirm <strong>{candidate.name}</strong> is also you, retype
            your full name and check the box below. This is recorded as a
            tier-1 self-attestation.
          </p>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              Retype your full name
            </span>
            <input
              type="text"
              value={retypedName}
              onChange={(e) => setRetypedName(e.target.value)}
              placeholder={primaryName}
              autoComplete="off"
              className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] focus:border-[var(--color-primary)] outline-none bg-white text-sm"
            />
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-1"
            />
            <span className="text-sm text-[var(--color-text-secondary)]">
              I confirm I am also this candidate. I understand this will
              merge the records on Havesay under my attested identity.
            </span>
          </label>
          {state.kind === "error" && (
            <p className="text-sm text-red-700 font-medium">
              {state.message}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSubmitClaim}
              disabled={
                pending ||
                state.kind === "submitting" ||
                !confirmed ||
                retypedName.trim().length < 2
              }
              className="civic-btn-primary px-4 py-2 text-sm"
            >
              {state.kind === "submitting" ? "Submitting…" : "Submit claim"}
            </button>
            <button
              type="button"
              onClick={onCancelConfirm}
              disabled={pending}
              className="civic-btn-secondary px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
