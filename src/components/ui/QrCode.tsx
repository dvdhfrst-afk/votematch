'use client';

/**
 * Client-rendered QR code (Booth Mode embed handoff, V2 pillar 5b).
 *
 * Renders an SVG QR entirely in the browser from the already-installed `qrcode`
 * dependency (no new package, no network, no server round-trip). SVG (not canvas)
 * so it scales crisply and needs no ref timing. Held at high contrast on a white
 * plate regardless of theme, because reliable phone-camera scanning wants
 * black-on-white, not a theme-tinted code.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface QrCodeProps {
  /** The URL (or text) to encode. */
  value: string;
  /** Rendered pixel size of the square code. Default 220. */
  size?: number;
  /** Accessible label for the code image. */
  label?: string;
}

export default function QrCode({ value, size = 220, label = 'QR code' }: QrCodeProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(value, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size,
      color: { dark: '#111111', light: '#ffffff' },
    })
      .then((out) => {
        if (!cancelled) {
          setSvg(out);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (failed) {
    return (
      <div
        role="img"
        aria-label={`${label} unavailable`}
        style={{
          width: size,
          height: size,
          display: 'grid',
          placeItems: 'center',
          background: '#fff',
          color: '#555',
          border: '1px solid var(--civic-border)',
          borderRadius: 8,
          fontSize: 12,
          textAlign: 'center',
          padding: 8,
        }}
      >
        Could not draw the code. Use the link below.
      </div>
    );
  }

  if (!svg) {
    // Reserve the space so there is no layout jump when the code paints.
    return <div aria-hidden="true" style={{ width: size, height: size }} />;
  }

  return (
    <div
      role="img"
      aria-label={label}
      style={{
        width: size,
        height: size,
        background: '#fff',
        borderRadius: 8,
        padding: 8,
        boxSizing: 'content-box',
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
