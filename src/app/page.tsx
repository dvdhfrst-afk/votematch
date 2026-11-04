import Link from "next/link";
import AddressInput from "@/components/ui/AddressInput";
import { lookupBallotAction } from "./actions";
import { getSessionUser } from "@/lib/session";
import { isGuideProviderReady } from "@/lib/guide/provider";

// Council #50 (2026-05-10, distribution): per-state Event JSON-LD for the
// imminent 2026 primaries. Voters searching "Maine June 2026 primary",
// "California primary 2026", etc. on Google can surface Havesay as a
// rich-event-result host. No DB queries, static, ships in homepage <head>.
const PRIMARY_EVENTS_2026 = [
  { state: 'California',   abbr: 'CA', date: '2026-06-02' },
  { state: 'Iowa',         abbr: 'IA', date: '2026-06-02' },
  { state: 'Montana',      abbr: 'MT', date: '2026-06-02' },
  { state: 'New Jersey',   abbr: 'NJ', date: '2026-06-02' },
  { state: 'New Mexico',   abbr: 'NM', date: '2026-06-02' },
  { state: 'South Dakota', abbr: 'SD', date: '2026-06-02' },
  { state: 'Maine',        abbr: 'ME', date: '2026-06-09' },
  { state: 'Nevada',       abbr: 'NV', date: '2026-06-09' },
];
const eventsJsonLd = PRIMARY_EVENTS_2026.map((e) => ({
  '@context': 'https://schema.org',
  '@type': 'Event',
  name: `${e.state} 2026 Primary Election`,
  startDate: e.date,
  eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
  eventStatus: 'https://schema.org/EventScheduled',
  location: { '@type': 'Place', name: `${e.state}, USA`, address: { '@type': 'PostalAddress', addressRegion: e.abbr, addressCountry: 'US' } },
  organizer: { '@type': 'Organization', name: 'Havesay', url: 'https://ballotbridge.org' },
  description: `Find every candidate on your ${e.state} primary ballot, nonpartisan, source-cited.`,
}));

// Secondary nav rendered as frame-style chips (border-pill). Points at the
// existing reference surfaces.
const NAV_CHIPS = [
  { label: 'how it works', href: '#how-it-works' },
  { label: 'methodology', href: '/methodology' },
  { label: 'privacy', href: '/privacy' },
];

export default async function HomePage() {
  // Return-visit continuity (1C): a voter who already resolved a ballot has a
  // session row with an address / precinct. Offer them a one-tap fast path
  // straight to /guide instead of re-entering their address. We only surface
  // this when the guide is backed by REAL data (isGuideProviderReady), so we
  // never route a returning voter into a disabled/mock guide. The device-side
  // profile + client matcher (1A/1B) hang off /guide from here; this fast path
  // is the server-known "you have a ballot" signal, independent of device
  // storage. Failures are swallowed — the homepage must always render.
  let welcomeBack = false;
  try {
    if (isGuideProviderReady()) {
      const user = await getSessionUser();
      welcomeBack = Boolean(user?.precinct_id || user?.address_text);
    }
  } catch {
    welcomeBack = false;
  }

  return (
    <main className="flex flex-col min-h-screen bg-[var(--civic-surface)]">
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(eventsJsonLd) }}
      />

      {/* Header: serif Havesay wordmark + chip menu affordance (frame chrome) */}
      <header className="w-full border-b border-[var(--civic-border)]">
        <div className="civic-container flex items-center justify-between py-4">
          <a
            href="/"
            className="civic-display text-2xl text-[var(--civic-primary)]"
          >
            Havesay
          </a>
          <nav className="flex items-center gap-2 text-sm">
            <a
              href="#how-it-works"
              className="hidden sm:inline-flex items-center rounded-full border border-[var(--civic-border-strong)] px-3 py-1.5 text-[13px] text-[var(--civic-text-secondary)] hover:border-[var(--civic-primary)] hover:text-[var(--civic-primary)] transition-colors"
            >
              how it works
            </a>
            <a
              href="/methodology"
              className="inline-flex items-center rounded-full border border-[var(--civic-border-strong)] px-3 py-1.5 text-[13px] text-[var(--civic-text-secondary)] hover:border-[var(--civic-primary)] hover:text-[var(--civic-primary)] transition-colors"
            >
              methodology
            </a>
          </nav>
        </div>
      </header>

      {/* Hero — phone-first single column; at lg the block centers with generous
          whitespace (map §4 proposal: no fake multi-column marketing grid). */}
      <section className="flex-1 flex flex-col px-5 sm:px-6 py-14 sm:py-20 lg:py-28">
        <div className="w-full max-w-xl lg:max-w-2xl mx-auto flex flex-col">
          {/* Display headline with the scribble accent on "Explained." */}
          <h1 className="civic-display text-[40px] leading-[1.05] sm:text-[52px] lg:text-6xl lg:text-center">
            Every race
            <br className="sm:hidden" /> on your ballot.
            <br />
            <span className="civic-scribble">Explained.</span>
          </h1>

          <p className="mt-5 text-[15px] sm:text-lg text-[var(--civic-text-secondary)] max-w-[34ch] lg:max-w-none lg:text-center">
            Nonpartisan. Anonymous. For every race on your ballot.
          </p>

          {/* Return-visit fast path: shown only when this session already has a
              resolved ballot. One tap back to /guide, no address re-entry. */}
          {welcomeBack && (
            <div className="mt-8 lg:mx-auto lg:w-full lg:max-w-md">
              <Link
                href="/guide"
                className="block rounded-xl border border-[var(--civic-primary)] bg-[var(--civic-primary-soft)] px-5 py-4 no-underline transition-colors hover:border-[var(--civic-primary-hover)]"
              >
                <div className="civic-mono text-[10px] uppercase tracking-[0.08em] text-[var(--civic-primary)]">
                  Welcome back
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span className="font-bold text-[var(--civic-text)]">
                    Open your ballot
                  </span>
                  <span aria-hidden="true" className="text-[var(--civic-primary)]">
                    →
                  </span>
                </div>
                <p className="mt-1 text-[13px] text-[var(--civic-text-secondary)]">
                  Your answers and plan are saved on this device. Pick up where you left off.
                </p>
              </Link>
              <div className="civic-mono mt-3 text-[10px] uppercase tracking-[0.08em] text-[var(--civic-text-muted)] lg:text-center">
                Or start a new address
              </div>
            </div>
          )}

          {/* Address-first entry. mono uppercase eyebrow, then the input.
              AddressInput owns the form + server-action wiring (unchanged). */}
          <div className="mt-9 sm:mt-10 lg:mx-auto lg:w-full">
            <div className="civic-mono text-[11px] uppercase tracking-[0.08em] text-[var(--civic-text-muted)] mb-2 lg:text-center">
              Start with your address
            </div>
            <AddressInput action={lookupBallotAction} />
          </div>

          {/* Trust chrome: mono statement + chip row (frame footer of hero). */}
          <div className="mt-12 sm:mt-14 pt-4 border-t border-dashed border-[var(--civic-border-strong)] lg:mx-auto lg:w-full lg:text-center">
            <div className="civic-mono text-[10px] uppercase tracking-[0.08em] text-[var(--civic-text-muted)]">
              No account · No tracking · Open methodology
            </div>
            <div className="mt-3 flex flex-wrap gap-2 lg:justify-center">
              {NAV_CHIPS.map((c) => (
                <a
                  key={c.label}
                  href={c.href}
                  className="inline-flex items-center rounded-full border border-[var(--civic-border-strong)] bg-[var(--civic-surface)] px-3 py-1.5 text-[13px] text-[var(--civic-text-secondary)] hover:border-[var(--civic-primary)] hover:text-[var(--civic-primary)] transition-colors"
                >
                  {c.label}
                </a>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* How it works — kept as an honest three-step readout, single readable
          column on every breakpoint (map: no fake marketing grid). */}
      <section
        id="how-it-works"
        className="py-14 sm:py-20 bg-[var(--civic-surface-muted)] border-t border-[var(--civic-border)]"
      >
        <div className="civic-container max-w-2xl mx-auto">
          <div className="civic-mono text-[11px] uppercase tracking-[0.08em] text-[var(--civic-text-muted)] text-center">
            How it works
          </div>
          <ol className="mt-8 space-y-6">
            {[
              {
                n: '1',
                title: 'Enter your address',
                body: 'We use it only to build your ballot, from U.S. Senate down to county council. Your address is not stored on our servers.',
              },
              {
                n: '2',
                title: 'Answer a few quick questions',
                body: 'A handful of questions about your priorities, about a minute. Skip any you like. Anonymous by default.',
              },
              {
                n: '3',
                title: 'See where candidates stand',
                body: 'Every match is source-cited and nonpartisan. Take your ballot into the booth confident and prepared.',
              },
            ].map((step) => (
              <li key={step.n} className="flex gap-4">
                <div
                  aria-hidden="true"
                  className="civic-display shrink-0 grid place-items-center w-9 h-9 rounded-full border border-[var(--civic-border-strong)] text-[var(--civic-primary)] text-lg"
                >
                  {step.n}
                </div>
                <div>
                  <h3 className="font-bold text-[var(--civic-text)]">
                    {step.title}
                  </h3>
                  <p className="mt-1 text-sm text-[var(--civic-text-secondary)] leading-relaxed">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Primary-reminder CTA — rolling wave tied to each state's 2026 primary */}
      <section
        id="primary-reminders"
        className="py-12 sm:py-16 border-t border-[var(--civic-border)]"
      >
        <div className="civic-container max-w-2xl mx-auto text-center">
          <h2 className="civic-display text-2xl sm:text-3xl text-[var(--civic-text)]">
            Primary voter? Get your state&apos;s reminder.
          </h2>
          <p className="mt-3 text-[var(--civic-text-secondary)] leading-relaxed">
            2026 state primaries run May 5 (IN, OH) through September 15 (DE).
            Tell us your state and we&apos;ll email when your primary is near,
            plus a monthly civic digest in between. One-click unsubscribe.
          </p>
          <div className="mt-6">
            <a
              href="/subscribe"
              className="civic-btn civic-btn-primary civic-btn-lg inline-flex"
            >
              Get primary reminders
            </a>
          </div>
          <p className="mt-3 text-xs text-[var(--civic-text-muted)]">
            Live in all 50 states + DC for the 2026 cycle.
          </p>
        </div>
      </section>

      {/* Trust Signals */}
      <section
        id="trust"
        className="py-12 sm:py-16 bg-[var(--civic-surface-muted)] border-t border-[var(--civic-border)]"
      >
        <div className="civic-container text-center">
          <p className="text-sm sm:text-base text-[var(--civic-text-muted)] max-w-2xl mx-auto leading-relaxed">
            Open-source algorithm &middot;{" "}
            <a
              href="/corrections"
              className="underline hover:text-[var(--civic-primary)] transition-colors"
            >
              Public corrections log
            </a>{" "}
            &middot; Reviewed by politically diverse volunteers
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[var(--civic-border)] py-8">
        <div className="civic-container text-center text-sm text-[var(--civic-text-muted)]">
          <p>Havesay is a nonpartisan civic project.</p>
          <p className="mt-1">
            Not affiliated with any political party or candidate.
          </p>
        </div>
      </footer>
    </main>
  );
}
