/**
 * Idaho Secretary of State — 2026 candidate-filings adapter (FIPS 16).
 *
 * Source pages (web-verified 2026-04-25):
 *   Landing:    https://sos.idaho.gov/elections/candidate-information/
 *               (alias of /elections-division/, redirects via WP rewrite)
 *   Past lists (precedent for naming):
 *     /elections-division/2020-primary-candidate-list/
 *     /elections-division/2020-general-election-candidate-list/
 *
 * State of play
 * -------------
 * Idaho posts each cycle's candidate list as a WordPress sub-page under
 * /elections-division/ (slug pattern: `<year>-<cycle>-candidate-list`).
 * As of 2026-04-25, neither `2024-primary-candidate-list` nor any 2026
 * variant is published — the most recent slug exposed by the landing
 * page is still `2020-primary-candidate-list`. (Idaho Code §34-704
 * requires SoS to publish the candidate list "promptly after the close
 * of the filing period," which for the 2026 cycle is March 13, 2026 —
 * so the list is overdue per statute, suggesting a slug change rather
 * than a deferred posting. The adapter probes both legacy and modern
 * slug variants.)
 *
 * The candidate-list pages themselves are static HTML — each contest is
 * a `<h3>` heading followed by a paragraph or `<ul>` of names. We
 * include the same parser scaffold here as for HI / DC: discover any
 * 2026-list URL on the landing page, follow it if present, parse the
 * heading-grouped HTML if we can.
 *
 * Idaho 2026 ballot scope (primary 2026-05-19, general 2026-11-03):
 *   - U.S. Senate (Class II seat)
 *   - U.S. House (2 districts)
 *   - Governor + Lt. Governor + Sec State + Treasurer + Controller +
 *     Attorney General + Superintendent of Public Instruction
 *   - State Senate (35 districts) + State House (70 seats: 2 per district)
 *   - District judges (nonpartisan)
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

import { politeFetch } from '../../fetch-polite';
import {
  insertCandidacies,
  type CandidacyInsertRow,
} from '../shared/candidacies-insert';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

const STATE_FIPS = '16';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-05-19';
const GENERAL_DATE = '2026-11-03';

const DEFAULT_LANDING_URL =
  'https://sos.idaho.gov/elections/candidate-information/';

/**
 * Slug variants the SoS has historically used. Probed in order — first
 * 200 wins. Listed newest-first so the most likely current slug is tried
 * before legacy ones.
 */
const CANDIDATE_LIST_SLUGS = [
  '2026-primary-candidate-list',
  '2026-primary-election-candidate-list',
  '2026-candidate-list',
  '2026-general-election-candidate-list',
  '2024-primary-candidate-list',
  '2024-general-election-candidate-list',
] as const;

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export type IdCandidacyRow = CandidacyInsertRow;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * From a landing-page HTML body, return any candidate-list URLs that
 * point at a year-keyed candidate list (filtered to electionYear or
 * later). Most useful when the SoS quietly renames the slug.
 */
export function findIdCandidateListLinks(
  html: string,
  electionYear: number,
): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $('a[href]').each((_i, a) => {
    const href = String($(a).attr('href') ?? '');
    if (!href) return;
    const lower = href.toLowerCase();
    if (!/candidate-list/.test(lower)) return;
    const yr = lower.match(/(\d{4})-/);
    if (!yr) return;
    const yearN = Number(yr[1]);
    if (Number.isFinite(yearN) && yearN >= electionYear - 1) {
      const abs = lower.startsWith('http')
        ? href
        : new URL(href, 'https://sos.idaho.gov').toString();
      out.add(abs);
    }
  });
  return Array.from(out);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse an Idaho per-cycle candidate-list HTML page.
 *
 * Structure (verified against 2020 primary list):
 *   <h2>2020 Primary Candidate List</h2>
 *   <h3>U.S. SENATOR</h3>
 *   <p>JOHN DOE — Republican</p>
 *   <p>JANE SMITH — Democratic</p>
 *   <h3>STATE SENATE DISTRICT 5</h3>
 *   ...
 *
 * We accept either '<p>' or '<li>' entries beneath the heading. Each
 * entry is "Name — Party" with em-dash, hyphen, or '|' as the separator.
 *
 * Returns [] if no recognizable structure (e.g. the WP page changed
 * layout). Production runs that get [] from a 200 page log a 'partial'
 * and surface for human review.
 */
export function parseIdahoCandidateList(
  html: string,
  opts: { electionDate: string; electionType: CandidacyInsertRow['election_type']; sourceTag: string },
): IdCandidacyRow[] {
  if (!html || html.length < 200) return [];
  const $ = cheerio.load(html);
  const out: IdCandidacyRow[] = [];
  const seen = new Set<string>();

  $('h3, h4').each((_i, h) => {
    const heading = $(h).text().replace(/\s+/g, ' ').trim();
    if (!heading) return;

    const district = extractDistrict(heading);
    const officeRaw = heading;

    // Walk siblings until next heading.
    let node = $(h).next();
    while (node.length && !/^h[1-6]$/i.test(node[0]!.name ?? '')) {
      const tag = node[0]!.name?.toLowerCase();
      if (tag === 'p' || tag === 'div') {
        const text = node.text().replace(/\s+/g, ' ').trim();
        if (text) extractCandidatesFromLine(text, officeRaw, district, opts, out, seen);
      } else if (tag === 'ul' || tag === 'ol') {
        node.find('li').each((_j, li) => {
          const text = $(li).text().replace(/\s+/g, ' ').trim();
          if (text) extractCandidatesFromLine(text, officeRaw, district, opts, out, seen);
        });
      }
      node = node.next();
    }
  });

  return out;
}

function extractCandidatesFromLine(
  line: string,
  officeRaw: string,
  district: string | null,
  opts: { electionDate: string; electionType: CandidacyInsertRow['election_type']; sourceTag: string },
  out: IdCandidacyRow[],
  seen: Set<string>,
): void {
  // Some entries put multiple candidates on one line separated by ';' or
  // bullets; split conservatively on ';' if present.
  const segs = line.includes(';') ? line.split(';') : [line];
  for (const seg of segs) {
    const s = seg.trim();
    if (!s) continue;
    // "John Doe — Republican" / "John Doe - Republican" / "John Doe | R"
    const m = s.match(
      /^([A-Z][A-Za-z'’.\- ]+?)\s*(?:[—–\-|•]|\(|,)\s*([A-Za-z][A-Za-z .]+?)\)?$/,
    );
    if (!m) continue;
    const name = m[1].trim();
    const party = m[2].trim();
    if (!name || !party) continue;
    if (/^total/i.test(name)) continue;
    const dedupKey = `id|${officeRaw.toLowerCase()}|${district ?? ''}|${party.toLowerCase()}|${name.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({
      reported_name: name,
      office_name: officeRaw,
      district_identifier: district,
      party_raw: party,
      date_filed: null,
      election_date: opts.electionDate,
      election_type: opts.electionType,
      source_row_id: dedupKey,
    });
  }
}

function extractDistrict(s: string): string | null {
  const m = s.match(/\bdistrict\s+0*(\d{1,3})\b/i);
  if (m && m[1]) return m[1];
  const trail = s.match(/\b0*(\d{1,3})\s*$/);
  if (trail && trail[1]) return trail[1];
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type IdCandidaciesAdapterOptions = {
  landingUrl?: string;
  /**
   * Slug variants to probe in order. Defaults to a list ordered
   * newest-first — we follow the first 200 hit.
   */
  slugCandidates?: readonly string[];
  electionYear?: number;
  /** Override election type (most 2026 candidacies are 'primary' filings). */
  electionType?: CandidacyInsertRow['election_type'];
  electionDate?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetchHtml?: (url: string) => Promise<{ status: number; body: string; resolvedUrl?: string }>;
};

export function createIdCandidaciesAdapter(
  options: IdCandidaciesAdapterOptions = {},
): SourceAdapter<IdCandidacyRow> {
  const landingUrl = options.landingUrl ?? DEFAULT_LANDING_URL;
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const electionType: CandidacyInsertRow['election_type'] =
    options.electionType ?? 'primary';
  const electionDate =
    options.electionDate ??
    (electionType === 'primary' ? PRIMARY_DATE : GENERAL_DATE);
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const slugCandidates = options.slugCandidates ?? CANDIDATE_LIST_SLUGS;

  const fetchOne =
    options.fetchHtml ??
    (async (url: string) => {
      const res = await politeFetch(url, { headers: { Accept: 'text/html,*/*' } });
      return {
        status: res.status,
        body: await res.text(),
        resolvedUrl: res.url,
      };
    });

  const adapter: SourceAdapter<IdCandidacyRow> = {
    name: 'sos-idaho-sos-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<IdCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching landing`, {
        stateFips: STATE_FIPS,
        url: landingUrl,
      });

      // 1) Fetch the landing page to anchor provenance.
      const landing = await fetchOne(landingUrl);
      if (landing.status >= 400) {
        throw new Error(
          `ID candidacies landing fetch failed: HTTP ${landing.status} from ${landingUrl}`,
        );
      }
      const landingHash = createHash('sha256').update(landing.body).digest('hex');

      // 2) From the landing, plus the static slug list, gather candidate URLs.
      const discovered = findIdCandidateListLinks(landing.body, electionYear);
      const candidateUrls = new Set<string>(discovered);
      for (const slug of slugCandidates) {
        candidateUrls.add(`https://sos.idaho.gov/elections-division/${slug}/`);
      }

      // 3) Probe each in order; keep the first 200 with usable structure.
      let matchedUrl: string | null = null;
      let matchedBody = '';
      let matchedStatus = 0;
      for (const url of candidateUrls) {
        try {
          const r = await fetchOne(url);
          if (r.status >= 200 && r.status < 300) {
            // The WP 404 page also returns 200 in some configs; rule it
            // out by checking <title>.
            if (/page\s*not\s*found/i.test(r.body.slice(0, 4096))) continue;
            matchedUrl = r.resolvedUrl ?? url;
            matchedBody = r.body;
            matchedStatus = r.status;
            break;
          }
        } catch {
          // Probe failure — try next slug.
        }
      }

      let rows: IdCandidacyRow[] = [];
      if (matchedBody) {
        rows = parseIdahoCandidateList(matchedBody, {
          electionDate,
          electionType,
          sourceTag: matchedUrl ?? '',
        });
      }

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        matched_url: matchedUrl,
        candidate_url_count: candidateUrls.size,
      });

      // Fold all bytes (landing + matched) into the content hash so a
      // landing-only run still differs from a list-found run.
      const finalHash = matchedBody
        ? createHash('sha256').update(landingHash).update(matchedBody).digest('hex')
        : landingHash;

      return {
        rows,
        expectedMinRows: 1,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'idaho-sos-candidacies',
          url: matchedUrl ?? landing.resolvedUrl ?? landingUrl,
          contentHash: finalHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            election_type: electionType,
            election_date: electionDate,
            primary_date: PRIMARY_DATE,
            general_date: GENERAL_DATE,
            landing_url: landingUrl,
            matched_status: matchedStatus,
            matched_url: matchedUrl,
            tried_urls: Array.from(candidateUrls),
            note: matchedUrl
              ? null
              : 'No 2026 candidate-list page yet. Adapter probed all known slug variants — re-run after Idaho SoS publishes the post-deadline list (statutory deadline 2026-03-13).',
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) return 'missing reported_name';
      if (!row.office_name || !row.office_name.trim()) return 'missing office_name';
      return null;
    },

    async insert(
      rows: IdCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertCandidacies(rows, refs, ctx, {
        stateFips: STATE_FIPS,
        source: 'sos-idaho-sos-candidacies',
        electionYear,
      });
    },
  };

  return adapter;
}
