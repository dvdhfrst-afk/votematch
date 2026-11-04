/**
 * youtube-transcript.ts -- no-API-key YouTube transcript + timestamp resolver
 * for the G1 golden-set labeling tool.
 *
 * WHY: a labeling human will not scrub a two-hour video to verify a one-line
 * quote. For YouTube-sourced pairs we fetch the video's caption track (no API
 * key: the watch page's `ytInitialPlayerResponse.captions` gives a public
 * `baseUrl` per track), fuzzy-locate the quote inside the transcript, and
 * rewrite the source link as a deep link (`&t=<seconds>s`) that drops the
 * reviewer at the quote. Where captions are unavailable or the quote cannot be
 * located, the caller badges the pair "timestamp unresolved" and offers the
 * skip action instead of asking anyone to watch the video.
 *
 * This module is split into PURE functions (parsing, normalization, quote
 * location, deep-link construction -- all unit tested, no network) and a thin
 * IO layer (`fetchYouTubeTranscript`, `resolveVideoTimestamp`) that performs the
 * fetches and degrades gracefully to an "unresolved" result on any failure.
 *
 * No em-dashes / en-dashes; acronyms spelled out on first use.
 */

// ===========================================================================
// Types
// ===========================================================================

export interface TranscriptSegment {
  /** Start time of this caption cue, in seconds. */
  start: number;
  /** Duration of this cue, in seconds (0 when unknown). */
  dur: number;
  /** Cue text (may contain HTML entities before decoding). */
  text: string;
}

export type MediaPlatform = 'youtube' | 'facebook' | 'rumble' | 'vimeo';

export interface QuoteLocation {
  /** Start time (seconds) to deep-link to. */
  startSeconds: number;
  /** Match quality in 0..1 (fraction of quote tokens found in the best window). */
  score: number;
  /** The transcript text of the matched window (for a human sanity check). */
  window: string;
}

export interface VideoResolution {
  platform: MediaPlatform | null;
  videoId: string | null;
  /** Resolved deep-link seconds, or null when unresolved. */
  seconds: number | null;
  /** The (possibly rewritten) URL. Equals the input URL when unresolved. */
  deepLink: string;
  resolved: boolean;
  /** Match score when resolved, else 0. */
  score: number;
  /** Human-readable status note for badging / logs. */
  note: string;
}

// ===========================================================================
// Platform + id parsing (pure)
// ===========================================================================

/** Detect the video platform of a URL, or null if it is not a known video host. */
export function detectVideoPlatform(url: string): MediaPlatform | null {
  const u = (url || '').toLowerCase();
  if (/(?:^|\/\/|\.)youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/(?:^|\/\/|\.)facebook\.com|fb\.watch/.test(u)) return 'facebook';
  if (/(?:^|\/\/|\.)rumble\.com/.test(u)) return 'rumble';
  if (/(?:^|\/\/|\.)vimeo\.com/.test(u)) return 'vimeo';
  return null;
}

/**
 * Extract the 11-character YouTube video id from a watch / short / embed / youtu.be
 * URL, or null. Case-preserving (video ids are case sensitive).
 */
export function parseYouTubeId(url: string): string | null {
  if (!url) return null;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/, // watch?v=ID
    /youtu\.be\/([A-Za-z0-9_-]{11})/, // youtu.be/ID
    /\/embed\/([A-Za-z0-9_-]{11})/, // /embed/ID
    /\/shorts\/([A-Za-z0-9_-]{11})/, // /shorts/ID
    /\/live\/([A-Za-z0-9_-]{11})/, // /live/ID
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

// ===========================================================================
// Text normalization + entity decoding (pure)
// ===========================================================================

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Decode the small set of HTML entities YouTube caption payloads emit. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (e) => ENTITY_MAP[e.toLowerCase()] ?? e);
}

/**
 * Normalize text for fuzzy matching: decode entities, lowercase, drop
 * apostrophes inside words, replace all other non-alphanumerics with spaces,
 * and collapse runs of whitespace. Deterministic and idempotent.
 */
export function normalizeForMatch(s: string): string {
  return decodeEntities(String(s ?? ''))
    .toLowerCase()
    .replace(/[‘’']/g, '') // curly + straight apostrophes: join contractions
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Tokenize normalized text into words. */
export function tokenize(s: string): string[] {
  const n = normalizeForMatch(s);
  return n ? n.split(' ') : [];
}

// ===========================================================================
// Transcript parsing (pure)
// ===========================================================================

/** Parse the default YouTube timedtext XML (`<text start="..." dur="...">`). */
export function parseTimedTextXml(xml: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const startM = attrs.match(/\bstart="([\d.]+)"/);
    const durM = attrs.match(/\bdur="([\d.]+)"/);
    const raw = m[2].replace(/<[^>]+>/g, ''); // strip inline tags
    const text = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({
      start: startM ? Number(startM[1]) : 0,
      dur: durM ? Number(durM[1]) : 0,
      text,
    });
  }
  return out;
}

/**
 * Parse the YouTube timedtext "format 3" XML (`<p t="ms" d="ms">` with optional
 * inner `<s>` word spans). This is what the InnerTube ANDROID client returns.
 */
export function parseTimedTextFormat3Xml(xml: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const tM = attrs.match(/\bt="(\d+)"/);
    const dM = attrs.match(/\bd="(\d+)"/);
    const inner = m[2].replace(/<[^>]+>/g, ''); // drop <s> spans, keep their text
    const text = decodeEntities(inner).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ start: tM ? Number(tM[1]) / 1000 : 0, dur: dM ? Number(dM[1]) / 1000 : 0, text });
  }
  return out;
}

/** Parse any timedtext body (JSON3, format-3 XML, or legacy `<text>` XML). */
export function parseTranscriptBody(body: string): TranscriptSegment[] {
  const t = body.trimStart();
  if (t.startsWith('{')) {
    const s = parseTimedTextJson3(body);
    if (s.length) return s;
  }
  if (t.includes('<timedtext') || /<p\b[^>]*\bt=/.test(t)) {
    const s = parseTimedTextFormat3Xml(body);
    if (s.length) return s;
  }
  return parseTimedTextXml(body);
}

/** Parse the YouTube timedtext JSON3 format (`events[].segs[].utf8`, `tStartMs`). */
export function parseTimedTextJson3(json: string): TranscriptSegment[] {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return [];
  }
  const events = (doc as { events?: unknown[] })?.events;
  if (!Array.isArray(events)) return [];
  const out: TranscriptSegment[] = [];
  for (const ev of events as Array<Record<string, unknown>>) {
    const segs = ev.segs as Array<{ utf8?: string }> | undefined;
    if (!Array.isArray(segs)) continue;
    const text = segs
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const startMs = Number(ev.tStartMs ?? 0);
    const durMs = Number(ev.dDurationMs ?? 0);
    out.push({ start: startMs / 1000, dur: durMs / 1000, text: decodeEntities(text) });
  }
  return out;
}

// ===========================================================================
// Quote location (pure) -- the heart of the resolver, unit tested
// ===========================================================================

/**
 * Flatten transcript segments into a word stream, each word tagged with the
 * start time of the cue it came from. Enables word-level windowed matching.
 */
function wordStream(segments: TranscriptSegment[]): Array<{ w: string; start: number }> {
  const out: Array<{ w: string; start: number }> = [];
  for (const seg of segments) {
    for (const w of tokenize(seg.text)) out.push({ w, start: seg.start });
  }
  return out;
}

/**
 * locateQuoteInTranscript(quote, segments, opts): fuzzy-find a quote inside a
 * transcript and return the best deep-link start time.
 *
 * Method: tokenize both sides, slide a window (size = quote length, with a
 * little slack for caption word drift) over the transcript word stream, and
 * score each window by the multiset overlap of quote tokens it contains. The
 * best window above `minScore` wins; the returned start time is that of the
 * earliest transcript word that matches the quote's first token inside the
 * window (so the link lands at the quote, not the window edge). Deterministic;
 * ties break toward the earlier position.
 *
 * Returns null when no window clears the threshold (caller badges "unresolved").
 */
export function locateQuoteInTranscript(
  quote: string,
  segments: TranscriptSegment[],
  opts: { minScore?: number; minTokens?: number } = {},
): QuoteLocation | null {
  const minScore = opts.minScore ?? 0.6;
  const minTokens = opts.minTokens ?? 3;
  const q = tokenize(quote);
  const stream = wordStream(segments);
  if (q.length === 0 || stream.length === 0) return null;
  // Very short quotes are unreliable to place; require a minimum token count.
  if (q.length < minTokens) return null;

  // Multiset of quote tokens for overlap scoring.
  const qCount = new Map<string, number>();
  for (const t of q) qCount.set(t, (qCount.get(t) ?? 0) + 1);

  const W = q.length;
  const slack = Math.max(2, Math.round(W * 0.3)); // tolerate caption drift
  const win = Math.min(stream.length, W + slack);

  let bestScore = 0;
  let bestStart = -1;
  let bestI = -1;
  for (let i = 0; i + Math.min(W, win) <= stream.length; i++) {
    const end = Math.min(i + win, stream.length);
    // Count overlap of quote multiset within window [i, end).
    const seen = new Map<string, number>();
    for (let k = i; k < end; k++) {
      const w = stream[k].w;
      if (qCount.has(w)) seen.set(w, (seen.get(w) ?? 0) + 1);
    }
    let overlap = 0;
    for (const [w, c] of seen) overlap += Math.min(c, qCount.get(w)!);
    const score = overlap / q.length;
    if (score > bestScore) {
      bestScore = score;
      bestI = i;
      // Deep-link to the first window word that matches the quote's first token,
      // else the first quote-token match, else the window start.
      let anchor = stream[i].start;
      const first = q[0];
      let found = false;
      for (let k = i; k < end; k++) {
        if (stream[k].w === first) {
          anchor = stream[k].start;
          found = true;
          break;
        }
      }
      if (!found) {
        for (let k = i; k < end; k++) {
          if (qCount.has(stream[k].w)) {
            anchor = stream[k].start;
            break;
          }
        }
      }
      bestStart = anchor;
    }
  }

  if (bestScore < minScore || bestStart < 0) return null;
  const windowText = stream
    .slice(bestI, Math.min(bestI + win, stream.length))
    .map((x) => x.w)
    .join(' ');
  return { startSeconds: Math.floor(bestStart), score: Number(bestScore.toFixed(3)), window: windowText };
}

// ===========================================================================
// Deep-link construction (pure)
// ===========================================================================

/**
 * buildYouTubeDeepLink(url, seconds): return the URL with a `t=<seconds>s`
 * time parameter. Replaces any existing `t` param. Idempotent.
 */
export function buildYouTubeDeepLink(url: string, seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  try {
    const u = new URL(url);
    u.searchParams.set('t', `${s}s`);
    return u.toString();
  } catch {
    // Fallback for non-parseable URLs: strip an existing t= then append.
    const base = url.replace(/([?&])t=[^&]*/g, '$1').replace(/[?&]$/, '');
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}t=${s}s`;
  }
}

// ===========================================================================
// IO layer -- fetch captions, resolve a timestamp (graceful degradation)
// ===========================================================================

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Extract the caption track baseUrls from a watch-page HTML string (pure).
 * Retained for provenance / fallback and covered by unit tests; the live path
 * now uses the InnerTube player endpoint (see fetchYouTubeTranscript).
 */
export function extractCaptionTracks(html: string): Array<{ baseUrl: string; lang: string }> {
  // Find the captionTracks array inside ytInitialPlayerResponse.
  const idx = html.indexOf('"captionTracks"');
  if (idx < 0) return [];
  // Grab a bounded slice and pull baseUrl + languageCode pairs.
  const slice = html.slice(idx, idx + 20000);
  const out: Array<{ baseUrl: string; lang: string }> = [];
  const re = /"baseUrl":"(.*?)"[\s\S]*?"languageCode":"(.*?)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    const baseUrl = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    out.push({ baseUrl, lang: m[2] });
  }
  return out;
}

/** Pick the best caption track: exact English, then any English, then first. */
export function pickCaptionTrack(
  tracks: Array<{ baseUrl: string; lang: string }>,
): { baseUrl: string; lang: string } | null {
  if (tracks.length === 0) return null;
  return (
    tracks.find((t) => t.lang === 'en') ??
    tracks.find((t) => t.lang.toLowerCase().startsWith('en')) ??
    tracks[0]
  );
}

/**
 * InnerTube mobile client contexts. The public WEB `timedtext` endpoint began
 * returning empty bodies in 2024/2025 (a proof-of-origin-token block), but the
 * mobile InnerTube `player` endpoint still hands back working caption baseUrls
 * with no API key. IOS returns clean JSON3; ANDROID returns format-3 XML.
 */
const INNERTUBE_CLIENTS: Array<{ client: Record<string, unknown>; ua: string }> = [
  {
    client: { clientName: 'IOS', clientVersion: '20.10.4', hl: 'en' },
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_0 like Mac OS X)',
  },
  {
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en' },
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
  },
];

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
}

/** Fetch the InnerTube player response for a video (no API key). null on error. */
async function fetchInnerTubePlayer(
  videoId: string,
  client: Record<string, unknown>,
  ua: string,
  fetchImpl: FetchLike,
): Promise<{ captionTracks: CaptionTrack[] } | null> {
  try {
    const res = await fetchImpl('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': ua, 'Accept-Language': 'en' },
      body: JSON.stringify({ context: { client }, videoId }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
    };
    const captionTracks = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    return { captionTracks };
  } catch {
    return null;
  }
}

/**
 * fetchYouTubeTranscript(videoId): fetch the caption track for a video with no
 * API key via the InnerTube mobile player endpoint. Prefers manual English
 * captions over auto-generated. Returns [] on any failure (no captions, bot
 * wall, network error).
 */
export async function fetchYouTubeTranscript(
  videoId: string,
  fetchImpl: FetchLike = fetch,
): Promise<TranscriptSegment[]> {
  for (const { client, ua } of INNERTUBE_CLIENTS) {
    const player = await fetchInnerTubePlayer(videoId, client, ua, fetchImpl);
    if (!player || player.captionTracks.length === 0) continue;
    const tracks = player.captionTracks;
    // Prefer manual English, then any English, then any manual, then first.
    const track =
      tracks.find((t) => t.languageCode === 'en' && t.kind !== 'asr') ??
      tracks.find((t) => (t.languageCode ?? '').toLowerCase().startsWith('en')) ??
      tracks.find((t) => t.kind !== 'asr') ??
      tracks[0];
    if (!track?.baseUrl) continue;
    const url = track.baseUrl + (track.baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    try {
      const cr = await fetchImpl(url, { headers: { 'Accept-Language': 'en', 'User-Agent': ua } });
      if (cr.ok) {
        const segs = parseTranscriptBody(await cr.text());
        if (segs.length > 0) return segs;
      }
      // Some baseUrls ignore fmt; try the raw URL too.
      const rr = await fetchImpl(track.baseUrl, { headers: { 'Accept-Language': 'en', 'User-Agent': ua } });
      if (rr.ok) {
        const segs = parseTranscriptBody(await rr.text());
        if (segs.length > 0) return segs;
      }
    } catch {
      /* try next client */
    }
  }
  return [];
}

/**
 * resolveVideoTimestamp(url, quote): high-level resolver. For a YouTube URL,
 * fetch captions, locate the quote, and return a deep link. For any other
 * platform, or when captions/quote cannot be resolved, return an unresolved
 * result with a badge-ready note (never throws).
 */
export async function resolveVideoTimestamp(
  url: string,
  quote: string,
  fetchImpl: FetchLike = fetch,
): Promise<VideoResolution> {
  const platform = detectVideoPlatform(url);
  const base: VideoResolution = {
    platform,
    videoId: null,
    seconds: null,
    deepLink: url,
    resolved: false,
    score: 0,
    note: 'not a video source',
  };
  if (!platform) return base;
  if (platform !== 'youtube') {
    return { ...base, note: `${platform} video, timestamp unresolved (no no-key transcript path)` };
  }
  const videoId = parseYouTubeId(url);
  if (!videoId) return { ...base, note: 'youtube video, could not parse video id' };
  const segments = await fetchYouTubeTranscript(videoId, fetchImpl);
  if (segments.length === 0) {
    return { ...base, videoId, note: 'video source, timestamp unresolved (captions unavailable)' };
  }
  const loc = locateQuoteInTranscript(quote, segments);
  if (!loc) {
    return { ...base, videoId, note: 'video source, timestamp unresolved (quote not found in transcript)' };
  }
  return {
    platform,
    videoId,
    seconds: loc.startSeconds,
    deepLink: buildYouTubeDeepLink(url, loc.startSeconds),
    resolved: true,
    score: loc.score,
    note: `resolved to ${loc.startSeconds}s (match ${(loc.score * 100).toFixed(0)}%)`,
  };
}
