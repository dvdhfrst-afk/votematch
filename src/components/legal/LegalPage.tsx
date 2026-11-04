import type { ReactNode } from "react";

interface LegalPageProps {
  title: string;
  effectiveDate: string;
  lastUpdated?: string;
  intro?: ReactNode;
  children: ReactNode;
}

export default function LegalPage({
  title,
  effectiveDate,
  lastUpdated,
  intro,
  children,
}: LegalPageProps) {
  return (
    <main className="flex flex-col min-h-screen">
      <header className="w-full border-b border-[var(--color-border)]">
        <div className="civic-container flex items-center justify-between py-4">
          <a
            href="/"
            className="text-xl font-bold text-[var(--color-primary)]"
          >
            Havesay
          </a>
          <nav className="hidden sm:flex items-center gap-6 text-sm font-medium text-[var(--color-text-secondary)]">
            <a href="/methodology" className="hover:text-[var(--color-primary)] transition-colors">
              Methodology
            </a>
            <a href="/corrections" className="hover:text-[var(--color-primary)] transition-colors">
              Corrections
            </a>
          </nav>
        </div>
      </header>

      <section className="flex-1 py-12 sm:py-16 bg-[var(--color-bg)]">
        <div className="civic-container max-w-3xl">
          <h1 className="text-3xl sm:text-4xl font-bold text-[var(--color-text)] mb-2">
            {title}
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] mb-8">
            Effective {effectiveDate}
            {lastUpdated ? ` . Last updated ${lastUpdated}` : ""}
          </p>
          {intro ? (
            <div className="text-[var(--color-text-secondary)] text-base leading-relaxed mb-8">
              {intro}
            </div>
          ) : null}
          <article className="legal-prose text-[var(--color-text)] text-base leading-relaxed">
            {children}
          </article>
        </div>
      </section>

      <footer className="border-t border-[var(--color-border)] py-8 bg-[var(--color-bg)]">
        <div className="civic-container text-center text-sm text-[var(--color-text-muted)]">
          <p>Havesay is a nonpartisan civic project.</p>
          <p className="mt-2">
            <a href="/privacy" className="hover:text-[var(--color-primary)] underline">Privacy</a>
            <span className="mx-2">&middot;</span>
            <a href="/terms" className="hover:text-[var(--color-primary)] underline">Terms</a>
            <span className="mx-2">&middot;</span>
            <a href="/corrections" className="hover:text-[var(--color-primary)] underline">Corrections</a>
          </p>
        </div>
      </footer>
    </main>
  );
}
