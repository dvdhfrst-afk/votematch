import Link from "next/link";
import type { Candidate, Confidence } from "@/types/database";
import MatchBar from "@/components/ui/MatchBar";
import ConfidenceBadge from "@/components/ui/ConfidenceBadge";

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const PARTY_COLORS: Record<string, string> = {
  Republican: "text-red-700 bg-red-50",
  Democrat: "text-blue-700 bg-blue-50",
  Democratic: "text-blue-700 bg-blue-50",
  Libertarian: "text-yellow-700 bg-yellow-50",
  Independent: "text-gray-700 bg-gray-50",
  "United Utah": "text-purple-700 bg-purple-50",
};

/**
 * Optional voter-view signals carried alongside the base Candidate type.
 * Both default to false at the call site so callers that haven't opted in
 * to the augmented type still render unchanged.
 */
interface CandidateWithSignals extends Candidate {
  selfAttested?: boolean;
  wellDocumented?: boolean;
}

export default function CandidateRow({
  candidate,
  matchScore,
  matchConfidence,
}: {
  candidate: CandidateWithSignals;
  matchScore?: number;
  matchConfidence?: Confidence;
}) {
  const initials = getInitials(candidate.name);
  const partyStyle =
    PARTY_COLORS[candidate.party ?? ""] ?? "text-gray-700 bg-gray-50";

  // Issue E: photo only renders when the underlying view said so.
  // v_voter_candidates already nulls photo_url when the candidate hasn't
  // opted in via /for-candidates. Defensive double-check here so a future
  // direct-table caller can't accidentally surface a photo.
  const showPhoto = Boolean(candidate.photo_url) && candidate.selfAttested === true;

  return (
    <Link
      href={`/candidate/${candidate.id}`}
      className="flex items-center gap-4 p-3 rounded-lg hover:bg-[var(--color-bg-alt)] transition-colors group"
    >
      {/* Photo placeholder */}
      <div className="w-12 h-12 rounded-full bg-[var(--color-bg-muted)] flex items-center justify-center text-[var(--color-primary)] font-bold text-sm shrink-0">
        {showPhoto && candidate.photo_url ? (
          <img
            src={candidate.photo_url}
            alt={candidate.name}
            className="w-12 h-12 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-[var(--color-text)] group-hover:text-[var(--color-primary)] transition-colors">
            {candidate.name}
          </span>
          {/* Party — empty-state copy convention. Placeholder pill rather
              than nothing so the row layout stays consistent. */}
          {candidate.party ? (
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${partyStyle}`}
            >
              {candidate.party}
            </span>
          ) : (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full text-[var(--color-text-muted)] bg-[var(--color-bg-muted)] italic">
              Party not yet filed
            </span>
          )}

          {/* Issue D: per-candidate badges. Self-attested ranks higher than
              well-documented (own-words > coverage); show both when both
              apply. Hidden when neither is set so the row stays clean. */}
          {candidate.selfAttested && (
            <span
              className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full text-emerald-800 bg-emerald-50 border border-emerald-200"
              title="Candidate has personally affirmed these positions via the Havesay candidate portal."
            >
              <svg
                className="w-3 h-3"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2.5}
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4.5 12.75l6 6 9-13.5"
                />
              </svg>
              Verified by candidate
            </span>
          )}
          {candidate.wellDocumented && !candidate.selfAttested && (
            <span
              className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full text-sky-800 bg-sky-50 border border-sky-200"
              title="We have at least 10 high- or medium-confidence classified positions, 5+ cited sources, and 2+ source types for this candidate."
            >
              <svg
                className="w-3 h-3"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              Well-documented
            </span>
          )}
        </div>

        {/* Match score */}
        {matchScore !== undefined && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="flex-1 max-w-[200px]">
              <MatchBar percentage={matchScore} size="small" />
            </div>
            {matchConfidence && (
              <ConfidenceBadge confidence={matchConfidence} />
            )}
          </div>
        )}
      </div>

      {/* Arrow */}
      <svg
        className="w-5 h-5 text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8.25 4.5l7.5 7.5-7.5 7.5"
        />
      </svg>
    </Link>
  );
}
