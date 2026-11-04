/**
 * Commercial-use-OK source policy for body-research + per-candidate
 * scraping agents.
 *
 * Last full audit: 2026-05-27 — cross-checked against every source
 * Ballotpedia uses. See
 *   00-inbox/2026-05-27-ballotpedia-sources-audit.md          (their stack)
 *   00-inbox/2026-05-27-preapproved-candidate-scraping-sites.md (cross-check)
 *
 * Verified TOS posture:
 *  - Wikipedia (en.wikipedia.org): CC BY-SA 4.0 — commercial OK with
 *    attribution + share-alike. We attribute via citations[]; the share-
 *    alike obligation propagates only to substantial verbatim derivation
 *    (avoid quoting >280 chars).
 *  - US federal .gov (congress.gov, senate.gov, house.gov, whitehouse.gov,
 *    supremecourt.gov, census.gov, fec.gov, fjc.gov, regulations.gov, etc.):
 *    US Government work, public domain.
 *  - State / county / municipal .gov (and .us subdomains): public-record
 *    posture, no commercial-use restriction in practice.
 *  - OpenStates (https://openstates.org): ODbL — commercial OK with
 *    attribution + share-alike for data. Used as corroborating only, never
 *    primary (per 2026-05-26 directive).
 *
 * EXCLUDED (confirmed commercial-use restrictive):
 *  - ballotpedia.org: anti-scraping clause prohibits commercial automated
 *    extraction (Ballotpedia:Copyrights, accessed 2026-05-25).
 *  - opensecrets.org: CC BY-NC-SA 3.0 — non-commercial only. Use FEC + state
 *    CF systems directly instead. Confirmed 2026-05-27.
 *  - ontheissues.org: reproduction prohibited without written permission.
 *  - isidewith.com: direct voter-matching competitor; no public data terms.
 *  - billtrack50.com: commercial API. We route around via OpenStates.
 *  - ncsl.org: "All rights reserved" with no CC license.
 *  - statecourtreport.org / brennancenter.org: no public CC license.
 *  - Social media (twitter.com, facebook.com, instagram.com, youtube.com,
 *    linkedin.com, tiktok.com): ToS prohibits scraping. Agent never fetches.
 *  - Subscription / proprietary databases.
 *
 * PENDING-PERMISSION (must email source before building on it; not in this
 * allowlist until permission lands):
 *  - votesmart.org / api.votesmart.org (Vote Smart NPAT)
 *  - vote411.org / lwv.org (LWV Vote411 voter guide)
 *  - adambrown.info (BYU Utah legislator ideology)
 *  - data.stanford.edu (Bonica DIME / CFscores; verify commercial-use posture)
 *  - Debate/forum video archives (UDC, PBS Utah, C-SPAN where applicable)
 */

const PUBLIC_DOMAIN_FEDERAL_HOSTS = new Set([
  'congress.gov',
  'senate.gov',
  'house.gov',
  'bioguide.congress.gov',
  'whitehouse.gov',
  'supremecourt.gov',
  'census.gov',
  'fec.gov',
  'gpo.gov',
  'usa.gov',
  'data.gov',
  // Added 2026-05-27 after Ballotpedia-sourcing audit (see
  // 00-inbox/2026-05-27-preapproved-candidate-scraping-sites.md). FJC is the
  // Federal Judicial Center; their Biographical Directory of Article III
  // Federal Judges (1789–present) is US gov work, public domain. This is the
  // same source Ballotpedia uses for federal-judge coverage.
  'fjc.gov',
  // api.regulations.gov is the public-comment-period docket portal we use
  // via ingest-regulations Inngest function. Same federal-public-domain
  // posture as the rest of the .gov set.
  'regulations.gov',
]);

const CC_LICENSED_HOSTS = new Set([
  'en.wikipedia.org',
  'wikipedia.org',
  'openstates.org',
]);

// Forbidden hosts — explicit so the agent surfaces an error if it tries.
// Adds 2026-05-27 after the Ballotpedia-sourcing audit
// (00-inbox/2026-05-27-preapproved-candidate-scraping-sites.md):
//
//  - opensecrets.org: CC BY-NC-SA 3.0 (Non-Commercial). Commercial republication
//    requires a paid license per their bulk-data ToS. Use FEC + state CF
//    systems directly instead.
//  - ontheissues.org: footer reads "Reproduction of material from any
//    OnTheIssues.org pages without written permission is prohibited." No CC
//    grant. Read-only research at most.
//  - isidewith.com: direct competitor in the voter-matching space; no public
//    data terms. Audit Dataset 13.
//  - billtrack50.com: commercial API. Ballotpedia pays for it; we route around
//    via OpenStates (free, ODbL).
//
// These join the original entries: Ballotpedia (commercial-extraction ToS),
// NCSL (all rights reserved), statecourtreport.org / brennancenter.org (no
// public CC license), and the social platforms (ToS prohibits scraping).
const FORBIDDEN_HOSTS = new Set([
  'ballotpedia.org',
  'ncsl.org',
  'statecourtreport.org',
  'brennancenter.org',
  'opensecrets.org',
  'ontheissues.org',
  'isidewith.com',
  'billtrack50.com',
  'twitter.com', 'x.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'linkedin.com',
  'tiktok.com',
]);

// Official primary hosts that are neither .gov/.us nor CC-licensed but ARE the
// authoritative source for a body — chiefly TERRITORY legislatures, which run on
// .org/.com rather than .gov. CURATED + REVIEWED per the spend-efficiency upgrade
// plan (#5, convert partial→verified): each entry is confirmed the official site
// of the body, never auto-added, so a spoofed lookalike can't slip in.
//
// Without this, a legitimate territory legislature run (e.g. the US Virgin
// Islands Senate) spends real agent time, then gets its only primary citation
// rejected and is overridden to unverified — paying for a partial instead of a
// verified result (observed 2026-06-02: legvi.org rejected).
//
// To add a host: confirm by fetching it that it's the official site of the body
// (the body's own roster/members page), then add it here with the date + body.
const OFFICIAL_PRIMARY_HOSTS = new Set([
  'legvi.org',            // Legislature of the U.S. Virgin Islands (confirmed 2026-06-02, legvi.org/senator/)
  // Utah school districts + small cities on .org/.us domains (2026-06-04):
  // the Opus agent extracted Jordan SD's full 7-member roster from the
  // district's own official site and the gate rejected it ("not on
  // allowlist: jordandistrict.org") — paying for a partial instead of a
  // verified. Each host below was operator-verified in-browser and/or direct-
  // fetched this session (full member rosters seen).
  'jordandistrict.org',     // Jordan School District Board of Education (/board/, 7 members w/ districts)
  'pcschools.us',           // Park City School District Board (/board-of-education, 5 members w/ precincts)
  'ccsdut.org',             // Cache County School District Board (/board-of-education/board-members)
  'ssanpete.org',           // South Sanpete School District Board (/district-information/board-of-education/members.html)
  'gunnisoncityutah.org',   // Gunnison City mayor & council (operator: gunnisoncity.org is dead; this is the real site)
  'monticelloutah.org',     // Monticello City official site (operator-verified)
  'castlevalleyutah.com',   // Town of Castle Valley official site (eyes-on 2026-06-04: contacts page names Mayor Jazmine Duncan)
  // TODO (review each before adding — do not guess the domain):
  //   Guam Legislature, CNMI Legislature, American Samoa Fono, Puerto Rico
  //   (PR uses *.pr.gov which already passes the .gov check).
  // STRUCTURAL TODO (logged in pending-decisions): a domain stored in
  // primary_source_urls as an operator-verified roster for a body should
  // count as primary for THAT body's citations automatically — the curated
  // set here doesn't scale to 13K school districts.
]);

// ── Per-body trusted hosts (2026-06-04, Utah lessons-learned) ─────────────
// A roster URL stored in primary_source_urls was operator-verified as the
// body's OFFICIAL site — so citations from that same host are primary FOR
// THAT BODY, even on .org/.com/.us domains the global rules can't bless.
// Utah cost: Jordan SD's full 7-member roster (jordandistrict.org) and Park
// City's (pcschools.us) were extracted by Opus and then REJECTED by the
// curated allowlist — paying for partials. A hand-curated host list cannot
// scale to 13K school districts; the PSU table is the per-body trust store.
// The write path registers the body's PSU roster host before validating its
// citations and clears afterwards. Module-level is safe: each research
// process validates one body at a time, and every caller re-registers.
let SESSION_TRUSTED_HOSTS: Set<string> = new Set();
export function setBodyTrustedHosts(hosts: string[] | null): void {
  SESSION_TRUSTED_HOSTS = new Set(
    (hosts ?? [])
      .map((h) => {
        try { return new URL(h).hostname.toLowerCase().replace(/^www\./, ''); }
        catch { return h.toLowerCase().replace(/^www\./, ''); }
      })
      .filter(Boolean),
  );
}

export function isSourceAllowed(urlOrHost: string | null | undefined): { allowed: boolean; reason: string } {
  if (!urlOrHost || typeof urlOrHost !== 'string') {
    return { allowed: false, reason: 'no URL provided' };
  }
  let host: string;
  try {
    host = new URL(urlOrHost).hostname.toLowerCase();
  } catch {
    // Treat raw host string
    host = urlOrHost.toLowerCase();
  }
  // strip leading www.
  if (host.startsWith('www.')) host = host.slice(4);

  if (FORBIDDEN_HOSTS.has(host)) {
    return { allowed: false, reason: `forbidden source (commercial-use prohibited): ${host}` };
  }

  // Per-body trusted host (operator-verified PSU roster domain).
  if (SESSION_TRUSTED_HOSTS.has(host)) {
    return { allowed: true, reason: `operator-verified roster host for this body (primary_source_urls): ${host}` };
  }

  // Curated official non-.gov primary hosts (territory legislatures, etc.)
  if (OFFICIAL_PRIMARY_HOSTS.has(host)) {
    return { allowed: true, reason: `official primary host (curated): ${host}` };
  }

  // Public-domain federal .gov
  if (PUBLIC_DOMAIN_FEDERAL_HOSTS.has(host)) {
    return { allowed: true, reason: `federal .gov (public domain): ${host}` };
  }

  // CC-licensed
  if (CC_LICENSED_HOSTS.has(host)) {
    return { allowed: true, reason: `CC-licensed: ${host}` };
  }

  // .gov / .us suffix — state/local government
  // Match third-level domains like state.ut.us, utah.gov, sos.ca.gov, etc.
  if (/\.(gov|us)$/.test(host) || /^(.+\.)?(gov|us)$/.test(host)) {
    return { allowed: true, reason: `government domain (public-record posture): ${host}` };
  }

  // Curated .org / .com / .net hosts for municipal + school primary
  // sources (see PRIMARY_HOST_PATTERNS below). The allowlist must stay
  // consistent with classifySourceTier — if we call a host "primary" for
  // verification, we have to let citations to it through the gatekeeper.
  if (PRIMARY_HOST_PATTERNS.some((p) => p.test(host))) {
    return { allowed: true, reason: `municipal/school primary host pattern: ${host}` };
  }

  return { allowed: false, reason: `not on allowlist: ${host}` };
}

export function classifySourceKind(urlOrHost: string): string {
  try {
    const host = new URL(urlOrHost).hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'en.wikipedia.org' || host === 'wikipedia.org') return 'wikipedia';
    if (host === 'openstates.org') return 'openstates';
    if (PUBLIC_DOMAIN_FEDERAL_HOSTS.has(host)) return 'gov_federal';
    if (/\.state\.[a-z]{2}\.us$/.test(host)) return 'gov_state';
    if (/\.(gov|us)$/.test(host)) return 'gov_other';
  } catch { /* fallthrough */ }
  return 'other';
}

/**
 * Source tier — the trust posture introduced 2026-05-26 after the audit
 * found 64 hallucinated authoritative=true bodies.
 *
 * - 'primary': the source IS the authority for the fact (federal .gov for
 *   federal bodies, state .gov for state, county .gov for county, city
 *   charter/.gov for municipal). Required for size_authoritative=true.
 *
 * - 'corroborating': supports cross-checking but is NEVER the source of
 *   truth (Wikipedia, OpenStates, NCES district directory used as discovery
 *   only, etc.). Per user directive 2026-05-26: Wikipedia/OpenStates can
 *   only corroborate or help us *discover* a primary URL.
 *
 * - 'excluded': forbidden hosts (Ballotpedia, NCSL, social media, etc.).
 *
 * - 'unknown': not on our maps. Treated as excluded for authoritative
 *   purposes; surfaces as a warning.
 *
 * Notes on municipal .org / .com handling:
 *   Many US cities run their official sites on .org or .com (slcgov.com,
 *   cityofchicago.org, boisecity.org). The allowlist must accept these as
 *   primary when they look like city/town hosts. We use a conservative
 *   pattern set rather than a blanket open door, because spam .com sites
 *   exist. See MUNICIPAL_PRIMARY_PATTERNS below.
 */
export type SourceTier = 'primary' | 'corroborating' | 'excluded' | 'unknown';

/**
 * Patterns we trust as municipal/county primary hosts even on .org or .com.
 * Conservative: must look like an obvious government identifier. Update as
 * we encounter real-world hosts.
 */
const MUNICIPAL_PRIMARY_PATTERNS: RegExp[] = [
  /^cityof[a-z]+\.(org|com|net)$/,         // cityofchicago.org, cityofboise.com
  /^[a-z]+gov\.(org|com|net)$/,            // slcgov.com, nycgov.com
  /^[a-z]+city\.(org|com|net)$/,           // boisecity.org, kansascity.org
  /^cityof[a-z]+\.gov$/,                   // any cityof*.gov
  /^[a-z]+\.[a-z]{2}\.gov$/,               // slc.ut.gov-style nesting
  /^[a-z]+county\.(org|com|gov)$/,         // [name]county.org etc.
  /^[a-z]+countygov\.(org|com)$/,
  /^[a-z]+twp\.(org|com|gov)$/,            // [name]twp.org (townships)
  /^[a-z]+township\.(org|com|gov)$/,
  /^townof[a-z]+\.(org|com|gov)$/,
  /^villageof[a-z]+\.(org|com|gov)$/,
  /^boroughof[a-z]+\.(org|com|gov)$/,
];

/**
 * Patterns we trust as school-district primary hosts. NCES district codes
 * are public-domain federal but the actual rosters live at district .org /
 * .net / .k12.<state>.us.
 */
const SCHOOL_PRIMARY_PATTERNS: RegExp[] = [
  /\.k12\.[a-z]{2}\.us$/,                  // standard state K-12 pattern
  /^[a-z]+schools\.(org|net)$/,            // slcschools.org, denverschools.org
  /^[a-z]+sd\.(org|net|gov)$/,             // [name]sd.org school district
  /^[a-z]+isd\.(org|net|gov)$/,            // [name]isd (independent SD, TX common)
  /^[a-z]+esd\.(org|net|gov)$/,            // educational service district
  /^[a-z]+psd\.(org|net|gov)$/,            // public school district
];

const PRIMARY_HOST_PATTERNS: RegExp[] = [
  ...MUNICIPAL_PRIMARY_PATTERNS,
  ...SCHOOL_PRIMARY_PATTERNS,
];

/**
 * Optional jurisdiction hint biases tiering. For a state body, hostnames
 * matching `*.utah.gov` are primary; for a municipal body in Utah, the
 * city's own host (slc.gov, slcgov.com) is primary while utah.gov is only
 * corroborating. Without a hint, we use the conservative "any .gov / .us
 * is primary; explicit .org/.com patterns above; rest is corroborating
 * or excluded."
 */
export function classifySourceTier(
  urlOrHost: string | null | undefined,
  _jurisdictionHint?: { level?: 'federal' | 'state' | 'county' | 'municipal' | 'school' | 'special_district' | 'judicial'; fips_state?: string | null },
): SourceTier {
  if (!urlOrHost || typeof urlOrHost !== 'string') return 'excluded';
  let host: string;
  try {
    host = new URL(urlOrHost).hostname.toLowerCase();
  } catch {
    host = urlOrHost.toLowerCase();
  }
  if (host.startsWith('www.')) host = host.slice(4);

  if (FORBIDDEN_HOSTS.has(host)) return 'excluded';

  // Per-body trusted host (operator-verified PSU roster domain) — primary.
  if (SESSION_TRUSTED_HOSTS.has(host)) return 'primary';

  // Curated official non-.gov primary hosts (territory legislatures, etc.) —
  // the authoritative source for their body, so they tier as primary.
  if (OFFICIAL_PRIMARY_HOSTS.has(host)) return 'primary';

  // Wikipedia + OpenStates are corroborating ONLY (user directive 2026-05-26).
  if (CC_LICENSED_HOSTS.has(host)) return 'corroborating';

  // Federal public-domain hosts are always primary for federal bodies and
  // corroborating for sub-federal bodies. We approximate by treating them
  // as primary regardless (federal .gov is the canonical source for federal
  // bodies, and for sub-federal bodies it's at least an authoritative
  // federal listing — still a primary record of the entity's existence).
  if (PUBLIC_DOMAIN_FEDERAL_HOSTS.has(host)) return 'primary';

  // Any .gov is primary (state, county, municipal all use these).
  if (host.endsWith('.gov')) return 'primary';

  // .us with a state component (state.ut.us, ci.salt-lake-city.ut.us etc.)
  // is primary. Bare .us is corroborating (some marketing sites use .us).
  if (/\.[a-z]{2}\.us$/.test(host)) return 'primary';
  if (host.endsWith('.us')) return 'corroborating';

  // .org / .com / .net — require explicit pattern match to be primary.
  if (PRIMARY_HOST_PATTERNS.some((p) => p.test(host))) return 'primary';

  // Everything else: unknown. Caller can choose to log + treat as excluded.
  return 'unknown';
}

/**
 * Convenience: count primary citations in a list. Use in write.ts to gate
 * size_authoritative=true on at least one primary citation.
 */
export function countPrimaryCitations(
  citations: Array<{ url?: string | null }> | null | undefined,
  jurisdictionHint?: Parameters<typeof classifySourceTier>[1],
): number {
  if (!Array.isArray(citations)) return 0;
  let n = 0;
  for (const c of citations) {
    if (classifySourceTier(c.url, jurisdictionHint) === 'primary') n++;
  }
  return n;
}
