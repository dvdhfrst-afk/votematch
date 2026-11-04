import Link from 'next/link';
import { isGuideRenderable } from '@/lib/guide/provider';
import { BetaChip } from '@/components/guide/primitives';
import GuideUnavailable from './GuideUnavailable';

/**
 * Guide layout — mobile-first civic shell.
 *
 * Design reference:
 *   .design-bundles/ballot-bridge/project/design-system/index.html  (header + chrome)
 *
 * · 3px nation-accent stripe at the very top (flag-red for US theme)
 * · Sticky site-header below with serif brand mark + system-sans nav
 * · Respects safe-area insets (notch phones)
 * · Print strips the header + footer via .civic-print-hide
 */
export default function GuideLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Content-integrity gate: when NO provider will serve pages ('disabled'),
  // render the honest "in development" notice instead of the child pages, which
  // would otherwise call getGuideProvider() and throw. When a provider IS
  // available ('live', or 'mock' behind the dev flag), children render normally.
  // Child pages ALSO self-guard (isGuideRenderable()) so their provider calls
  // never execute in the disabled case. Note: mock is dev-only and never linked
  // from user-facing surfaces (those gate on isGuideProviderReady()).
  const guideReady = isGuideRenderable();

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background: 'var(--civic-surface-muted)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Thin nation-accent stripe — the entire visual "this is a civic tool" signal */}
      <span className="civic-header-stripe civic-print-hide" aria-hidden="true" />

      <header
        className="civic-print-hide sticky top-0"
        style={{
          zIndex: 'var(--z-header)',
          background: 'var(--civic-surface)',
          borderBottom: '1px solid var(--civic-border)',
        }}
      >
        <div
          className="max-w-3xl mx-auto px-4 flex items-center gap-3"
          style={{ minHeight: 56, paddingTop: 'env(safe-area-inset-top)' }}
        >
          <Link
            href="/guide"
            className="flex items-baseline gap-2 min-h-[44px] items-center"
            style={{ textDecoration: 'none', color: 'var(--civic-text)' }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 28,
                height: 28,
                borderRadius: 4,
                background: 'var(--civic-primary)',
                color: 'var(--civic-on-primary)',
                display: 'inline-grid',
                placeItems: 'center',
                fontFamily: 'var(--font-serif)',
                fontWeight: 700,
                fontSize: 14,
                position: 'relative',
                top: 2,
              }}
            >
              {/* Interim wordmark glyph — Havesay initial. Placeholder pending
                  the real Havesay icon (DEFINITION-OF-WORKING item 6 / map §1
                  brand flag). Adapted from the frames' "BB" glyph. */}
              H
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
              <span style={{ fontFamily: 'var(--font-serif)', fontWeight: 700, fontSize: 16 }}>
                Havesay
              </span>
              <span
                className="civic-mono"
                style={{
                  fontSize: 10,
                  color: 'var(--civic-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Your ballot · explained
              </span>
            </span>
          </Link>

          <div className="flex-1" />

          <Link
            href="/guide/plan"
            className="text-sm font-medium min-h-[44px] flex items-center px-3"
            style={{
              color: 'var(--civic-primary)',
              borderRadius: 'var(--r-md)',
            }}
          >
            My plan
          </Link>
        </div>
      </header>

      <main className="flex-1">
        {guideReady ? children : <GuideUnavailable />}
      </main>

      <footer
        className="civic-print-hide py-8 px-4"
        style={{ fontSize: 12, color: 'var(--civic-text-muted)' }}
      >
        <div className="flex flex-col items-center gap-3">
          {/* Every AI-touched surface carries the Beta · AI marker (design law). */}
          {guideReady && <BetaChip />}
          <span>
            {guideReady
              ? 'Scoring is math, not opinion'
              : 'Full-ballot guide in development'}
          </span>
        </div>
      </footer>
    </div>
  );
}
