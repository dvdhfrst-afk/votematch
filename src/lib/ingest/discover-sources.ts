/**
 * discover-sources.ts -- aggregator-free SOURCE DISCOVERY for a person already
 * in the database.
 *
 * SCOPE (read this first). This module surfaces ONLY the approved-source URLs
 * (uniform resource locators) ALREADY ATTRIBUTED to a given person in our own
 * database: the person's stored website, the contact-field rows we already
 * captured, the candidacy filing fields, the votesearch state-portal profile,
 * and the legacy candidate_sources rows. Because each of these URLs was already
 * linked to this specific person_id by an earlier authoritative step (a filing
 * row, a verified contact field, a state-portal profile), the bind back to that
 * person is AUTHORITATIVE -- hence the high bind_confidence values below.
 *
 * What this module does (ADDED): active web-search discovery of NEW, previously
 * unknown owned sources for a person who has NO attributed source yet, via
 * discoverActiveForPerson at the bottom of this file. It stays AGGREGATOR-FREE:
 * it never pulls from Ballotpedia, Vote411, BallotReady, iSideWith, Vote Smart,
 * On The Issues, Vote Compass, or any of the denylisted sources in raw-ingest.ts
 * (the same DENYLIST gates both halves of this module).
 *
 * Aggregator-free guarantee, here: every discovered URL is run through the same
 * canonicalizeUrl + DENYLIST used by the ingest pipeline, so a denylisted domain
 * that somehow got attributed to a person (a stale legacy candidate_sources row
 * pointing at ballotpedia, say) is DROPPED at discovery time and never enqueued.
 *
 * Resilience: the live local Postgres schema has evolved past several of the
 * tables/columns this module reads (candidate_sources.source_type was migrated
 * from the pre-007 ('campaign_website'|'state_profile') enum to the post-007
 * ('website' + source_subtype) taxonomy; candidacies.website / .campaign_email
 * were added later; candidate_contact_fields is newer still). To avoid guessing
 * which migration the live DB is at, every source probes information_schema for
 * the table + the exact columns it needs FIRST and skips gracefully (no throw,
 * no partial query) when something is absent. One missing table never aborts
 * discovery.
 *
 * Single TypeScript runtime, no Python (architecture rule). Takes a structural
 * query client so the dispatching script can pass a pg Client and tests can pass
 * a stub.
 */

import type { QueryResultRow } from 'pg';
import { canonicalizeUrl, isDenied, registrableDomainOf } from '@/lib/ingest/raw-ingest';
import { search as searchBackend, buildCampaignQueries, type SearchResult } from '@/lib/ingest/search-backend';
import { verifyDomain, type DomainConfirmation } from '@/lib/ingest/domain-verify';
import {
  relMeLoop,
  blueskyProfile,
  youtubeChannel,
  resolvePublishedHandle,
  corroborateHandle,
  extractRelMeLinks,
} from '@/lib/ingest/handle-verify';

// Re-export so callers can introspect the denylist without a second import.
export { DENYLIST } from '@/lib/ingest/raw-ingest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal query surface. pg's Client and PoolClient both satisfy this; tests can
 * pass a stub. Mirrors the QueryClient pattern in identity-resolve.ts.
 */
export interface QueryClient {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** A coarse provenance family for a discovered URL. */
export type SourceFamily = 'candidate_site' | 'social';

/**
 * Where the URL came from in OUR data. Maps to raw_evidence.discovery_path.
 *   person_record  -- people / candidate_contact_fields (a stored person field)
 *   state_portal   -- a government candidate-profile portal (votesearch.utah.gov)
 *   filing         -- candidacies filing fields (website / campaign_email domain)
 *   legacy_source  -- the pre-graph candidate_sources table
 */
export type DiscoveryPath =
  | 'person_record'
  | 'state_portal'
  | 'filing'
  | 'legacy_source';

/** One discovered, vetted, person-attributed source URL. */
export interface DiscoveredSource {
  /** Canonicalized URL (already through canonicalizeUrl, never denylisted). */
  url: string;
  source_family: SourceFamily;
  discovery_path: DiscoveryPath;
  /** Authoritative bind confidence in [0, 1] for this person_id attribution. */
  bind_confidence: number;
  /** Social platform when known (candidate_contact_fields.platform). Optional. */
  platform?: string | null;
  /** Human-readable note: which table/column produced it (for the CLI log). */
  origin: string;
}

// ---------------------------------------------------------------------------
// Non-campaign email domains -- we do NOT derive a campaign site from these
// ---------------------------------------------------------------------------

/**
 * Free / consumer mail providers. A campaign_email at one of these is NOT a
 * campaign domain, so we must NOT synthesize https://<domain> from it (that
 * would point us at gmail.com, not the candidate's site). Matched against the
 * registrable domain of the email host.
 */
const FREE_MAIL_DOMAINS = new Set<string>([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'me.com',
  'comcast.net',
  // common close cousins of the above, kept conservative
  'icloud.com',
  'aol.com',
  'msn.com',
  'protonmail.com',
  'proton.me',
  'ymail.com',
]);

/**
 * Government / state-portal domains that must never be synthesized into a
 * campaign site URL from an email address. A candidate may have an official
 * government email (e.g. someone@example.gov), but https://utah.gov is the state
 * portal, not their campaign site. Explicitly list known Utah portals because
 * the registrable-domain heuristic below (endsWith ".gov") already catches
 * the generic case; these are included for clarity and defence-in-depth.
 *
 * Used ONLY by isNonCampaignEmailDomain / siteFromEmail -- does NOT affect
 * website_url or votesearch URL paths.
 */
const GOVERNMENT_PORTAL_DOMAINS = new Set<string>([
  'utah.gov',
  'le.utah.gov',        // Utah Legislature (uniform resource locator) portal
  'votesearch.utah.gov', // Utah election candidate-profile portal
  'vote.utah.gov',      // Utah voter information portal
]);

/**
 * True when a registrable (or full) email domain must NOT be used to
 * synthesize a campaign website URL.
 *
 * Blocks:
 *   1. Free / consumer mail providers (gmail.com, yahoo.com, ...).
 *   2. Any domain whose registrable form ends in ".gov" or ".mil" --
 *      synthesizing https://something.gov produces a government portal,
 *      not the candidate's campaign site.
 *   3. The ".us" ccTLD (country-code top-level domain) with a gov-style
 *      sub-label pattern (e.g. state.ut.us, co.slc.ut.us) -- these are
 *      legacy official government hosts common in older US jurisdictions.
 *   4. Explicitly denylisted Utah portal hosts (belt-and-suspenders, in case
 *      the registrable-domain extraction resolves them to just "utah.gov").
 *
 * Used only by siteFromEmail (the campaign_email synthesis arm). Does NOT
 * affect website_url or any votesearch URL handling.
 */
function isNonCampaignEmailDomain(domain: string | null): boolean {
  if (!domain) return true; // null -> treat as non-campaign
  const d = domain.toLowerCase();
  if (FREE_MAIL_DOMAINS.has(d)) return true;
  if (GOVERNMENT_PORTAL_DOMAINS.has(d)) return true;
  // Generic .gov and .mil TLDs (top-level domains) are always government hosts.
  if (d.endsWith('.gov') || d === 'gov') return true;
  if (d.endsWith('.mil') || d === 'mil') return true;
  // Legacy US government pattern: *.state.XX.us, *.co.CITY.XX.us, etc.
  // A .us domain with three or more labels whose second-to-last label is a
  // two-letter US state code is almost always an official government host.
  if (d.endsWith('.us')) {
    const labels = d.split('.');
    // e.g. "state.ut.us" -> labels = ['state','ut','us'], length >= 3
    if (labels.length >= 3) {
      const stateLabel = labels[labels.length - 2];
      // Two-letter US state/territory abbreviation heuristic.
      if (/^[a-z]{2}$/.test(stateLabel)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Schema introspection -- "skip gracefully if absent"
// ---------------------------------------------------------------------------

async function tableExists(client: QueryClient, table: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = 'public' and table_name = $1
     ) as exists`,
    [table],
  );
  return rows[0]?.exists === true;
}

/** Return the set of columns that exist on a public table (empty if no table). */
async function columnsOf(client: QueryClient, table: string): Promise<Set<string>> {
  const { rows } = await client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

/** True iff the table exists AND has every column in `needed`. */
async function hasTableWithColumns(
  client: QueryClient,
  table: string,
  needed: string[],
): Promise<boolean> {
  if (!(await tableExists(client, table))) return false;
  const cols = await columnsOf(client, table);
  return needed.every((c) => cols.has(c));
}

// ---------------------------------------------------------------------------
// negative-cache gate -- skip URLs known-dead and not yet due for recheck
// ---------------------------------------------------------------------------

/**
 * Build the set of canonical URLs that are currently in url_negative_cache with
 * recheck_after NULL (permanent) or in the future (not yet due). Those are
 * skipped: re-enqueuing a known-bad URL would just waste a fetch. URLs whose
 * recheck_after is in the PAST are allowed through (due for a recheck).
 *
 * We canonicalize each candidate before lookup because url_negative_cache is
 * keyed on the canonical form (the ingest pipeline writes it canonical).
 */
async function loadNegativeCacheBlocked(
  client: QueryClient,
  canonicalUrls: string[],
): Promise<Set<string>> {
  const blocked = new Set<string>();
  if (canonicalUrls.length === 0) return blocked;
  if (!(await tableExists(client, 'url_negative_cache'))) return blocked;

  const { rows } = await client.query<{ url_canonical: string }>(
    `select url_canonical
       from url_negative_cache
      where url_canonical = any($1::text[])
        and (recheck_after is null or recheck_after > now())`,
    [canonicalUrls],
  );
  for (const r of rows) blocked.add(r.url_canonical);
  return blocked;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalize a raw URL and reject it if malformed or denylisted. Returns the
 * canonical string, or null when it should be dropped. Adding a scheme when one
 * is missing (bare "smith4mayor.org") is handled here so person-record values
 * that omit https:// still resolve.
 */
function vetUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let candidate = raw.trim();
  if (!candidate) return null;
  // Add a scheme if the value is a bare host/path (common in stored fields).
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let canonical: string;
  let registrable: string | null;
  let host: string;
  try {
    const c = canonicalizeUrl(candidate);
    canonical = c.canonical;
    registrable = c.registrableDomain;
    host = new URL(canonical).hostname;
  } catch {
    return null; // malformed -> drop
  }
  if (isDenied(registrable, host)) return null; // aggregator -> drop
  return canonical;
}

/**
 * Derive https://<email-host-domain> from a campaign_email field.
 *
 * Returns null (no site synthesized) when the email domain is a free-mail
 * provider, a government host (*.gov, *.mil, gov-pattern *.us), or an
 * explicitly known portal (utah.gov, le.utah.gov, ...). Both the raw email
 * host and its registrable form are checked so subdomains are caught too
 * (e.g. mail.utah.gov -> registrable = utah.gov -> blocked).
 */
function siteFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes('.')) return null;
  // Derive the registrable domain so subdomain variants are caught.
  let registrable: string | null = null;
  try {
    registrable = canonicalizeUrl(`https://${domain}`).registrableDomain;
  } catch {
    return null;
  }
  // Block free-mail, government hosts, and known portals (both the full email
  // host and its registrable form must pass).
  if (isNonCampaignEmailDomain(domain) || isNonCampaignEmailDomain(registrable)) return null;
  return `https://${domain}`;
}

/** The votesearch state-portal host (Utah election candidate profiles). */
const VOTESEARCH_HOST = 'votesearch.utah.gov';

// ---------------------------------------------------------------------------
// discoverSourcesForPerson -- the public entry point
// ---------------------------------------------------------------------------

/**
 * Discover the approved-source URLs already attributed to `personId` in the
 * database and return them as DiscoveredSource[], deduped by canonical URL,
 * denylist-dropped, and negative-cache-filtered.
 *
 * Each source query is guarded by an information_schema probe so a live DB at a
 * different migration level (a missing table / column) is skipped gracefully
 * rather than throwing. The first attribution wins on dedupe: if the same URL
 * shows up from two sources we keep the FIRST one encountered (the source order
 * below is highest-trust-first), so a 0.95 state-portal URL is not silently
 * downgraded by a later 0.85 legacy hit.
 *
 * @param client connected pg query client (live local Postgres via the bridge)
 * @param personId the people.id to discover sources for
 * @returns deduped, vetted DiscoveredSource[] ready for ingestOne
 */
export async function discoverSourcesForPerson(
  client: QueryClient,
  personId: string,
): Promise<DiscoveredSource[]> {
  // Accumulate raw (pre-dedup) candidates with their canonical URL already
  // computed; dedupe + negative-cache filter happen at the end so we only hit
  // url_negative_cache once with the full canonical set.
  const candidates: DiscoveredSource[] = [];

  const push = (
    rawUrl: string | null | undefined,
    family: SourceFamily,
    path: DiscoveryPath,
    bind: number,
    origin: string,
    platform?: string | null,
  ): void => {
    const canonical = vetUrl(rawUrl);
    if (!canonical) return;
    candidates.push({
      url: canonical,
      source_family: family,
      discovery_path: path,
      bind_confidence: bind,
      platform: platform ?? null,
      origin,
    });
  };

  // ----------------------------------------------------------------
  // SOURCE 1 -- people.website_url  (family candidate_site, person_record, 0.9)
  // ----------------------------------------------------------------
  if (await hasTableWithColumns(client, 'people', ['id', 'website_url'])) {
    try {
      const { rows } = await client.query<{ website_url: string | null }>(
        `select website_url from people where id = $1`,
        [personId],
      );
      for (const r of rows) {
        push(r.website_url, 'candidate_site', 'person_record', 0.9, 'people.website_url');
      }
    } catch {
      /* skip this source on any query error */
    }
  }

  // ----------------------------------------------------------------
  // SOURCE 2 + 3 + 4 -- candidate_contact_fields
  //   field_kind='website', not suppressed -> candidate_site / person_record / 0.9
  //   field_kind='social',  not suppressed -> social / person_record / 0.9 (+platform)
  //   any row with source_url LIKE '%votesearch%' -> enqueue THAT votesearch
  //     profile URL: candidate_site / state_portal / 0.95
  // ----------------------------------------------------------------
  if (
    await hasTableWithColumns(client, 'candidate_contact_fields', [
      'person_id',
      'field_kind',
      'value',
      'suppressed',
    ])
  ) {
    const ccfCols = await columnsOf(client, 'candidate_contact_fields');
    const hasPlatform = ccfCols.has('platform');
    const hasSourceUrl = ccfCols.has('source_url');
    const selectCols = [
      'field_kind',
      'value',
      'suppressed',
      hasPlatform ? 'platform' : `null::text as platform`,
      hasSourceUrl ? 'source_url' : `null::text as source_url`,
    ].join(', ');
    try {
      const { rows } = await client.query<{
        field_kind: string;
        value: string | null;
        suppressed: boolean | null;
        platform: string | null;
        source_url: string | null;
      }>(
        `select ${selectCols}
           from candidate_contact_fields
          where person_id = $1 and coalesce(suppressed, false) = false`,
        [personId],
      );
      for (const r of rows) {
        if (r.field_kind === 'website') {
          push(
            r.value,
            'candidate_site',
            'person_record',
            0.9,
            'candidate_contact_fields.website',
          );
        } else if (r.field_kind === 'social') {
          push(
            r.value,
            'social',
            'person_record',
            0.9,
            'candidate_contact_fields.social',
            r.platform,
          );
        }
        // votesearch profile URL itself: enqueue the source_url that points at
        // the state portal. This catches ANY field_kind whose provenance is the
        // votesearch portal (the profile page is the artifact we want).
        if (hasSourceUrl && r.source_url && /votesearch/i.test(r.source_url)) {
          push(
            r.source_url,
            'candidate_site',
            'state_portal',
            0.95,
            'candidate_contact_fields.source_url(votesearch)',
          );
        }
      }
    } catch {
      /* skip this source on any query error */
    }
  }

  // ----------------------------------------------------------------
  // SOURCE 5 -- candidacies (filing): .website + campaign_email-domain
  //   family candidate_site, discovery_path filing, bind 0.9
  //   email-domain only when it is NOT a free-mail provider.
  // ----------------------------------------------------------------
  if (await hasTableWithColumns(client, 'candidacies', ['person_id'])) {
    const candCols = await columnsOf(client, 'candidacies');
    const hasWebsite = candCols.has('website');
    const hasCampaignEmail = candCols.has('campaign_email');
    if (hasWebsite || hasCampaignEmail) {
      const selectCols = [
        hasWebsite ? 'website' : `null::text as website`,
        hasCampaignEmail ? 'campaign_email' : `null::text as campaign_email`,
      ].join(', ');
      try {
        const { rows } = await client.query<{
          website: string | null;
          campaign_email: string | null;
        }>(
          `select ${selectCols} from candidacies where person_id = $1`,
          [personId],
        );
        for (const r of rows) {
          if (hasWebsite) {
            push(r.website, 'candidate_site', 'filing', 0.9, 'candidacies.website');
          }
          if (hasCampaignEmail) {
            const site = siteFromEmail(r.campaign_email);
            if (site) {
              push(
                site,
                'candidate_site',
                'filing',
                0.9,
                'candidacies.campaign_email(domain)',
              );
            }
          }
        }
      } catch {
        /* skip this source on any query error */
      }
    }
  }

  // ----------------------------------------------------------------
  // SOURCE 6 -- candidate_sources (legacy), joined via
  //   people.legacy_candidate_ids. We accept BOTH the pre-007 enum values
  //   ('campaign_website','state_profile') AND the post-007 representation
  //   (source_type='website' AND source_subtype IN ('campaign_site','state_profile'))
  //   so this works whichever migration the live DB is at.
  //   family candidate_site, discovery_path legacy_source, bind 0.85
  // ----------------------------------------------------------------
  if (
    (await hasTableWithColumns(client, 'people', ['id', 'legacy_candidate_ids'])) &&
    (await hasTableWithColumns(client, 'candidate_sources', [
      'candidate_id',
      'source_type',
      'url',
    ]))
  ) {
    try {
      const legacy = await client.query<{ legacy_candidate_ids: string[] | null }>(
        `select legacy_candidate_ids from people where id = $1`,
        [personId],
      );
      const ids = legacy.rows[0]?.legacy_candidate_ids ?? [];
      if (Array.isArray(ids) && ids.length > 0) {
        const csCols = await columnsOf(client, 'candidate_sources');
        const hasSubtype = csCols.has('source_subtype');
        // The WHERE matches the pre-007 enum OR (when the subtype column exists)
        // the post-007 'website' + subtype representation.
        const typePredicate = hasSubtype
          ? `(source_type in ('campaign_website','state_profile')
              or (source_type = 'website' and source_subtype in ('campaign_site','state_profile')))`
          : `source_type in ('campaign_website','state_profile')`;
        const { rows } = await client.query<{ url: string | null }>(
          `select url
             from candidate_sources
            where candidate_id = any($1::uuid[])
              and url is not null
              and ${typePredicate}`,
          [ids],
        );
        for (const r of rows) {
          push(
            r.url,
            'candidate_site',
            'legacy_source',
            0.85,
            'candidate_sources(legacy)',
          );
        }
      }
    } catch {
      /* skip this source on any query error */
    }
  }

  // ----------------------------------------------------------------
  // DEDUPE (first attribution wins) + negative-cache filter.
  // ----------------------------------------------------------------
  const byUrl = new Map<string, DiscoveredSource>();
  for (const c of candidates) {
    if (!byUrl.has(c.url)) byUrl.set(c.url, c);
  }
  const deduped = Array.from(byUrl.values());

  const blocked = await loadNegativeCacheBlocked(
    client,
    deduped.map((d) => d.url),
  );
  const surviving = deduped.filter((d) => !blocked.has(d.url));

  return surviving;
}

/**
 * The state-portal host this module recognizes, exported for tests / callers
 * that want to assert votesearch handling without re-deriving it.
 */
export const STATE_PORTAL_HOSTS: readonly string[] = [VOTESEARCH_HOST];

// ===========================================================================
// ACTIVE DISCOVERY -- find NEW, previously-unknown owned sources for a person
// who has NO attributed source yet. (Build 3.)
//
// This is the active-web-search half that discoverSourcesForPerson deliberately
// leaves out. It runs the chain from section 1 of the research doc:
//
//   ANCHOR  (candidacies.website / campaign_email domain / FEC committee URL)
//     -> SEARCH (name + office + locality, "elect NAME", "NAME for OFFICE")
//     -> RANK   (owned-domain heuristics; hard-filter banned aggregators)
//     -> DOMAIN-VERIFY (RDAP / crt.sh / DNS)
//     -> EXPAND (sitemap.xml + RSS + outbound link graph from the confirmed site)
//     -> HANDLE-VERIFY (rel=me loop / Bluesky / YouTube)
//     -> GATE   (attributed only on primary-source trace OR rel=me loop OR a
//                strong multi-signal content match; else unattributed -> review)
//
// Aggregator-free throughout (the same canonicalizeUrl + DENYLIST gate every
// candidate URL). NEVER scrapes Meta/X/TikTok/LinkedIn -- handles for those are
// resolved only from links published on the candidate's own confirmed site.
// ===========================================================================

/** How a discovered URL earned (or failed to earn) attribution. */
export type AttributionBasis =
  | 'anchor_primary' // came from a primary record (filing / FEC committee URL)
  | 'rel_me_loop' // reciprocal rel="me" loop confirmed
  | 'multi_signal' // strong multi-signal content + domain match
  | 'unattributed'; // not enough -> queued for human review

/** A person record as much as active discovery needs to anchor + search + corroborate. */
export interface ActivePerson {
  id: string;
  name: string;
  state_fips?: string | null;
  office?: string | null;
  locality?: string | null;
  /** A filed campaign website, when one is on the candidacy/filing record. */
  filed_website?: string | null;
  /** A filed campaign email (we derive a domain anchor from it). */
  filed_email?: string | null;
  /** An FEC committee URL, when available from federal enrichment. */
  fec_committee_url?: string | null;
}

/** One actively-discovered source with its confirmation provenance. */
export interface ActiveDiscoveredSource {
  url: string;
  source_family: SourceFamily;
  /** raw_evidence.discovery_path for the active chain. */
  discovery_path: 'active_anchor' | 'active_search' | 'active_expand' | 'active_social';
  /** Bind confidence to flow into ingestOne. Attributed >= publish; queued < it. */
  bind_confidence: number;
  /** Whether this source cleared the GATE. */
  attributed: boolean;
  /** Why it did / did not clear the gate. */
  basis: AttributionBasis;
  /** Registrable domain (for the per-domain dedup + the log). */
  registrable: string | null;
  /** Owned-domain rank score (0..1) from the RANK step. */
  rankScore: number;
  /** Social platform when this is a social handle. */
  platform?: string | null;
  /** Human-readable note for the CLI log. */
  origin: string;
}

export interface ActiveDiscoveryResult {
  person_id: string;
  /** Anchor domains/URLs derived from primary records. */
  anchors: string[];
  /** Count of raw search-result URLs considered (post denylist). */
  searched: number;
  /** Ranked candidate domains after the RANK step (denylist already applied). */
  rankedCandidates: Array<{ url: string; registrable: string | null; rankScore: number }>;
  /** Domains that passed DOMAIN-VERIFY (>=2 corroborating signals). */
  confirmedDomains: string[];
  /** Handles that passed HANDLE-VERIFY (rel=me loop / Bluesky / YouTube). */
  verifiedHandles: string[];
  /** Final sources: attributed ones plus unattributed/queued ones. */
  sources: ActiveDiscoveredSource[];
  /** Convenience splits. */
  attributedCount: number;
  unattributedCount: number;
  /** Whether the search layer ran in degraded mode (DuckDuckGo fallback). */
  searchDegraded: boolean;
  notes: string[];
}

export interface ActiveDiscoveryOpts {
  /** Max search queries to run (politeness). Default 3. */
  maxQueries?: number;
  /** Max ranked candidate domains to domain-verify. Default 8. */
  maxCandidates?: number;
  /** Min corroborating domain signals (resolves/cert/registered) to confirm. Default 2. */
  minDomainSignals?: number;
  /** Bind confidence assigned to an attributed source. Default 0.92 (>= publish). */
  attributedBind?: number;
  /** Bind confidence assigned to an unattributed/queued source. Default 0.5. */
  unattributedBind?: number;
  /** Injected search() for OFFLINE TESTS. Defaults to the real search backend. */
  searchImpl?: typeof searchBackend;
  /** Injected verifyDomain() for OFFLINE TESTS. */
  verifyDomainImpl?: typeof verifyDomain;
  /** Injected relMeLoop() for OFFLINE TESTS. */
  relMeLoopImpl?: typeof relMeLoop;
  /** Injected blueskyProfile() for OFFLINE TESTS. */
  blueskyProfileImpl?: typeof blueskyProfile;
  /** Injected youtubeChannel() for OFFLINE TESTS. */
  youtubeChannelImpl?: typeof youtubeChannel;
  /** Injected fetch (for EXPAND sitemap/RSS/link-graph). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override SEARX_URL into the search backend. */
  searxUrl?: string | null;
}

// ---------------------------------------------------------------------------
// RANK -- owned-domain vs noise heuristics (exported for the offline test)
// ---------------------------------------------------------------------------

/**
 * Tokens that strongly suggest a CAMPAIGN domain by naming convention:
 * "elect", "for<office>", "vote", "4" (smith4mayor), and the candidate's own
 * surname appearing in the registrable domain.
 */
const CAMPAIGN_DOMAIN_TOKENS = ['elect', 'vote', 'for', 'campaign', 'committee'];

/** Phrases on a page that signal an owned campaign site. */
const OWNED_PAGE_SIGNALS: Array<{ re: RegExp; tag: string; weight: number }> = [
  { re: /paid\s+for\s+by/i, tag: 'paid_for_by', weight: 0.35 },
  { re: /\bdonate\b|actblue\.com|winred\.com|secure\.anedot\.com/i, tag: 'donate', weight: 0.2 },
  { re: /\b(issues|platform|priorities|where\s+i\s+stand|on\s+the\s+issues)\b/i, tag: 'issues', weight: 0.15 },
  { re: /\b(volunteer|yard\s+sign|endorsements?)\b/i, tag: 'campaign_chrome', weight: 0.1 },
];

/** Known noise hosts that are not owned sites even when not on the denylist. */
const NOISE_HOST_PATTERNS: RegExp[] = [
  /(?:^|\.)wikipedia\.org$/i,
  /(?:^|\.)wikidata\.org$/i,
  /(?:^|\.)linkedin\.com$/i, // resolved via published link only, not as a ranked site
  /(?:^|\.)youtube\.com$/i,
  /(?:^|\.)facebook\.com$/i,
  /(?:^|\.)twitter\.com$/i,
  /(?:^|\.)x\.com$/i,
  /(?:^|\.)instagram\.com$/i,
  /(?:^|\.)tiktok\.com$/i,
  /(?:^|\.)news\b/i,
  /(?:^|\.)nytimes\.com$|(?:^|\.)washingtonpost\.com$|(?:^|\.)cnn\.com$/i,
  /(?:^|\.)reddit\.com$/i,
  /(?:^|\.)amazon\.com$|(?:^|\.)ebay\.com$/i,
];

export interface RankInput {
  url: string;
  /** Optional page text (search snippet or a fetched body) for OWNED_PAGE_SIGNALS. */
  pageText?: string | null;
  /** Optional title for locality/name matching. */
  title?: string | null;
}

export interface RankedUrl {
  url: string;
  registrable: string | null;
  host: string;
  rankScore: number;
  /** Which positive signals fired (for the log + the test). */
  signals: string[];
  /** True when this is noise (a social/news/wiki host) -- excluded as a SITE. */
  isNoise: boolean;
  /** True when the URL is denylisted (hard-filtered). */
  isDenied: boolean;
}

/**
 * rankCandidate(input, identity): score a single candidate URL as a plausibly-
 * OWNED campaign domain. Returns isDenied:true for any banned aggregator (the
 * caller hard-filters those). Returns isNoise:true for social/news/wiki hosts
 * (handled as handles/cross-checks, not as ranked sites).
 *
 * Positive signals (additive, clamped to [0,1]):
 *   + campaign-convention domain token (elect/vote/for/4 + surname)   up to 0.4
 *   + candidate surname in the registrable domain                      0.25
 *   + "paid for by" disclaimer in page text                            0.35
 *   + donate / ActBlue / WinRed link                                   0.2
 *   + issues / platform page                                           0.15
 *   + locality string in domain or title                              0.1
 *
 * EXPORTED so the offline test can assert owned-vs-noise + denylist behavior.
 */
export function rankCandidate(
  input: RankInput,
  identity: { name: string; office?: string | null; locality?: string | null },
): RankedUrl {
  let host = '';
  let registrable: string | null = null;
  let canonical = input.url;
  let denied = false;
  try {
    const c = canonicalizeUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.url) ? input.url : `https://${input.url}`);
    canonical = c.canonical;
    registrable = c.registrableDomain;
    host = new URL(canonical).hostname.toLowerCase();
  } catch {
    return { url: input.url, registrable: null, host: '', rankScore: 0, signals: [], isNoise: true, isDenied: false };
  }
  denied = isDenied(registrable, host);
  if (denied) {
    return { url: canonical, registrable, host, rankScore: 0, signals: ['denylist'], isNoise: false, isDenied: true };
  }

  const isNoise = NOISE_HOST_PATTERNS.some((re) => re.test(host));
  if (isNoise) {
    return { url: canonical, registrable, host, rankScore: 0, signals: ['noise_host'], isNoise: true, isDenied: false };
  }

  const signals: string[] = [];
  let score = 0;

  const regLabel = (registrable ?? host).toLowerCase();
  const surname = lastNameToken(identity.name);
  const officeKey = (identity.office ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const localityKey = (identity.locality ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // Campaign-convention domain tokens.
  const regNoTld = regLabel.split('.')[0];
  if (CAMPAIGN_DOMAIN_TOKENS.some((t) => regNoTld.includes(t)) || /\b4\b|[a-z]4[a-z]/.test(regNoTld)) {
    score += 0.4;
    signals.push('campaign_domain_token');
  }
  // Surname in the registrable domain.
  if (surname && surname.length >= 3 && regNoTld.includes(surname)) {
    score += 0.25;
    signals.push('surname_in_domain');
  }
  // Locality in the domain or title.
  const titleKey = (input.title ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (localityKey && localityKey.length >= 3 && (regNoTld.includes(localityKey) || titleKey.includes(localityKey))) {
    score += 0.1;
    signals.push('locality_match');
  }
  // Office in the domain (e.g. "formayor").
  if (officeKey && officeKey.length >= 3 && regNoTld.includes(officeKey)) {
    score += 0.1;
    signals.push('office_in_domain');
  }

  // Page-text owned signals.
  const text = input.pageText ?? '';
  if (text) {
    for (const s of OWNED_PAGE_SIGNALS) {
      if (s.re.test(text)) {
        score += s.weight;
        signals.push(s.tag);
      }
    }
  }

  score = Math.max(0, Math.min(1, score));
  return { url: canonical, registrable, host, rankScore: score, signals, isNoise: false, isDenied: false };
}

/** Extract a lowercase alphanumeric surname token from a "First Last" name. */
function lastNameToken(name: string): string {
  const parts = (name ?? '')
    .trim()
    .split(/\s+/)
    .map((p) => p.replace(/[^a-zA-Z]/g, ''))
    .filter(Boolean);
  if (parts.length === 0) return '';
  // Drop a trailing suffix (Jr/Sr/II/III/IV) so "John Smith Jr" -> "smith".
  const suffixes = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
  let idx = parts.length - 1;
  while (idx > 0 && suffixes.has(parts[idx].toLowerCase())) idx--;
  return parts[idx].toLowerCase();
}

/**
 * rankAndFilter(results, identity, max): map every search result through
 * rankCandidate, HARD-FILTER denied aggregators and noise hosts, sort by score
 * descending, dedup by registrable domain (keep the highest-scoring URL per
 * domain), and truncate to `max`. EXPORTED for the offline test.
 */
export function rankAndFilter(
  results: Array<RankInput>,
  identity: { name: string; office?: string | null; locality?: string | null },
  max: number,
): RankedUrl[] {
  const ranked = results
    .map((r) => rankCandidate(r, identity))
    .filter((r) => !r.isDenied && !r.isNoise); // hard-filter aggregators + noise

  ranked.sort((a, b) => b.rankScore - a.rankScore);

  const byDomain = new Map<string, RankedUrl>();
  for (const r of ranked) {
    const key = r.registrable ?? r.host;
    if (!byDomain.has(key)) byDomain.set(key, r);
  }
  return Array.from(byDomain.values()).slice(0, max);
}

// ---------------------------------------------------------------------------
// EXPAND -- sitemap.xml + RSS + outbound link graph from a confirmed site
// ---------------------------------------------------------------------------

/** Extract <loc> entries from a sitemap.xml or RSS/Atom feed body. */
function extractSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  if (!xml) return out;
  // sitemap <loc>, RSS <link>, Atom <link href="">.
  const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  const linkRe = /<link>\s*([^<\s]+)\s*<\/link>/gi;
  const atomRe = /<link[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(xml)) !== null) out.push(m[1]);
  while ((m = linkRe.exec(xml)) !== null) out.push(m[1]);
  while ((m = atomRe.exec(xml)) !== null) out.push(m[1]);
  return Array.from(new Set(out));
}

/** Extract outbound <a href> absolute URLs from an HTML body. */
function extractOutboundLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  if (!html) return out;
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(new URL(m[1], baseUrl).toString());
    } catch {
      /* skip */
    }
  }
  return Array.from(new Set(out));
}

interface ExpandOutcome {
  /** Same-domain pages found via sitemap/RSS (more of the owned site). */
  ownPages: string[];
  /** Outbound social-platform links published on the site (the only sanctioned source for those handles). */
  socialLinks: string[];
  /** rel="me" links published on the site (candidate handle for verification). */
  relMeLinks: string[];
  /** The home-page HTML body (so the caller can re-rank with real page text). */
  homeBody: string;
  notes: string[];
}

/**
 * expandFromSite(siteUrl): fetch the confirmed site's home page, robots-aware
 * sitemap.xml, and a /feed or /rss feed, then harvest (a) same-domain pages,
 * (b) outbound social-platform links published on the site, and (c) rel="me"
 * links. Total -- a missing sitemap/feed is just an empty list, never a throw.
 */
async function expandFromSite(
  siteUrl: string,
  registrable: string | null,
  fetchImpl: typeof fetch,
): Promise<ExpandOutcome> {
  const notes: string[] = [];
  const ownPages = new Set<string>();
  const socialLinks = new Set<string>();
  let homeBody = '';
  let relMeLinks: string[] = [];

  let origin = '';
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    return { ownPages: [], socialLinks: [], relMeLinks: [], homeBody: '', notes: ['malformed siteUrl'] };
  }

  const polite = async (u: string): Promise<string> => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetchImpl(u, {
        headers: { 'User-Agent': 'Havesay-DiscoveryBot/1.0', Accept: '*/*' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return '';
      return await res.text();
    } catch {
      return '';
    }
  };

  // Home page.
  homeBody = await polite(siteUrl);
  if (homeBody) {
    relMeLinks = extractRelMeLinks(homeBody, siteUrl);
    for (const link of extractOutboundLinks(homeBody, siteUrl)) {
      const ph = resolvePublishedHandle(link);
      if (ph) socialLinks.add(ph.url);
    }
  } else {
    notes.push('home page returned no body');
  }

  // sitemap.xml + a feed (best-effort).
  for (const path of ['/sitemap.xml', '/feed', '/rss', '/feed.xml', '/atom.xml']) {
    const body = await polite(origin + path);
    if (!body) continue;
    for (const loc of extractSitemapLocs(body)) {
      try {
        const u = new URL(loc);
        const reg = registrableDomainOf(u.hostname);
        // Same-owned-domain pages only.
        if (registrable && reg === registrable) ownPages.add(u.toString());
        // Social platform links published in the feed also count.
        const ph = resolvePublishedHandle(u.toString());
        if (ph) socialLinks.add(ph.url);
      } catch {
        /* skip */
      }
    }
  }

  return {
    ownPages: Array.from(ownPages),
    socialLinks: Array.from(socialLinks),
    relMeLinks,
    homeBody,
    notes,
  };
}

// ---------------------------------------------------------------------------
// ANCHOR -- derive primary-record anchor domains
// ---------------------------------------------------------------------------

function anchorUrlsFor(person: ActivePerson): Array<{ url: string; basis: 'filing' | 'fec' }> {
  const out: Array<{ url: string; basis: 'filing' | 'fec' }> = [];
  // Filed campaign website (primary record).
  const filedSite = vetUrl(person.filed_website);
  if (filedSite) out.push({ url: filedSite, basis: 'filing' });
  // Filed email domain (only when it is a real campaign domain).
  const fromEmail = siteFromEmail(person.filed_email);
  const vettedEmailSite = vetUrl(fromEmail);
  if (vettedEmailSite) out.push({ url: vettedEmailSite, basis: 'filing' });
  // FEC committee URL (primary record).
  const fec = vetUrl(person.fec_committee_url);
  if (fec) out.push({ url: fec, basis: 'fec' });
  return out;
}

// ---------------------------------------------------------------------------
// discoverActiveForPerson -- the public entry point for active discovery
// ---------------------------------------------------------------------------

/**
 * discoverActiveForPerson(person, opts): run the full ANCHOR -> SEARCH -> RANK
 * -> DOMAIN-VERIFY -> EXPAND -> HANDLE-VERIFY -> GATE chain for a person who has
 * NO attributed source yet, returning the discovered sources split into
 * attributed (cleared the gate) and unattributed (queued for review).
 *
 * GATE RULE: a source is marked attributed ONLY on
 *   (a) a primary-source trace (an ANCHOR domain from a filing / FEC committee
 *       URL), OR
 *   (b) a confirmed reciprocal rel="me" loop, OR
 *   (c) a strong multi-signal content match (domain-verify >= minDomainSignals
 *       AND rankScore high AND name corroboration).
 * Everything else is left UNATTRIBUTED with a sub-publish bind_confidence and
 * should be enqueued for human review by the caller.
 *
 * Total -- never throws; all network primitives are total. Backend-agnostic:
 * the search layer is the self-hostable SearXNG/DuckDuckGo backend, injectable
 * for offline tests.
 */
export async function discoverActiveForPerson(
  person: ActivePerson,
  opts: ActiveDiscoveryOpts = {},
): Promise<ActiveDiscoveryResult> {
  const maxQueries = opts.maxQueries ?? 3;
  const maxCandidates = opts.maxCandidates ?? 8;
  const minDomainSignals = opts.minDomainSignals ?? 2;
  const attributedBind = opts.attributedBind ?? 0.92;
  const unattributedBind = opts.unattributedBind ?? 0.5;
  const doSearch = opts.searchImpl ?? searchBackend;
  const doVerifyDomain = opts.verifyDomainImpl ?? verifyDomain;
  const doRelMe = opts.relMeLoopImpl ?? relMeLoop;
  const doBluesky = opts.blueskyProfileImpl ?? blueskyProfile;
  const doYoutube = opts.youtubeChannelImpl ?? youtubeChannel;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const identity = { name: person.name, office: person.office, locality: person.locality };
  const result: ActiveDiscoveryResult = {
    person_id: person.id,
    anchors: [],
    searched: 0,
    rankedCandidates: [],
    confirmedDomains: [],
    verifiedHandles: [],
    sources: [],
    attributedCount: 0,
    unattributedCount: 0,
    searchDegraded: false,
    notes: [],
  };

  // De-dup the final source list by canonical URL.
  const sourceByUrl = new Map<string, ActiveDiscoveredSource>();
  const addSource = (s: ActiveDiscoveredSource): void => {
    const existing = sourceByUrl.get(s.url);
    // Prefer an attributed source over an unattributed duplicate.
    if (!existing || (s.attributed && !existing.attributed)) sourceByUrl.set(s.url, s);
  };

  // ---- ANCHOR ----
  const anchors = anchorUrlsFor(person);
  const anchorRegistrables = new Set<string>();
  for (const a of anchors) {
    let reg: string | null = null;
    try {
      reg = canonicalizeUrl(a.url).registrableDomain;
    } catch {
      /* ignore */
    }
    if (reg) anchorRegistrables.add(reg);
    result.anchors.push(a.url);
    // A primary-record anchor is attributed by basis (a) of the gate.
    addSource({
      url: a.url,
      source_family: 'candidate_site',
      discovery_path: 'active_anchor',
      bind_confidence: attributedBind,
      attributed: true,
      basis: 'anchor_primary',
      registrable: reg,
      rankScore: 1,
      origin: `anchor:${a.basis}`,
    });
  }

  // ---- SEARCH ----
  const queries = buildCampaignQueries(identity).slice(0, maxQueries);
  const rawResults: SearchResult[] = [];
  for (const q of queries) {
    const resp = await doSearch(q, { searxUrl: opts.searxUrl });
    if (resp.degraded) result.searchDegraded = true;
    rawResults.push(...resp.results);
  }
  result.searched = rawResults.length;
  if (result.searchDegraded) {
    result.notes.push('search ran DEGRADED (DuckDuckGo fallback; set SEARX_URL for real coverage)');
  }

  // ---- RANK (hard-filter aggregators + noise; dedup by domain) ----
  const rankInputs: RankInput[] = rawResults.map((r) => ({
    url: r.url,
    pageText: r.snippet ?? null,
    title: r.title ?? null,
  }));
  // Drop any candidate already on an anchor domain so a filed site that also
  // turns up in search is not double-counted as a separate candidate.
  const ranked = rankAndFilter(rankInputs, identity, maxCandidates).filter(
    (r) => !(r.registrable && anchorRegistrables.has(r.registrable)),
  );
  result.rankedCandidates = ranked.map((r) => ({ url: r.url, registrable: r.registrable, rankScore: r.rankScore }));

  // ---- DOMAIN-VERIFY + EXPAND + HANDLE-VERIFY + GATE for each ranked candidate ----
  const verifiedHandleSet = new Set<string>();
  for (const cand of ranked) {
    const conf: DomainConfirmation = await doVerifyDomain(cand.url);
    const confirmed = conf.signalCount >= minDomainSignals;
    if (confirmed) result.confirmedDomains.push(conf.domain);

    // EXPAND from the (resolving) site for own pages + social + rel=me links.
    let expanded: ExpandOutcome = { ownPages: [], socialLinks: [], relMeLinks: [], homeBody: '', notes: [] };
    if (conf.resolves) {
      expanded = await expandFromSite(cand.url, cand.registrable, fetchImpl);
    }

    // Re-rank the site with its real home-page text (stronger owned signal than
    // the snippet) so "paid for by" / donate / issues can lift a thin snippet.
    const reranked = rankCandidate({ url: cand.url, pageText: expanded.homeBody || undefined }, identity);
    const effectiveScore = Math.max(cand.rankScore, reranked.rankScore);

    // GATE basis (c): strong multi-signal content match.
    const nameCorr = corroborateHandle(expanded.homeBody, identity);
    const strongMultiSignal = confirmed && effectiveScore >= 0.5 && nameCorr.matched.includes('name');

    // GATE basis (b): a reciprocal rel="me" loop. Try the site's own rel=me
    // links -- if any forms a reciprocal loop, the site is attributed.
    let relMeAttributed = false;
    for (const profile of expanded.relMeLinks.slice(0, 4)) {
      const loop = await doRelMe(cand.url, profile);
      if (loop.verified) {
        relMeAttributed = true;
        verifiedHandleSet.add(profile);
        addSource({
          url: profile,
          source_family: 'social',
          discovery_path: 'active_social',
          bind_confidence: attributedBind,
          attributed: true,
          basis: 'rel_me_loop',
          registrable: null,
          rankScore: effectiveScore,
          origin: `rel_me_loop(${cand.url})`,
        });
      }
    }

    const attributed = relMeAttributed || strongMultiSignal;
    addSource({
      url: cand.url,
      source_family: 'candidate_site',
      discovery_path: 'active_search',
      bind_confidence: attributed ? attributedBind : unattributedBind,
      attributed,
      basis: relMeAttributed ? 'rel_me_loop' : strongMultiSignal ? 'multi_signal' : 'unattributed',
      registrable: cand.registrable,
      rankScore: effectiveScore,
      origin:
        `rank=${effectiveScore.toFixed(2)} signals=${conf.signalCount}` +
        (confirmed ? ' confirmed' : ' unconfirmed') +
        ` corr=${nameCorr.matched.join('+') || 'none'}`,
    });

    // Same-domain pages found via sitemap/RSS inherit the site's attribution.
    for (const page of expanded.ownPages.slice(0, 10)) {
      const v = vetUrl(page);
      if (!v) continue;
      addSource({
        url: v,
        source_family: 'candidate_site',
        discovery_path: 'active_expand',
        bind_confidence: attributed ? attributedBind : unattributedBind,
        attributed,
        basis: attributed ? (relMeAttributed ? 'rel_me_loop' : 'multi_signal') : 'unattributed',
        registrable: cand.registrable,
        rankScore: effectiveScore,
        origin: `expand:sitemap(${cand.url})`,
      });
    }

    // Social handles published on the site -> Meta/X/TikTok/LinkedIn stay
    // corroboration-only (queued); we NEVER scrape those platforms. The link
    // came from the candidate's OWN site, but the gate needs more than a
    // published link to attribute it.
    for (const social of expanded.socialLinks.slice(0, 12)) {
      const ph = resolvePublishedHandle(social);
      if (!ph) continue;
      const handleAttributed = false;
      const basis: AttributionBasis = 'unattributed';
      addSource({
        url: ph.url,
        source_family: 'social',
        discovery_path: 'active_social',
        bind_confidence: handleAttributed ? attributedBind : unattributedBind,
        attributed: handleAttributed,
        basis,
        registrable: null,
        rankScore: effectiveScore,
        platform: ph.platform,
        origin: `published_handle(${ph.platform}) from ${cand.url}`,
      });
    }
  }

  // ---- Bluesky / YouTube back-link verification on the candidate name ----
  // These are keyless / free-quota and can confirm a handle independent of the
  // site. A confirmed Bluesky/YouTube profile whose description corroborates the
  // candidate is a verified handle (attributed); otherwise queued.
  try {
    const bsky = await doBluesky(person.name);
    if (bsky.ok) {
      const corr = corroborateHandle(`${bsky.displayName ?? ''} ${bsky.description ?? ''}`, identity);
      const attributed = corr.corroborated;
      const handleUrl = `https://bsky.app/profile/${bsky.handle}`;
      if (attributed) verifiedHandleSet.add(handleUrl);
      addSource({
        url: handleUrl,
        source_family: 'social',
        discovery_path: 'active_social',
        bind_confidence: attributed ? attributedBind : unattributedBind,
        attributed,
        basis: attributed ? 'multi_signal' : 'unattributed',
        registrable: null,
        rankScore: attributed ? 0.6 : 0,
        platform: 'bluesky',
        origin: `bluesky(${bsky.handle}) ${corr.detail}`,
      });
    }
  } catch {
    /* total: bluesky errors are non-fatal */
  }

  try {
    const yt = await doYoutube(person.name);
    if (yt.ok && yt.channelId) {
      const corr = corroborateHandle(`${yt.title ?? ''} ${yt.description ?? ''}`, identity);
      const attributed = corr.corroborated;
      const handleUrl = `https://www.youtube.com/channel/${yt.channelId}`;
      if (attributed) verifiedHandleSet.add(handleUrl);
      addSource({
        url: handleUrl,
        source_family: 'social',
        discovery_path: 'active_social',
        bind_confidence: attributed ? attributedBind : unattributedBind,
        attributed,
        basis: attributed ? 'multi_signal' : 'unattributed',
        registrable: null,
        rankScore: attributed ? 0.6 : 0,
        platform: 'youtube',
        origin: `youtube(${yt.channelId}) ${corr.detail}`,
      });
    } else if (yt.skipped) {
      result.notes.push('youtube verification skipped (no YOUTUBE_API_KEY)');
    }
  } catch {
    /* total: youtube errors are non-fatal */
  }

  // ---- finalize ----
  result.verifiedHandles = Array.from(verifiedHandleSet);
  result.sources = Array.from(sourceByUrl.values());
  result.attributedCount = result.sources.filter((s) => s.attributed).length;
  result.unattributedCount = result.sources.filter((s) => !s.attributed).length;
  return result;
}
