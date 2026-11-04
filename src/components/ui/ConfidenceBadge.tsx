import type { Confidence } from "@/types/database";

const styles: Record<Confidence, string> = {
  high: "bg-emerald-100 text-emerald-800 border-emerald-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-gray-100 text-gray-600 border-gray-200",
  candidate_direct: "bg-sky-100 text-sky-800 border-sky-200",
  no_data: "bg-gray-50 text-gray-500 border-gray-200",
  insufficient_overlap: "bg-amber-50 text-amber-900 border-amber-300",
};

const labels: Record<Confidence, string> = {
  high: "High confidence",
  medium: "Med confidence",
  low: "Low confidence",
  candidate_direct: "Candidate's own words",
  no_data: "No data",
  insufficient_overlap: "Insufficient overlap",
};

export default function ConfidenceBadge({
  confidence,
}: {
  confidence: Confidence;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${styles[confidence]}`}
    >
      {labels[confidence]}
    </span>
  );
}
