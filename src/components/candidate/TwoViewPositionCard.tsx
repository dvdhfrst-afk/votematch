"use client";

import { useState } from "react";
import type { Position, SubDimension, Domain } from "@/types/database";
import ConfidenceBadge from "@/components/ui/ConfidenceBadge";
import SourceTierBadge from "@/components/ui/SourceTierBadge";
import { firstQuote } from "@/lib/provenance";

/**
 * Shows one sub-dimension with both STATED (candidate's own words) and
 * INFERRED (our analysis of full record) positions side-by-side, with a
 * gap indicator when they diverge.
 *
 * The gap is the accountability feature — when stated.score and
 * inferred.score disagree by >0.25, we surface it prominently. This is what
 * distinguishes Havesay from other VAAs that show only one position
 * per issue.
 *
 * If only one view exists (e.g., no stated position because candidate has
 * no tier-1 sources on this issue), the card degrades gracefully — shows
 * the one view with a clear "no stated position yet" label.
 */

const DOMAIN_LABELS: Record<Domain, string> = {
  economy: "Economy",
  social: "Social Issues",
  healthcare: "Healthcare",
  education: "Education",
  environment: "Environment",
  governance: "Governance",
  public_safety: "Public Safety",
  infrastructure: "Infrastructure",
};

const DOMAIN_COLORS: Record<Domain, string> = {
  economy: "bg-emerald-100 text-emerald-800",
  social: "bg-purple-100 text-purple-800",
  healthcare: "bg-red-100 text-red-800",
  education: "bg-blue-100 text-blue-800",
  environment: "bg-green-100 text-green-800",
  governance: "bg-indigo-100 text-indigo-800",
  public_safety: "bg-orange-100 text-orange-800",
  infrastructure: "bg-slate-100 text-slate-800",
};

export default function TwoViewPositionCard({
  stated,
  inferred,
  subDimension,
}: {
  stated: Position | null;
  inferred: Position | null;
  subDimension: SubDimension;
}) {
  const [showDetail, setShowDetail] = useState(false);

  // If neither view exists, render nothing (caller shouldn't call us)
  if (!stated && !inferred) return null;

  // Stable id for the card's sources/citation section so the inferred-panel
  // "see primary sources" link can scroll the user directly to it. Same id
  // is used by the detail toggle below.
  const detailSectionId = `card-sources-${subDimension.id}`;

  const statedPct = stated ? Math.round(stated.score * 100) : null;
  const inferredPct = inferred ? Math.round(inferred.score * 100) : null;
  const hasBoth = stated && inferred;
  const gap = hasBoth ? Math.abs(stated.score - inferred.score) : null;
  const wideGap = gap !== null && gap > 0.25;
  const agree = gap !== null && gap <= 0.15;

  return (
    <div
      className={`civic-card ${
        wideGap ? "border-l-4 border-slate-400" : ""
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="font-bold text-[var(--color-text)]">
            {subDimension.name}
          </h3>
          <span
            className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full mt-1 ${DOMAIN_COLORS[subDimension.domain]}`}
          >
            {DOMAIN_LABELS[subDimension.domain]}
          </span>
        </div>
        {wideGap && (
          <span
            className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-100 text-slate-700"
            title="The candidate's own campaign materials describe this issue differently than our analysis of their public record. Compare both views below."
          >
            Stated differs from record — compare below
          </span>
        )}
        {agree && (
          <span className="text-xs font-semibold px-2 py-1 rounded-full bg-emerald-100 text-emerald-900">
            ✓ Stated matches record
          </span>
        )}
      </div>

      {/* Combined spectrum bar with both pins */}
      <div className="mt-4">
        <div className="flex justify-between text-xs text-[var(--color-text-muted)] mb-1.5">
          <span>{subDimension.spectrum_low}</span>
          <span>{subDimension.spectrum_high}</span>
        </div>
        <div className="relative h-4 bg-gradient-to-r from-slate-200 to-slate-500 rounded-full">
          {statedPct !== null && (
            <div
              className="absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white border-[3px] border-[var(--color-primary)] shadow-md z-10"
              style={{ left: `calc(${statedPct}% - 10px)` }}
              title={`Stated: ${stated!.score.toFixed(2)}`}
            />
          )}
          {inferredPct !== null && (
            <div
              className="absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-[var(--color-primary)] border-[3px] border-white shadow-md"
              style={{ left: `calc(${inferredPct}% - 10px)` }}
              title={`Inferred: ${inferred!.score.toFixed(2)}`}
            />
          )}
          {/* Connecting line between pins when both exist */}
          {hasBoth && gap !== null && gap > 0.05 && (
            <div
              className="absolute top-1/2 -translate-y-1/2 h-1 bg-[var(--color-primary)]/40 rounded"
              style={{
                left: `${Math.min(statedPct!, inferredPct!)}%`,
                width: `${Math.abs(statedPct! - inferredPct!)}%`,
              }}
            />
          )}
        </div>
        {/* Legend */}
        <div className="flex gap-4 mt-2 text-xs text-[var(--color-text-muted)]">
          {stated && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full bg-white border-[2px] border-[var(--color-primary)]" />
              Stated {stated.score.toFixed(2)}
            </span>
          )}
          {inferred && (
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full bg-[var(--color-primary)] border-[2px] border-white" />
              Inferred {inferred.score.toFixed(2)}
            </span>
          )}
        </div>
      </div>

      {/* Per-view detail panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
        {/* STATED */}
        <div className="bg-[var(--color-bg-alt)] rounded-lg p-3">
          <div className="flex items-start justify-between gap-2 mb-1">
            <span className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">
              Stated
            </span>
            <div className="flex flex-col items-end gap-1 shrink-0">
              {stated?.source_tier && <SourceTierBadge tier={stated.source_tier} size="xs" />}
              {stated && <ConfidenceBadge confidence={stated.confidence} />}
            </div>
          </div>
          {stated ? (
            <>
              <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                {stated.ai_summary ?? stated.nuance_notes ?? "—"}
              </p>
              {firstQuote(stated.source_citations) && (
                <blockquote className="mt-2 border-l-2 border-[var(--color-border)] pl-2.5 text-xs italic text-[var(--color-text-secondary)] leading-relaxed">
                  &ldquo;{firstQuote(stated.source_citations)}&rdquo;
                </blockquote>
              )}
              <p className="mt-2 text-xs text-[var(--color-text-muted)] italic">
                From the candidate&apos;s own campaign materials.
              </p>
            </>
          ) : (
            <p className="text-sm text-[var(--color-text-muted)] italic">
              No stated position on this issue in the candidate&apos;s official
              materials. Consider this an invitation for them to weigh in.
            </p>
          )}
        </div>

        {/* INFERRED */}
        <div className="bg-[var(--color-bg-alt)] rounded-lg p-3">
          <div className="flex items-start justify-between gap-2 mb-1">
            <span className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">
              Inferred from record
            </span>
            <div className="flex flex-col items-end gap-1 shrink-0">
              {inferred?.source_tier && <SourceTierBadge tier={inferred.source_tier} size="xs" />}
              {inferred && <ConfidenceBadge confidence={inferred.confidence} />}
            </div>
          </div>
          {inferred ? (
            <>
              <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
                {inferred.ai_summary ?? inferred.nuance_notes ?? "—"}
              </p>
              {firstQuote(inferred.source_citations) && (
                <blockquote className="mt-2 border-l-2 border-[var(--color-border)] pl-2.5 text-xs italic text-[var(--color-text-secondary)] leading-relaxed">
                  &ldquo;{firstQuote(inferred.source_citations)}&rdquo;
                </blockquote>
              )}
              <p className="mt-2 text-xs text-[var(--color-text-muted)] italic">
                Based on our analysis of voting records, interviews, and media
                coverage.
              </p>
              {/*
                UCA § 20A-11-1801 synthetic-media disclosure (Utah 2024 HB 118).
                Applies to INFERRED panels only — this block is AI-paraphrased
                from multiple public sources and is not the candidate's own
                words. The STATED panel is exempt because it reproduces the
                candidate's own materials.
                See 13-community-features/02-legal-review-packet.md:58 and
                15-council/decisions/007-two-view-implementation-plan.md §5.1.
              */}
              <p className="mt-3 pt-2 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)] leading-snug">
                <span aria-label="AI-generated content disclosure">
                  AI-paraphrased from public sources. Not the candidate&apos;s
                  direct words.
                </span>{" "}
                <a
                  href={`#${detailSectionId}`}
                  onClick={(e) => {
                    // Make sure the sources section is expanded when the
                    // reader follows the link — otherwise the anchor jumps to
                    // a collapsed region and they see nothing.
                    e.preventDefault();
                    setShowDetail(true);
                    // Next tick: let state flush so the target exists, then
                    // scroll it into view. No-op on SSR.
                    if (typeof window !== "undefined") {
                      queueMicrotask(() => {
                        document
                          .getElementById(detailSectionId)
                          ?.scrollIntoView({ behavior: "smooth", block: "start" });
                      });
                    }
                  }}
                  className="underline text-[var(--color-primary)] hover:opacity-80"
                >
                  See primary sources &rarr;
                </a>
              </p>
            </>
          ) : (
            <p className="text-sm text-[var(--color-text-muted)] italic">
              Not enough public record to infer a position beyond what the
              candidate has stated.
            </p>
          )}
        </div>
      </div>

      {/* Detail toggle: sources + nuance */}
      {(stated || inferred) && (
        <div className="mt-3" id={detailSectionId}>
          <button
            type="button"
            onClick={() => setShowDetail(!showDetail)}
            className="text-xs font-medium text-[var(--color-primary)] hover:underline"
          >
            {showDetail ? "Hide" : "See"} sources and classifier notes
          </button>
          {showDetail && (
            <div className="mt-2 space-y-3">
              {stated && (
                <DetailPanel label="Stated view" position={stated} />
              )}
              {inferred && (
                <DetailPanel label="Inferred view" position={inferred} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailPanel({ label, position }: { label: string; position: Position }) {
  return (
    <div className="bg-[var(--color-bg-alt)] rounded-lg p-3 text-sm">
      <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-2">
        {label}
      </p>
      {position.nuance_notes && (
        <p className="text-[var(--color-text-secondary)] mb-2">
          {position.nuance_notes}
        </p>
      )}
      {position.source_citations.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-1">
            Sources ({position.source_citations.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {position.source_citations.slice(0, 8).map((src, i) => {
              const display = src.title || `Source ${i + 1}`;
              if (src.url) {
                return (
                  <a
                    key={i}
                    href={src.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[var(--color-primary)] hover:underline"
                  >
                    {display}
                  </a>
                );
              }
              return (
                <span
                  key={i}
                  className="text-xs text-[var(--color-text-muted)]"
                >
                  {display}
                </span>
              );
            })}
            {position.source_citations.length > 8 && (
              <span className="text-xs text-[var(--color-text-muted)]">
                +{position.source_citations.length - 8} more
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
