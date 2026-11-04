import Link from 'next/link';

/**
 * Honest "in development" surface for the guide.
 *
 * The full-ballot guide currently has no live (DB-backed) provider — only a
 * MOCK provider that returns invented races and candidates. Rendering those
 * under real Havesay branding is a content-integrity hazard: a voter could
 * mistake fabricated candidates for their actual ballot. Until the live
 * provider is wired (NEXT_PUBLIC_GUIDE_PROVIDER=live), every /guide/* route
 * renders this notice instead of any mock content.
 *
 * See src/lib/guide/provider.ts (getGuideMode / isGuideProviderReady).
 */
export default function GuideUnavailable() {
  return (
    <div className="max-w-xl mx-auto px-4 py-16 text-center space-y-5">
      <h1
        style={{
          fontFamily: 'var(--font-serif)',
          fontWeight: 700,
          fontSize: 'clamp(24px, 1.5rem + 1vw, 34px)',
          lineHeight: 1.15,
          color: 'var(--civic-text)',
        }}
      >
        The full-ballot guide is still in development
      </h1>
      <p
        style={{
          fontSize: 16,
          lineHeight: 1.55,
          color: 'var(--civic-text-secondary)',
        }}
      >
        We are building a race-by-race guide backed by real, source-cited ballot
        data. It is not ready yet, and we will not show placeholder candidates in
        its place. In the meantime, your live ballot and your matches are
        available.
      </p>
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
        <Link href="/ballot" className="civic-btn-primary text-base px-7 py-3">
          View your ballot
        </Link>
      </div>
    </div>
  );
}
