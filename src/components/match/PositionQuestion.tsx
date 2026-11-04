"use client";

interface Option {
  value: number;
  label: string;
  description: string;
}

export default function PositionQuestion({
  question,
  options,
  selected,
  onSelect,
  onNext,
}: {
  question: string;
  options: Option[];
  selected: number | null;
  onSelect: (value: number) => void;
  onNext: () => void;
}) {
  return (
    <div className="w-full max-w-lg mx-auto">
      <h2 className="text-2xl sm:text-3xl font-bold text-[var(--color-primary)] mb-8 text-center">
        {question}
      </h2>

      <div className="space-y-3">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onSelect(option.value)}
            className={`w-full text-left p-4 rounded-xl border-2 transition-all duration-150
              ${
                selected === option.value
                  ? "border-[var(--color-primary)] bg-blue-50"
                  : "border-[var(--color-border)] bg-white hover:border-[var(--color-primary)]/40"
              }`}
          >
            <div className="flex items-start gap-3">
              <span
                className={`mt-0.5 w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center
                ${
                  selected === option.value
                    ? "border-[var(--color-primary)] bg-[var(--color-primary)]"
                    : "border-gray-300"
                }`}
              >
                {selected === option.value && (
                  <span className="w-2 h-2 rounded-full bg-white" />
                )}
              </span>
              <div>
                <p className="font-semibold text-[var(--color-text)]">
                  {option.label}
                </p>
                <p className="text-sm text-[var(--color-text-secondary)] mt-0.5">
                  {option.description}
                </p>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="mt-8 text-center">
        <button
          type="button"
          onClick={onNext}
          disabled={selected === null}
          className="civic-btn-primary text-lg px-10 py-3"
        >
          Next
        </button>
      </div>
    </div>
  );
}
