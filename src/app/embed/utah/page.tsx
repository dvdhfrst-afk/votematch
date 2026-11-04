import type { Metadata } from 'next';
import EmbedApp from './EmbedApp';

/**
 * /embed/utah - the iframe-embeddable Utah ballot widget (the CalMatters model:
 * one build, many partner sites). Reads a `partner` query param for the
 * co-branding slot. noindex: this surface is embedded, not a destination page.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

export const metadata: Metadata = {
  title: 'Utah ballot guide',
  robots: { index: false, follow: false },
};

function first(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0]?.trim() || null;
  return (v ?? '').trim() || null;
}

export default async function EmbedUtahPage({
  searchParams,
}: {
  searchParams: Promise<{ partner?: string | string[] }>;
}) {
  const sp = await searchParams;
  const partner = first(sp.partner);

  // Booth Mode (V2 pillar 5b) is the handoff destination: the voter carries their
  // phone into the booth. Prefer the canonical app domain when configured; a bare
  // relative path is resolved to an absolute URL client-side (against our own
  // iframe origin) so it is scannable in the QR code.
  const appBase = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
  const boothUrl = `${appBase}/booth`;

  return <EmbedApp partner={partner} boothUrl={boothUrl} />;
}
