import SourceTierBadge from "@/components/ui/SourceTierBadge";

/**
 * "What we found online about you" (read-only, server-rendered).
 *
 * Shows the candidate the AI-inferred positions Havesay has derived from
 * their public record (view_type='inferred'), with the score, the inferred
 * stance summary, and the source citations behind it. This is purely
 * informational: it lets a logged-in candidate SEE what we found so they can
 * decide to put their own words first via the editor above.
 *
 * This is NOT the counsel-gated dispute flow. It never links to
 * /disputes. Corrections route through the candidate's claim email, matching
 * the portal's existing support convention (support@example.org).
 *
 * The read path mirrors the disputes page: office-graph candidacies read
 * positions by person_id, legacy candidates by candidate_id. See
 * loadPortalSubject + DATA-MAP.md for the keying contract.
 */

type SubDim = {
  id: string;
  domain: string;
  name: string;
  spectrum_low: string;
  spectrum_high: string;
};

type Citation = { url?: string; title?: string; quote?: string | null };

export type FoundPosition = {
  id: string;
  sub_dimension_id: string;
  score: number;
  confidence: string;
  source_tier: string | null;
  source_citations: Citation[];
  ai_summary: string | null;
};

export default function FoundOnlineSection({
  positions,
  subDims,
}: {
  positions: FoundPosition[];
  subDims: SubDim[];
}) {
  const subDimById = new Map<string, SubDim>(subDims.map((sd) => [sd.id, sd]));

  return (
    <section
      aria-labelledby="found-online-heading"
      className="civic-card mb-6 border-l-4 border-[var(--color-primary)]"
    >
      <h2
        id="found-online-heading"
        className="font-semibold text-[var(--color-text)] mb-1"
      >
        What we found online about you
      </h2>
      <p className="text-sm text-[var(--color-text-secondary)]">
        These positions are AI-inferred from your public record (statements,
        coverage, and where applicable your voting record). They are our best
        read of where you likely stand, not your own words. Voters always see
        them clearly labeled as inferred, kept separate from anything you state
        yourself. Setting your own positions in the editor below is how you put
        your own words first.
      </p>

      {positions.length === 0 ? (
        <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            We have not found public position statements for you yet.
          </p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            Set your positions in the editor below so voters see your own words
            first.
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-[var(--color-text-muted)] mt-3 mb-2">
            {positions.length} inferred position
            {positions.length === 1 ? "" : "s"} on file. Expand each to see the
            stance and the sources behind it.
          </p>
          <ul className="space-y-2">
            {positions.map((pos) => (
              <FoundPositionRow
                key={pos.id}
                position={pos}
                subDim={subDimById.get(pos.sub_dimension_id) ?? null}
              />
            ))}
          </ul>

          <p className="text-xs text-[var(--color-text-muted)] mt-4">
            See something wrong? Reply to your claim email and we will review
            it. You can also email{" "}
            <a
              href="mailto:support@example.org"
              className="underline"
            >
              support@example.org
            </a>
            .
          </p>
        </>
      )}
    </section>
  );
}

function FoundPositionRow({
  position,
  subDim,
}: {
  position: FoundPosition;
  subDim: SubDim | null;
}) {
  const dimName = (subDim?.name ?? position.sub_dimension_id).replace(
    /_/g,
    " ",
  );
  const lowLabel = subDim?.spectrum_low ?? "low";
  const highLabel = subDim?.spectrum_high ?? "high";
  const scorePct = Math.round(position.score * 100);
  const citations = position.source_citations ?? [];

  return (
    <li className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)]">
      <details className="group">
        <summary className="flex items-center justify-between gap-3 px-3 py-2.5 cursor-pointer list-none">
          <div className="min-w-0">
            <span className="text-sm font-semibold text-[var(--color-text)] capitalize">
              {dimName}
            </span>
            <span className="block text-xs text-[var(--color-text-muted)] mt-0.5 truncate">
              {lowLabel} to {highLabel}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <SourceTierBadge
              tier={position.source_tier ?? "ml_inferred_from_corpus"}
              size="xs"
            />
            <span className="text-sm font-bold text-[var(--color-text)] tabular-nums">
              {scorePct}%
            </span>
            <span
              aria-hidden="true"
              className="text-[var(--color-text-muted)] transition-transform group-open:rotate-90"
            >
              &rsaquo;
            </span>
          </div>
        </summary>

        <div className="px-3 pb-3 pt-1 space-y-2">
          {position.ai_summary && (
            <p className="text-sm text-[var(--color-text-secondary)] italic">
              &ldquo;{position.ai_summary}&rdquo;
            </p>
          )}
          <p className="text-[11px] text-[var(--color-text-muted)] uppercase tracking-wider">
            confidence: {position.confidence}
          </p>

          {citations.length > 0 ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-1">
                Source{citations.length > 1 ? "s" : ""} ({citations.length})
              </p>
              <ul className="space-y-1.5">
                {citations.slice(0, 5).map((c, i) => (
                  <li key={c.url ?? i} className="text-xs">
                    {c.url ? (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--color-primary)] underline break-words"
                      >
                        {c.title || c.url}
                      </a>
                    ) : (
                      <span className="text-[var(--color-text-secondary)]">
                        {c.title || `Source ${i + 1}`}
                      </span>
                    )}
                    {c.quote && c.quote.trim() && (
                      <blockquote className="mt-1 border-l-2 border-[var(--color-border)] pl-2 text-[var(--color-text-secondary)] italic">
                        &ldquo;{c.quote.trim()}&rdquo;
                      </blockquote>
                    )}
                  </li>
                ))}
                {citations.length > 5 && (
                  <li className="text-xs text-[var(--color-text-muted)]">
                    +{citations.length - 5} more
                  </li>
                )}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-[var(--color-text-muted)]">
              No public source was captured for this inference.
            </p>
          )}
        </div>
      </details>
    </li>
  );
}
