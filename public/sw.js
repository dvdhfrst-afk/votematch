/*
 * Havesay service worker (hand-rolled, no workbox).
 *
 * Goals (work-order 1C):
 *   - Precache the app shell so /guide and the offline fallback open with no
 *     network.
 *   - Runtime caching:
 *       * navigations            -> network-first, fall back to cache, then to
 *                                   the honest /offline document.
 *       * /api/positions-bundle  -> network-first, cache fallback (public
 *                                   position vectors; safe to cache).
 *       * supabase REST GETs of  -> stale-while-revalidate (public ballot /
 *         public ballot data        candidate data only).
 *       * static build assets    -> stale-while-revalidate.
 *   - NEVER cache anything personalized: any request carrying the session
 *     cookie, or any response carrying Set-Cookie / Authorization / a
 *     non-public Cache-Control, is passed straight through and never stored.
 *
 * The request-classification logic is mirrored, pure, in
 * src/lib/pwa/sw-logic.ts and unit-tested there. Keep the two in sync.
 */

const VERSION = 'havesay-v2';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const OFFLINE_URL = '/offline';
const POSITIONS_BUNDLE_PATH = '/api/positions-bundle';

// App-shell precache list. Kept deliberately small: the shell entry points and
// the offline fallback. Hashed Next build assets are cached at runtime (their
// URLs are content-addressed, so stale-while-revalidate is safe and we do not
// have to know their names ahead of time).
const SHELL_ASSETS = [
  '/guide',
  '/guide/plan',
  '/booth',
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll is atomic-ish: if any request 404s the whole install fails, so
      // add individually and tolerate misses (a route may be gated/disabled).
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { credentials: 'omit' });
            if (res.ok) await cache.put(url, res.clone());
          } catch {
            /* offline at install time is fine; runtime will fill the cache */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('havesay-') && !k.startsWith(VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// ---- request classification (mirror of src/lib/pwa/sw-logic.ts) ----------

const SESSION_COOKIE = 'session_token';

function hasSessionCookie(request) {
  const cookie = request.headers.get('cookie') || '';
  return cookie.split(/;\s*/).some((c) => c.startsWith(`${SESSION_COOKIE}=`));
}

function isSupabaseRestGet(url, request) {
  return (
    request.method === 'GET' &&
    url.pathname.includes('/rest/v1/') &&
    // public data only: the guide reads candidate/position/office rows. If the
    // request is authenticated (Authorization header present), do not cache.
    !request.headers.get('authorization')
  );
}

// Decide how to handle a request. Returns a strategy string.
function chooseStrategy(url, request, sameOrigin) {
  if (request.method !== 'GET') return 'passthrough';

  // Never cache anything personalized: a request that carries the session
  // cookie may return voter-scoped server data. Straight to network.
  if (sameOrigin && hasSessionCookie(request)) return 'passthrough';

  if (request.mode === 'navigate') return 'navigate';

  if (sameOrigin && url.pathname === POSITIONS_BUNDLE_PATH) {
    return 'network-first';
  }

  if (!sameOrigin && isSupabaseRestGet(url, request)) {
    return 'stale-while-revalidate';
  }

  if (
    sameOrigin &&
    (url.pathname.startsWith('/_next/static/') ||
      url.pathname.startsWith('/icons/') ||
      /\.(?:css|js|woff2?|png|jpg|jpeg|svg|webp|ico)$/.test(url.pathname))
  ) {
    return 'stale-while-revalidate';
  }

  return 'passthrough';
}

// A response is safe to store only if it is a real, non-personalized response.
function isCacheableResponse(response) {
  if (!response || !response.ok) return false;
  if (response.type === 'opaque') return false; // can't inspect -> don't store
  if (response.headers.get('set-cookie')) return false;
  const cc = (response.headers.get('cache-control') || '').toLowerCase();
  if (cc.includes('no-store') || cc.includes('private')) return false;
  return true;
}

// ---- strategy implementations --------------------------------------------

async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    if (isCacheableResponse(res)) {
      const cache = await caches.open(cacheName);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error('network-first: no network and no cache');
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (isCacheableResponse(res)) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || fetch(request);
}

async function handleNavigate(request) {
  try {
    const res = await fetch(request);
    // Cache successful shell navigations (public pages only; personalized
    // requests were already routed to passthrough before we got here).
    if (isCacheableResponse(res) && request.method === 'GET') {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response(
      'You are offline. Your saved answers and plan are still on this device.',
      { status: 503, headers: { 'content-type': 'text/plain' } },
    );
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const strategy = chooseStrategy(url, request, sameOrigin);

  switch (strategy) {
    case 'navigate':
      event.respondWith(handleNavigate(request));
      break;
    case 'network-first':
      event.respondWith(networkFirst(request, RUNTIME_CACHE));
      break;
    case 'stale-while-revalidate':
      event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
      break;
    case 'passthrough':
    default:
      // Do not call respondWith: let the browser handle it normally, so the
      // SW never touches personalized / mutating requests.
      break;
  }
});

// Allow the page to trigger an immediate activation after an update.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ---- daily-prompt notification (work-order Phase 2B) ----------------------
// The notification is SHOWN by the page via registration.showNotification (see
// src/components/pwa/DailyReminder.tsx) - this handler only routes the TAP back
// into the app. It carries no opinion; data.url points at /guide?prompt=1 so the
// on-device "Today's question" card is front-and-center on open. Focuses an
// existing tab when one is open, else opens a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target =
    (event.notification.data && event.notification.data.url) || '/guide?prompt=1';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of all) {
        // Reuse any open Havesay tab; navigate it to the prompt and focus.
        if ('focus' in client) {
          try {
            if ('navigate' in client) await client.navigate(target);
          } catch {
            /* cross-origin or navigation blocked; fall through to focus */
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })(),
  );
});
