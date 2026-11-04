"use client";

/**
 * AxisSlider - one continuous 0-1 slider for a single matching axis.
 *
 * Doc 07 section 2.8 prefers a CONTINUOUS slider over a discrete 5-point Likert
 * for placing a voter on an axis: it captures intensity (how strongly, not just
 * which side) and avoids the false precision of named buckets. The slider runs
 * left (spectrum_low, score 0.0) to right (spectrum_high, score 1.0); the value
 * is the raw 0-1 score that feeds buildVoterAxisVector unchanged.
 *
 * Mobile-first (hard rule): the native range input gives a large, draggable
 * thumb and works on touch with no hover dependency. Pole labels sit beneath the
 * track, wrapping on narrow screens. The whole control is keyboard-accessible
 * (arrow keys move the thumb) and labelled for screen readers.
 *
 * Acronyms, spelled out on first use: UI (user interface).
 */
export default function AxisSlider({
  axisUid,
  label,
  spectrumLow,
  spectrumHigh,
  value,
  onChange,
}: {
  axisUid: string;
  label: string;
  spectrumLow: string;
  spectrumHigh: string;
  /** 0-1 current score. */
  value: number;
  onChange: (value: number) => void;
}) {
  // Render the slider on a 0-100 integer track for smooth touch dragging, then
  // map back to 0-1 on change. 100 steps is finer than any voter can
  // meaningfully distinguish, so it reads as continuous.
  const pct = Math.round(value * 100);
  const sliderId = `axis-${axisUid}`;
  const labelId = `${sliderId}-label`;

  return (
    <div className="w-full">
      <p
        id={labelId}
        className="font-medium text-[var(--color-text)] mb-3 leading-snug"
      >
        {label}
      </p>

      <input
        id={sliderId}
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        aria-labelledby={labelId}
        aria-valuetext={`${pct}% toward ${spectrumHigh}`}
        // h-8 gives a tall, easy touch target; accent-color themes the native
        // thumb/track to the primary brand color without custom CSS.
        className="w-full h-8 cursor-pointer accent-[var(--color-primary)] touch-pan-y"
      />

      <div className="flex justify-between gap-3 mt-1">
        <span className="text-sm text-[var(--color-text-secondary)] max-w-[45%] text-left">
          {spectrumLow}
        </span>
        <span className="text-sm text-[var(--color-text-secondary)] max-w-[45%] text-right">
          {spectrumHigh}
        </span>
      </div>
    </div>
  );
}
