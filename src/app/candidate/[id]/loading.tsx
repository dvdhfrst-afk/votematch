/**
 * Route-level loading skeleton for a candidate detail page. Renders while the
 * server component loads the candidate, positions, tier, and best-effort
 * voting-record and finance surfaces, so the voter sees a calm placeholder
 * instead of a blank screen. Mirrors the real layout (header, candidate header
 * card, source-coverage strip, a couple of position-card shapes). Mobile-first
 * and decorative only, so it is hidden from assistive tech and announces
 * "Loading candidate" once.
 */
export default function CandidateLoading() {
  return (
    <main className="min-h-screen bg-[var(--color-bg-alt)]">
      <span className="sr-only" role="status" aria-live="polite">
        Loading candidate
      </span>
      <header className="bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="civic-container py-4 flex items-center gap-4">
          <span className="text-xl font-bold text-[var(--color-primary)]">
            Havesay
          </span>
        </div>
      </header>

      <div className="civic-container py-8" aria-hidden="true">
        <div className="max-w-3xl mx-auto animate-pulse">
          <div className="civic-card mt-4">
            <div className="flex items-start gap-5">
              <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-[var(--color-bg-muted)] shrink-0" />
              <div className="flex-1 space-y-3">
                <div className="h-7 w-2/3 rounded bg-[var(--color-bg-muted)]" />
                <div className="h-4 w-1/2 rounded bg-[var(--color-bg-muted)]" />
                <div className="h-4 w-1/3 rounded bg-[var(--color-bg-muted)]" />
              </div>
            </div>
            <div className="mt-5 pt-5 border-t border-[var(--color-border)] space-y-2">
              <div className="h-4 w-full rounded bg-[var(--color-bg-muted)]" />
              <div className="h-4 w-5/6 rounded bg-[var(--color-bg-muted)]" />
            </div>
          </div>

          <div className="mt-8 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
            <div className="h-4 w-1/3 rounded bg-[var(--color-bg-muted)] mb-3" />
            <div className="h-4 w-2/3 rounded bg-[var(--color-bg-muted)]" />
          </div>

          <div className="mt-6 space-y-4">
            {[0, 1].map((i) => (
              <div key={i} className="civic-card space-y-3">
                <div className="h-5 w-1/2 rounded bg-[var(--color-bg-muted)]" />
                <div className="h-4 w-full rounded bg-[var(--color-bg-muted)]" />
                <div className="h-4 w-4/5 rounded bg-[var(--color-bg-muted)]" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
