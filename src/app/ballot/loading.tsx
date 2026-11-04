/**
 * Route-level loading skeleton for the ballot page. Renders while the server
 * component resolves the precinct and loads races, so the voter sees a calm,
 * structured placeholder instead of a blank screen. Mirrors the real layout
 * (header, title, a few race-card shapes). Mobile-first and decorative only,
 * so it is hidden from assistive tech and announces "Loading your ballot" once.
 */
export default function BallotLoading() {
  return (
    <main className="min-h-screen bg-[var(--color-bg-alt)]">
      <span className="sr-only" role="status" aria-live="polite">
        Loading your ballot
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
          <div className="h-9 w-1/2 rounded bg-[var(--color-bg-muted)] mb-3" />
          <div className="h-4 w-2/3 rounded bg-[var(--color-bg-muted)] mb-8" />

          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="civic-card space-y-3">
                <div className="flex items-center gap-3">
                  <div className="h-6 w-16 rounded bg-[var(--color-bg-muted)]" />
                  <div className="h-5 w-1/2 rounded bg-[var(--color-bg-muted)]" />
                </div>
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
