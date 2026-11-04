import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Offline',
  robots: { index: false, follow: false },
};

/**
 * Offline fallback (1C). Served by the service worker (public/sw.js) when a
 * navigation fails with no network. Deliberately static and self-contained:
 * no session, no provider, no data fetch, so it precaches cleanly and renders
 * with zero network. Honest framing: the voter's saved answers and plan live
 * on the device, so they are still reachable.
 */
export default function OfflinePage() {
  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center px-6 text-center"
      style={{ background: 'var(--civic-surface-muted)' }}
    >
      <div className="max-w-md mx-auto">
        <span
          aria-hidden="true"
          style={{
            display: 'inline-grid',
            placeItems: 'center',
            width: 56,
            height: 56,
            borderRadius: 12,
            background: 'var(--civic-primary)',
            color: 'var(--civic-on-primary)',
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 26,
            marginBottom: 20,
          }}
        >
          H
        </span>
        <h1
          style={{
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 'clamp(24px, 1.4rem + 1vw, 32px)',
            lineHeight: 1.15,
            color: 'var(--civic-text)',
          }}
        >
          You&rsquo;re offline
        </h1>
        <p
          style={{
            marginTop: 12,
            fontSize: 16,
            lineHeight: 1.55,
            color: 'var(--civic-text-secondary)',
          }}
        >
          Your saved answers and plan are still here, on this device. New
          candidate data will load again when you reconnect.
        </p>
        <div className="mt-7 flex flex-col items-center gap-3">
          <Link href="/booth" className="civic-btn civic-btn-primary civic-btn-lg">
            Open my booth checklist
          </Link>
          <Link
            href="/guide"
            className="text-sm font-medium min-h-[44px] flex items-center"
            style={{ color: 'var(--civic-primary)' }}
          >
            Back to my ballot
          </Link>
        </div>
        <p
          className="civic-mono"
          style={{
            marginTop: 28,
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--civic-text-muted)',
          }}
        >
          Havesay · your ballot lives on your device
        </p>
      </div>
    </main>
  );
}
