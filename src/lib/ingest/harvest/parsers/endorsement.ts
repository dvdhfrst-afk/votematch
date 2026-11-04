/**
 * endorsement.ts -- the ENDORSEMENT / SCORECARD SourceParser (Harvest Build 2).
 *
 * THE PATTERN (12-positioning-engine/13-harvest-buildout-plan.md, Build 2):
 *   One endorsing ORGANIZATION's own endorsement / scorecard page (a primary
 *   statement BY the org -- NOT an aggregator) names many candidates. We fetch
 *   that page ONCE, parse the list of (candidate name, race/office if present,
 *   grade or endorsed/not), and emit one ParsedUnit per listed candidate. The
 *   shared runner (source-harvest-runner.ts) then resolves each name against the
 *   source's RACE ROSTER, so a mention only ever binds to someone actually in the
 *   race -- a namesake outside the roster is structurally impossible to hit. A
 *   mention that matches no in-scope candidacy is held UNATTRIBUTED to the source.
 *
 * SIGNAL VIEW: inferred. An endorsement is a THIRD-PARTY read of a candidate, not
 * the candidate's own words, so every unit is signal_view='inferred' (gated, never
 * a stated-view position).
 *
 * THE ORG -> AXIS HINT (held, not a real position yet):
 *   data/positioning/org-axis-map.json maps each org slug to the sub_dimension
 *   axis (or axes) + direction (on the same 0.0->1.0 anchor scale) + strength its
 *   endorsement implies. This parser looks the source's org up in that map and
 *   stores the mapped axis hint in ParsedUnit.extra.axis_hints. Per the buildout
 *   plan this is HELD: we store the endorsement FACT + the hint, and write NO real
 *   axis position until the multivariable schema lands. When it does, an editor-
 *   reviewed map like this becomes the inferred-view source-to-axis translation.
 *
 * COMPLIANCE (data-source policy, CLAUDE.md): we ONLY fetch the org's OWN
 * published endorsement / scorecard page (a primary source we attribute), via
 * runPageFetch (the existing tiered fetch -- we never reimplement fetching). We
 * NEVER read a banned aggregator; the org slug carries an editorial homepage /
 * endorsement_page so provenance is the org itself. The runner's per-URL
 * normalize/scrub/hash/idempotency apply unchanged.
 *
 * Single TypeScript runtime, no Python. No new npm dependency: HTML is reduced to
 * text with a small dependency-free strip (the live runPageFetch already
 * returns compact markdown), and the org map is read from the JSON file
 * with node:fs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPageFetch } from '@/lib/agent-tools/page-fetch';
import type {
  HarvestSource,
  ParsedUnit,
  ParserDeps,
  SourceParser,
} from '../source-harvest-runner';

// ---------------------------------------------------------------------------
// source_family + the org-axis map
// ---------------------------------------------------------------------------

/** The source_family tag for endorsement evidence (Build 2). */
export const ENDORSEMENT_SOURCE_FAMILY = 'endorsement';

/** One axis hint from the org-axis map (held until the multivariable schema lands). */
export interface OrgAxisHint {
  axis: string;
  direction: number;
  strength: number;
  rationale?: string;
}

/** One org entry in the editorial org-axis map. */
export interface OrgAxisEntry {
  display_name: string;
  homepage?: string;
  endorsement_page?: string;
  kind?: string;
  editorial: boolean;
  held: boolean;
  axes: OrgAxisHint[];
}

export interface OrgAxisMapFile {
  map_version?: string;
  orgs: Record<string, OrgAxisEntry>;
}

/**
 * Default location of the editorial org-axis map (relative to <cwd>, which is the
 * app/ dir when scripts run). Overridable via deps.orgAxisMapPath (tests inject a
 * fixture). The map is loaded ONCE per parse call and cached on the module.
 */
function defaultOrgAxisMapPath(): string {
  return join(process.cwd(), 'data', 'positioning', 'org-axis-map.json');
}

let _cachedMap: { path: string; map: OrgAxisMapFile } | null = null;

/**
 * Load the org-axis map JSON. Cached by path. A missing / malformed file does NOT
 * throw: we return an empty map so the harvester still stores endorsement FACTS
 * (just with no axis hint). The map is editorial and HELD, so its absence must
 * never block evidence capture.
 */
export function loadOrgAxisMap(path?: string): OrgAxisMapFile {
  const p = path ?? defaultOrgAxisMapPath();
  if (_cachedMap && _cachedMap.path === p) return _cachedMap.map;
  let map: OrgAxisMapFile = { orgs: {} };
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as OrgAxisMapFile;
    if (parsed && typeof parsed === 'object' && parsed.orgs) map = parsed;
  } catch {
    map = { orgs: {} };
  }
  _cachedMap = { path: p, map };
  return map;
}

/** Look up an org's axis hints by slug. Returns null when the org is not mapped. */
export function axisHintsForOrg(
  orgSlug: string | null | undefined,
  map: OrgAxisMapFile,
): { entry: OrgAxisEntry; hints: OrgAxisHint[] } | null {
  if (!orgSlug) return null;
  const entry = map.orgs[orgSlug];
  if (!entry) return null;
  return { entry, hints: entry.axes ?? [] };
}

// ---------------------------------------------------------------------------
// Page -> rows: parse an endorsement / scorecard page into listed candidates
// ---------------------------------------------------------------------------

/** One parsed scorecard / endorsement row before resolution. */
export interface EndorsementRow {
  /** The candidate NAME exactly as it appeared on the page. */
  name: string;
  /** The office / race text when the page printed one alongside the name, else null. */
  office: string | null;
  /** The grade / status text (e.g. "A+", "Endorsed", "F"), else null. */
  grade: string | null;
  /** The raw source line / cell the row was extracted from (provenance). */
  raw: string;
}

/**
 * A capitalized personal-name run: 2 to 4 capitalized tokens, allowing internal
 * hyphens, apostrophes, periods (initials), and the common lowercase particles
 * (de, la, van, von, der). This is the candidate-name shape on a typical
 * endorsement list. We deliberately require >= 2 tokens so single capitalized
 * words (headers like "Endorsements", "Senate") are not mistaken for names; the
 * roster bind is the real safety net, this regex only proposes candidates.
 */
const NAME_RUN =
  "[A-Z][A-Za-z'.-]+(?:\\s+(?:de|la|del|van|von|der|den|di|da|bin|al)\\b)?(?:\\s+[A-Z][A-Za-z'.-]+){1,3}";

/**
 * A grade token an org might print: letter grades (with optional +/-), or an
 * endorsed-status word. The letter-grade alternative is ordered longest-first
 * (A+ / A- before bare A) and uses a leading \b but NO trailing \b -- a "+"/"-"
 * suffix is a non-word char, so a trailing \b would reject "A+" before a period
 * and silently fall through to bare "A". The (?![A-Za-z]) lookahead keeps it from
 * matching the "A" inside a word like "Alex".
 */
const GRADE_RE =
  /\b(A\+|A-|B\+|B-|C\+|C-|D\+|D-|A|B|C|D|F)(?![A-Za-z])|\b(endorsed|recommended|gun sense (?:candidate|distinction)|pro-?life|pro-?choice|preferred|supported|opposed|not endorsed)\b/i;

/**
 * Heuristic office / race tokens that, when present in a line, are captured as the
 * row's office hint (the runner's roster scoping is the authority; this is just a
 * provenance breadcrumb that helps a human reviewer and a future axis writer).
 */
const OFFICE_RE =
  /\b((?:U\.?S\.?\s+(?:Senate|House|Representative|Senator)|State (?:Senate|House|Assembly|Representative|Senator)|City Council|County Commission(?:er)?|School Board|Senate|House|Governor|Lieutenant Governor|Attorney General|Secretary of State|Treasurer|Auditor|Mayor)(?:\s+District\s+\d+)?|District\s+\d+|[A-Z][A-Za-z]+(?:'s)?\s+\d+(?:st|nd|rd|th)\s+(?:Congressional\s+)?District)\b/i;

/**
 * Lines that are pure page chrome (nav, donate, share, cookie, copyright). We drop
 * these before name extraction so they never propose a spurious candidate.
 */
const CHROME_LINE_RE =
  /\b(donate|subscribe|sign up|share this|follow us|cookie|privacy policy|terms of (?:use|service)|all rights reserved|copyright|menu|skip to (?:main|content)|read more|learn more|press release|paid for by)\b/i;

/**
 * Words that, when they are the WHOLE of a proposed name run, mark it as a section
 * header / org name / generic phrase rather than a person. This catches "Sierra
 * Club", "Endorsed Candidates", "State Senate District", "Gun Sense", etc. A real
 * candidate name almost never consists solely of these tokens. (The roster bind is
 * still the final precision gate; this just trims obvious page furniture.)
 */
const NON_NAME_TOKENS = new Set([
  'club', 'committee', 'fund', 'action', 'endorsed', 'endorsements', 'endorsement',
  'candidate', 'candidates', 'recommended', 'recommendations', 'scorecard', 'grades',
  'grade', 'rating', 'ratings', 'senate', 'house', 'assembly', 'district', 'state',
  'county', 'city', 'council', 'commission', 'commissioner', 'governor', 'mayor',
  'board', 'school', 'national', 'american', 'association', 'federation', 'union',
  'league', 'society', 'foundation', 'coalition', 'campaign', 'political', 'voters',
  'pac', 'office', 'race', 'election', 'cycle', 'meet', 'our', 'the', 'for', 'of',
  'and', 'sierra', 'everytown', 'safety', 'gun', 'sense', 'rifle', 'conservation',
  'chamber', 'commerce', 'education', 'planned', 'parenthood', 'rights', 'human',
  'realtors', 'farm', 'bureau', 'police', 'fraternal', 'order', 'life', 'right',
  'reproductive', 'freedom', 'all', 'champions', 'leaders', 'pro', 'choice',
]);

/**
 * isProbablyOrgOrSection: true when EVERY token of the proposed name is a generic
 * org / section word (a header, not a person). "Sierra Club" -> true; "Maria
 * Gonzalez" -> false; "James O'Brien" -> false.
 */
function isProbablyOrgOrSection(name: string): boolean {
  const toks = name
    .toLowerCase()
    .replace(/[^a-z\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (toks.length === 0) return true;
  return toks.every((t) => NON_NAME_TOKENS.has(t));
}

/**
 * lineProposesCandidates: a line is treated as a candidate ROW only when it shows
 * row evidence -- it carries a grade/status token OR an office/race token OR it is a
 * SHORT bare list entry (<= 6 words, the shape of a plain "Name" / "Name, Office"
 * endorsement list item). Prose sentences and long paragraphs are skipped so a
 * mention of the org or a sentence about "endorsed climate champions" does not
 * propose a person. Recall stays high (the roster bind is the precision gate); this
 * just keeps obvious non-rows out.
 */
function lineProposesCandidates(line: string): boolean {
  if (GRADE_RE.test(line) || OFFICE_RE.test(line)) return true;
  const wordCount = line.split(/\s+/).filter(Boolean).length;
  return wordCount > 0 && wordCount <= 6;
}

/**
 * splitIntoLines: reduce a fetched body (HTML or jina markdown) to candidate
 * lines. We do a dependency-free strip (the live jina tier already returns
 * markdown; raw HTML gets tags removed) then split on line breaks and on the
 * obvious list / table separators so each candidate ends up on its own line.
 */
function splitIntoLines(body: string): string[] {
  let t = body;
  // Drop smart_fetch banner + comments + script/style blocks.
  t = t.replace(/<!--[\s\S]*?-->/g, '\n');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // KEEP A ROW TOGETHER. A scorecard row is "<td>Name</td><td>Office</td><td>Grade</td>";
  // the name, office and grade must stay on ONE line so the grade/office regexes can
  // pick them up. So: cell closers (</td></th>) become a FIELD separator (a marker),
  // and only ROW/BLOCK closers (</tr></li></p></div><hN>) become line breaks. The
  // field marker is later collapsed to a space, so a single line carries the whole row.
  t = t.replace(/<\/(td|th)>/gi, ' ⦙ '); // dotted field separator marker
  t = t.replace(/<\/(li|tr|p|div|h[1-6]|table|ul|ol|section|article)>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<(li|tr|h[1-6])[^>]*>/gi, '\n');
  // Strip remaining tags.
  t = t.replace(/<[^>]+>/g, ' ');
  // Markdown list markers become line separators; table pipes become field markers
  // (markdown tables put name|office|grade on one line, which we want to keep).
  t = t.replace(/^\s*[-*+]\s+/gm, '\n');
  t = t.replace(/\|/g, ' ⦙ ');
  // Decode the few HTML entities that show up in names.
  t = t
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ');
  return t
    .split(/\r?\n/)
    // Collapse the field marker to a space so a whole row reads as one line.
    .map((l) => l.replace(/⦙/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

/**
 * parseEndorsementPage: turn a fetched endorsement / scorecard page body into
 * EndorsementRow[] -- one row per candidate the page lists. Deduped by (name,
 * office) so the same name appearing twice (e.g. in a header summary and the
 * table) yields one row. This is deliberately RECALL-leaning at the page-parse
 * step: the roster bind in the runner is the precision gate, so it is fine to
 * propose a few non-candidate names here -- they will simply fail to bind and be
 * held unattributed, never guessed onto a person.
 */
export function parseEndorsementPage(body: string): EndorsementRow[] {
  const lines = splitIntoLines(body);
  const rows: EndorsementRow[] = [];
  const seen = new Set<string>();
  const nameRe = new RegExp(NAME_RUN);

  for (const line of lines) {
    if (CHROME_LINE_RE.test(line)) continue;
    // Only mine lines that look like a candidate ROW (grade/office token or a short
    // bare list entry). Prose / headers are skipped.
    if (!lineProposesCandidates(line)) continue;

    // A typical row reads "Name [| Office] [| Grade]" in column order. Isolate the
    // candidate-NAME region as the text BEFORE the first office/grade token so a
    // greedy name match cannot swallow "County Commission District" into the name.
    const officeMatch = line.match(OFFICE_RE);
    const gradeMatch = line.match(GRADE_RE);
    const cutIdxs = [officeMatch?.index, gradeMatch?.index].filter(
      (i): i is number => typeof i === 'number',
    );
    const nameRegion = cutIdxs.length ? line.slice(0, Math.min(...cutIdxs)) : line;

    const nm = nameRegion.match(nameRe);
    if (!nm) continue;
    const name = nm[0].trim();
    // A name run that is ONLY office words or a section / org header is not a person.
    if (isProbablyOrgOrSection(name)) continue;

    const grade = gradeMatch ? gradeMatch[0].trim() : null;
    const office = officeMatch ? officeMatch[0].trim() : null;
    const key = `${name.toLowerCase()}|${(office ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ name, office, grade, raw: line.slice(0, 400) });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Fetch: the org's OWN endorsement page, via runPageFetch
// ---------------------------------------------------------------------------

/** The fetcher seam: returns the page body text for a URL, or null on failure. */
export type EndorsementFetcher = (url: string) => Promise<string | null>;

/**
 * The live default fetcher: runPageFetch (plain HTTP GET),
 * with the smart_fetch banner stripped. Never reimplements fetching. Returns null
 * on any failure / empty body so the parser yields zero units rather than throwing.
 */
const defaultFetcher: EndorsementFetcher = async (url: string) => {
  try {
    const res = await runPageFetch({ url });
    if (res.isError) return null;
    const text = res.content?.[0]?.text ?? '';
    if (!text.trim()) return null;
    // Strip the leading smart_fetch banner comment if present.
    return text.replace(
      /^<!--\s*smart_fetch:[^>]*-->\n?/,
      '',
    );
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// The SourceParser
// ---------------------------------------------------------------------------

/**
 * Resolve the org slug for a source. Priority:
 *   1. source.meta.org_slug (set at registration time -- the canonical path).
 *   2. fall back to matching the source URL's host against an org's
 *      endorsement_page / homepage host in the map.
 * Returns null when no org can be identified (the unit still stores the FACT, just
 * with no axis hint).
 */
function resolveOrgSlug(source: HarvestSource, map: OrgAxisMapFile): string | null {
  const fromMeta = (source.meta as { org_slug?: unknown } | null | undefined)?.org_slug;
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim();

  // Host-match fallback.
  const hostOf = (u: string | null | undefined): string | null => {
    if (!u) return null;
    try {
      return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  };
  const srcHost = hostOf(source.url);
  if (!srcHost) return null;
  for (const [slug, entry] of Object.entries(map.orgs)) {
    const ep = hostOf(entry.endorsement_page);
    const hp = hostOf(entry.homepage);
    if (ep === srcHost || hp === srcHost) return slug;
  }
  return null;
}

/**
 * The endorsement page URL to fetch:
 *   - source.url when set (the registered page);
 *   - else the mapped org's endorsement_page.
 */
function endorsementUrlFor(source: HarvestSource, orgSlug: string | null, map: OrgAxisMapFile): string | null {
  if (source.url && source.url.trim()) return source.url.trim();
  if (orgSlug) {
    const ep = map.orgs[orgSlug]?.endorsement_page;
    if (ep) return ep;
  }
  return null;
}

export const endorsementParser: SourceParser = {
  source_type: 'endorsement_org',

  async fetchAndParse(source: HarvestSource, deps: ParserDeps): Promise<ParsedUnit[]> {
    // Injected seams (tests stub these); live defaults otherwise.
    const d = deps as {
      orgAxisMapPath?: string;
      orgAxisMap?: OrgAxisMapFile;
      fetcher?: EndorsementFetcher;
      /** Test seam: feed a page body directly, skipping the fetch entirely. */
      pageBody?: string;
    };

    const map = d.orgAxisMap ?? loadOrgAxisMap(d.orgAxisMapPath);
    const orgSlug = resolveOrgSlug(source, map);
    const hint = axisHintsForOrg(orgSlug, map);

    // Fetch the org's own endorsement page (or use an injected body in tests).
    let body: string | null = d.pageBody ?? null;
    if (body == null) {
      const url = endorsementUrlFor(source, orgSlug, map);
      if (!url) return [];
      const fetcher = d.fetcher ?? defaultFetcher;
      body = await fetcher(url);
    }
    if (!body || !body.trim()) return [];

    const rows = parseEndorsementPage(body);
    if (rows.length === 0) return [];

    const orgDisplay = orgSlug ? (map.orgs[orgSlug]?.display_name ?? orgSlug) : null;
    const pageUrl = endorsementUrlFor(source, orgSlug, map) ?? (source.url ?? null);

    return rows.map((row): ParsedUnit => {
      // content: the endorsement / grade TEXT for this candidate (what the org
      // published about them). This is what hashes + dedups in the runner.
      const contentParts = [
        orgDisplay ? `${orgDisplay} endorsement.` : 'Endorsement.',
        row.grade ? `Grade/status: ${row.grade}.` : 'Listed as endorsed.',
        row.office ? `Office/race: ${row.office}.` : '',
        `Candidate: ${row.name}.`,
      ].filter(Boolean);
      const content = contentParts.join(' ');

      return {
        candidateMention: row.name,
        locus: {
          org: orgSlug ?? orgDisplay ?? null,
          page_url: pageUrl,
          row: row.raw,
          office: row.office,
          grade: row.grade,
        },
        content,
        source_family: ENDORSEMENT_SOURCE_FAMILY,
        signal_view: 'inferred',
        extra: {
          org_slug: orgSlug,
          org_display_name: orgDisplay,
          grade: row.grade,
          raw: row.raw,
          // The HELD org->axis hint: stored, NOT written as a real position yet.
          axis_hint_held: true,
          axis_hints: hint
            ? hint.hints.map((h) => ({
                axis: h.axis,
                direction: h.direction,
                strength: h.strength,
                editorial: hint.entry.editorial === true,
                held: hint.entry.held !== false,
              }))
            : [],
        },
      };
    });
  },
};

export default endorsementParser;
