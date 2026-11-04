import { tierMeta } from "@/lib/provenance";
import type { SourceTier } from "@/types/database";

/**
 * Per-position provenance label. Says WHERE a position came from
 * (candidate-stated / voting record / media / AI-inferred) so a voter can
 * weigh it. Orthogonal to ConfidenceBadge (how sure we are) — both can show
 * on the same card. Shared by the voter and candidate portals; styling comes
 * from `@/lib/provenance` (neutral civic tints, never partisan).
 *
 * The glyph carries the distinction without relying on color (CVD-safe), and
 * the native `title` exposes the plain-language explanation on hover. Pass
 * `withExplanation` to render the explanation inline (used in the visibility
 * explainer), or the default compact pill elsewhere.
 */
export default function SourceTierBadge({
  tier,
  size = "sm",
  className = "",
}: {
  tier: SourceTier | string | null | undefined;
  size?: "sm" | "xs";
  className?: string;
}) {
  const meta = tierMeta(tier);
  const pad = size === "xs" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]";
  return (
    <span
      title={meta.explanation}
      className={`inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap ${pad} ${meta.badgeClass} ${className}`}
    >
      <span aria-hidden="true">{meta.glyph}</span>
      {meta.label}
    </span>
  );
}
