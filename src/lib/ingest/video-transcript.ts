/**
 * video-transcript.ts -- YouTube (and embedded-video) transcript ingestion for
 * Havesay.
 *
 * WHY THIS EXISTS. Many candidates state their actual positions in videos --
 * an embedded "meet the candidate" clip on their site, a recorded forum, a news
 * interview linked from their press page. A text summary plus a direct quote
 * pulled from the spoken transcript is positioning EVIDENCE we would otherwise
 * miss by only scraping page prose. This module turns a public video's captions
 * into clean text that the existing raw-evidence pipeline can store and the
 * positioning classifier can read (source_family = 'video_transcript').
 *
 * TWO EXPORTS:
 *   extractVideoRefs(html, baseUrl) -- scan candidate-site HTML / markdown / text
 *     for embedded or linked YouTube videos and return normalized video IDs +
 *     canonical watch URLs (deduped by video ID).
 *   fetchYoutubeTranscript(idOrUrl) -- fetch a public video's transcript via the
 *     undocumented-but-keyless InnerTube caption endpoints (with a yt-dlp
 *     fallback if a binary is configured), parse + clean it, and return a
 *     structured Transcript, or null when no transcript exists.
 *
 * METHOD + ToS POSTURE (researched 2026-06-15, see the build report).
 *   PRIMARY: YouTube's internal "InnerTube" API. We POST videoId to
 *     https://www.youtube.com/youtubei/v1/player (no API key, no quota), read
 *     captions.playerCaptionsTracklistRenderer.captionTracks[].baseUrl, then GET
 *     that baseUrl with &fmt=json3 to get structured caption JSON. This is the
 *     same call the youtube.com web player makes; it needs only a browser-like
 *     User-Agent. We do NOT scrape the /watch page HTML, do NOT use a paid
 *     aggregator (Apify, Supadata, etc. -- those are exactly the kind of
 *     license-encumbered third party the data-source policy in CLAUDE.md tells
 *     us to avoid), and need no API key.
 *   FALLBACK: yt-dlp (a maintained open-source binary) invoked with
 *     --write-auto-subs --write-subs --skip-download --sub-format json3/vtt, only
 *     when BB_YTDLP_PATH is set. yt-dlp is NOT installed on the host by default;
 *     the parent must install it for the fallback to engage (see the report).
 *     Without it, the InnerTube path is the sole method and a transcript that
 *     InnerTube cannot reach simply returns null (no-captions-available case).
 *
 *   Honest ToS note: the InnerTube endpoints are undocumented and accessing them
 *   may be inconsistent with YouTube's Terms of Service. We use them narrowly --
 *   PUBLIC captions of PUBLIC videos a candidate themself published or that a
 *   news outlet published, for nonpartisan civic research, at a polite rate, no
 *   API key, no bulk harvesting, robots-irrelevant (this is an API, not a crawl).
 *   The endpoint can change without notice; when it does, the yt-dlp fallback
 *   (which the maintainers keep current) is the recovery path. Age-restricted,
 *   private, and members-only videos require auth and are NOT supported -- they
 *   return null, same as no-captions.
 *
 * NETWORK + TESTABILITY. fetchYoutubeTranscript takes an injectable fetch and an
 * injectable yt-dlp runner so the offline test can drive both the InnerTube path
 * and the json3/vtt cleaning logic with fixtures and zero network. extractVideoRefs
 * is pure (string in, refs out).
 *
 * Single TypeScript runtime, no Python (architecture rule). The yt-dlp fallback
 * shells out to a BINARY via node:child_process execFile (that is not a Python
 * runtime in our process; it is an external tool, same posture as smart_fetch's
 * playwright tier).
 */

import { execFile } from 'node:child_process';
import { POLITE_USER_AGENT } from '@/lib/bot-user-agent';

// ===========================================================================
// extractVideoRefs -- find embedded/linked videos in candidate-site content
// ===========================================================================

/** One discovered video reference. */
export interface VideoRef {
  /** Platform. YouTube is the priority; Vimeo is detected as a TODO marker. */
  platform: 'youtube' | 'vimeo';
  /** Normalized 11-char YouTube video ID (or the Vimeo numeric ID). */
  videoId: string;
  /** Canonical public watch URL we will store as raw_evidence.source_url. */
  url: string;
  /** Coarse note on where the ref was found (iframe / link / data-attr / text). */
  via: 'iframe' | 'link' | 'data_attr' | 'text';
}

// A YouTube video ID is exactly 11 chars of [A-Za-z0-9_-]. We anchor on that
// shape everywhere so we never grab a channel/playlist token by mistake.
const YT_ID = '[A-Za-z0-9_-]{11}';
const YT_ID_RE = new RegExp(`^${YT_ID}$`);

/**
 * The set of YouTube-reference patterns we scan for. Each pattern's first
 * capture group is the 11-char video ID. We deliberately accept the messy
 * realities of site builders:
 *   - <iframe src="https://www.youtube.com/embed/<id>...">
 *   - youtube-nocookie.com/embed/<id>  (privacy-enhanced embed)
 *   - youtu.be/<id>  (share links)
 *   - watch?v=<id>  (canonical watch links, anywhere in href or markdown)
 *   - /v/<id>  and  /shorts/<id>  and  /live/<id>
 *   - lazy-load data-* attributes (data-src, data-video-id, data-youtube-id,
 *     data-ytid, data-embed, data-href) used by Squarespace/Wix/Weebly/Elementor
 *   - bare youtube.com / youtu.be URLs sitting in markdown or plain text (the
 *     stored candidate-site evidence is often CLEANED markdown, not raw HTML,
 *     so we must catch URLs that are not inside any tag)
 *
 * Order matters only for the `via` label we attach; dedup is by video ID.
 */
interface RefPattern {
  re: RegExp;
  via: VideoRef['via'];
}

const YT_PATTERNS: RefPattern[] = [
  // iframe / embed (also covers youtube-nocookie.com because the host portion is
  // matched loosely as youtube(-nocookie)?\.com).
  {
    re: new RegExp(
      `<iframe[^>]+src\\s*=\\s*["']\\s*(?:https?:)?//(?:www\\.)?youtube(?:-nocookie)?\\.com/embed/(${YT_ID})`,
      'gi',
    ),
    via: 'iframe',
  },
  // Generic embed URL not necessarily inside an <iframe> tag (e.g. in markdown
  // or a data-attr value): youtube(-nocookie).com/embed/<id>
  {
    re: new RegExp(
      `(?:https?:)?//(?:www\\.)?youtube(?:-nocookie)?\\.com/embed/(${YT_ID})`,
      'gi',
    ),
    via: 'text',
  },
  // youtu.be short links.
  {
    re: new RegExp(`(?:https?:)?//(?:www\\.)?youtu\\.be/(${YT_ID})`, 'gi'),
    via: 'link',
  },
  // watch?v=<id>  (v= can be anywhere in the query string).
  {
    re: new RegExp(
      `(?:https?:)?//(?:www\\.)?(?:m\\.)?youtube\\.com/watch\\?[^"'\\s<>]*?\\bv=(${YT_ID})`,
      'gi',
    ),
    via: 'link',
  },
  // /v/<id>, /shorts/<id>, /live/<id> path forms.
  {
    re: new RegExp(
      `(?:https?:)?//(?:www\\.)?youtube\\.com/(?:v|shorts|live)/(${YT_ID})`,
      'gi',
    ),
    via: 'link',
  },
  // Lazy-load data-* attributes carrying a bare 11-char video ID. Site builders
  // stash the ID in data-video-id / data-youtube-id / data-ytid / data-id so the
  // real iframe is only injected on click. We require the value to be EXACTLY a
  // video ID (quote-to-quote) so we do not grab arbitrary data-* junk.
  {
    re: new RegExp(
      `\\bdata-(?:video-?id|youtube-?id|ytid|yt-id|embed-id|id)\\s*=\\s*["'](${YT_ID})["']`,
      'gi',
    ),
    via: 'data_attr',
  },
  // Lazy-load data-* attributes carrying a full youtube URL (data-src,
  // data-href, data-url, data-embed). We reuse the URL forms above by matching
  // the embed/watch/youtu.be shapes inside the attribute value.
  {
    re: new RegExp(
      `\\bdata-(?:src|href|url|embed|lazy-?src)\\s*=\\s*["'][^"']*?(?:youtube(?:-nocookie)?\\.com/(?:embed/|watch\\?[^"']*?\\bv=)|youtu\\.be/)(${YT_ID})`,
      'gi',
    ),
    via: 'data_attr',
  },
];

// Vimeo detection (TODO: full support). We surface a VideoRef so the caller can
// SEE that a Vimeo video exists, but fetchYoutubeTranscript only handles
// YouTube. Vimeo transcript fetching is a separate future build (its caption
// endpoint + ToS posture differ). YouTube is the priority per the task.
const VIMEO_PATTERNS: RegExp[] = [
  /(?:https?:)?\/\/player\.vimeo\.com\/video\/(\d{6,12})/gi,
  /(?:https?:)?\/\/(?:www\.)?vimeo\.com\/(\d{6,12})/gi,
];

/**
 * extractVideoRefs(html, baseUrl): scan a candidate-site artifact -- which may
 * be raw HTML, Jina markdown, or cleaned plain text -- for embedded or linked
 * videos. Returns normalized VideoRefs deduped by video ID, in first-seen order.
 *
 * baseUrl is accepted for symmetry with other extractors and for future
 * relative-URL resolution; the current patterns all match absolute or
 * protocol-relative URLs and bare IDs, so it is not strictly required.
 */
export function extractVideoRefs(html: string, baseUrl?: string): VideoRef[] {
  void baseUrl; // reserved for future relative-URL resolution
  const out: VideoRef[] = [];
  const seen = new Set<string>(); // dedup key: 'youtube:<id>' / 'vimeo:<id>'

  if (!html) return out;

  for (const { re, via } of YT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      if (!id || !YT_ID_RE.test(id)) continue;
      const key = `youtube:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        platform: 'youtube',
        videoId: id,
        url: `https://www.youtube.com/watch?v=${id}`,
        via,
      });
    }
  }

  for (const re of VIMEO_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      if (!id) continue;
      const key = `vimeo:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        platform: 'vimeo',
        videoId: id,
        url: `https://vimeo.com/${id}`,
        via: 'text',
      });
    }
  }

  return out;
}

/**
 * normalizeYoutubeId(idOrUrl): accept a bare 11-char ID or any YouTube URL form
 * and return the 11-char video ID, or null if it is not a recognizable YouTube
 * reference. Exported for the script + tests.
 */
export function normalizeYoutubeId(idOrUrl: string): string | null {
  const s = (idOrUrl ?? '').trim();
  if (!s) return null;
  if (YT_ID_RE.test(s)) return s; // already a bare ID

  // Run the same YT_PATTERNS over the single string; first hit wins.
  for (const { re } of YT_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(s);
    if (m && m[1] && YT_ID_RE.test(m[1])) return m[1];
  }
  // Last resort: a v=<id> query param the patterns above missed (no host).
  const v = s.match(new RegExp(`[?&]v=(${YT_ID})`));
  if (v && YT_ID_RE.test(v[1])) return v[1];
  return null;
}

// ===========================================================================
// fetchYoutubeTranscript -- InnerTube primary + yt-dlp fallback
// ===========================================================================

/** One cleaned caption segment. Times are in SECONDS (converted from ms). */
export interface TranscriptSegment {
  start: number;
  dur: number;
  text: string;
}

/** The structured result. */
export interface Transcript {
  videoId: string;
  title?: string;
  /** Language code of the chosen track, e.g. 'en' / 'en-US'. */
  lang: string;
  segments: TranscriptSegment[];
  /** Full transcript joined into readable paragraphs. */
  text: string;
  /** Which method produced it (for provenance + logging). */
  method: 'innertube' | 'yt-dlp';
  /** True when the chosen track is auto-generated (ASR), not human-authored. */
  autoGenerated: boolean;
}

export interface FetchTranscriptOptions {
  /** Preferred language codes, in order. Prefix-matched. Default ['en']. */
  languages?: string[];
  /** Per-network-call timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Injected fetch for OFFLINE TESTS. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Path to a yt-dlp binary for the FALLBACK path. Defaults to env
   * BB_YTDLP_PATH. When unset (the host default), the yt-dlp fallback is
   * disabled and the InnerTube path is the sole method.
   */
  ytDlpPath?: string | null;
  /**
   * Injected yt-dlp runner for OFFLINE TESTS. Given a videoId, resolves to the
   * raw json3 (or vtt) caption text and the chosen track's language + title, or
   * null. Defaults to a node:child_process execFile shell-out when ytDlpPath is
   * set, else null (fallback off).
   */
  ytDlpRunner?: (videoId: string, opts: { languages: string[]; timeoutMs: number }) =>
    Promise<{ raw: string; format: 'json3' | 'vtt'; lang: string; title?: string } | null>;
}

// Requests identify honestly. If the host refuses this client, the transcript
// is treated as unavailable (null), never retried with a disguised UA.
const BROWSER_UA = POLITE_USER_AGENT;
const INNERTUBE_PLAYER_URL =
  'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_CONTEXT = {
  client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'en' },
};

/** One caption track as returned by the InnerTube player response. */
interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string; // 'asr' for auto-generated; absent for manual
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
}

/**
 * Pick the best caption track: walk preferred languages in order, preferring a
 * MANUAL (human) track over an auto-generated (asr) one for the same language;
 * if no preferred language matches, fall back to the first track of any kind.
 * Prefix-matched ('en' matches 'en', 'en-US', 'en-GB').
 */
export function chooseCaptionTrack(
  tracks: CaptionTrack[],
  languages: string[],
): CaptionTrack | null {
  const usable = tracks.filter((t) => t.baseUrl);
  if (usable.length === 0) return null;

  for (const want of languages) {
    const w = want.toLowerCase();
    const inLang = usable.filter((t) => (t.languageCode ?? '').toLowerCase().startsWith(w));
    if (inLang.length === 0) continue;
    // Prefer a manual track (no kind='asr') over an auto-generated one.
    const manual = inLang.find((t) => t.kind !== 'asr');
    return manual ?? inLang[0];
  }
  // No preferred language -- take the first available, manual-first.
  return usable.find((t) => t.kind !== 'asr') ?? usable[0];
}

// ---------------------------------------------------------------------------
// Caption parsers (json3 + vtt) -- PURE, exported for the offline test.
// ---------------------------------------------------------------------------

/** Decode the few HTML entities YouTube leaves in caption text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

/**
 * parseJson3(raw): parse YouTube's fmt=json3 caption JSON into segments.
 * Shape: { events: [ { tStartMs, dDurationMs, segs: [ { utf8 } ] } ] }.
 * Events without `segs` (timing/style markers) are skipped. Times -> seconds.
 */
export function parseJson3(raw: string): TranscriptSegment[] {
  let data: { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> };
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const events = Array.isArray(data.events) ? data.events : [];
  const segs: TranscriptSegment[] = [];
  for (const ev of events) {
    if (!ev || !Array.isArray(ev.segs)) continue;
    const text = ev.segs.map((s) => s?.utf8 ?? '').join('');
    const cleaned = decodeEntities(text).replace(/\s+/g, ' ').trim();
    if (!cleaned) continue; // pure-newline / blank event
    segs.push({
      start: (ev.tStartMs ?? 0) / 1000,
      dur: (ev.dDurationMs ?? 0) / 1000,
      text: cleaned,
    });
  }
  return segs;
}

// WebVTT cue timestamp: 00:00:01.234 --> 00:00:04.567  (hours optional).
const VTT_TIME_RE =
  /(\d{2}:)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(\d{2}:)?(\d{2}):(\d{2})[.,](\d{3})/;

function vttToSeconds(h: string | undefined, m: string, s: string, ms: string): number {
  const hh = h ? parseInt(h, 10) : 0;
  return hh * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(ms, 10) / 1000;
}

/**
 * parseVtt(raw): parse a WebVTT caption file into segments. Strips the WEBVTT
 * header, cue numbers, inline <...> tags and karaoke <00:00:00.000> timing
 * spans, and the &gt;&gt; speaker markers YouTube sometimes injects. Times ->
 * seconds.
 */
export function parseVtt(raw: string): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  if (!raw) return segs;
  // Split into cue blocks on blank lines.
  const blocks = raw.replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    // Find the timing line in this block.
    let timeIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (VTT_TIME_RE.test(lines[i])) {
        timeIdx = i;
        break;
      }
    }
    if (timeIdx === -1) continue; // header block / NOTE / no timing
    const tm = lines[timeIdx].match(VTT_TIME_RE)!;
    const start = vttToSeconds(tm[1], tm[2], tm[3], tm[4]);
    const end = vttToSeconds(tm[5], tm[6], tm[7], tm[8]);
    const textLines = lines.slice(timeIdx + 1);
    let text = textLines.join(' ');
    // Strip inline timing spans <00:00:00.000> and styling tags <c>...</c>.
    text = text.replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g, '');
    text = text.replace(/<[^>]+>/g, '');
    text = decodeEntities(text);
    text = text.replace(/^\s*&?gt;&?gt;\s*/i, '').replace(/^\s*>>\s*/, '');
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    segs.push({ start, dur: Math.max(0, end - start), text });
  }
  return segs;
}

/**
 * cleanSegments(segs): dedup the overlapping/rolling lines auto-captions emit
 * (each cue often repeats the tail of the previous cue as new words stream in),
 * then join into readable paragraphs.
 *
 * Strategy:
 *   1. Drop a segment whose text is identical to the previous kept segment.
 *   2. Drop a segment whose text is fully contained in (a prefix-overlap of) the
 *      previous one -- the classic rolling-caption duplicate.
 *   3. When consecutive segments share a trailing/leading overlap, keep only the
 *      NEW tail so the joined text reads once, not twice.
 *   4. Group into paragraphs at sentence-ending punctuation followed by a gap,
 *      so the result is readable prose rather than a wall of 2-second fragments.
 *
 * Returns { segments, text }. Segments are the de-overlapped cue list (times
 * preserved for the FIRST occurrence); text is the paragraph-joined string.
 */
export function cleanSegments(segs: TranscriptSegment[]): { segments: TranscriptSegment[]; text: string } {
  const kept: TranscriptSegment[] = [];
  for (const seg of segs) {
    const cur = seg.text.trim();
    if (!cur) continue;
    if (kept.length === 0) {
      kept.push({ ...seg, text: cur });
      continue;
    }
    const prev = kept[kept.length - 1];
    const prevText = prev.text;
    // (1) exact duplicate of the previous kept line.
    if (cur === prevText) continue;
    // (2) current fully contained in previous (rolling caption shrinking) -> skip.
    if (prevText.includes(cur)) continue;
    // (2b) previous fully contained in current (rolling caption growing) ->
    // replace previous with the longer current, keeping previous start time.
    if (cur.includes(prevText)) {
      kept[kept.length - 1] = { start: prev.start, dur: seg.dur, text: cur };
      continue;
    }
    // (3) trailing/leading word overlap: keep only the new tail.
    const newTail = stripLeadingOverlap(prevText, cur);
    if (newTail !== cur && newTail.trim() === '') continue; // nothing new
    kept.push({ ...seg, text: newTail });
  }

  // (4) join into paragraphs. Start a new paragraph when the prior chunk ended a
  // sentence; otherwise keep accumulating on one line.
  const paragraphs: string[] = [];
  let buf = '';
  for (const seg of kept) {
    buf = buf ? `${buf} ${seg.text}` : seg.text;
    if (/[.!?]["')\]]?$/.test(seg.text)) {
      paragraphs.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) paragraphs.push(buf.trim());

  const text = paragraphs.join('\n\n').replace(/[ \t]+/g, ' ').trim();
  return { segments: kept, text };
}

/**
 * stripLeadingOverlap(prev, cur): if `cur` begins with the last few words of
 * `prev` (the rolling-caption overlap), drop that shared prefix from `cur` and
 * return only the new tail. Word-granular, longest-overlap-wins, capped so we do
 * not do quadratic work on a long line.
 */
function stripLeadingOverlap(prev: string, cur: string): string {
  const prevWords = prev.split(/\s+/);
  const curWords = cur.split(/\s+/);
  const maxK = Math.min(prevWords.length, curWords.length, 12);
  for (let k = maxK; k >= 2; k--) {
    const prevTail = prevWords.slice(prevWords.length - k).join(' ').toLowerCase();
    const curHead = curWords.slice(0, k).join(' ').toLowerCase();
    if (prevTail === curHead) {
      return curWords.slice(k).join(' ');
    }
  }
  return cur;
}

// ---------------------------------------------------------------------------
// InnerTube primary path
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetchViaInnerTube(videoId, ...): the keyless primary. POST to youtubei/v1/player,
 * read captionTracks, choose a track, GET its baseUrl with &fmt=json3, parse.
 * Returns a Transcript or null (no captions / private / age-restricted / error).
 */
async function fetchViaInnerTube(
  videoId: string,
  languages: string[],
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Transcript | null> {
  // Step 1: player metadata.
  const playerRes = await fetchWithTimeout(
    fetchImpl,
    INNERTUBE_PLAYER_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
      },
      body: JSON.stringify({ context: INNERTUBE_CONTEXT, videoId }),
    },
    timeoutMs,
  );
  if (!playerRes || !playerRes.ok) return null;

  let player: {
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
    videoDetails?: { title?: string };
    playabilityStatus?: { status?: string };
  };
  try {
    player = await playerRes.json();
  } catch {
    return null;
  }

  // Private / age-restricted / unplayable videos have no captionTracks here.
  const tracks =
    player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) return null;

  const track = chooseCaptionTrack(tracks, languages);
  if (!track || !track.baseUrl) return null;

  // Step 2: fetch the caption track as json3.
  const sep = track.baseUrl.includes('?') ? '&' : '?';
  const capUrl = `${track.baseUrl}${sep}fmt=json3`;
  const capRes = await fetchWithTimeout(
    fetchImpl,
    capUrl,
    { method: 'GET', headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' } },
    timeoutMs,
  );
  if (!capRes || !capRes.ok) return null;

  const rawCaptions = await capRes.text();
  if (!rawCaptions || !rawCaptions.trim()) return null;

  const parsed = parseJson3(rawCaptions);
  if (parsed.length === 0) return null;

  const { segments, text } = cleanSegments(parsed);
  if (!text.trim()) return null;

  return {
    videoId,
    title: player.videoDetails?.title,
    lang: track.languageCode ?? languages[0] ?? 'en',
    segments,
    text,
    method: 'innertube',
    autoGenerated: track.kind === 'asr',
  };
}

// ---------------------------------------------------------------------------
// yt-dlp fallback path (only when a binary path is configured)
// ---------------------------------------------------------------------------

/**
 * Default yt-dlp runner: shell out to the binary at ytDlpPath, asking only for
 * caption files (no media). Writes subs to a temp dir, reads back the json3 (or
 * vtt) file, returns its raw text + format + lang. Total -- any failure returns
 * null. Only used when ytDlpPath is set; otherwise the fallback is OFF.
 *
 * NOTE: this path is exercised live (not in the offline test, which injects a
 * runner). yt-dlp is NOT installed on the host by default; the parent must
 * install it and set BB_YTDLP_PATH for this to engage.
 */
function makeDefaultYtDlpRunner(ytDlpPath: string): NonNullable<FetchTranscriptOptions['ytDlpRunner']> {
  return async (videoId, { languages, timeoutMs }) => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');

    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-ytdlp-'));
    const outTmpl = path.join(tmpBase, '%(id)s.%(ext)s');
    const langArg = (languages.length ? languages : ['en']).join(',') + ',en.*';
    const args = [
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs', langArg,
      '--sub-format', 'json3/vtt/best',
      '--no-playlist',
      '--no-warnings',
      '-o', outTmpl,
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    try {
      await new Promise<void>((resolve, reject) => {
        const child = execFile(ytDlpPath, args, { timeout: timeoutMs }, (err) => {
          // yt-dlp exits non-zero when no subs exist; we treat that as "no subs"
          // by simply finding no file below, so do not reject on exit code.
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') reject(err);
          else resolve();
        });
        child.on('error', reject);
      });

      const files = await fs.readdir(tmpBase);
      // Prefer json3, then vtt.
      const json3File = files.find((f) => f.endsWith('.json3'));
      const vttFile = files.find((f) => f.endsWith('.vtt'));
      const chosen = json3File ?? vttFile;
      if (!chosen) return null;
      const raw = await fs.readFile(path.join(tmpBase, chosen), 'utf8');
      // Derive lang from the filename: <id>.<lang>.<ext>.
      const parts = chosen.split('.');
      const lang = parts.length >= 3 ? parts[parts.length - 2] : languages[0] ?? 'en';
      return {
        raw,
        format: json3File ? 'json3' : 'vtt',
        lang,
      };
    } catch {
      return null;
    } finally {
      try {
        await fs.rm(tmpBase, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  };
}

async function fetchViaYtDlp(
  videoId: string,
  languages: string[],
  timeoutMs: number,
  runner: NonNullable<FetchTranscriptOptions['ytDlpRunner']>,
): Promise<Transcript | null> {
  const res = await runner(videoId, { languages, timeoutMs });
  if (!res || !res.raw) return null;
  const parsed = res.format === 'json3' ? parseJson3(res.raw) : parseVtt(res.raw);
  if (parsed.length === 0) return null;
  const { segments, text } = cleanSegments(parsed);
  if (!text.trim()) return null;
  return {
    videoId,
    title: res.title,
    lang: res.lang || languages[0] || 'en',
    segments,
    text,
    method: 'yt-dlp',
    autoGenerated: true, // yt-dlp path most often returns auto-subs; conservative
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * fetchYoutubeTranscript(idOrUrl, opts): return a cleaned Transcript for a public
 * YouTube video, or null when no transcript is available (no captions, private,
 * age-restricted, or every method failed).
 *
 * Order: InnerTube (primary, keyless) -> yt-dlp (only if a binary path is
 * configured). Both paths feed the same json3/vtt parser + cleaner.
 */
export async function fetchYoutubeTranscript(
  idOrUrl: string,
  opts: FetchTranscriptOptions = {},
): Promise<Transcript | null> {
  const videoId = normalizeYoutubeId(idOrUrl);
  if (!videoId) return null;

  const languages = opts.languages && opts.languages.length ? opts.languages : ['en'];
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // PRIMARY: InnerTube.
  try {
    const t = await fetchViaInnerTube(videoId, languages, timeoutMs, fetchImpl);
    if (t) return t;
  } catch {
    /* fall through to fallback */
  }

  // FALLBACK: yt-dlp, only when a runner is injected (tests) or a binary path is
  // configured (live, after the parent installs yt-dlp + sets BB_YTDLP_PATH).
  const ytDlpPath = opts.ytDlpPath ?? process.env.BB_YTDLP_PATH ?? null;
  const runner =
    opts.ytDlpRunner ?? (ytDlpPath ? makeDefaultYtDlpRunner(ytDlpPath) : null);
  if (runner) {
    try {
      const t = await fetchViaYtDlp(videoId, languages, timeoutMs, runner);
      if (t) return t;
    } catch {
      /* give up -> null */
    }
  }

  return null; // no-captions-available (or every method failed)
}
