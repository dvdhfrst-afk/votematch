"use client";

import { useState, useTransition } from "react";
import { submitDisputeAction } from "./actions";

type SubDim = {
  id: string;
  domain: string;
  name: string;
  spectrum_low: string;
  spectrum_high: string;
};

type Position = {
  id: string;
  sub_dimension_id: string;
  score: number;
  confidence: string;
  view_type: string;
  source_citations: Array<{ url: string; title: string; date?: string }>;
  ai_summary: string | null;
  created_at: string;
};

type ExistingDispute = {
  id: string;
  sub_dimension_id: string;
  dispute_type: string;
  status: string;
  created_at: string;
};

type DisputeType =
  | "wrong_score"
  | "wrong_topic"
  | "wrong_source"
  | "no_position"
  | "other";

const DISPUTE_TYPE_LABELS: Record<DisputeType, string> = {
  wrong_score: "Score is wrong (but topic is right)",
  wrong_topic: "Wrong topic — you didn't speak on this",
  wrong_source: "The cited source doesn't say what we claim",
  no_position: "You have not taken a public position on this",
  other: "Something else (explain below)",
};

const STATUS_LABELS: Record<string, string> = {
  submitted: "Submitted — waiting for review",
  in_review: "Under review",
  accepted: "Accepted — position corrected",
  rejected_evidence: "Reviewed — our original record was confirmed",
  rejected_off_topic: "Reviewed — dispute didn't match dimension",
  merged: "Merged into a related dispute",
};

export default function DisputesList({
  token,
  positions,
  subDims,
  existingDisputes,
}: {
  token: string;
  positions: Position[];
  subDims: SubDim[];
  existingDisputes: ExistingDispute[];
}) {
  const subDimById = new Map<string, SubDim>(subDims.map((sd) => [sd.id, sd]));
  const existingBySubDim = new Map<string, ExistingDispute[]>();
  for (const d of existingDisputes) {
    const arr = existingBySubDim.get(d.sub_dimension_id) ?? [];
    arr.push(d);
    existingBySubDim.set(d.sub_dimension_id, arr);
  }

  return (
    <div className="space-y-4">
      {positions.map((pos) => (
        <DisputeRow
          key={pos.id}
          token={token}
          position={pos}
          subDim={subDimById.get(pos.sub_dimension_id) ?? null}
          existing={existingBySubDim.get(pos.sub_dimension_id) ?? []}
        />
      ))}
    </div>
  );
}

function DisputeRow({
  token,
  position,
  subDim,
  existing,
}: {
  token: string;
  position: Position;
  subDim: SubDim | null;
  existing: ExistingDispute[];
}) {
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disputeType, setDisputeType] = useState<DisputeType>("wrong_score");
  const [suggestedScore, setSuggestedScore] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [isPending, startTransition] = useTransition();

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const parsedScore =
        suggestedScore === "" ? null : Number(suggestedScore);
      if (parsedScore != null && (Number.isNaN(parsedScore) || parsedScore < 0 || parsedScore > 1)) {
        setError("Suggested score must be a number between 0 and 1.");
        return;
      }
      const result = await submitDisputeAction({
        token,
        sub_dimension_id: position.sub_dimension_id,
        position_id: position.id,
        dispute_type: disputeType,
        suggested_score: parsedScore,
        reason: reason || null,
      });
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      setSubmitted(true);
      setOpen(false);
    });
  };

  const dimName = subDim?.name ?? position.sub_dimension_id;
  const lowLabel = subDim?.spectrum_low ?? "low";
  const highLabel = subDim?.spectrum_high ?? "high";
  const scorePct = Math.round(position.score * 100);

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
            {subDim?.domain ?? "unknown"}
          </div>
          <div className="text-lg font-bold text-[var(--color-text)]">
            {dimName}
          </div>
          <div className="text-xs text-[var(--color-text-secondary)] mt-1">
            <span>{lowLabel}</span>
            <span className="mx-1">↔</span>
            <span>{highLabel}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-[var(--color-text-muted)]">
            Inferred score
          </div>
          <div className="text-xl font-bold text-[var(--color-text)] tabular-nums">
            {scorePct}%
          </div>
          <div className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
            confidence: {position.confidence}
          </div>
        </div>
      </div>

      {position.ai_summary && (
        <p className="text-sm text-[var(--color-text-secondary)] mt-3 italic">
          &ldquo;{position.ai_summary}&rdquo;
        </p>
      )}

      {position.source_citations.length > 0 && (
        <div className="mt-2 text-xs text-[var(--color-text-muted)]">
          Source{position.source_citations.length > 1 ? "s" : ""}:{" "}
          {position.source_citations.slice(0, 3).map((c, i) => (
            <span key={c.url}>
              {i > 0 && ", "}
              <a
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {c.title || c.url}
              </a>
            </span>
          ))}
          {position.source_citations.length > 3 &&
            ` +${position.source_citations.length - 3} more`}
        </div>
      )}

      {existing.length > 0 && (
        <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <div className="font-semibold mb-1">
            You&apos;ve already disputed this dimension:
          </div>
          <ul className="space-y-0.5">
            {existing.map((d) => (
              <li key={d.id}>
                {STATUS_LABELS[d.status] ?? d.status} ·{" "}
                <span className="opacity-70">
                  {new Date(d.created_at).toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {submitted && (
        <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          Dispute submitted. A reviewer will look at it within a few business
          days. You&apos;ll keep seeing your dispute history above as we
          process it.
        </div>
      )}

      {!submitted && !open && (
        <button
          onClick={() => setOpen(true)}
          className="mt-3 text-sm text-[var(--color-primary)] font-medium underline hover:no-underline"
        >
          Dispute this position
        </button>
      )}

      {!submitted && open && (
        <div className="mt-4 border-t border-[var(--color-border)] pt-4 space-y-3">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-1">
              What&apos;s wrong?
            </label>
            <select
              className="w-full text-sm border border-[var(--color-border)] rounded px-2 py-1 bg-[var(--color-bg)]"
              value={disputeType}
              onChange={(e) => setDisputeType(e.target.value as DisputeType)}
            >
              {(
                Object.keys(DISPUTE_TYPE_LABELS) as DisputeType[]
              ).map((dt) => (
                <option key={dt} value={dt}>
                  {DISPUTE_TYPE_LABELS[dt]}
                </option>
              ))}
            </select>
          </div>

          {disputeType === "wrong_score" && (
            <div>
              <label className="block text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-1">
                Your suggested score (0.00 = strongly {lowLabel.toLowerCase()}, 1.00 = strongly {highLabel.toLowerCase()})
              </label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={suggestedScore}
                onChange={(e) => setSuggestedScore(e.target.value)}
                placeholder="e.g. 0.30"
                className="w-32 text-sm border border-[var(--color-border)] rounded px-2 py-1 bg-[var(--color-bg)]"
              />
              <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
                Informational — a reviewer will still verify before any change
                ships.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-1">
              Tell the reviewer why
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 2000))}
              maxLength={2000}
              rows={4}
              placeholder="Explain what's wrong and, if helpful, point to a primary source."
              className="w-full text-sm border border-[var(--color-border)] rounded px-2 py-1 bg-[var(--color-bg)]"
            />
            <div className="text-[11px] text-[var(--color-text-muted)] mt-1">
              {reason.length} / 2000
            </div>
          </div>

          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
              {error}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={onSubmit}
              disabled={isPending}
              className="text-sm font-medium px-3 py-1.5 rounded bg-[var(--color-primary)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? "Submitting…" : "Submit dispute"}
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              disabled={isPending}
              className="text-sm font-medium px-3 py-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-bg-muted)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
