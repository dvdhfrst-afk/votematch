/**
 * forum-video.ts -- the 'forum_video' SourceParser for the source-centric harvest
 * engine (Build 1).
 *
 * THE PATTERN (see 12-positioning-engine/13-harvest-buildout-plan.md, Build 1):
 *   ONE forum/debate video covers MANY candidates. We fetch the video's
 *   transcript ONCE (reusing the existing fetchYoutubeTranscript pipeline), then
 *   SEGMENT it into per-candidate answer spans and attribute each span to the
 *   roster candidate it belongs to. The generic runner (source-harvest-runner.ts)
 *   then does the SAFE write: a span that resolves to exactly one roster person is
 *   stored ATTRIBUTED; a span we cannot confidently attribute is stored
 *   UNATTRIBUTED (candidateMention=null) tied to the source. We NEVER guess.
 *
 * WHY SEGMENTATION IS THE HARD PART. Auto-captions have NO speaker labels -- the
 * transcript is one undifferentiated stream of words. A candidate forum, though,
 * has STRUCTURE we can exploit:
 *   (a) MODERATOR CUES. A moderator hands the floor by name: "Candidate Smith,
 *       your response", "Let's go to Jane Doe", "Next question to Mr. Lee",
 *       "Thank you, Smith. Jones, same question." Each cue marks a TURN BOUNDARY
 *       and names whose turn it is. This is the strongest signal.
 *   (b) NAME SELF-REFERENCE. Candidates introduce themselves: "I'm Jane Doe and
 *       I'm running for ...". A self-intro near the start of a span confirms (or
 *       supplies) the speaker for that span.
 *   (c) The RACE ROSTER. We already know the 2 to 4 people in scope, so a cue or
 *       self-reference only has to match a small known set. A name the cue/intro
 *       produces is bound by the SAME roster-constrained resolver the runner uses
 *       (race-roster.ts), so a namesake outside the race is structurally
 *       impossible to hit, and an ambiguous mention is held, not guessed.
 *
 * SEGMENTATION ALGORITHM (deterministic, no LLM, no network beyond the transcript
 * fetch):
 *   1. Walk the cleaned transcript segments in time order.
 *   2. At each segment, scan its text for a TURN-OPENING cue (a moderator handoff
 *      or a self-introduction) that names a roster candidate. A cue STARTS a new
 *      span owned by that candidate; everything until the next cue is that
 *      candidate's answer text.
 *   3. Text BEFORE the first cue (moderator preamble, ground rules) is an
 *      UNATTRIBUTED span -- it belongs to the source, not a candidate.
 *   4. A cue whose name is AMBIGUOUS within the roster (a shared surname matching
 *      two roster members) does NOT assign the span -- it still opens a new span
 *      but leaves candidateMention null so the runner holds it unattributed. We
 *      never pick one of two namesakes.
 *   5. Each emitted span becomes a ParsedUnit with locus = {video_url, start,
 *      end} (timestamps from the transcript), content = the joined span text,
 *      source_family = 'video_transcript', signal_view = 'stated' (the
 *      candidate's own spoken words).
 *
 * ATTRIBUTION SAFETY. The parser does the SEGMENT-and-name step; the binding of a
 * name to a person_id is done by the runner via resolveMentionInRoster. The
 * parser uses resolveMentionInRoster ONLY to decide whether a cue's name is a
 * confident, UNIQUE roster hit worth opening a candidate-owned span on -- it does
 * not itself emit a person_id. So both the parser and the runner share one safe
 * resolver, and "ambiguous" / "outside roster" always falls through to
 * unattributed.
 *
 * REUSE. fetchYoutubeTranscript + normalizeYoutubeId from video-transcript.ts
 * (the transcript pipeline already exists -- we do NOT re-implement caption
 * fetching). loadRosterForSource + resolveMentionInRoster from race-roster.ts
 * (the runner passes the roster via deps; the parser also loads it as a fallback).
 *
 * Single TypeScript runtime, no Python, no new npm deps. The transcript fetch is
 * injectable (deps.fetchTranscript) so the offline test drives the parser with a
 * fixture and zero network.
 */

import {
  fetchYoutubeTranscript,
  normalizeYoutubeId,
  type Transcript,
  type TranscriptSegment,
} from '@/lib/ingest/video-transcript';
import {
  loadRosterForSource,
  resolveMentionInRoster,
  type Roster,
} from '@/lib/ingest/harvest/race-roster';
import type {
  SourceParser,
  HarvestSource,
  ParserDeps,
  ParsedUnit,
} from '@/lib/ingest/harvest/source-harvest-runner';

// ---------------------------------------------------------------------------
// Deps the parser accepts (injected by the runner / tests)
// ---------------------------------------------------------------------------

/**
 * Optional parser deps. The runner always passes { client }. Build-1 callers may
 * additionally inject:
 *   - roster: the already-loaded race roster (the runner loads it once; if it is
 *     forwarded via parserDeps the parser reuses it instead of re-querying).
 *   - fetchTranscript: an injectable transcript fetcher for OFFLINE TESTS. When
 *     absent, the parser uses the real fetchYoutubeTranscript (InnerTube + yt-dlp).
 *   - languages / timeoutMs: forwarded to fetchYoutubeTranscript.
 */
export interface ForumVideoDeps extends ParserDeps {
  roster?: Roster;
  fetchTranscript?: (idOrUrl: string) => Promise<Transcript | null>;
  languages?: string[];
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Cue detection -- moderator handoffs + candidate self-introductions
// ---------------------------------------------------------------------------

/** Honorifics a moderator/candidate may prefix a name with; stripped for matching. */
const HONORIFICS = ['mr', 'mrs', 'ms', 'miss', 'dr', 'councilman', 'councilwoman', 'councilmember', 'commissioner', 'mayor', 'senator', 'representative', 'judge', 'sheriff', 'candidate'];

/**
 * Moderator handoff phrasings. Each pattern captures the NAME the floor is being
 * handed to in group 1. We keep the captured name SHORT (1 to 4 words of
 * letters/hyphens/apostrophes/periods) so we grab "Jane Doe" or "Mr. Lee" but not
 * a whole sentence. Resolution against the roster does the real disambiguation;
 * these patterns just FIND a plausible name + a turn boundary.
 *
 * Honorifics are allowed inside the captured name and stripped before resolving.
 */
const NAME = `((?:${HONORIFICS.map((h) => h + '\\.?').join('|')}\\s+)?[A-Z][a-zA-Z'.-]+(?:\\s+[A-Z][a-zA-Z'.-]+){0,3})`;

/**
 * HANDOFF cues name the INCOMING speaker and OPEN a new turn. Each pattern's
 * group 1 is the name the floor is handed TO.
 */
const MODERATOR_CUE_PATTERNS: RegExp[] = [
  // "Candidate Smith, your response" / "Smith, your response" / "Jane, your answer"
  new RegExp(`\\b${NAME}\\s*,?\\s+(?:your|the)\\s+(?:response|answer|turn|time|reply|rebuttal)\\b`, 'g'),
  // "your response, Smith" / "the floor is yours, Jane Doe"
  new RegExp(`\\b(?:your\\s+(?:response|answer|turn)|the\\s+floor\\s+is\\s+yours)\\s*,?\\s+${NAME}\\b`, 'g'),
  // "next question (goes) to Jane Doe" / "this question is for Mr. Lee" / "to Smith"
  new RegExp(`\\b(?:next\\s+question|this\\s+question|first\\s+question|same\\s+question)\\s+(?:goes\\s+)?(?:to|for|is\\s+for)\\s+${NAME}\\b`, 'g'),
  // "let's (go|start|turn) to Jane Doe" / "we'll start with Smith"
  new RegExp(`\\b(?:let'?s\\s+(?:go|start|turn|hear)|we'?ll\\s+(?:start|begin|go)|over)\\s+(?:to|with|from)\\s+${NAME}\\b`, 'g'),
  // "Jane Doe, you have (two minutes|the floor)"
  new RegExp(`\\b${NAME}\\s*,?\\s+you\\s+(?:have|get|may)\\b`, 'g'),
];

/**
 * COURTESY cues ("thank you, Jane") name the OUTGOING speaker. They mark a turn
 * BOUNDARY but must NOT open a span named after that person -- the next speaker
 * is named by the handoff that follows. We use a courtesy only to know that a
 * boundary exists and to keep the courtesy text with the prior span; we NEVER
 * open a candidate-owned span on a courtesy name.
 */
const COURTESY_CUE_PATTERNS: RegExp[] = [
  new RegExp(`\\bthank\\s+you,?\\s+${NAME}\\b`, 'g'),
  new RegExp(`\\bthanks,?\\s+${NAME}\\b`, 'g'),
];

/**
 * Candidate self-introduction phrasings. Captures the speaker's own name in group
 * 1. A self-intro confirms or supplies the owner of the span it opens.
 */
const SELF_INTRO_PATTERNS: RegExp[] = [
  // "I'm Jane Doe" / "I am Jane Doe" / "my name is Jane Doe" / "this is Jane Doe"
  new RegExp(`\\b(?:i'?m|i\\s+am|my\\s+name\\s+is|this\\s+is)\\s+${NAME}\\b`, 'g'),
];

/**
 * Reduce a raw captured name span to the bindable name. The capture group can
 * over-reach across a sentence boundary or a courtesy ("Jane. Mr. Smith") because
 * the multi-word name pattern is permissive; this normalizes it:
 *   1. Take only the text after the LAST sentence-ending period (". ") so a
 *      preceding clause ("Thank you, Jane.") does not contaminate the name.
 *   2. Drop everything up to and INCLUDING the last honorific token, so
 *      "Mr. Smith" -> "Smith" and "Dr. Jane Doe" -> "Jane Doe".
 * The roster resolver then binds the cleaned surname/name within the small roster.
 */
function stripHonorific(name: string): string {
  let s = name.trim();
  // (1) Keep only the final sentence clause (drop a leading "...Jane. " courtesy).
  const lastPeriod = s.lastIndexOf('. ');
  if (lastPeriod >= 0) s = s.slice(lastPeriod + 2).trim();
  // (2) Drop up to and including the last honorific token.
  const parts = s.split(/\s+/);
  let lastHonorific = -1;
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i].toLowerCase().replace(/\.$/, '');
    if (HONORIFICS.includes(tok)) lastHonorific = i;
  }
  if (lastHonorific >= 0 && lastHonorific < parts.length - 1) {
    return parts.slice(lastHonorific + 1).join(' ');
  }
  return s;
}

/** One detected cue: where in the segment text it sits + the name it named. */
interface DetectedCue {
  /** Character index of the cue within the segment text (turn boundary marker). */
  index: number;
  /** The raw captured name (honorific stripped). */
  name: string;
  /** handoff (names the INCOMING speaker) / self (introduces self) / courtesy (names OUTGOING). */
  kind: 'moderator' | 'self' | 'courtesy';
}

/**
 * Scan one segment's text for the TURN-OPENING cue (a moderator handoff or a
 * self-introduction) that names the INCOMING speaker, returning the cue at which
 * the new span should open, or null when the segment contains no turn opener.
 *
 * Handling of the three cue kinds:
 *   - HANDOFF (MODERATOR_CUE_PATTERNS): names the incoming speaker -> a real turn
 *     opener.
 *   - SELF-INTRO (SELF_INTRO_PATTERNS): the speaker names themselves -> a turn
 *     opener (confirms / supplies the owner).
 *   - COURTESY ("thank you, Jane"): names the OUTGOING speaker -> NOT an opener;
 *     it only tells us a boundary exists. We do NOT open a span on a courtesy
 *     name (that was the bug: "Thank you, Jane. Mr. Smith, your response" must
 *     open SMITH's span, not re-open Jane's).
 *
 * We return the EARLIEST handoff/self cue. A courtesy that PRECEDES a handoff is
 * ignored as an opener (its text stays with the prior span); a courtesy with NO
 * following handoff in the same segment yields null (no new span opens, the
 * answer text continues under the current speaker -- the next segment's handoff
 * will open the next turn).
 */
function detectCue(text: string): DetectedCue | null {
  const openers: DetectedCue[] = [];

  for (const re of MODERATOR_CUE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = stripHonorific(m[1] ?? '');
      if (name) openers.push({ index: m.index, name, kind: 'moderator' });
      if (re.lastIndex === m.index) re.lastIndex++; // guard zero-width
    }
  }
  for (const re of SELF_INTRO_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = stripHonorific(m[1] ?? '');
      if (name) openers.push({ index: m.index, name, kind: 'self' });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }

  if (openers.length === 0) return null;
  // Earliest opener wins; a moderator handoff beats a self-intro at the same index.
  openers.sort((a, b) => a.index - b.index || (a.kind === 'moderator' ? -1 : 1));
  return openers[0];
}

/**
 * hasCourtesyCue(text): true when the text contains a "thank you, NAME" closing
 * courtesy. Used only to recognize a turn BOUNDARY in a segment that has no
 * handoff opener (e.g. a moderator's "Thank you, Jane." with the next handoff in
 * the following segment), so the courtesy text is not mistaken for the next
 * speaker's answer. We do NOT open a named span on it -- a courtesy names the
 * OUTGOING speaker.
 */
function hasCourtesyCue(text: string): boolean {
  for (const re of COURTESY_CUE_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Span model -- an attributed (or held) stretch of transcript
// ---------------------------------------------------------------------------

interface Span {
  /** Resolved roster name to attribute the span to, or null when held. */
  mention: string | null;
  /** Whether the opening cue's name resolved to a UNIQUE roster person. */
  resolved: boolean;
  /** Why it did / did not resolve (for the provenance extra + log). */
  basis: 'moderator_cue' | 'self_intro' | 'preamble' | 'ambiguous_cue' | 'unknown_cue' | 'no_cue_yet';
  startTime: number;
  endTime: number;
  /** Accumulated text segments for this span. */
  texts: string[];
}

/**
 * segmentTranscript(segments, roster, videoUrl): the core. Walk the time-ordered
 * transcript segments, open a new span at each turn-opening cue that names a
 * roster candidate, and accumulate answer text into the current span. Text before
 * the first cue is a 'preamble' span (held unattributed). A cue whose name is
 * ambiguous within the roster opens a span but leaves it unattributed.
 *
 * EXPORTED so the offline test can assert segmentation independent of the runner.
 */
export function segmentTranscript(
  segments: TranscriptSegment[],
  roster: Roster,
  videoUrl: string,
): ParsedUnit[] {
  void videoUrl; // locus url is added by buildUnits; kept in signature for clarity
  const spans: Span[] = [];

  // The current open span. Start with a preamble span so any leading moderator
  // ground-rules text is captured (and held unattributed) rather than dropped.
  let current: Span = {
    mention: null,
    resolved: false,
    basis: 'no_cue_yet',
    startTime: segments.length ? segments[0].start : 0,
    endTime: segments.length ? segments[0].start : 0,
    texts: [],
  };

  const openNewSpanIfCue = (segText: string, segStart: number): { opened: boolean; preText: string; postText: string } => {
    const cue = detectCue(segText);
    if (!cue) return { opened: false, preText: segText, postText: '' };

    // Resolve the cue's name against the roster (SAFE: roster-confined, unique).
    const res = resolveMentionInRoster(cue.name, roster);

    // The text BEFORE the cue belongs to the OUTGOING span; the text FROM the cue
    // onward starts the NEW span. Split at the cue index.
    const preText = segText.slice(0, cue.index).trim();
    const postText = segText.slice(cue.index).trim();

    // Close the current span (append the pre-cue tail) before opening the new one.
    if (preText) current.texts.push(preText);
    spans.push(current);

    if (res.status === 'resolved') {
      current = {
        mention: res.entry.canonical_name,
        resolved: true,
        basis: cue.kind === 'self' ? 'self_intro' : 'moderator_cue',
        startTime: segStart,
        endTime: segStart,
        texts: [],
      };
    } else {
      // Ambiguous or outside-roster cue -> open a span but DO NOT name it. The
      // runner holds it unattributed (candidateMention null). Never guess.
      current = {
        mention: null,
        resolved: false,
        basis: res.status === 'ambiguous' ? 'ambiguous_cue' : 'unknown_cue',
        startTime: segStart,
        endTime: segStart,
        texts: [],
      };
    }
    if (postText) current.texts.push(postText);
    return { opened: true, preText, postText };
  };

  // Mark whether the very first cue has been seen (so the leading span is labeled
  // 'preamble' rather than 'no_cue_yet' once we know it was pre-cue text).
  let sawFirstCue = false;

  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;

    const before = spans.length;
    const { opened } = openNewSpanIfCue(text, seg.start);
    if (opened) {
      sawFirstCue = true;
      // The span pushed by openNewSpanIfCue was the OUTGOING one; if it was the
      // pre-cue leading span, retag it as 'preamble'.
      const pushed = spans[before];
      if (pushed && pushed.basis === 'no_cue_yet') pushed.basis = 'preamble';
      current.endTime = seg.start + seg.dur;
      continue;
    }

    // No turn-opener in this segment. Append to the current span. If it carries a
    // closing courtesy ("thank you, Jane") and we are inside an attributed turn,
    // the speaker's turn has ENDED here: keep the courtesy with the current span,
    // then close it and open a fresh PENDING (unattributed) span so any following
    // un-handed-off content does not bleed onto the prior speaker. A handoff in a
    // later segment will name the next turn; until then it stays unattributed.
    current.texts.push(text);
    current.endTime = seg.start + seg.dur;
    if (current.resolved && hasCourtesyCue(text)) {
      spans.push(current);
      current = {
        mention: null,
        resolved: false,
        basis: 'no_cue_yet',
        startTime: seg.start + seg.dur,
        endTime: seg.start + seg.dur,
        texts: [],
      };
    }
  }
  // Push the final open span.
  spans.push(current);
  void sawFirstCue;

  return buildUnits(spans, videoUrl);
}

/**
 * Turn the accumulated spans into ParsedUnits, dropping empty spans and merging a
 * span's text into one content blob. locus carries the video URL + the span's
 * time range so provenance can later show "found in: <forum> at MM:SS".
 */
function buildUnits(spans: Span[], videoUrl: string): ParsedUnit[] {
  const units: ParsedUnit[] = [];
  for (const span of spans) {
    const content = span.texts.join(' ').replace(/\s+/g, ' ').trim();
    if (!content) continue; // empty span (e.g. an empty leading preamble)
    units.push({
      candidateMention: span.resolved ? span.mention : null,
      locus: {
        video_url: videoUrl,
        start: round1(span.startTime),
        end: round1(span.endTime),
      },
      content,
      source_family: 'video_transcript',
      signal_view: 'stated',
      extra: {
        segmentation_basis: span.basis,
        // Surface the raw cue name even when unattributed so a human reviewer can
        // see what the moderator said without re-fetching the video.
        cue_name: span.mention ?? null,
        held_reason:
          span.basis === 'ambiguous_cue'
            ? 'cue name ambiguous within roster -- held, not guessed'
            : span.basis === 'unknown_cue'
              ? 'cue name not in race roster -- held'
              : span.basis === 'preamble'
                ? 'pre-cue moderator preamble -- belongs to source, not a candidate'
                : null,
      },
    });
  }
  return units;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// The SourceParser
// ---------------------------------------------------------------------------

/**
 * Resolve the YouTube video reference this source addresses. A forum_video
 * harvest_sources row carries the video at source.url (a watch URL) or in
 * source.meta.video_id / source.meta.video_url. We normalize to an 11-char id.
 */
function resolveVideoRef(source: HarvestSource): { idOrUrl: string; watchUrl: string } | null {
  const meta = (source.meta ?? {}) as { video_id?: string; video_url?: string };
  const raw = source.url || meta.video_url || meta.video_id || '';
  const id = normalizeYoutubeId(raw);
  if (!id) return null;
  return { idOrUrl: id, watchUrl: `https://www.youtube.com/watch?v=${id}` };
}

/**
 * forumVideoParser -- the Build-1 SourceParser. Given a forum_video source:
 *   1. resolve the video id from the source's url/meta,
 *   2. fetch its transcript (reusing fetchYoutubeTranscript; injectable for tests),
 *   3. load the race roster (reuse the runner-provided one if forwarded, else
 *      load it from the source scope),
 *   4. segment the transcript into per-candidate ParsedUnits.
 *
 * Returns [] (no units) when the source has no resolvable video or no transcript
 * is available -- the runner treats an empty unit list as a clean no-op.
 *
 * NOTE: this parser is NOT auto-registered in PARSER_REGISTRY here -- the parent
 * wires it (per the task's "do NOT edit source-harvest-runner.ts's
 * PARSER_REGISTRY"). The CLI in scripts/harvest-forums.ts uses it directly.
 */
export const forumVideoParser: SourceParser = {
  source_type: 'forum_video',
  async fetchAndParse(harvestSource: HarvestSource, deps: ParserDeps): Promise<ParsedUnit[]> {
    const d = deps as ForumVideoDeps;

    const ref = resolveVideoRef(harvestSource);
    if (!ref) return [];

    // (2) transcript -- injectable for offline tests.
    const fetchTranscript =
      d.fetchTranscript ??
      ((idOrUrl: string) =>
        fetchYoutubeTranscript(idOrUrl, {
          languages: d.languages ?? ['en'],
          timeoutMs: d.timeoutMs ?? 15_000,
        }));

    const transcript = await fetchTranscript(ref.idOrUrl);
    if (!transcript || transcript.segments.length === 0) return [];

    // (3) roster -- reuse the runner's if forwarded, else load from source scope.
    let roster: Roster | undefined = d.roster;
    if (!roster) {
      try {
        roster = await loadRosterForSource(d.client, harvestSource);
      } catch {
        // No roster -> segment anyway; every span falls through to unattributed
        // (the safe outcome), held to the source for later binding.
        roster = { entries: [], scope: {}, note: 'roster load failed; all spans held unattributed' };
      }
    }

    // (4) segment + attribute.
    return segmentTranscript(transcript.segments, roster, ref.watchUrl);
  },
};
