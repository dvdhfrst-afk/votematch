/**
 * news-qa.ts -- Build 3 of the source-centric harvest engine: the local-news
 * voter-guide / candidate-Q&A SourceParser (source_type 'news_guide').
 *
 * THE PATTERN (see 12-positioning-engine/13-harvest-buildout-plan.md, Build 3):
 *   A local or regional outlet sends every candidate in a race the SAME short
 *   questionnaire and publishes the answers as a single voter-guide page. That is
 *   ONE source covering MANY candidates -- the source-centric shape. We fetch the
 *   page once, segment it by candidate, and emit one ParsedUnit per candidate
 *   carrying THAT candidate's OWN written answers (each question paired with their
 *   answer). The generic runner (source-harvest-runner.ts) then resolves each
 *   candidateMention against the race ROSTER and writes attributed / unattributed
 *   raw_evidence with provenance. signal_view is 'stated' -- these are the
 *   candidate's own words, not a third party's read of them.
 *
 * SEGMENTATION (the hard part). Real voter guides come in TWO layouts, and a page
 * can mix them. Both express the candidate name and the question as HEADINGS, so
 * the parser works on a normalized HEADING TREE rather than on outlet-specific CSS:
 *
 *   A) QUESTION-GROUPED (the dominant layout, e.g. Utah News Dispatch race pages):
 *        ## The Issues
 *        ### <Topic>
 *        #### <Question text?>
 *        ##### <Candidate Name> (<party abbr>)
 *        <answer paragraphs>
 *        ##### <Candidate Name> (<party abbr>)
 *        <answer paragraphs>
 *      The candidate-name heading REPEATS under every question. We walk the tree,
 *      track the current question (nearest preceding question heading) and the
 *      current candidate (nearest preceding candidate-name heading), and append
 *      each answer block to that (candidate, question) pair.
 *
 *   B) CANDIDATE-GROUPED (e.g. a single bio/profile block per candidate, or a
 *      one-Q&A-per-section guide):
 *        ## The Candidates  (or "Meet the candidates", "Profiles", ...)
 *        ### <Candidate Name>
 *        <party / bio / their statement>
 *      Here each candidate appears ONCE and everything under their heading until
 *      the next candidate heading is theirs.
 *
 *   SINGLE-CANDIDATE Q&A: a profile article about one candidate. Falls out of the
 *   same machinery as a candidate-grouped guide with a roster of one mention.
 *
 * The KEY to telling a candidate-name heading from a topic/question heading is the
 * RACE ROSTER, supplied to the parser via deps.roster: a heading whose text
 * matches a roster name (canonical key / safe token overlap) is a candidate
 * heading; everything else is structure. When no roster is available (a discovery
 * pass), we fall back to a name-shape heuristic (a short Title Case run, optionally
 * followed by a "(D)" / "(Republican)" party tag) so the parser still segments,
 * and the runner's roster-constrained resolver remains the final safety gate -- an
 * unrecognized name is held UNATTRIBUTED, never guessed onto a person.
 *
 * QUOTE / COMPLIANCE POSTURE (data-source policy + Build 3 spec):
 *   - Named-outlet content; we attribute every unit to (outlet, candidate, page).
 *   - We capture the CANDIDATE'S OWN answers (their words), not the outlet's
 *     editorial framing beyond the question prompt that contextualizes the answer.
 *   - PAYWALL / TEASER / LOGIN SHELL -> emit NOTHING. If the fetched page is a
 *     subscribe wall, a metered teaser, or a login shell with no real answers, we
 *     skip gracefully rather than store a junk shell. isPaywallOrTeaser() gates this.
 *   - Aggregators (Ballotpedia / Vote411 / etc.) are blocked upstream by the
 *     raw-ingest DENYLIST and by harvest-news-guides.ts refusing to register them;
 *     this parser additionally refuses to parse a denied host defensively.
 *
 * Single TypeScript runtime, no Python, no new dependency: cheerio (already a dep)
 * does the HTML -> heading-tree parse; Jina markdown is parsed by a tiny inline
 * heading scanner. The parser is pure given an injected fetch (deps.fetchImpl),
 * so the offline test drives it with fixtures and no network.
 */
import type {
  HarvestSource,
  ParsedUnit,
  ParserDeps,
  SourceParser,
} from '../source-harvest-runner';
import { resolveMentionInRoster, type Roster } from '../race-roster';
import { isDenied, registrableDomainOf } from '../../raw-ingest';

// ---------------------------------------------------------------------------
// Injected fetch seam: the runner passes runPageFetch through parserDeps so the
// offline test can stub it. The signature mirrors runPageFetch's return shape.
// ---------------------------------------------------------------------------

export interface SmartFetchResult {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
}
export type SmartFetchFn = (args: {
  url: string;
}) => Promise<SmartFetchResult>;

/** Extra deps this parser reads off ParserDeps (all optional / injected). */
interface NewsQaDeps extends ParserDeps {
  /** The smart-fetch implementation. Live: runPageFetch. Test: a stub. */
  fetchImpl?: SmartFetchFn;
  /**
   * The in-scope race roster, when the runner has already loaded it. Used to tell
   * candidate-name headings apart from topic/question headings. The runner passes
   * this; in a standalone call it may be absent (the name-shape fallback fires).
   */
  roster?: Roster;
  /** Raw page body, injected by the offline test to bypass fetch entirely. */
  rawBody?: string;
  /** Coarse content-type hint for the injected body ('text/html' | 'text/markdown'). */
  rawContentType?: string;
}

// ---------------------------------------------------------------------------
// Heading tree -- the layout-neutral intermediate representation
// ---------------------------------------------------------------------------

/** One node in the flattened document: a heading (with level) or a text block. */
interface DocNode {
  kind: 'heading' | 'text';
  /** Heading level 1..6 (h1=1). Undefined for text. */
  level?: number;
  /** Heading title text, or a paragraph of body text. */
  text: string;
}

// Boilerplate heading titles that are page chrome, never candidate or question
// headings. Compared case-insensitively against the trimmed heading text.
const CHROME_HEADINGS = new Set(
  [
    'the candidates',
    'the issues',
    'details',
    'most viewed',
    'related stories',
    'sponsored story',
    'connect',
    'membership',
    'about us',
    'more',
    'reporting for and from the crossroads of the west',
    'democracy toolkit',
    'menu',
    'search',
    'navigation',
  ].map((s) => s.toLowerCase()),
);

// Section headings that INTRODUCE a candidate-grouped block (layout B).
const CANDIDATE_SECTION_HEADINGS = [
  'the candidates',
  'meet the candidates',
  'candidates',
  'profiles',
  'candidate profiles',
];

// ---------------------------------------------------------------------------
// Paywall / teaser / login shell detection
// ---------------------------------------------------------------------------

/**
 * Markers that strongly imply the fetched artifact is a subscribe wall, a metered
 * teaser, or a login shell rather than the actual answers. Matched case-insensitively.
 * These are deliberately HIGH-PRECISION phrases (whole subscribe-CTA copy), not bare
 * words like "subscribe" that appear in every site footer.
 */
const PAYWALL_MARKERS = [
  'subscribe to continue reading',
  'subscribe to read',
  'to continue reading',
  'continue reading this article',
  'this article is for subscribers',
  'subscribers only',
  'subscriber exclusive',
  'log in to read',
  'sign in to continue',
  'create a free account to continue',
  'register to continue reading',
  'you have reached your article limit',
  'you have read your',
  'become a member to read',
  'unlock this article',
  'support local journalism to read',
];

/**
 * isPaywallOrTeaser(text, candidateAnswerCount): true when the page looks like a
 * paywall / teaser / login shell that we must skip. Two independent signals:
 *   1. A paywall CTA phrase appears AND the page yielded essentially no candidate
 *      answers (a real article that merely links "subscribe" in its footer still
 *      has its answers, so we only treat the CTA as a wall when answers are absent).
 *   2. The extracted body is too short to plausibly contain real answers (a
 *      login-shell skeleton), regardless of CTA copy.
 * Exported for the offline test.
 */
export function isPaywallOrTeaser(fullText: string, candidateAnswerCount: number): boolean {
  const t = (fullText ?? '').toLowerCase();
  const hasWallCta = PAYWALL_MARKERS.some((m) => t.includes(m));
  // A wall is a wall only when it also starved us of answers. A populated guide
  // that happens to carry a "subscribe" footer is NOT a wall.
  if (hasWallCta && candidateAnswerCount === 0) return true;
  // A skeletal login/teaser shell: almost no meaningful body and no answers.
  if (candidateAnswerCount === 0 && t.replace(/\s+/g, ' ').trim().length < 400) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Body -> DocNode[] (two parsers: HTML via cheerio, markdown via a line scanner)
// ---------------------------------------------------------------------------

/** True when the body looks like Jina-style markdown rather than raw HTML. */
function looksLikeMarkdown(body: string, contentType: string): boolean {
  if (/markdown/i.test(contentType)) return true;
  if (/^\s*Title:\s.+\n/m.test(body) && /Markdown Content:/i.test(body)) return true;
  const tagCount = (body.match(/<[a-z!/][^>]*>/gi) ?? []).length;
  const atxCount = (body.match(/^#{1,6}\s+\S/gm) ?? []).length;
  return atxCount >= 3 && tagCount < atxCount;
}

/** Parse Jina/ATX markdown into a flat DocNode list (headings + text blocks). */
function markdownToNodes(body: string): DocNode[] {
  const nodes: DocNode[] = [];
  // Drop a Jina preamble ("Title: .. / URL Source: .. / Markdown Content:") so the
  // first H1 is the article title, not the preamble.
  let md = body;
  const mc = md.indexOf('Markdown Content:');
  if (mc >= 0) md = md.slice(mc + 'Markdown Content:'.length);

  const lines = md.split(/\r?\n/);
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (text) nodes.push({ kind: 'text', text });
    buf = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, '');
    const h = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) {
      flush();
      nodes.push({ kind: 'heading', level: h[1].length, text: stripInlineMd(h[2]) });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    buf.push(stripInlineMd(line.trim()));
  }
  flush();
  return nodes;
}

/** Strip the inline markdown a heading/line may carry (links, bold, images). */
function stripInlineMd(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> link text
    .replace(/[*_`]+/g, '') // emphasis / code ticks
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse HTML into a flat DocNode list via cheerio (already a dependency). */
function htmlToNodes(body: string): DocNode[] {
  const nodes: DocNode[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cheerio = require('cheerio') as typeof import('cheerio');
    const $ = cheerio.load(body);
    $('script, style, noscript, nav, header, footer, svg, iframe, form, link, meta, aside').remove();
    $(
      '[role="navigation"], [role="banner"], [role="contentinfo"], .nav, .navbar, .header, .footer, .sidebar, .menu, .related, .most-viewed, .ad, .ads',
    ).remove();
    const root = $('main').first().length ? $('main').first() : $('body');
    root.find('h1, h2, h3, h4, h5, h6, p, li, dd, blockquote').each((_i, el) => {
      const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? '';
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (!text) return;
      const m = tag.match(/^h([1-6])$/);
      if (m) nodes.push({ kind: 'heading', level: Number(m[1]), text });
      else nodes.push({ kind: 'text', text });
    });
  } catch {
    // cheerio unavailable -- fall back to a crude tag-walk so the parser still runs.
    return crudeHtmlToNodes(body);
  }
  return nodes;
}

/** Minimal regex tag-walk fallback when cheerio cannot load. */
function crudeHtmlToNodes(body: string): DocNode[] {
  const nodes: DocNode[] = [];
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const re = /<(h[1-6]|p|li|dd|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const tag = m[1].toLowerCase();
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const h = tag.match(/^h([1-6])$/);
    if (h) nodes.push({ kind: 'heading', level: Number(h[1]), text });
    else nodes.push({ kind: 'text', text });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Heading classification: candidate-name vs question vs chrome
// ---------------------------------------------------------------------------

/**
 * A candidate-name heading often carries a trailing party tag: "Jane Doe (D)",
 * "Jane Doe (Republican)", "Jane Doe (UF (Utah Forward))". Strip that to get the
 * bare name and keep the party hint.
 */
function splitNameAndParty(headingText: string): { name: string; party: string | null } {
  // Take everything before the first parenthesis as the name; first paren group is party.
  const m = headingText.match(/^([^(]+?)\s*\(([^)]*(?:\([^)]*\))?[^)]*)\)\s*$/);
  if (m) {
    return { name: m[1].trim(), party: m[2].replace(/\([^)]*\)/g, '').trim() || null };
  }
  return { name: headingText.trim(), party: null };
}

/**
 * Does this heading text name a roster candidate? Reuses the SAME roster-confined
 * resolver the runner uses (resolveMentionInRoster), so "Bob Smith" matches a
 * roster "Robert Smith" variant and a non-candidate topic heading does not. Returns
 * the matched roster entry's canonical name (so the emitted mention is the clean
 * name) or null.
 */
function rosterNameForHeading(headingText: string, roster: Roster | undefined): string | null {
  if (!roster || roster.entries.length === 0) return null;
  const { name } = splitNameAndParty(headingText);
  const res = resolveMentionInRoster(name, roster);
  if (res.status === 'resolved') return res.entry.canonical_name;
  return null;
}

/**
 * Name-shape fallback when no roster is present: a heading is treated as a
 * candidate name when it is a SHORT Title Case run of 2..4 words (a personal name),
 * optionally followed by a party tag, and is not a known chrome heading. The
 * runner's roster-constrained resolver is still the final gate downstream, so a
 * false positive here just becomes an UNATTRIBUTED unit, never a wrong bind.
 */
function looksLikePersonName(headingText: string): boolean {
  const { name } = splitNameAndParty(headingText);
  if (CHROME_HEADINGS.has(name.toLowerCase())) return false;
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  // Each word starts uppercase (allow internal apostrophes/hyphens, initials "J.").
  return words.every((w) => /^[A-Z][A-Za-z.'-]*$/.test(w));
}

/** True when a heading is a question prompt (ends in "?" or is under "The Issues"). */
function looksLikeQuestion(headingText: string): boolean {
  return /\?\s*$/.test(headingText.trim());
}

/** True when a heading introduces a candidate-grouped section (layout B). */
function isCandidateSectionHeading(headingText: string): boolean {
  const t = headingText.trim().toLowerCase();
  return CANDIDATE_SECTION_HEADINGS.some((h) => t === h || t.startsWith(h));
}

// ---------------------------------------------------------------------------
// "No response" detection -- a candidate who declined the questionnaire
// ---------------------------------------------------------------------------

const NO_RESPONSE_RE = /^\s*(no response|did not respond|declined to respond|no answer|n\/?a)\.?\s*$/i;
function isNoResponse(text: string): boolean {
  return NO_RESPONSE_RE.test(text.trim());
}

// ---------------------------------------------------------------------------
// Segmentation: DocNode[] -> per-candidate (question, answer) collections
// ---------------------------------------------------------------------------

interface CandidateAccum {
  /** Display mention as it appeared (roster canonical name when matched). */
  mention: string;
  party: string | null;
  /** Ordered (question, answer) pairs gathered for this candidate. */
  qa: Array<{ question: string | null; answer: string }>;
}

/**
 * segmentByCandidate -- the core. Walks the DocNode list and assigns every answer
 * text block to a (candidate, question) pair. Handles BOTH layouts in one pass:
 *
 *   - Track currentQuestion: set whenever we see a question heading (ends "?") or a
 *     topic heading inside the issues section. Reset to null at a new candidate
 *     section.
 *   - Track currentCandidate: set whenever a heading resolves to a roster name (or,
 *     fallback, looks like a person name). Subsequent text blocks belong to that
 *     candidate under the currentQuestion until the next candidate / question heading.
 *
 * isCandidate(headingText): roster match first (precise), else name-shape fallback.
 */
function segmentByCandidate(
  nodes: DocNode[],
  roster: Roster | undefined,
): Map<string, CandidateAccum> {
  const byCandidate = new Map<string, CandidateAccum>();
  let currentQuestion: string | null = null;
  let currentCandidate: string | null = null;

  // Determine, for a heading, whether it names a candidate and what mention to use.
  const candidateOf = (headingText: string): { mention: string; party: string | null } | null => {
    const rosterName = rosterNameForHeading(headingText, roster);
    if (rosterName) {
      const { party } = splitNameAndParty(headingText);
      return { mention: rosterName, party };
    }
    if (!roster || roster.entries.length === 0) {
      if (looksLikePersonName(headingText)) {
        const { name, party } = splitNameAndParty(headingText);
        return { mention: name, party };
      }
    }
    return null;
  };

  for (const node of nodes) {
    if (node.kind === 'heading') {
      const text = node.text.trim();
      if (!text) continue;

      // A candidate-section heading ("The Candidates") resets the question context
      // so bios that follow are not mis-tagged to the previous question.
      if (isCandidateSectionHeading(text)) {
        currentQuestion = null;
        currentCandidate = null;
        continue;
      }

      // Chrome heading -> close the current candidate (we have left the content).
      if (CHROME_HEADINGS.has(text.toLowerCase())) {
        currentCandidate = null;
        continue;
      }

      const cand = candidateOf(text);
      if (cand) {
        currentCandidate = cand.mention;
        if (!byCandidate.has(cand.mention)) {
          byCandidate.set(cand.mention, { mention: cand.mention, party: cand.party, qa: [] });
        } else if (cand.party && !byCandidate.get(cand.mention)!.party) {
          byCandidate.get(cand.mention)!.party = cand.party;
        }
        continue;
      }

      // Not a candidate heading. Treat a question-shaped heading (or any non-chrome
      // heading inside the issues flow) as the current question, and clear the
      // current candidate so the next candidate heading re-binds explicitly.
      if (looksLikeQuestion(text)) {
        currentQuestion = text;
        currentCandidate = null;
      } else {
        // A topic heading ("Utah needs"): keep it as a coarse question context but
        // do not overwrite a more specific question prompt that may follow.
        currentQuestion = text;
        currentCandidate = null;
      }
      continue;
    }

    // Text block -> belongs to the current candidate (if any) under currentQuestion.
    if (node.kind === 'text' && currentCandidate) {
      const answer = node.text.trim();
      if (!answer) continue;
      if (isNoResponse(answer)) continue; // declined -> nothing to attribute
      // Skip pure party labels / boilerplate that are not the candidate's words.
      if (/^(democrat|republican|libertarian|independent|nonpartisan|unaffiliated|incumbent)\b.{0,40}$/i.test(answer)) {
        continue;
      }
      const acc = byCandidate.get(currentCandidate)!;
      acc.qa.push({ question: currentQuestion, answer });
    }
  }

  return byCandidate;
}

// ---------------------------------------------------------------------------
// Rendering a candidate's slice into the unit content
// ---------------------------------------------------------------------------

/**
 * Render one candidate's gathered Q&A into the extracted_text body of a ParsedUnit.
 * Each pair is "Q: <question>\nA: <answer>"; a bio block with no question is kept as
 * a plain statement. This is the candidate's OWN words, quote-limited to their
 * answers (the question prompt is the outlet's neutral framing that contextualizes
 * the answer; we keep it so the stated position is interpretable).
 */
function renderUnitContent(acc: CandidateAccum): string {
  const parts: string[] = [];
  for (const { question, answer } of acc.qa) {
    if (question) parts.push(`Q: ${question}\nA: ${answer}`);
    else parts.push(answer);
  }
  return parts.join('\n\n').trim();
}

/** Pull the article title (first H1) for provenance, when present. */
function articleTitle(nodes: DocNode[]): string | null {
  const h1 = nodes.find((n) => n.kind === 'heading' && n.level === 1 && n.text.trim());
  return h1 ? h1.text.trim() : null;
}

// ---------------------------------------------------------------------------
// fetchAndParse -- the SourceParser entry point
// ---------------------------------------------------------------------------

/** Parse smart_fetch's banner-wrapped success payload into { ok, body, contentType }. */
function unwrapSmartFetch(res: SmartFetchResult): { ok: boolean; body: string; contentType: string } {
  const text = res?.content?.[0]?.text ?? '';
  if (res?.isError) return { ok: false, body: '', contentType: '' };
  const banner = text.match(
    /^<!--\s*smart_fetch:\s*tier=(\S+)\s+status=(\d+)[^>]*-->\n?/,
  );
  if (banner) {
    const tier = banner[1];
    return {
      ok: true,
      body: text.slice(banner[0].length),
      contentType: tier === 'jina' ? 'text/markdown' : 'text/html',
    };
  }
  return { ok: true, body: text, contentType: 'text/html' };
}

/**
 * parseGuideBody -- the pure core, exported for the offline test. Given a raw page
 * body + content-type + the in-scope roster, returns the per-candidate ParsedUnits
 * (or [] when the page is a paywall/teaser shell). No I/O.
 */
export function parseGuideBody(
  body: string,
  contentType: string,
  source: HarvestSource,
  roster: Roster | undefined,
): ParsedUnit[] {
  if (!body || !body.trim()) return [];

  const nodes = looksLikeMarkdown(body, contentType) ? markdownToNodes(body) : htmlToNodes(body);
  const byCandidate = segmentByCandidate(nodes, roster);

  // Count candidates that actually yielded answers (a "No response" candidate has 0).
  const withAnswers = [...byCandidate.values()].filter((c) => c.qa.length > 0);

  // Paywall / teaser / login shell -> emit nothing.
  const fullText = nodes.map((n) => n.text).join(' ');
  if (isPaywallOrTeaser(fullText, withAnswers.length)) return [];

  const outlet = source.meta?.outlet as string | undefined;
  const outletName =
    outlet ??
    (source.url ? registrableDomainOf(new URL(source.url).hostname) ?? source.url : 'unknown');
  const pageUrl = source.url ?? null;
  const title = articleTitle(nodes);

  const units: ParsedUnit[] = [];
  for (const acc of withAnswers) {
    const content = renderUnitContent(acc);
    if (!content) continue;
    const questions = acc.qa.map((q) => q.question).filter((q): q is string => !!q);
    units.push({
      candidateMention: acc.mention,
      locus: {
        outlet: outletName,
        page_url: pageUrl,
        section: title ?? 'voter guide',
        party_hint: acc.party,
      },
      content,
      source_family: 'news_qa',
      signal_view: 'stated',
      extra: {
        outlet: outletName,
        page_url: pageUrl,
        article_title: title,
        questions,
        answer_count: acc.qa.length,
        party_hint: acc.party,
      },
    });
  }
  return units;
}

/**
 * The news_guide parser. fetchAndParse:
 *   1. Defensive denylist check on the URL host (aggregators never parsed here).
 *   2. Fetch the page via the injected fetch (live: runPageFetch, a plain
 *      HTTP GET through politeFetch). JavaScript-only pages yield no body.
 *   3. Unwrap the body, segment by candidate, emit one stated-view ParsedUnit per
 *      candidate with answers; skip gracefully (return []) on paywall / teaser / fetch fail.
 */
export const newsQaParser: SourceParser = {
  source_type: 'news_guide',
  async fetchAndParse(source: HarvestSource, deps: ParserDeps): Promise<ParsedUnit[]> {
    const d = deps as NewsQaDeps;
    const roster = d.roster;

    // (1) Defensive denylist guard (the registry / runner also guard this).
    if (source.url) {
      let host = '';
      try {
        host = new URL(source.url).hostname.toLowerCase();
      } catch {
        return []; // malformed URL -> nothing to parse
      }
      if (isDenied(registrableDomainOf(host), host)) return [];
    }

    // (2) Body: injected (test) or fetched (live).
    let body = d.rawBody ?? '';
    let contentType = d.rawContentType ?? 'text/html';
    if (!body) {
      if (!source.url) return [];
      const fetchImpl = d.fetchImpl;
      if (!fetchImpl) {
        // No fetcher injected: lazily import the live runPageFetch so the offline
        // test (which always injects rawBody or fetchImpl) never loads it.
        const { runPageFetch } = await import('@/lib/agent-tools/page-fetch');
        const res = await runPageFetch({ url: source.url });
        const un = unwrapSmartFetch(res);
        if (!un.ok || !un.body.trim()) return [];
        body = un.body;
        contentType = un.contentType;
      } else {
        const res = await fetchImpl({ url: source.url });
        const un = unwrapSmartFetch(res);
        if (!un.ok || !un.body.trim()) return [];
        body = un.body;
        contentType = un.contentType;
      }
    }

    // (3) Segment + emit.
    return parseGuideBody(body, contentType, source, roster);
  },
};

// Re-export a couple of internals for the offline test's white-box assertions.
export const __test = {
  splitNameAndParty,
  segmentByCandidate,
  markdownToNodes,
  htmlToNodes,
  isPaywallOrTeaser,
  rosterNameForHeading,
  looksLikePersonName,
};
