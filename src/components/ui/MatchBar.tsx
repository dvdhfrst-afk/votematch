export default function MatchBar({
  percentage,
  size = "default",
}: {
  percentage: number;
  size?: "small" | "default" | "large";
}) {
  const clamped = Math.max(0, Math.min(100, percentage));

  const barColor =
    clamped >= 70
      ? "bg-emerald-500"
      : clamped >= 40
        ? "bg-amber-500"
        : "bg-red-500";

  const textColor =
    clamped >= 70
      ? "text-emerald-700"
      : clamped >= 40
        ? "text-amber-700"
        : "text-red-700";

  const heightClass =
    size === "small" ? "h-1.5" : size === "large" ? "h-4" : "h-2.5";

  const textClass =
    size === "small"
      ? "text-xs"
      : size === "large"
        ? "text-lg font-bold"
        : "text-sm font-semibold";

  return (
    <div className="flex items-center gap-2.5 w-full">
      <div
        className={`flex-1 rounded-full bg-gray-200 overflow-hidden ${heightClass}`}
      >
        <div
          className={`${barColor} ${heightClass} rounded-full transition-all duration-500 ease-out`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className={`${textColor} ${textClass} tabular-nums min-w-[3ch]`}>
        {Math.round(clamped)}%
      </span>
    </div>
  );
}
