'use client';

/**
 * EmbedHeightReporter - posts the widget's content height to the parent window
 * so the host page's embed.js can size the iframe to fit (no inner scrollbar).
 * Standard newsroom-embed pattern. Posts on mount and whenever content resizes.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { useEffect } from 'react';

export const EMBED_HEIGHT_MESSAGE = 'havesay:embed:height';

export default function EmbedHeightReporter() {
  useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) return;

    const post = () => {
      const height = Math.ceil(document.documentElement.scrollHeight);
      // Target '*' is acceptable here: the payload is a non-sensitive height
      // integer, and the host reads it only from our iframe's origin.
      window.parent.postMessage({ type: EMBED_HEIGHT_MESSAGE, height }, '*');
    };

    post();
    const ro = new ResizeObserver(post);
    ro.observe(document.documentElement);
    window.addEventListener('load', post);
    const interval = window.setInterval(post, 1000); // catch late layout shifts

    return () => {
      ro.disconnect();
      window.removeEventListener('load', post);
      window.clearInterval(interval);
    };
  }, []);

  return null;
}
