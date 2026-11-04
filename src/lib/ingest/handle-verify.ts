/**
 * handle-verify.ts -- social-handle ownership verification primitives for
 * AGGREGATOR-FREE active discovery.
 *
 * The whole game in identity is confirmation: a name match alone is NEVER
 * enough. This module implements the verification rung of the discovery chain
 * (section 1 of 12-positioning-engine/09-candidate-research-techniques-and-
 * tools.md) using only free/open, terms-of-service-clean primitives:
 *
 *   1. relMeLoop(siteUrl, profileUrl) -- the IndieWeb anti-impersonation
 *      primitive. The candidate's OWN confirmed site links to a profile
 *      (rel="me") AND that profile links back to the site. A reciprocal loop
 *      proves the same entity controls both. This is the strongest free signal.
 *   2. blueskyProfile(handle) -- the keyless Bluesky public API
 *      (public.api.bsky.app). Confirms a handle exists and returns its display
 *      name + description, which we corroborate against name/office/locality.
 *   3. youtubeChannel(...) -- YouTube Data API v3 when YOUTUBE_API_KEY is set;
 *      gracefully SKIPPED (returns skipped:true) when the key is absent.
 *
 * For Meta / X / TikTok / LinkedIn there is NO clean automated read path
 * (X read is metered-only, the others ban anti-automation). Per the data-source
 * policy we resolve a handle on those platforms ONLY from a link the candidate
 * published on their OWN confirmed site, then corroborate by name/office/
 * locality string match. We NEVER scrape those platforms. resolvePublishedHandle
 * + corroborateHandle below encode exactly that posture.
 *
 * Native fetch only, no new npm deps, no Python. Every function is total
 * (never throws); errors become ok:false / verified:false result objects.
 */

import { canonicalKey } from '@/lib/ingest/identity-resolve';

// ---------------------------------------------------------------------------
// shared config
// ---------------------------------------------------------------------------

const DEFAULT_USER_AGENT =
  'Havesay-DiscoveryBot/1.0 (aggregator-free civic data; contact: no-reply@example.org)';

export interface HandleVerifyOpts {
  /** Per-call timeout in ms. Default 10000. */
  timeoutMs?: number;
  /** Injected fetch for OFFLINE TESTS. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Descriptive User-Agent. */
  userAgent?: string;
}

interface FetchTextOutcome {
  ok: boolean;
  status: number;
  body: string;
  finalUrl: string;
  error?: string;
}

async function fetchText(
  url: string,
  opts: HandleVerifyOpts,
): Promise<FetchTextOutcome> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent },
      redirect: 'follow',
      signal: controller.signal,
    });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      body,
      finalUrl: (res as Response).url || url,
    };
  } catch (e) {
    return { ok: false, status: 0, body: '', finalUrl: url, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// rel="me" extraction
// ---------------------------------------------------------------------------

/** Normalize a URL for reciprocal comparison: lowercase host, drop scheme + trailing slash + www. */
function normForCompare(raw: string): string | null {
  try {
    let u: URL;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      u = new URL(raw);
    } else {
      u = new URL(`https://${raw}`);
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '') path = '';
    // Compare on host + path (ignore scheme, query, fragment, trailing slash).
    return `${host}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Extract rel="me" link targets from an HTML document. Matches both
 * <a rel="me" href> and <link rel="me" href>, in either attribute order, and
 * tolerates multi-token rel values (rel="me noopener"). Regex-based (no DOM
 * dependency) so it works on any fetched body. Returns absolute URLs resolved
 * against baseUrl.
 */
export function extractRelMeLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  if (!html) return out;
  // Match any <a ...> or <link ...> tag, then test for rel containing "me"
  // and pull href. Two passes keep the regex simple and order-independent.
  const tagRe = /<(?:a|link)\b[^>]*>/gi;
  const tags = html.match(tagRe) ?? [];
  for (const tag of tags) {
    const relMatch = tag.match(/\brel\s*=\s*["']([^"']*)["']/i);
    if (!relMatch) continue;
    const relTokens = relMatch[1].toLowerCase().split(/\s+/);
    if (!relTokens.includes('me')) continue;
    const hrefMatch = tag.match(/\bhref\s*=\s*["']([^"']*)["']/i);
    if (!hrefMatch || !hrefMatch[1]) continue;
    try {
      const abs = new URL(hrefMatch[1], baseUrl).toString();
      out.push(abs);
    } catch {
      /* skip malformed href */
    }
  }
  // Dedup, preserve order.
  return Array.from(new Set(out));
}

// ---------------------------------------------------------------------------
// (1) rel=me reciprocal loop
// ---------------------------------------------------------------------------

export interface RelMeResult {
  /** True ONLY when BOTH directions link to each other (the reciprocal loop). */
  verified: boolean;
  siteUrl: string;
  profileUrl: string;
  /** Site -> profile rel=me present. */
  siteLinksToProfile: boolean;
  /** Profile -> site rel=me (or plain link) present. */
  profileLinksToSite: boolean;
  /** Human-readable explanation. */
  detail: string;
}

/**
 * relMeLoop(siteUrl, profileUrl): confirm a reciprocal rel="me" relationship.
 *
 *   step 1: fetch siteUrl, confirm it has a rel="me" link to profileUrl.
 *   step 2: fetch profileUrl, confirm it links back to siteUrl (rel="me"
 *           preferred; a plain <a href> back to the site host also counts,
 *           since many social profiles expose the website link without rel=me).
 *
 * verified is TRUE only when both directions hold -- that is the anti-
 * impersonation guarantee. Total: any fetch error yields verified:false with a
 * detail, never a throw.
 */
export async function relMeLoop(
  siteUrl: string,
  profileUrl: string,
  opts: HandleVerifyOpts = {},
): Promise<RelMeResult> {
  const base = {
    siteUrl,
    profileUrl,
    siteLinksToProfile: false,
    profileLinksToSite: false,
  };

  const profileNorm = normForCompare(profileUrl);
  const siteNorm = normForCompare(siteUrl);
  if (!profileNorm || !siteNorm) {
    return { ...base, verified: false, detail: 'malformed siteUrl or profileUrl' };
  }

  // --- step 1: site -> profile ---
  const siteRes = await fetchText(siteUrl, opts);
  if (!siteRes.ok || !siteRes.body) {
    return { ...base, verified: false, detail: `could not fetch site (${siteRes.error ?? `http ${siteRes.status}`})` };
  }
  const siteRelMe = extractRelMeLinks(siteRes.body, siteRes.finalUrl).map(normForCompare).filter(Boolean) as string[];
  const siteLinksToProfile = siteRelMe.includes(profileNorm);
  if (!siteLinksToProfile) {
    return {
      ...base,
      verified: false,
      detail: `site has no rel="me" link to the profile (${siteRelMe.length} rel=me link(s) found, none matched)`,
    };
  }

  // --- step 2: profile -> site ---
  const profRes = await fetchText(profileUrl, opts);
  if (!profRes.ok || !profRes.body) {
    return {
      ...base,
      siteLinksToProfile: true,
      verified: false,
      detail: `site links to profile, but could not fetch profile to confirm back-link (${profRes.error ?? `http ${profRes.status}`})`,
    };
  }
  const profRelMe = extractRelMeLinks(profRes.body, profRes.finalUrl).map(normForCompare).filter(Boolean) as string[];
  let profileLinksToSite = profRelMe.includes(siteNorm);
  // Fallback: a plain (non-rel=me) anchor back to the site host also counts --
  // social profiles often expose the website without a rel=me attribute.
  if (!profileLinksToSite) {
    const siteHost = siteNorm.split('/')[0];
    const plainLinkRe = new RegExp(`href\\s*=\\s*["']https?://(?:www\\.)?${siteHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    if (plainLinkRe.test(profRes.body)) profileLinksToSite = true;
  }

  const verified = siteLinksToProfile && profileLinksToSite;
  return {
    ...base,
    siteLinksToProfile: true,
    profileLinksToSite,
    verified,
    detail: verified
      ? 'reciprocal rel="me" loop confirmed (site<->profile)'
      : 'site links to profile but profile does not link back (no reciprocal loop)',
  };
}

// ---------------------------------------------------------------------------
// (2) Bluesky public profile (keyless)
// ---------------------------------------------------------------------------

export interface BlueskyResult {
  ok: boolean;
  handle: string;
  did?: string | null;
  displayName?: string | null;
  description?: string | null;
  httpStatus?: number;
  error?: string;
}

interface BskyProfilePayload {
  did?: string;
  handle?: string;
  displayName?: string;
  description?: string;
}

/**
 * blueskyProfile(handle): confirm a Bluesky handle exists via the KEYLESS
 * public API (public.api.bsky.app/xrpc/app.bsky.actor.getProfile). Returns the
 * decentralized identifier (DID), display name, and description so the caller
 * can corroborate against the candidate's name/office/locality. Total: a 400
 * (handle not found) or any error yields ok:false, never a throw.
 */
export async function blueskyProfile(
  handleInput: string,
  opts: HandleVerifyOpts = {},
): Promise<BlueskyResult> {
  // Accept a bare handle, an @handle, or a bsky.app profile URL.
  let handle = (handleInput ?? '').trim();
  const urlMatch = handle.match(/bsky\.app\/profile\/([^/?#]+)/i);
  if (urlMatch) handle = urlMatch[1];
  handle = handle.replace(/^@/, '');
  if (!handle) {
    return { ok: false, handle: handleInput, error: 'empty handle' };
  }

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const url = `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, handle, httpStatus: res.status, error: `bluesky http ${res.status}` };
    }
    const p = (await res.json()) as BskyProfilePayload;
    return {
      ok: true,
      handle: p.handle ?? handle,
      did: p.did ?? null,
      displayName: p.displayName ?? null,
      description: p.description ?? null,
      httpStatus: res.status,
    };
  } catch (e) {
    return { ok: false, handle, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// (3) YouTube Data API v3 (key-gated; skipped without YOUTUBE_API_KEY)
// ---------------------------------------------------------------------------

export interface YouTubeResult {
  /** True when a lookup ran AND found the channel. */
  ok: boolean;
  /** True when the lookup was SKIPPED because no YOUTUBE_API_KEY is set. */
  skipped: boolean;
  query: string;
  channelId?: string | null;
  title?: string | null;
  description?: string | null;
  customUrl?: string | null;
  httpStatus?: number;
  error?: string;
}

interface YtChannelItem {
  id?: string | { channelId?: string };
  snippet?: { title?: string; description?: string; customUrl?: string };
}
interface YtResponse {
  items?: YtChannelItem[];
}

/**
 * youtubeChannel(identifier, opts): resolve a YouTube channel via the YouTube
 * Data API v3 ONLY when YOUTUBE_API_KEY (env or opts.apiKey) is set; otherwise
 * returns skipped:true (graceful skip, NOT an error -- the channel link still
 * gets ingested as a source, it just is not API-verified).
 *
 * identifier may be a channel id (UC...), a handle (@name), or a free-text
 * query (the candidate name). For a channel id we use channels?id=; otherwise
 * we use channels?forHandle= for an @handle, or search?type=channel for text.
 */
export async function youtubeChannel(
  identifier: string,
  opts: HandleVerifyOpts & { apiKey?: string | null } = {},
): Promise<YouTubeResult> {
  const apiKey = opts.apiKey === undefined ? process.env.YOUTUBE_API_KEY ?? null : opts.apiKey;
  const id = (identifier ?? '').trim();
  if (!apiKey) {
    return { ok: false, skipped: true, query: id, error: 'YOUTUBE_API_KEY not set -- skipped' };
  }
  if (!id) {
    return { ok: false, skipped: false, query: id, error: 'empty identifier' };
  }

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  // Decide the endpoint shape from the identifier.
  let url: string;
  let isSearch = false;
  if (/^UC[0-9A-Za-z_-]{20,}$/.test(id)) {
    url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${encodeURIComponent(id)}&key=${encodeURIComponent(apiKey)}`;
  } else if (id.startsWith('@')) {
    url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=${encodeURIComponent(id)}&key=${encodeURIComponent(apiKey)}`;
  } else {
    isSearch = true;
    url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(id)}&key=${encodeURIComponent(apiKey)}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, skipped: false, query: id, httpStatus: res.status, error: `youtube http ${res.status}` };
    }
    const p = (await res.json()) as YtResponse;
    const item = p.items?.[0];
    if (!item) {
      return { ok: false, skipped: false, query: id, httpStatus: res.status, error: 'no channel found' };
    }
    const channelId = isSearch
      ? typeof item.id === 'object'
        ? item.id?.channelId ?? null
        : null
      : typeof item.id === 'string'
        ? item.id
        : null;
    return {
      ok: true,
      skipped: false,
      query: id,
      channelId,
      title: item.snippet?.title ?? null,
      description: item.snippet?.description ?? null,
      customUrl: item.snippet?.customUrl ?? null,
      httpStatus: res.status,
    };
  } catch (e) {
    return { ok: false, skipped: false, query: id, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Meta / X / TikTok / LinkedIn -- site-published-link-only posture
// ---------------------------------------------------------------------------

/** Platforms with NO clean automated read path -- handle from own site only. */
export const NO_SCRAPE_PLATFORMS = [
  'facebook',
  'instagram',
  'threads',
  'x',
  'twitter',
  'tiktok',
  'linkedin',
] as const;

export type NoScrapePlatform = (typeof NO_SCRAPE_PLATFORMS)[number];

const PLATFORM_HOST_PATTERNS: Array<{ platform: NoScrapePlatform; re: RegExp }> = [
  { platform: 'facebook', re: /(?:^|\.)facebook\.com$|(?:^|\.)fb\.com$/i },
  { platform: 'instagram', re: /(?:^|\.)instagram\.com$/i },
  { platform: 'threads', re: /(?:^|\.)threads\.net$/i },
  { platform: 'x', re: /(?:^|\.)x\.com$/i },
  { platform: 'twitter', re: /(?:^|\.)twitter\.com$/i },
  { platform: 'tiktok', re: /(?:^|\.)tiktok\.com$/i },
  { platform: 'linkedin', re: /(?:^|\.)linkedin\.com$/i },
];

export interface PublishedHandle {
  platform: NoScrapePlatform;
  url: string;
  handle: string | null;
}

/**
 * resolvePublishedHandle(url): classify a single URL the candidate published on
 * their OWN site as one of the no-scrape platforms, extracting the handle when
 * possible. Returns null when the URL is not one of those platforms. This is
 * the ONLY sanctioned way to obtain a Meta/X/TikTok/LinkedIn handle: from the
 * candidate's own published link -- never by scraping the platform.
 */
export function resolvePublishedHandle(url: string): PublishedHandle | null {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const match = PLATFORM_HOST_PATTERNS.find((p) => p.re.test(host));
  if (!match) return null;

  // Extract a handle from the first path segment for the common platforms.
  const seg = u.pathname.split('/').filter(Boolean);
  let handle: string | null = null;
  switch (match.platform) {
    case 'x':
    case 'twitter':
    case 'facebook':
    case 'instagram':
    case 'tiktok':
      // /@name (tiktok) or /name.
      handle = seg[0] ? seg[0].replace(/^@/, '') : null;
      break;
    case 'threads':
      handle = seg[0] ? seg[0].replace(/^@/, '') : null;
      break;
    case 'linkedin':
      // /in/<slug> or /company/<slug>.
      if (seg[0] === 'in' || seg[0] === 'company') handle = seg[1] ?? null;
      else handle = seg[0] ?? null;
      break;
  }
  return { platform: match.platform, url: u.toString(), handle };
}

export interface CorroborationResult {
  /** True when the profile metadata corroborates the candidate identity. */
  corroborated: boolean;
  /** Which signals matched (name / office / locality). */
  matched: string[];
  detail: string;
}

/**
 * corroborateHandle(profileText, identity): string-match corroboration for a
 * resolved handle whose profile we obtained through a sanctioned channel (the
 * candidate's own site link, a keyless Bluesky description, or a YouTube
 * channel description). Requires the candidate NAME to appear (canonical-key
 * folded) PLUS at least one of office / locality to count as corroborated.
 *
 * This is deliberately NOT a high-trust signal on its own -- it is one input to
 * the discovery GATE, which still needs a primary-source trace OR a rel=me loop
 * for a strong bind. Corroboration alone leaves a source UNATTRIBUTED (queued).
 */
export function corroborateHandle(
  profileText: string | null | undefined,
  identity: { name: string; office?: string | null; locality?: string | null },
): CorroborationResult {
  const text = (profileText ?? '').toString();
  if (!text.trim()) {
    return { corroborated: false, matched: [], detail: 'no profile text to corroborate against' };
  }
  const foldedText = canonicalKey(text);
  const matched: string[] = [];

  const nameKey = canonicalKey(identity.name ?? '');
  // Name match: the candidate's folded name appears as a substring of the
  // folded profile text. (canonicalKey strips spaces, so "Jane Doe" -> "janedoe".)
  const nameMatch = nameKey.length >= 4 && foldedText.includes(nameKey);
  if (nameMatch) matched.push('name');

  const officeKey = canonicalKey(identity.office ?? '');
  if (officeKey.length >= 3 && foldedText.includes(officeKey)) matched.push('office');

  const localityKey = canonicalKey(identity.locality ?? '');
  if (localityKey.length >= 3 && foldedText.includes(localityKey)) matched.push('locality');

  // Require name + at least one of office/locality.
  const corroborated = nameMatch && (matched.includes('office') || matched.includes('locality'));
  return {
    corroborated,
    matched,
    detail: corroborated
      ? `corroborated via ${matched.join(' + ')}`
      : `insufficient corroboration (matched: ${matched.join(', ') || 'none'}; need name + office/locality)`,
  };
}
