/**
 * harvest-targeting.ts -- SMARTER HARVEST TARGETING for the discover stage.
 *
 * WHY THIS EXISTS (2026-07-02). The overnight AZ run fetched 594 candidate URLs;
 * ~334 of them were social-profile AUTH WALLS (Facebook "This content isn't
 * available right now" / "Log into Facebook", X "Log in / Sign up" chrome with no
 * post body, Instagram CAPTCHA stubs, LinkedIn login gates) and most of the rest
 * were BARE HOMEPAGES or donation pages -- while the actual policy prose lives on
 * unfetched /issues, /platform, /priorities subpages. The phi4 extractor
 * (abstain-not-guess) correctly returns nothing on that junk, so HARVEST TARGETING
 * is the throughput ceiling for position coverage. This module fixes targeting:
 *
 *   (a) detectAuthWall  -- recognize an auth-gated / CAPTCHA / "content
 *       unavailable" social stub from its extracted_text so the row is marked
 *       junk and never counted as usable positioning evidence. Built from the
 *       actual 334 rows (see the signature comments on each pattern).
 *
 *   (b) policySubpathCandidates + extractNavPolicyLinks -- given a candidate
 *       campaign site, produce the policy-bearing subpages to fetch: a curated
 *       list of common policy paths (/issues, /platform, /priorities, ...) PLUS
 *       any policy-ish nav anchors parsed out of a fetched page body. Real AZ
 *       candidate sites use BOTH conventions: WordPress builds expose /issues;
 *       Squarespace builds use custom paths like /amelias-priorities that are
 *       ONLY discoverable by parsing the nav.
 *
 *   (c) prioritizeSources -- order a discovered source list so batch composition
 *       is candidate_site issues-subpage > candidate_site other > news > social.
 *
 * PURE + TOTAL. No network, no DB, no model. Every function is deterministic and
 * unit-tested (harvest-targeting.test.ts). The discover stage (discover-sources.ts
 * / discover-and-ingest.ts) calls these; it still does all fetching through the
 * existing page fetch, never a new fetcher.
 *
 * Single TypeScript runtime, no Python (architecture rule).
 */

// ---------------------------------------------------------------------------
// (a) AUTH-WALL / CAPTCHA / "content unavailable" DETECTION
// ---------------------------------------------------------------------------

/**
 * The social platforms whose profile pages are auth-gated and therefore prone to
 * returning a login wall / CAPTCHA stub instead of content. Matched against the
 * registrable domain (endsWith), so www./m. subdomains are covered.
 */
export const AUTH_GATED_SOCIAL_DOMAINS: readonly string[] = [
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'linkedin.com',
  'tiktok.com',
];

/**
 * Login-wall / CAPTCHA / "content unavailable" text signatures, each pulled
 * VERBATIM from the extracted_text of the real overnight AZ rows (2026-07-02).
 * A match means the fetched artifact is an auth wall, NOT candidate content.
 *
 * Deliberately specific: these are boilerplate strings the platforms serve to
 * unauthenticated readers, not phrases a candidate would write. Grouped by the
 * row family each was observed in.
 */
export const AUTH_WALL_SIGNATURES: readonly RegExp[] = [
  // Facebook "content unavailable" wall (10 rows): the profile is private /
  // deleted / restricted to logged-in viewers.
  /This content isn't available right now/i,
  /When this happens, it's usually because the owner only shared it/i,
  // Facebook login wall (5 rows): "Explore the things you love / Log into
  // Facebook / Email or mobile number / Password".
  /Log into Facebook/i,
  /Explore the things you love/i,
  // Instagram "profile unavailable" wall (7 rows): "Profile isn't available /
  // The link may be broken, or the profile may have been removed. / Sign up for
  // Instagram". These carry no candidate content by construction.
  /Profile isn't available/i,
  /profile may have been removed/i,
  /Sign up for Instagram/i,
  // X / Twitter login wall (92 rows): the onboarding Log in / Sign up chrome.
  // The mode=login + mode=signup pair is the unambiguous fingerprint (a real
  // scraped profile carries the same chrome, so this pattern is necessary but
  // NOT sufficient -- see isAuthWallStub below, which also requires thin body).
  /onboarding\/web\?mode=login/i,
  // Instagram / generic Jina CAPTCHA warning (72 rows): the Reader could not
  // get past the interstitial and returned an empty Markdown Content body.
  /This page maybe requiring CAPTCHA/i,
  // Generic login/sign-up affordance text seen across the walls.
  /\bLog In\b[\s\S]{0,40}\bSign [Uu]p\b/,
  /\bForgot [Pp]assword\?/,
  /\bForgot [Aa]ccount\?/,
];

/**
 * Minimum length of REAL content (after the Jina "Markdown Content:" preamble)
 * for an auth-gated social page to count as having usable body rather than being
 * a pure stub. Calibrated from the data: Instagram/LinkedIn CAPTCHA rows carry
 * < 40 chars after the preamble; a genuinely-scraped X profile (bio + posts)
 * carries thousands. 200 is a safe floor that keeps real bios (e.g. a typical
 * candidate X profile, ~1.3K chars of bio + post prose) while dropping stubs.
 */
export const AUTH_WALL_MIN_BODY_LEN = 200;

/** Strip the Jina Reader preamble ("Title: ... URL Source: ... Markdown Content:") so we measure only the actual page body. */
export function stripJinaPreamble(text: string): string {
  if (!text) return '';
  const idx = text.indexOf('Markdown Content:');
  const body = idx >= 0 ? text.slice(idx + 'Markdown Content:'.length) : text;
  return body.replace(/\s+/g, ' ').trim();
}

export interface AuthWallVerdict {
  /** True when the row is an auth wall / CAPTCHA / unavailable stub with no usable content. */
  isAuthWall: boolean;
  /** Machine-stable reason tag for provenance / the reset script. */
  reason:
    | 'ok'
    | 'fb_unavailable'
    | 'fb_login'
    | 'ig_unavailable'
    | 'x_login_stub'
    | 'captcha_stub'
    | 'linkedin_blocked'
    | 'login_affordance_stub'
    | 'not_social';
}

/** The registrable domain (or full host) is an auth-gated social platform. */
export function isAuthGatedSocialDomain(hostOrRegistrable: string | null | undefined): boolean {
  if (!hostOrRegistrable) return false;
  const h = hostOrRegistrable.toLowerCase();
  return AUTH_GATED_SOCIAL_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

/**
 * detectAuthWall(extractedText, opts): classify a fetched social row as an auth
 * wall / CAPTCHA / "content unavailable" stub vs. a page that actually carries
 * body content.
 *
 * Decision rule:
 *   - If the domain is known and NOT an auth-gated social platform, never an
 *     auth wall (reason 'not_social') -- a candidate's own campaign site is never
 *     flagged here even if it happens to contain the word "Log In".
 *   - Facebook "content unavailable" and "Log into Facebook" walls are auth walls
 *     outright (they carry no candidate content by construction).
 *   - The X login chrome and the generic Log-In/Sign-Up affordance are auth walls
 *     ONLY when the residual body (after the Jina preamble) is below
 *     AUTH_WALL_MIN_BODY_LEN. This is the crucial guard: ~90% of X rows carry the
 *     login chrome AT THE TOP but still have a real bio + posts below it; those
 *     must NOT be discarded. Only the thin stubs are junk.
 *   - The CAPTCHA warning with an empty body is an auth wall (Jina got walled).
 *
 * Pure + total. `domain` is optional; when omitted we skip the not_social short
 * circuit and judge purely on text (so a caller that only has the text can still
 * use it).
 */
export function detectAuthWall(
  extractedText: string | null | undefined,
  opts: { domain?: string | null } = {},
): AuthWallVerdict {
  const text = extractedText ?? '';
  const domain = opts.domain ?? null;

  // A known non-social domain is never an auth wall here.
  if (domain && !isAuthGatedSocialDomain(domain)) {
    return { isAuthWall: false, reason: 'not_social' };
  }

  // Facebook "content unavailable" -- no body by construction.
  if (
    /This content isn't available right now/i.test(text) ||
    /When this happens, it's usually because the owner only shared it/i.test(text)
  ) {
    return { isAuthWall: true, reason: 'fb_unavailable' };
  }

  // Facebook login wall -- "Log into Facebook" / "Explore the things you love".
  if (/Log into Facebook/i.test(text) || /Explore the things you love/i.test(text)) {
    return { isAuthWall: true, reason: 'fb_login' };
  }

  // Instagram "profile unavailable" wall -- no body by construction. Fire
  // regardless of length (the stub prose can exceed the thin-body floor).
  if (
    /Profile isn't available/i.test(text) ||
    /profile may have been removed/i.test(text) ||
    /Sign up for Instagram/i.test(text)
  ) {
    return { isAuthWall: true, reason: 'ig_unavailable' };
  }

  const body = stripJinaPreamble(text);
  const thin = body.length < AUTH_WALL_MIN_BODY_LEN;

  // LinkedIn block -- Jina reports "error 999" (LinkedIn's anti-bot code) and
  // returns an empty body. A candidate's LinkedIn is never usable evidence here.
  if (/error 999/i.test(text) && thin) {
    return { isAuthWall: true, reason: 'linkedin_blocked' };
  }

  // CAPTCHA warning -- Jina got walled; the body is empty for these rows.
  if (/This page maybe requiring CAPTCHA/i.test(text) && thin) {
    return { isAuthWall: true, reason: 'captcha_stub' };
  }

  // X / Twitter login chrome -- ONLY a wall when the body is thin (a real
  // profile keeps the same chrome but has a substantial bio + posts below).
  if (/onboarding\/web\?mode=login/i.test(text) && thin) {
    return { isAuthWall: true, reason: 'x_login_stub' };
  }

  // Generic login/sign-up or forgot-password/account affordance with a thin
  // body (the "Log In / Sign up / Forgot Account?" family named in the brief).
  if (
    thin &&
    (/\bLog In\b[\s\S]{0,40}\bSign [Uu]p\b/.test(text) ||
      /\bForgot [Pp]assword\?/.test(text) ||
      /\bForgot [Aa]ccount\?/.test(text))
  ) {
    return { isAuthWall: true, reason: 'login_affordance_stub' };
  }

  return { isAuthWall: false, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// (b) POLICY-SUBPAGE DISCOVERY
// ---------------------------------------------------------------------------

/**
 * Common policy-bearing subpage paths on candidate campaign sites, ordered
 * best-first. Derived from what real AZ candidate sites actually use (probed
 * 2026-07-02): WordPress builds expose /issues, /platform, /about; many use
 * /priorities or /on-the-issues; /vision and /where-i-stand appear too. These
 * are PROBE candidates -- a site that soft-404s the path just yields no new
 * content (the ledger dedups the soft-404 template; the extractor abstains), so
 * over-probing is cheap and safe. Squarespace/Wix custom paths (e.g.
 * /amelias-priorities) are NOT in this list -- those are caught by nav parsing.
 */
export const POLICY_SUBPATHS: readonly string[] = [
  '/issues',
  '/platform',
  '/priorities',
  '/on-the-issues',
  '/where-i-stand',
  '/vision',
  '/about',
  '/policy',
  '/policies',
  '/positions',
  '/plan',
  '/agenda',
];

/**
 * Anchor-text / path tokens that mark a NAV LINK as policy-bearing. Used by
 * extractNavPolicyLinks to keep only the links worth fetching as positioning
 * evidence and drop chrome (Donate, Events, Volunteer, Contact, Store, Cart).
 */
const POLICY_LINK_TOKENS: RegExp[] =
  [
    /\bissues?\b/i,
    /\bplatform\b/i,
    /\bpriorit/i, // priorities / priority
    /\bpolic/i, // policy / policies
    /\bpositions?\b/i,
    /\bon the issues\b/i,
    /\bwhere .* stands?\b/i,
    /\bvision\b/i,
    /\bagenda\b/i,
    /\bplan\b/i,
    /\babout\b/i, // about pages often carry biographical stance prose
    /\bmeet\b/i, // "Meet <name>" bio pages carry biographical stance prose
    /\bmy (?:plan|vision|priorities|values)\b/i,
    /\bvalues\b/i,
  ];

/** Chrome link tokens we always drop even if a weak policy token also matched. */
const CHROME_LINK_TOKENS: RegExp[] = [
  /\bdonate\b/i,
  /\bcontribute\b/i,
  /\bvolunteer\b/i,
  /\byard sign/i,
  /\bevents?\b/i,
  /\bcontact\b/i,
  /\bstore\b/i,
  /\bcart\b/i,
  /\bshop\b/i,
  /\bmerch\b/i,
  /\bsign ?up\b/i,
  /\bsubscribe\b/i,
  /\bmailing list\b/i,
  /\bhome\b/i,
  /\bskip to\b/i,
  /\blog ?in\b/i,
  // Legal / site chrome that superficially matches the "polic" token but is
  // never candidate positioning content (privacy-policy, cookie-policy, terms).
  /\bprivacy\b/i,
  /\bcookie/i,
  /\bterms\b/i,
  /\bterms[- ]?(?:of[- ]?service|and[- ]?conditions)\b/i,
  /\bdisclaimer\b/i,
  /\baccessibility\b/i,
];

/** File extensions that are never policy pages (assets). */
const ASSET_EXT_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|pdf|css|js|mp4|mov|zip|xml|json|woff2?|ttf)(\?|#|$)/i;

/**
 * True when an anchor (text + resolved path) looks like a policy-bearing link.
 * Requires a policy token in EITHER the visible text OR the URL path, and no
 * chrome token. Exported for the unit test.
 */
export function isPolicyNavLink(text: string, path: string): boolean {
  const hay = `${text} ${path}`;
  // Chrome tokens are checked against BOTH the visible text AND the path so a
  // link with empty anchor text (e.g. an icon link to /privacy-policy) is still
  // rejected by its path.
  if (CHROME_LINK_TOKENS.some((re) => re.test(hay))) return false;
  return POLICY_LINK_TOKENS.some((re) => re.test(hay));
}

/**
 * Normalize a path for dedup + probing: lowercase, strip a trailing slash on a
 * non-root path, drop the fragment/query. Root stays '/'.
 */
export function normalizePath(pathname: string): string {
  let p = (pathname || '/').split('#')[0].split('?')[0].toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (!p.startsWith('/')) p = '/' + p;
  return p || '/';
}

/**
 * extractNavPolicyLinks(body, baseUrl): parse a fetched page body (Jina markdown
 * OR raw HTML) for SAME-SITE policy-bearing nav links and return their absolute,
 * canonical URLs. This is what catches builder-custom paths (Squarespace's
 * /amelias-priorities, /about-amelia) that a fixed path list can never guess.
 *
 * Matches BOTH markdown links `[text](url)` and HTML anchors `<a href="url">text`.
 * Keeps only links whose host is the same registrable site as baseUrl, drops
 * asset URLs and chrome links, dedups by normalized path, and excludes the home
 * page itself. Total: a malformed link is skipped, never thrown.
 */
export function extractNavPolicyLinks(body: string, baseUrl: string): string[] {
  if (!body) return [];
  let baseHost: string;
  let baseReg: string;
  try {
    baseHost = new URL(baseUrl).hostname.toLowerCase();
    baseReg = baseHost.replace(/^www\./, '');
  } catch {
    return [];
  }

  const found = new Map<string, string>(); // normalizedPath -> absolute url

  const consider = (rawText: string, rawHref: string): void => {
    if (!rawHref) return;
    let abs: URL;
    try {
      abs = new URL(rawHref, baseUrl);
    } catch {
      return;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
    const host = abs.hostname.toLowerCase();
    if (host.replace(/^www\./, '') !== baseReg) return; // same-site only
    if (ASSET_EXT_RE.test(abs.pathname + abs.search)) return;
    const path = normalizePath(abs.pathname);
    if (path === '/') return; // never re-add the home page
    const text = (rawText || '').replace(/[#*_`>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!isPolicyNavLink(text, path)) return;
    // Rebuild a clean absolute URL (origin + normalized path, no fragment/query).
    const clean = `${abs.protocol}//${abs.host}${path}`;
    if (!found.has(path)) found.set(path, clean);
  };

  // Markdown links: [text](href)
  for (const m of body.matchAll(/\[([^\]]{0,80})\]\(([^)\s]+)\)/g)) {
    consider(m[1], m[2]);
  }
  // HTML anchors: <a ... href="href" ...>text</a>
  for (const m of body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const inner = m[2].replace(/<[^>]+>/g, ' ');
    consider(inner, m[1]);
  }

  return Array.from(found.values());
}

/**
 * policySubpathCandidates(siteUrl): the curated common policy paths joined onto a
 * candidate site's origin, as absolute canonical URLs. These are PROBE targets;
 * the caller fetches them through the normal ingest path and lets soft-404 dedup
 * / extractor-abstain handle any that do not exist. Excludes the origin itself.
 *
 * Total: a malformed siteUrl returns []. Deduped, origin-scoped.
 */
export function policySubpathCandidates(siteUrl: string): string[] {
  let origin: string;
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of POLICY_SUBPATHS) {
    const url = origin + p;
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// (c) BATCH PRIORITIZATION
// ---------------------------------------------------------------------------

/**
 * The priority tiers for batch composition (lower number = fetched first):
 *   0  candidate_site issues/policy SUBPAGE  (the highest-yield positioning evidence)
 *   1  candidate_site other (homepage, about, etc.)
 *   2  news / video_transcript / other non-social
 *   3  social
 * Exported so the test and the caller share the vocabulary.
 */
export const HARVEST_PRIORITY = {
  site_policy_subpage: 0,
  site_other: 1,
  news: 2,
  social: 3,
} as const;

export type HarvestPriority = (typeof HARVEST_PRIORITY)[keyof typeof HARVEST_PRIORITY];

/** True when a URL path is a policy subpage (issues/platform/priorities/...). */
export function isPolicySubpageUrl(url: string): boolean {
  let path: string;
  try {
    path = normalizePath(new URL(url).pathname);
  } catch {
    return false;
  }
  if (path === '/') return false;
  return isPolicyNavLink('', path);
}

/**
 * harvestPriorityOf(source): assign a priority tier to a discovered source based
 * on its source_family and URL shape. `source_family` follows the pipeline
 * vocabulary ('candidate_site' | 'social' | 'news' | 'video_transcript' | ...).
 * Pure.
 */
export function harvestPriorityOf(source: {
  url: string;
  source_family?: string | null;
}): HarvestPriority {
  const fam = (source.source_family ?? '').toLowerCase();
  if (fam === 'social') return HARVEST_PRIORITY.social;
  if (fam === 'candidate_site') {
    return isPolicySubpageUrl(source.url)
      ? HARVEST_PRIORITY.site_policy_subpage
      : HARVEST_PRIORITY.site_other;
  }
  if (fam === 'news') return HARVEST_PRIORITY.news;
  // video_transcript and anything else rank alongside news (non-social content).
  return HARVEST_PRIORITY.news;
}

/**
 * prioritizeSources(sources): STABLE-sort a discovered source list so batch
 * composition reflects candidate_site policy-subpage > candidate_site other >
 * news > social. Ties keep their original relative order (stable), so within a
 * tier the discovery order (highest bind_confidence first, as discover-sources
 * already yields) is preserved. Does not mutate the input.
 */
export function prioritizeSources<T extends { url: string; source_family?: string | null }>(
  sources: readonly T[],
): T[] {
  return sources
    .map((s, i) => ({ s, i, p: harvestPriorityOf(s) }))
    .sort((a, b) => (a.p !== b.p ? a.p - b.p : a.i - b.i))
    .map((x) => x.s);
}
