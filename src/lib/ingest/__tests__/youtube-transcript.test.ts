/**
 * Offline unit tests for the YouTube transcript / timestamp resolver.
 * Pure functions only: no network, no live YouTube. Covers id + platform
 * parsing, transcript parsing (XML + JSON3), entity decoding, deep-link
 * construction, and the fuzzy quote-location that lands the deep link.
 */
import { describe, it, expect } from 'vitest';
import {
  detectVideoPlatform,
  parseYouTubeId,
  normalizeForMatch,
  decodeEntities,
  tokenize,
  parseTimedTextXml,
  parseTimedTextJson3,
  parseTimedTextFormat3Xml,
  parseTranscriptBody,
  locateQuoteInTranscript,
  buildYouTubeDeepLink,
  extractCaptionTracks,
  pickCaptionTrack,
  type TranscriptSegment,
} from '../youtube-transcript';

describe('detectVideoPlatform', () => {
  it('identifies known video hosts and rejects the rest', () => {
    expect(detectVideoPlatform('https://www.youtube.com/watch?v=abc12345678')).toBe('youtube');
    expect(detectVideoPlatform('https://youtu.be/abc12345678')).toBe('youtube');
    expect(detectVideoPlatform('https://www.facebook.com/watch/?v=123')).toBe('facebook');
    expect(detectVideoPlatform('https://fb.watch/xyz')).toBe('facebook');
    expect(detectVideoPlatform('https://rumble.com/v123-title.html')).toBe('rumble');
    expect(detectVideoPlatform('https://example.com/campaign')).toBeNull();
  });
});

describe('parseYouTubeId', () => {
  it('extracts the 11-char id from every URL shape', () => {
    expect(parseYouTubeId('https://www.youtube.com/watch?v=My9RjTTB1eA')).toBe('My9RjTTB1eA');
    expect(parseYouTubeId('https://youtu.be/My9RjTTB1eA?t=30')).toBe('My9RjTTB1eA');
    expect(parseYouTubeId('https://www.youtube.com/embed/My9RjTTB1eA')).toBe('My9RjTTB1eA');
    expect(parseYouTubeId('https://www.youtube.com/shorts/My9RjTTB1eA')).toBe('My9RjTTB1eA');
    expect(parseYouTubeId('https://www.youtube.com/watch?list=RD&v=My9RjTTB1eA&t=5')).toBe('My9RjTTB1eA');
  });
  it('returns null for non-YouTube or malformed URLs', () => {
    expect(parseYouTubeId('https://example.com')).toBeNull();
    expect(parseYouTubeId('')).toBeNull();
  });
});

describe('decodeEntities + normalizeForMatch', () => {
  it('decodes the entities YouTube caption payloads emit', () => {
    expect(decodeEntities('rights &amp; freedoms')).toBe('rights & freedoms');
    expect(decodeEntities('don&#39;t')).toBe("don't");
    expect(decodeEntities('&quot;quote&quot;')).toBe('"quote"');
  });
  it('normalizes case, punctuation, and contractions for matching', () => {
    expect(normalizeForMatch("We DON'T support that!")).toBe('we dont support that');
    expect(normalizeForMatch('Public   lands, forever.')).toBe('public lands forever');
    expect(tokenize('Reject expanded ICE enforcement')).toEqual(['reject', 'expanded', 'ice', 'enforcement']);
  });
});

describe('parseTimedTextXml', () => {
  it('parses cues with start/dur and strips inline tags + entities', () => {
    const xml =
      '<?xml version="1.0"?><transcript>' +
      '<text start="0.5" dur="2.0">We must <b>protect</b> public lands</text>' +
      '<text start="2.5" dur="1.5">and reject the sell-off &amp; more</text>' +
      '<text start="4.0" dur="1.0">   </text>' +
      '</transcript>';
    const segs = parseTimedTextXml(xml);
    expect(segs).toHaveLength(2); // blank cue dropped
    expect(segs[0]).toEqual({ start: 0.5, dur: 2.0, text: 'We must protect public lands' });
    expect(segs[1].text).toBe('and reject the sell-off & more');
  });
});

describe('parseTimedTextJson3', () => {
  it('parses events/segs and converts ms to seconds', () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'protect ' }, { utf8: 'public lands' }] },
        { tStartMs: 3200, dDurationMs: 1000, segs: [{ utf8: '\n' }] }, // whitespace-only -> dropped
        { tStartMs: 4000, dDurationMs: 1500, segs: [{ utf8: 'no sell off' }] },
      ],
    });
    const segs = parseTimedTextJson3(json);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ start: 1, dur: 2, text: 'protect public lands' });
    expect(segs[1]).toEqual({ start: 4, dur: 1.5, text: 'no sell off' });
  });
  it('returns [] on malformed JSON', () => {
    expect(parseTimedTextJson3('not json')).toEqual([]);
  });
});

describe('parseTimedTextFormat3Xml', () => {
  it('parses <p t d> cues with inner <s> word spans and converts ms to seconds', () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><head><ws id="0"/></head><body>' +
      '<p t="500" d="2000"><s>protect</s><s ac="1"> public</s><s> lands</s></p>' +
      '<p t="2500" d="1500">and reject the sell off</p>' +
      '<p t="4000" d="800">  </p>' +
      '</body></timedtext>';
    const segs = parseTimedTextFormat3Xml(xml);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ start: 0.5, dur: 2, text: 'protect public lands' });
    expect(segs[1]).toEqual({ start: 2.5, dur: 1.5, text: 'and reject the sell off' });
  });
});

describe('parseTranscriptBody', () => {
  it('auto-detects JSON3, format-3 XML, and legacy XML', () => {
    const json3 = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world' }] }] });
    expect(parseTranscriptBody(json3)[0].text).toBe('hello world');
    expect(parseTranscriptBody('<timedtext format="3"><body><p t="0" d="1000">hi there</p></body></timedtext>')[0].text).toBe('hi there');
    expect(parseTranscriptBody('<transcript><text start="0" dur="1">legacy line</text></transcript>')[0].text).toBe('legacy line');
  });
});

describe('buildYouTubeDeepLink', () => {
  it('adds t=<seconds>s and replaces any existing t param, idempotently', () => {
    expect(buildYouTubeDeepLink('https://www.youtube.com/watch?v=abc12345678', 92)).toBe(
      'https://www.youtube.com/watch?v=abc12345678&t=92s',
    );
    const once = buildYouTubeDeepLink('https://www.youtube.com/watch?v=abc12345678&t=10s', 92);
    expect(once).toBe('https://www.youtube.com/watch?v=abc12345678&t=92s');
    expect(buildYouTubeDeepLink(once, 92)).toBe(once); // idempotent
  });
  it('floors fractional seconds and never goes negative', () => {
    expect(buildYouTubeDeepLink('https://youtu.be/abc12345678', 30.9)).toContain('t=30s');
    expect(buildYouTubeDeepLink('https://youtu.be/abc12345678', -5)).toContain('t=0s');
  });
});

describe('extractCaptionTracks + pickCaptionTrack', () => {
  it('pulls baseUrl/languageCode pairs from watch-page HTML and prefers English', () => {
    const html =
      'junk...{"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[' +
      '{"baseUrl":"https://youtube.com/api/timedtext?v=x\\u0026lang=es","name":{},"languageCode":"es"},' +
      '{"baseUrl":"https://youtube.com/api/timedtext?v=x\\u0026lang=en","name":{},"languageCode":"en"}' +
      ']}}}...more junk';
    const tracks = extractCaptionTracks(html);
    expect(tracks.length).toBeGreaterThanOrEqual(1);
    const picked = pickCaptionTrack(tracks);
    expect(picked?.lang).toBe('en');
    expect(picked?.baseUrl).toContain('&lang=en'); // & decoded to &
  });
  it('returns [] when the page has no caption tracks', () => {
    expect(extractCaptionTracks('<html>no captions here</html>')).toEqual([]);
    expect(pickCaptionTrack([])).toBeNull();
  });
});

describe('locateQuoteInTranscript', () => {
  // A realistic transcript broken into short caption cues.
  const transcript: TranscriptSegment[] = [
    { start: 0, dur: 3, text: 'Thanks everyone for coming out tonight' },
    { start: 3, dur: 3, text: 'I want to talk about our public lands' },
    { start: 6, dur: 4, text: 'We must protect public lands and reject the sell off to private interests' },
    { start: 10, dur: 3, text: 'because once they are gone they are gone forever' },
    { start: 13, dur: 3, text: 'now let me turn to healthcare and the cost of prescriptions' },
  ];

  it('locates an exact quote and returns the cue start time', () => {
    const loc = locateQuoteInTranscript('protect public lands and reject the sell off', transcript);
    expect(loc).not.toBeNull();
    expect(loc!.startSeconds).toBe(6);
    expect(loc!.score).toBeGreaterThan(0.9);
  });

  it('tolerates punctuation, case, and contraction differences', () => {
    const loc = locateQuoteInTranscript('We MUST protect public-lands, and reject the sell-off!', transcript);
    expect(loc).not.toBeNull();
    expect(loc!.startSeconds).toBe(6);
  });

  it('lands near the quote even when it spans cue boundaries', () => {
    const loc = locateQuoteInTranscript('gone they are gone forever now let me turn to healthcare', transcript);
    expect(loc).not.toBeNull();
    // Anchor is the first matching token ("gone") which appears in the 10s cue.
    expect(loc!.startSeconds).toBe(10);
  });

  it('returns null when the quote is absent from the transcript', () => {
    const loc = locateQuoteInTranscript('we will build a new stadium downtown by next spring', transcript);
    expect(loc).toBeNull();
  });

  it('returns null for too-short quotes and empty transcripts', () => {
    expect(locateQuoteInTranscript('public lands', transcript, { minTokens: 3 })).toBeNull();
    expect(locateQuoteInTranscript('protect public lands', [])).toBeNull();
  });
});
