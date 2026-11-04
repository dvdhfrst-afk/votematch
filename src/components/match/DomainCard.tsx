"use client";

import type { Domain } from "@/types/database";

const DOMAIN_META: Record<
  Domain,
  { icon: string; label: string; description: string }
> = {
  economy: {
    icon: "\uD83D\uDCB0",
    label: "Economy",
    description: "Jobs, taxes, cost of living",
  },
  social: {
    icon: "\uD83E\uDD1D",
    label: "Social Issues",
    description: "Civil rights, equality, social policy",
  },
  healthcare: {
    icon: "\uD83C\uDFE5",
    label: "Healthcare",
    description: "Insurance, drug costs, public health",
  },
  education: {
    icon: "\uD83C\uDF93",
    label: "Education",
    description: "Schools, funding, curriculum",
  },
  environment: {
    icon: "\uD83C\uDF0D",
    label: "Environment",
    description: "Climate, energy, public lands",
  },
  governance: {
    icon: "\uD83C\uDFDB\uFE0F",
    label: "Governance",
    description: "Elections, transparency, government reform",
  },
  public_safety: {
    icon: "\uD83D\uDEE1\uFE0F",
    label: "Public Safety",
    description: "Policing, criminal justice, gun policy",
  },
  infrastructure: {
    icon: "\uD83D\uDE84",
    label: "Infrastructure",
    description: "Roads, transit, housing, broadband",
  },
};

export default function DomainCard({
  domain,
  selected,
  rank,
  onToggle,
}: {
  domain: Domain;
  selected: boolean;
  rank: number | null;
  onToggle: (domain: Domain) => void;
}) {
  const meta = DOMAIN_META[domain];

  return (
    <button
      type="button"
      onClick={() => onToggle(domain)}
      className={`relative flex flex-col items-center text-center p-5 rounded-xl border-2 transition-all duration-150 cursor-pointer
        ${
          selected
            ? "border-[var(--color-primary)] bg-blue-50 shadow-sm"
            : "border-[var(--color-border)] bg-white hover:border-[var(--color-primary)]/40"
        }`}
    >
      {/* Rank badge */}
      {rank !== null && (
        <span className="absolute -top-2.5 -right-2.5 w-7 h-7 rounded-full bg-[var(--color-primary)] text-white text-sm font-bold flex items-center justify-center shadow">
          {rank}
        </span>
      )}

      {/* Check icon for selected */}
      {selected && (
        <span className="absolute top-2 left-2">
          <svg
            className="w-5 h-5 text-[var(--color-primary)]"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      )}

      <span className="text-3xl mb-2">{meta.icon}</span>
      <span className="font-bold text-[var(--color-text)] text-sm">
        {meta.label}
      </span>
      <span className="text-xs text-[var(--color-text-muted)] mt-1">
        {meta.description}
      </span>
    </button>
  );
}

export { DOMAIN_META };
