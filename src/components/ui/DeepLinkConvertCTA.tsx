/**
 * Top-of-page banner for deep-landing voters arriving from search engines.
 *
 * Council #39 (voter perspective): robots.txt + sitemap shipped in #38, so
 * /office/[id], /officeholder/[id], /person/[id], /candidate/[id] are now
 * indexable. A stranger Googling "[name] state senator" needs to know what
 * Havesay is and have a one-tap path to ballot lookup. Without this,
 * every search-engine visitor is a dead end.
 *
 * Server component — zero client JS. Links to `/` where the real address
 * input lives.
 */
import Link from 'next/link';

export default function DeepLinkConvertCTA() {
  return (
    <div className="mb-6 flex items-center justify-between gap-3 rounded border border-blue-200 bg-blue-50 px-4 py-3">
      <div className="text-sm text-gray-800">
        <Link href="/" className="font-semibold text-blue-700 hover:underline">
          Havesay
        </Link>{' '}
        — see every race on your 2026 ballot, matched to your priorities.
        Free, nonpartisan, all 50 states.
      </div>
      <Link
        href="/"
        className="whitespace-nowrap rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
      >
        See your ballot &rarr;
      </Link>
    </div>
  );
}
