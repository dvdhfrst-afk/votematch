/**
 * discover-forum-videos.ts -- forum/debate VIDEO discovery for the source-centric
 * harvest engine (Build 1).
 *
 * GOAL. Given a RACE (jurisdiction / office / cycle) or a known HOST-ORG channel,
 * find candidate-forum and debate VIDEOS to register as
 * harvest_sources(source_type='forum_video'). The forum-video parser then fetches
 * each video's transcript once and attributes per-candidate answer spans (see
 * parsers/forum-video.ts).
 *
 * WHO PUBLISHES FORUM VIDEOS (researched 2026-06-15). Candidate forums and
 * debates are overwhelmingly recorded by a small set of NONPARTISAN HOST ORGS and
 * posted to their own YouTube channels and websites:
 *   - League of Women Voters chapters (state + local) -- the single most prolific
 *     host; each chapter posts forums to its own YouTube channel and a
 *     "candidate forums" page.
 *   - PEG / public-access TV (the Public, Educational, Governmental cable
 *     channels) -- e.g. "<County> Community Television", PEGTV, CCTV. They
 *     livestream and archive forums on YouTube + their own sites.
 *   - Chambers of Commerce, public libraries, and civic groups (Rotary, NAACP,
 *     neighborhood councils) that co-host candidate nights.
 * These are exactly the ACCEPTABLE-source kind from CLAUDE.md's data-source
 * policy: nonpartisan civic hosts publishing PUBLIC video of PUBLIC events. We do
 * NOT touch aggregators (Ballotpedia, Vote411, BallotReady, etc.) -- the shared
 * DENYLIST + the search backend's vetting enforce that.
 *
 * DISCOVERY APPROACH (two complementary modes, both aggregator-free):
 *
 *   MODE A -- RACE SEARCH. Build the operator queries a human would run:
 *     "<office> <locality> <cycle> candidate forum", "... candidate debate",
 *     "<locality> League of Women Voters candidate forum <cycle>", and
 *     "<locality> candidate forum youtube". Run them through the project's
 *     backend-agnostic search layer (search-backend.ts: self-hosted SearXNG,
 *     DuckDuckGo fallback). For every returned URL pointer, FETCH the page and run
 *     extractVideoRefs (reused from video-transcript.ts) to pull the YouTube
 *     videos embedded or linked on it -- a League "candidate forums" page or a PEG
 *     archive page lists many forum videos at once. Result URLs that are
 *     THEMSELVES youtube watch/embed/youtu.be links are captured directly.
 *
 *   MODE B -- HOST-ORG CHANNEL. Given a known host-org channel page (a League
 *     chapter's YouTube channel, a PEG station's videos page, a chamber's media
 *     page) FETCH it and extractVideoRefs the forum videos it lists. This is the
 *     high-precision path once you know a region's hosts; MODE A is how you find
 *     those hosts in the first place.
 *
 * RANKING + WHY. Each candidate video gets a confidence in [0,1] and a short
 * "why" string. Signals (additive, clamped): the page/title contains forum/debate
 * language; it contains the cycle year; it contains the office or locality; it
 * came from a recognized host-org host (lwv*, *pegtv*, *communitymedia*, etc.); it
 * was a direct youtube result vs. extracted from a listing page. A low-confidence
 * hit is still RETURNED (the caller decides) but flagged so a thin match is not
 * silently registered.
 *
 * OUTPUT. CandidateForumVideo[] -- each with the canonical watch URL, the video
 * id, confidence, why, and the source page it was found on. The harvest-forums.ts
 * script maps these onto harvest_sources(source_type='forum_video') rows
 * (url = the watch URL, scope = the race's FIPS/office/cycle, meta.video_id +
 * meta.discovery).
 *
 * Single TypeScript runtime, no Python, no new npm deps. Native fetch only;
 * search() and the page-fetch are injectable so the offline test runs with zero
 * network.
 */

import { search as searchBackend, type SearchResult } from '@/lib/ingest/search-backend';
import { extractVideoRefs, normalizeYoutubeId } from '@/lib/ingest/video-transcript';
import { canonicalizeUrl, isDenied } from '@/lib/ingest/raw-ingest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The race scope to discover forum videos for (MODE A). */
export interface ForumRaceScope {
  /** Office name as a search term, e.g. "County Commission", "Mayor". */
  office?: string | null;
  /** Locality string, e.g. "Davis County, Utah" / "Salt Lake City". */
  locality?: string | null;
  /** State name or abbreviation, e.g. "Utah" / "UT" (used in queries). */
  state?: string | null;
  /** Election cycle / year, e.g. "2026". */
  cycle?: string | null;
}

/** A known host-org channel/page to harvest forum videos from (MODE B). */
export interface HostOrgChannel {
  /** The channel or videos-listing URL (a YouTube channel, a PEG videos page). */
  url: string;
  /** Optional label for the why string, e.g. "Davis County LWV". */
  label?: string | null;
}

/** One discovered candidate-forum video. */
export interface CandidateForumVideo {
  /** Canonical YouTube watch URL (to store as harvest_sources.url). */
  url: string;
  /** 11-char YouTube video id (to store in meta.video_id). */
  videoId: string;
  /** Discovery confidence in [0,1]. */
  confidence: number;
  /** Human-readable reasons the confidence was assigned (for the log + review). */
  why: string[];
  /** The page the video was found on (a listing page, or the watch URL itself). */
  foundOn: string;
  /** Which discovery mode produced it. */
  mode: 'race_search' | 'host_channel';
}

export interface DiscoverForumOpts {
  /** Max search queries to run in MODE A (politeness). Default 4. */
  maxQueries?: number;
  /** Max search-result PAGES to fetch + scan per run. Default 12. */
  maxPagesToScan?: number;
  /** Max candidate videos to return. Default 25. */
  limit?: number;
  /** Per-fetch timeout in ms. Default 12000. */
  timeoutMs?: number;
  /** Min confidence to KEEP a video (lower ones are dropped). Default 0.0 (keep all, flagged). */
  minConfidence?: number;
  /** Injected search() for OFFLINE TESTS. Defaults to the real search backend. */
  searchImpl?: typeof searchBackend;
  /** Injected page fetcher for OFFLINE TESTS. Given a URL, returns HTML/text or null. */
  fetchPage?: (url: string) => Promise<string | null>;
  /** Override SEARX_URL into the search backend. */
  searxUrl?: string | null;
  /** Descriptive User-Agent for page fetches. */
  userAgent?: string;
}

export interface DiscoverForumResult {
  /** Final, ranked, deduped candidate forum videos. */
  videos: CandidateForumVideo[];
  /** The queries that were run (MODE A). */
  queries: string[];
  /** Count of result pages fetched + scanned. */
  pagesScanned: number;
  /** True if the search backend ran degraded (DuckDuckGo fallback). */
  searchDegraded: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Host-org recognition + forum-language signals
// ---------------------------------------------------------------------------

/**
 * Hosts that are recognized nonpartisan forum publishers. A video found on (or
 * linked from) one of these earns a confidence bump. Substring-matched against
 * the registrable domain / hostname, lowercased.
 */
const HOST_ORG_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(?:^|\.)lwv/i, label: 'League of Women Voters' },
  { re: /leagueofwomenvoters/i, label: 'League of Women Voters' },
  { re: /pegtv|peg-tv|publicaccess|communitymedia|communitytelevision|communitytv|\bcctv\b|cantv|accesstv|accesshumboldt|mediacenter/i, label: 'PEG / public-access TV' },
  { re: /chamber/i, label: 'Chamber of Commerce' },
  { re: /library|libraries/i, label: 'Public library' },
  { re: /\bnaacp\b|rotary|kiwanis|jaycees|neighborhoodcouncil/i, label: 'Civic group' },
];

/** Forum/debate language signals (in a title or page text). */
const FORUM_LANG_RE = /\b(candidate\s+forum|candidate\s+debate|candidates?\s+night|forum|debate|town\s*hall|meet\s+the\s+candidates?)\b/i;
const DEBATE_LANG_RE = /\b(debate|forum)\b/i;

/** Recognize a host org by hostname; return its label or null. */
function recognizeHost(host: string): string | null {
  const h = host.toLowerCase();
  for (const { re, label } of HOST_ORG_PATTERNS) {
    if (re.test(h)) return label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Query building (MODE A)
// ---------------------------------------------------------------------------

/**
 * buildForumQueries(scope): the operator queries a researcher would run to find
 * forum/debate videos for a race. Most specific first. EXPORTED for the test.
 */
export function buildForumQueries(scope: ForumRaceScope): string[] {
  const office = (scope.office ?? '').trim();
  const locality = (scope.locality ?? '').trim();
  const state = (scope.state ?? '').trim();
  const cycle = (scope.cycle ?? '').trim();
  const place = [locality, state].filter(Boolean).join(' ').trim();

  const queries: string[] = [];
  // Office + place + cycle: the sharpest.
  if (office && place) {
    queries.push(`${office} ${place} ${cycle} candidate forum`.trim());
    queries.push(`${office} ${place} ${cycle} candidate debate`.trim());
  }
  // Place + cycle forum (catches multi-office "meet the candidates" events).
  if (place) {
    queries.push(`${place} ${cycle} candidate forum`.trim());
    queries.push(`${place} League of Women Voters candidate forum ${cycle}`.trim());
    queries.push(`${place} candidate forum youtube`.trim());
  }
  // Office only, last resort.
  if (office && cycle) queries.push(`${office} ${cycle} candidate forum`.trim());

  // Dedup, preserve order.
  const seen = new Set<string>();
  return queries.filter((q) => {
    const k = q.toLowerCase();
    if (!q || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

interface ScoreContext {
  scope?: ForumRaceScope | null;
  /** Title / snippet / surrounding text to scan for forum + scope language. */
  text: string;
  /** Host the video (or its listing page) came from. */
  host: string;
  /** True when the video URL was a DIRECT search/result hit (vs. extracted). */
  direct: boolean;
  /** Host-org label when the source page host was recognized. */
  hostLabel: string | null;
}

/**
 * scoreVideo(ctx): assign a [0,1] confidence + the "why" reasons. Additive
 * signals, clamped. EXPORTED for the offline test.
 *
 * Signals:
 *   + forum/debate language in the title/text          0.35
 *   + the cycle year present                           0.15
 *   + the office term present                           0.15
 *   + the locality term present                         0.15
 *   + a recognized host org (LWV / PEG / chamber / ...) 0.25
 *   + a direct youtube result (vs. extracted listing)   0.05
 */
export function scoreVideo(ctx: ScoreContext): { confidence: number; why: string[] } {
  const why: string[] = [];
  let score = 0;
  const text = (ctx.text ?? '').toLowerCase();
  const office = (ctx.scope?.office ?? '').trim().toLowerCase();
  const locality = (ctx.scope?.locality ?? '').trim().toLowerCase();
  const cycle = (ctx.scope?.cycle ?? '').trim().toLowerCase();

  if (FORUM_LANG_RE.test(text)) {
    score += 0.35;
    why.push('forum/debate language in title/page');
  }
  if (cycle && text.includes(cycle)) {
    score += 0.15;
    why.push(`cycle ${cycle} present`);
  }
  if (office) {
    // Match on the most distinctive office word (e.g. "commission", "mayor").
    const officeWord = office.split(/\s+/).sort((a, b) => b.length - a.length)[0] ?? office;
    if (officeWord.length >= 4 && text.includes(officeWord)) {
      score += 0.15;
      why.push(`office term "${officeWord}" present`);
    }
  }
  if (locality) {
    const locWord = locality.split(/[\s,]+/).sort((a, b) => b.length - a.length)[0] ?? locality;
    if (locWord.length >= 4 && text.includes(locWord)) {
      score += 0.15;
      why.push(`locality "${locWord}" present`);
    }
  }
  if (ctx.hostLabel) {
    score += 0.25;
    why.push(`recognized host org: ${ctx.hostLabel}`);
  }
  if (ctx.direct) {
    score += 0.05;
    why.push('direct video result');
  }
  if (why.length === 0) why.push('no strong forum signal -- low confidence, review before registering');

  return { confidence: Math.max(0, Math.min(1, score)), why };
}

// ---------------------------------------------------------------------------
// Default page fetcher (polite, total)
// ---------------------------------------------------------------------------

const DEFAULT_USER_AGENT =
  'Havesay-DiscoveryBot/1.0 (aggregator-free civic data; contact: no-reply@example.org)';

function makeDefaultPageFetcher(timeoutMs: number, userAgent: string): (url: string) => Promise<string | null> {
  return async (url: string): Promise<string | null> => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        headers: { Accept: 'text/html,application/xhtml+xml,*/*', 'User-Agent': userAgent },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Is this result URL itself a YouTube video reference? Returns the id or null. */
function directVideoId(url: string): string | null {
  return normalizeYoutubeId(url);
}

// ---------------------------------------------------------------------------
// MODE A -- race search
// ---------------------------------------------------------------------------

async function discoverByRaceSearch(
  scope: ForumRaceScope,
  opts: Required<Pick<DiscoverForumOpts, 'maxQueries' | 'maxPagesToScan' | 'timeoutMs' | 'userAgent'>> & {
    searchImpl: typeof searchBackend;
    fetchPage: (url: string) => Promise<string | null>;
    searxUrl?: string | null;
  },
  result: DiscoverForumResult,
  collect: (v: Omit<CandidateForumVideo, 'confidence' | 'why'> & { text: string; hostLabel: string | null }) => void,
): Promise<void> {
  const queries = buildForumQueries(scope).slice(0, opts.maxQueries);
  result.queries = queries;

  const seenResultUrls = new Set<string>();
  const resultUrls: SearchResult[] = [];
  for (const q of queries) {
    const resp = await opts.searchImpl(q, { searxUrl: opts.searxUrl });
    if (resp.degraded) result.searchDegraded = true;
    for (const r of resp.results) {
      if (seenResultUrls.has(r.url)) continue;
      seenResultUrls.add(r.url);
      resultUrls.push(r);
    }
  }
  if (result.searchDegraded) {
    result.notes.push('search ran DEGRADED (DuckDuckGo fallback; set SEARX_URL for real video discovery coverage)');
  }

  let scanned = 0;
  for (const r of resultUrls) {
    const host = hostOf(r.url);
    const hostLabel = recognizeHost(host);

    // (1) The result URL itself may be a YouTube video.
    const directId = directVideoId(r.url);
    if (directId) {
      collect({
        url: `https://www.youtube.com/watch?v=${directId}`,
        videoId: directId,
        foundOn: r.url,
        mode: 'race_search',
        text: `${r.title ?? ''} ${r.snippet ?? ''}`,
        hostLabel,
      });
      continue;
    }

    // (2) Otherwise FETCH the page and extract the YouTube videos on it (a League
    // "candidate forums" page or a PEG archive lists many at once). Skip
    // denylisted hosts and cap how many pages we fetch.
    if (scanned >= opts.maxPagesToScan) continue;
    let registrable: string | null = null;
    try {
      registrable = canonicalizeUrl(r.url).registrableDomain;
    } catch {
      /* ignore */
    }
    if (isDenied(registrable, host)) continue;

    const html = await opts.fetchPage(r.url);
    scanned++;
    result.pagesScanned = scanned;
    if (!html) continue;

    // Only treat the page as a forum-listing source if it actually mentions a
    // forum/debate -- avoids scraping every random youtube embed on a news site.
    const pageMentionsForum = DEBATE_LANG_RE.test(html) || FORUM_LANG_RE.test(`${r.title ?? ''} ${r.snippet ?? ''}`);
    const refs = extractVideoRefs(html, r.url).filter((v) => v.platform === 'youtube');
    for (const ref of refs) {
      collect({
        url: ref.url,
        videoId: ref.videoId,
        foundOn: r.url,
        mode: 'race_search',
        // Scope the scored text to the page title + snippet + a forum-language
        // flag so the extracted video inherits the listing page's signal.
        text: `${r.title ?? ''} ${r.snippet ?? ''} ${pageMentionsForum ? 'candidate forum' : ''}`,
        hostLabel,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// MODE B -- host-org channel
// ---------------------------------------------------------------------------

async function discoverByHostChannel(
  channels: HostOrgChannel[],
  opts: { fetchPage: (url: string) => Promise<string | null> },
  scope: ForumRaceScope | null,
  result: DiscoverForumResult,
  collect: (v: Omit<CandidateForumVideo, 'confidence' | 'why'> & { text: string; hostLabel: string | null }) => void,
): Promise<void> {
  for (const ch of channels) {
    const host = hostOf(ch.url);
    const hostLabel = recognizeHost(host) ?? (ch.label ?? null);

    // A channel URL may itself be a watch URL (a single forum video).
    const directId = directVideoId(ch.url);
    if (directId) {
      collect({
        url: `https://www.youtube.com/watch?v=${directId}`,
        videoId: directId,
        foundOn: ch.url,
        mode: 'host_channel',
        text: `${ch.label ?? ''} candidate forum`,
        hostLabel,
      });
      continue;
    }

    const html = await opts.fetchPage(ch.url);
    result.pagesScanned += 1;
    if (!html) {
      result.notes.push(`host channel returned no body: ${ch.url}`);
      continue;
    }
    const refs = extractVideoRefs(html, ch.url).filter((v) => v.platform === 'youtube');
    for (const ref of refs) {
      collect({
        url: ref.url,
        videoId: ref.videoId,
        foundOn: ch.url,
        mode: 'host_channel',
        // A known host-org channel is trusted forum-language context.
        text: `${ch.label ?? ''} candidate forum ${scope?.cycle ?? ''}`,
        hostLabel,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * discoverForumVideos -- find candidate-forum/debate videos for a race and/or
 * from known host-org channels, ranked by confidence, deduped by video id.
 *
 * Provide a `scope` (MODE A race search), `channels` (MODE B host-org harvest),
 * or both. The result's videos are ready to register as
 * harvest_sources(source_type='forum_video') by harvest-forums.ts.
 *
 * Total: never throws; all network primitives degrade to empty results.
 */
export async function discoverForumVideos(
  args: { scope?: ForumRaceScope | null; channels?: HostOrgChannel[] | null },
  opts: DiscoverForumOpts = {},
): Promise<DiscoverForumResult> {
  const maxQueries = opts.maxQueries ?? 4;
  const maxPagesToScan = opts.maxPagesToScan ?? 12;
  const limit = opts.limit ?? 25;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const minConfidence = opts.minConfidence ?? 0.0;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const searchImpl = opts.searchImpl ?? searchBackend;
  const fetchPage = opts.fetchPage ?? makeDefaultPageFetcher(timeoutMs, userAgent);

  const result: DiscoverForumResult = {
    videos: [],
    queries: [],
    pagesScanned: 0,
    searchDegraded: false,
    notes: [],
  };

  // Dedup by video id; keep the HIGHEST-confidence occurrence.
  const byId = new Map<string, CandidateForumVideo>();
  const scope = args.scope ?? null;

  const collect = (
    v: Omit<CandidateForumVideo, 'confidence' | 'why'> & { text: string; hostLabel: string | null },
  ): void => {
    const { confidence, why } = scoreVideo({
      scope,
      text: v.text,
      host: hostOf(v.foundOn),
      direct: !!directVideoId(v.foundOn),
      hostLabel: v.hostLabel,
    });
    const video: CandidateForumVideo = {
      url: v.url,
      videoId: v.videoId,
      confidence,
      why,
      foundOn: v.foundOn,
      mode: v.mode,
    };
    const existing = byId.get(v.videoId);
    if (!existing || video.confidence > existing.confidence) byId.set(v.videoId, video);
  };

  // MODE A.
  if (scope) {
    await discoverByRaceSearch(
      scope,
      { maxQueries, maxPagesToScan, timeoutMs, userAgent, searchImpl, fetchPage, searxUrl: opts.searxUrl },
      result,
      collect,
    );
  }
  // MODE B.
  if (args.channels && args.channels.length) {
    await discoverByHostChannel(args.channels, { fetchPage }, scope, result, collect);
  }

  result.videos = Array.from(byId.values())
    .filter((v) => v.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);

  if (result.videos.length === 0 && !scope && !(args.channels && args.channels.length)) {
    result.notes.push('no scope and no channels provided -- nothing to discover');
  }
  return result;
}
