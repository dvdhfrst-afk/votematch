/**
 * DataQualityBadge — visible provenance badge for every office/person/candidate card.
 *
 * The council's data-trust reviewer flagged that `offices.meta.data_quality_tier`
 * is stored but not surfaced: "When a journalist FOIAs or scrapes and finds 82.3%
 * of offices are 'compiled' (LLM-inferred) while the UI presents everything
 * uniformly, the story writes itself."
 *
 * This badge surfaces the tier so voters can see the strength of evidence behind
 * a given row. Tooltip explains what each tier means; optional source link lets
 * users click through to the underlying record.
 */

export type DataQualityTier = 'authoritative' | 'compiled' | 'default' | null | undefined;

type Props = {
  tier: DataQualityTier;
  sourceUrl?: string | null;
  lastVerified?: string | null;  // ISO date
  size?: 'xs' | 'sm';
  className?: string;
};

const TIER_META: Record<string, { label: string; tooltip: string; bg: string; fg: string; border: string }> = {
  authoritative: {
    label: 'state-verified',
    tooltip: 'Sourced from a state statute, secretary of state, or official election filing. Highest confidence.',
    bg: 'bg-emerald-50',
    fg: 'text-emerald-800',
    border: 'border-emerald-200',
  },
  compiled: {
    label: 'compiled',
    tooltip: 'Compiled from public sources (county rosters, press, Wikipedia, or language-model research). May lag the current officeholder by weeks.',
    bg: 'bg-amber-50',
    fg: 'text-amber-800',
    border: 'border-amber-200',
  },
  default: {
    label: 'template',
    tooltip: 'Generic placeholder from our office catalog. Specific officeholder data has not yet been verified.',
    bg: 'bg-gray-50',
    fg: 'text-gray-600',
    border: 'border-gray-200',
  },
};

export default function DataQualityBadge({ tier, sourceUrl, lastVerified, size = 'xs', className = '' }: Props) {
  const meta = TIER_META[tier ?? 'default'] ?? TIER_META.default;
  const sizeClasses = size === 'xs'
    ? 'px-1.5 py-0.5 text-[10px]'
    : 'px-2 py-0.5 text-xs';

  const verified = lastVerified ? `Last verified ${lastVerified.slice(0, 10)}` : null;
  const tooltipLines = [meta.tooltip, verified].filter(Boolean).join(' · ');

  const inner = (
    <span
      className={`inline-flex items-center gap-1 ${meta.bg} ${meta.fg} ${meta.border} border rounded font-medium ${sizeClasses} ${className}`}
      title={tooltipLines}
    >
      <span aria-hidden className="opacity-70">◆</span>
      {meta.label}
    </span>
  );

  if (sourceUrl) {
    return (
      <a
        href={sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="no-underline hover:underline"
      >
        {inner}
      </a>
    );
  }
  return inner;
}
