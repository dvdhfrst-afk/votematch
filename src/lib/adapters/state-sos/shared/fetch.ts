/**
 * Shared HTTP fetch helper for state-sos HTML adapters. Kept deliberately
 * minimal — rate-limiting happens one layer up inside base.ts via the
 * token bucket; this helper only wraps fetch() to surface Last-Modified /
 * ETag into the adapter meta for provenance.
 *
 * Per-state adapters that need custom headers (e.g. a bespoke User-Agent)
 * or POST bodies (e.g. ASP.NET __VIEWSTATE portals) should write their
 * own fetch rather than wrapping this one.
 */

import type { AdapterContext } from '../../types';
import type { StateFetchResult } from '../base';
import { politeFetch } from '../../fetch-polite';

export async function fetchHtml(
  url: string,
  _ctx?: AdapterContext,
): Promise<StateFetchResult> {
  const res = await politeFetch(url, {
    headers: {
      accept: 'text/html, application/xhtml+xml, */*',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`state-sos fetch: HTTP ${res.status} for ${url}`);
  }
  const body = await res.text();
  return {
    rawBody: body,
    resolvedUrl: res.url ?? url,
    meta: {
      lastModified: res.headers.get('last-modified') ?? undefined,
      etag: res.headers.get('etag') ?? undefined,
      contentType: res.headers.get('content-type') ?? undefined,
    },
  };
}
