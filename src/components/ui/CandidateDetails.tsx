"use client";

import { useState } from "react";
import Link from "next/link";

interface CandidateDetailsProps {
  candidateId: string;
  candidateName: string;
  agreements?: string[];
  disagreements?: string[];
}

export default function CandidateDetails({
  candidateId,
  candidateName,
  agreements = [],
  disagreements = [],
}: CandidateDetailsProps) {
  const [expanded, setExpanded] = useState(false);

  const hasContent = agreements.length > 0 || disagreements.length > 0;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-sm font-medium text-[var(--color-primary)] hover:underline"
      >
        {expanded ? "Hide details" : "More details"}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 text-sm">
          {agreements.length > 0 && (
            <div>
              <p className="font-semibold text-emerald-700 mb-1">Agreements</p>
              <ul className="list-disc list-inside text-[var(--color-text-secondary)] space-y-0.5">
                {agreements.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}

          {disagreements.length > 0 && (
            <div>
              <p className="font-semibold text-amber-700 mb-1">Disagreements</p>
              <ul className="list-disc list-inside text-[var(--color-text-secondary)] space-y-0.5">
                {disagreements.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}

          {!hasContent && (
            <p className="text-[var(--color-text-muted)] italic">
              No detailed match data available yet.
            </p>
          )}

          <Link
            href={`/candidate/${candidateId}`}
            className="inline-block text-sm font-medium text-[var(--color-primary)] hover:underline mt-1"
          >
            View full profile for {candidateName}
          </Link>
        </div>
      )}
    </div>
  );
}
