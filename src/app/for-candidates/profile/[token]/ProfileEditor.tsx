"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { saveDraftAction } from "./actions";

type SubDim = {
  id: string;
  domain: string;
  name: string;
  spectrum_low: string;
  spectrum_high: string;
};

type Response = {
  score: number | null;
  explanation: string;
  citation: string;
};

const EXPLANATION_MAX = 600; // ~200 chars target, 600 hard cap
const EXPLANATION_TARGET = 200;

export default function ProfileEditor({
  token,
  candidateId,
  candidacyId,
  pendingClaimId,
  candidateName,
  subDims,
  priorResponses,
  isPending,
}: {
  token: string;
  candidateId: string | null;
  candidacyId: string | null;
  pendingClaimId: string | null;
  candidateName: string;
  subDims: SubDim[];
  priorResponses: Record<
    string,
    { score?: number | null; explanation?: string; citation?: string }
  >;
  isPending: boolean;
}) {
  // True when we have a real subject row to persist against (office-graph
  // candidacy OR legacy candidate). Pending claims can only draft locally.
  const canPersist = Boolean(candidateId || candidacyId);

  // Local-storage key — scoped to whichever id we have so a candidate's
  // drafts don't leak across portal claims on the same browser.
  const localKey = `bb_for_candidates_draft_${
    candidacyId
      ? `candidacy:${candidacyId}`
      : candidateId
        ? candidateId
        : `claim:${pendingClaimId ?? "unknown"}`
  }`;

  const initial = useMemo<Record<string, Response>>(() => {
    const fromLocal =
      typeof window !== "undefined"
        ? safeParseLocal(window.localStorage.getItem(localKey))
        : null;

    const seed: Record<string, Response> = {};
    for (const sd of subDims) {
      const prior = priorResponses[sd.id];
      const local = fromLocal?.[sd.id];
      seed[sd.id] = {
        score:
          typeof local?.score === "number"
            ? local.score
            : typeof prior?.score === "number"
              ? prior.score
              : null,
        explanation:
          typeof local?.explanation === "string"
            ? local.explanation
            : typeof prior?.explanation === "string"
              ? prior.explanation
              : "",
        citation:
          typeof local?.citation === "string"
            ? local.citation
            : typeof prior?.citation === "string"
              ? prior.citation
              : "",
      };
    }
    return seed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localKey, subDims.length]);

  const [responses, setResponses] = useState<Record<string, Response>>(initial);
  const [pending, startTransition] = useTransition();
  const [serverMessage, setServerMessage] = useState<
    { kind: "success" | "error"; text: string } | null
  >(null);

  function update(subDimId: string, patch: Partial<Response>) {
    setResponses((prev) => {
      const next = { ...prev, [subDimId]: { ...prev[subDimId], ...patch } };
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(localKey, JSON.stringify(next));
        } catch {
          /* quota / disabled */
        }
      }
      return next;
    });
  }

  const answeredCount = Object.values(responses).filter(
    (r) => r.score !== null,
  ).length;

  function onSaveDraft() {
    setServerMessage(null);
    startTransition(async () => {
      const result = await saveDraftAction({ token, responses });
      if (result.ok) {
        setServerMessage({
          kind: "success",
          text: "Draft saved. Continue editing or move on to affirm.",
        });
      } else {
        setServerMessage({ kind: "error", text: result.error });
      }
    });
  }

  function onPreviewLocally() {
    // Scrolls to the preview section. The preview itself is already
    // rendered inline below — no separate route to keep the user in flow.
    const el = document.getElementById("for-candidates-preview");
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Group by domain for readability.
  const byDomain = useMemo(() => {
    const map = new Map<string, SubDim[]>();
    for (const sd of subDims) {
      const arr = map.get(sd.domain) ?? [];
      arr.push(sd);
      map.set(sd.domain, arr);
    }
    return [...map.entries()];
  }, [subDims]);

  return (
    <div className="space-y-8">
      <div className="civic-card flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-[var(--color-text)]">
            Progress
          </p>
          <p className="text-xs text-[var(--color-text-muted)]">
            Drafts auto-save to this browser. Use Save draft to push to the
            server too.
          </p>
        </div>
        <p className="font-mono text-lg text-[var(--color-primary)] whitespace-nowrap">
          {answeredCount} / {subDims.length}
        </p>
      </div>

      {byDomain.map(([domain, group]) => (
        <section key={domain}>
          <h2 className="text-xl font-bold text-[var(--color-primary)] mb-3 capitalize">
            {domain.replace(/_/g, " ")}
          </h2>
          <div className="space-y-4">
            {group.map((sd) => {
              const r = responses[sd.id];
              return (
                <SubDimCard
                  key={sd.id}
                  sd={sd}
                  response={r}
                  onUpdate={(patch) => update(sd.id, patch)}
                />
              );
            })}
          </div>
        </section>
      ))}

      <PreviewBlock
        candidateName={candidateName}
        subDims={subDims}
        responses={responses}
      />

      <div className="civic-card space-y-3">
        {serverMessage && (
          <p
            className={`text-sm font-medium ${
              serverMessage.kind === "success"
                ? "text-emerald-700"
                : "text-red-700"
            }`}
          >
            {serverMessage.text}
          </p>
        )}

        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={onPreviewLocally}
            className="civic-btn-secondary flex-1 text-base py-3"
          >
            Jump to preview
          </button>
          <button
            type="button"
            onClick={onSaveDraft}
            disabled={pending || isPending || !canPersist}
            className="civic-btn-secondary flex-1 text-base py-3"
            title={
              isPending
                ? "Server save disabled until your claim is verified — your draft is still in your browser."
                : ""
            }
          >
            {pending ? "Saving…" : "Save draft to server"}
          </button>
          {canPersist && (
            <Link
              href={`/for-candidates/profile/${token}/affirm`}
              className="civic-btn-primary flex-1 text-base py-3 text-center"
            >
              Continue to affirm
            </Link>
          )}
        </div>

        {isPending && (
          <p className="text-xs text-[var(--color-text-muted)]">
            Affirmation is disabled while we verify your candidacy. Your
            draft is preserved in this browser.
          </p>
        )}
      </div>
    </div>
  );
}

function SubDimCard({
  sd,
  response,
  onUpdate,
}: {
  sd: SubDim;
  response: Response;
  onUpdate: (patch: Partial<Response>) => void;
}) {
  const sliderValue = response.score === null ? 0.5 : response.score;
  const remaining = EXPLANATION_TARGET - response.explanation.length;
  return (
    <div className="civic-card">
      <div className="flex items-baseline justify-between mb-1 gap-3">
        <p className="font-semibold text-[var(--color-text)] capitalize">
          {sd.name.replace(/_/g, " ")}
        </p>
        <span className="text-xs font-mono text-[var(--color-text-muted)]">
          {response.score === null ? "Not set" : sliderValue.toFixed(2)}
        </span>
      </div>

      <div className="flex items-center gap-3 mb-1">
        <span className="text-xs text-[var(--color-text-muted)] w-32 text-right">
          {sd.spectrum_low}
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={sliderValue}
          onChange={(e) =>
            onUpdate({ score: parseFloat(e.target.value) })
          }
          aria-label={`Position on ${sd.name}`}
          className="flex-1"
        />
        <span className="text-xs text-[var(--color-text-muted)] w-32">
          {sd.spectrum_high}
        </span>
      </div>

      <div className="flex items-center gap-3 mb-3">
        <button
          type="button"
          onClick={() => onUpdate({ score: null })}
          className="text-xs text-[var(--color-text-muted)] underline"
        >
          Skip / no position
        </button>
      </div>

      <label className="block mb-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Why? (optional, ~{EXPLANATION_TARGET} characters)
        </span>
        <textarea
          rows={2}
          value={response.explanation}
          maxLength={EXPLANATION_MAX}
          onChange={(e) => onUpdate({ explanation: e.target.value })}
          placeholder="Your own words. Voters see this on your profile."
          className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] focus:border-[var(--color-primary)] outline-none bg-white text-sm"
        />
        <span
          className={`text-xs ${
            remaining < 0
              ? "text-amber-700"
              : "text-[var(--color-text-muted)]"
          }`}
        >
          {response.explanation.length} / {EXPLANATION_TARGET}
        </span>
      </label>

      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Citation URL (optional, recommended)
        </span>
        <input
          type="url"
          value={response.citation}
          onChange={(e) => onUpdate({ citation: e.target.value })}
          placeholder="https://example.com/your-position-statement"
          className="mt-1 w-full px-3 py-2 rounded-lg border border-[var(--color-border)] focus:border-[var(--color-primary)] outline-none bg-white text-sm"
        />
      </label>
    </div>
  );
}

function PreviewBlock({
  candidateName,
  subDims,
  responses,
}: {
  candidateName: string;
  subDims: SubDim[];
  responses: Record<string, Response>;
}) {
  const answered = subDims.filter((sd) => responses[sd.id]?.score !== null);
  return (
    <section
      id="for-candidates-preview"
      aria-labelledby="for-candidates-preview-heading"
      className="bg-white border border-[var(--color-border)] rounded-xl p-6"
    >
      <h2
        id="for-candidates-preview-heading"
        className="text-lg font-bold text-[var(--color-primary)] mb-1"
      >
        Voter preview
      </h2>
      <p className="text-sm text-[var(--color-text-secondary)] mb-4">
        This is roughly how your positions appear on your public profile and
        in voter match results.
      </p>
      {answered.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          No positions set yet. Move at least one slider above to see the
          preview.
        </p>
      ) : (
        <ul className="space-y-3">
          {answered.map((sd) => {
            const r = responses[sd.id];
            return (
              <li
                key={sd.id}
                className="border-l-2 border-[var(--color-primary)] pl-3"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-[var(--color-text)] capitalize">
                    {sd.name.replace(/_/g, " ")}
                  </span>
                  <span className="text-xs font-mono text-[var(--color-text-muted)]">
                    {r.score!.toFixed(2)}
                  </span>
                </div>
                {r.explanation.trim() && (
                  <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                    &ldquo;{r.explanation.trim()}&rdquo;{" "}
                    <span className="text-xs text-[var(--color-text-muted)]">
                      — {candidateName || "candidate"}
                    </span>
                  </p>
                )}
                {r.citation.trim() && (
                  <p className="text-xs text-[var(--color-text-muted)] mt-1">
                    Source: {r.citation.trim()}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function safeParseLocal(raw: string | null): Record<string, Response> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
