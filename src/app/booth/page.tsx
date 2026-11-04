import type { Metadata } from 'next';
import { isGuideRenderable } from '@/lib/guide/provider';
import BoothClient from '@/components/booth/BoothClient';

/**
 * Booth Mode (V2 pillar 5b) — the destination of every voter flow.
 *
 * Fully on-device: the server render is just a static shell. BoothClient reads
 * the voter's picks from IndexedDB and the public race/candidate data from the
 * service-worker-cached positions bundle, so this page works with no network at
 * the polling place. No opinion touches the server.
 *
 * noindex: this is a personal, device-local surface, not a destination page.
 */
export const metadata: Metadata = {
  title: 'Booth mode',
  robots: { index: false, follow: false },
};

export default function BoothPage() {
  // Gate on the guide being live so a disabled/mock build renders nothing rather
  // than an empty booth. In production the guide is live; the shell is identical
  // for everyone (no session data server-side), so it caches cleanly for offline.
  if (!isGuideRenderable()) return null;
  return <BoothClient />;
}
