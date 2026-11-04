"use client";

export default function BackButton() {
  return (
    <button
      type="button"
      onClick={() => history.back()}
      className="text-sm text-[var(--color-primary)] hover:underline mb-6 inline-flex items-center gap-1"
    >
      <svg
        className="w-4 h-4"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2}
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M15.75 19.5L8.25 12l7.5-7.5"
        />
      </svg>
      Back to ballot
    </button>
  );
}
