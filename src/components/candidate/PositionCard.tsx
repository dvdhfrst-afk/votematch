"use client";

import { useState } from "react";
import type { Position, SubDimension, Domain } from "@/types/database";
import ConfidenceBadge from "@/components/ui/ConfidenceBadge";
import SourceTierBadge from "@/components/ui/SourceTierBadge";
import { firstQuote } from "@/lib/provenance";

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

export default function PositionCard({
  position,
  subDimension,
  candidateId,
}: {
  position: Position;
  subDimension: SubDimension;
  candidateId?: string;
}) {
  const [showNuance, setShowNuance] = useState(false);

  const pct = Math.round(position.score * 100);
  const isLowConfidence = position.confidence === 'low';
  const sourceCount = position.source_citations.length;
  const quote = firstQuote(position.source_citations);

  return (
    <div className="civic-card">
      {/* Header — name + domain on the left; provenance tier + confidence on
          the right. The tier label says WHERE this came from (stated / record
          / media / AI-inferred); confidence says how sure we are. */}
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
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <SourceTierBadge tier={position.source_tier} />
          <ConfidenceBadge confidence={position.confidence} />
        </div>
      </div>

      {/* Spectrum bar */}
      <div className="mt-4">
        <div className="flex justify-between text-xs text-[var(--color-text-muted)] mb-1.5">
          <span>{subDimension.spectrum_low}</span>
          <span>{subDimension.spectrum_high}</span>
        </div>
        <div className="relative h-3 bg-gradient-to-r from-slate-200 to-slate-500 rounded-full">
          <div
            className="absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-[var(--color-primary)] border-3 border-white shadow-md transition-all duration-300"
            style={{ left: `calc(${pct}% - 10px)` }}
          />
        </div>
      </div>

      {/* AI summary — the neutral one-sentence narration of this position.
          This is what voters read first; nuance notes are secondary. */}
      {position.ai_summary && (
        <p className="mt-3 text-sm text-[var(--color-text-secondary)] leading-relaxed">
          {position.ai_summary}
        </p>
      )}

      {/* Direct quote — when a citation captured the candidate's (or source's)
          own words, show them verbatim so the voter can judge the basis
          themselves rather than trusting only our paraphrase. */}
      {quote && (
        <blockquote className="mt-3 border-l-2 border-[var(--color-border)] pl-3 text-sm italic text-[var(--color-text-secondary)] leading-relaxed">
          &ldquo;{quote}&rdquo;
        </blockquote>
      )}

      {/* Sources — blueprint-v6 §7.5 never-impute: every position must cite.
          Council #32 voter-perspective patch: surface view_type provenance and
          single-source warnings so voters can tell "candidate's own words"
          from "AI inference from a news article" — the legacy single-view
          card was ambiguous on both axes. */}
      {position.source_citations.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-1">
            {position.view_type === 'stated'
              ? `Cited from ${sourceCount === 1 ? 'one source' : `${sourceCount} sources`}`
              : `Inferred from ${sourceCount === 1 ? 'one public-record source' : `${sourceCount} public-record sources`}`}
          </p>
          <p className="text-[11px] text-[var(--color-text-muted)] italic mb-1.5 leading-snug">
            {position.view_type === 'stated'
              ? "Sources may be the candidate's own materials or third-party reporting that paraphrases them. Click through to see which."
              : "AI-paraphrased from voting records, news coverage, or interviews. Not the candidate’s direct words."}
          </p>
          {sourceCount === 1 && (
            <p className="text-[11px] text-amber-700 italic mb-1.5">
              Based on a single source — read it before relying on this score.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {position.source_citations.map((src, i) => {
              const label = src.title || `Source ${i + 1}`;
              if (src.url) {
                return (
                  <a
                    key={i}
                    href={src.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[var(--color-primary)] hover:underline"
                  >
                    {label}
                  </a>
                );
              }
              return (
                <span key={i} className="text-xs text-[var(--color-text-muted)]">
                  {label}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Nuance notes + low-confidence explanation — behind a toggle */}
      {(position.nuance_notes || isLowConfidence) && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowNuance(!showNuance)}
            className="text-xs font-medium text-[var(--color-primary)] hover:underline"
          >
            {showNuance
              ? "Hide classifier notes"
              : isLowConfidence
                ? "Why is confidence low?"
                : "Why this score?"}
          </button>
          {showNuance && (
            <div className="mt-2 text-sm text-[var(--color-text-secondary)] bg-[var(--color-bg-alt)] p-3 rounded-lg space-y-2">
              {isLowConfidence && (
                <div>
                  <p className="font-semibold text-[var(--color-text)]">
                    Low confidence means we&apos;re not fully sure.
                  </p>
                  <p className="mt-1">
                    Our classifier flags a score as low-confidence when one or
                    more of these apply: few sources (we have{" "}
                    <strong>{sourceCount} source{sourceCount === 1 ? "" : "s"}</strong>{" "}
                    on file for this issue), mixed signals across sources, or
                    reliance on paraphrased/third-party reporting instead of
                    the candidate&apos;s direct words. Read the notes below
                    before relying on this number.
                  </p>
                </div>
              )}
              {position.nuance_notes && (
                <p className={isLowConfidence ? "pt-2 border-t border-[var(--color-border)]" : ""}>
                  {position.nuance_notes}
                </p>
              )}
              {isLowConfidence && candidateId && (
                <p className="pt-2 border-t border-[var(--color-border)]">
                  Know more than we do?{" "}
                  <a
                    href={`/corrections/new?candidate_id=${candidateId}`}
                    className="font-medium text-[var(--color-primary)] hover:underline"
                  >
                    Submit a correction with evidence →
                  </a>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
