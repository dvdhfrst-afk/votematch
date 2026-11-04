/**
 * Georgia Secretary of State — 2026 candidate-filings adapter (FIPS 13).
 *
 * Source pages (web-verified 2026-04-25):
 *   Landing: https://sos.ga.gov/election-information/candidate-filing-information
 *   Other:   https://sos.ga.gov/page/2026-elections
 *            https://sos.ga.gov/news/2026-qualifying-information
 *
 * Cloudflare status (2026-04-25 probe):
 *   Every URL on sos.ga.gov returns HTTP 403 ("Just a moment...") via
 *   politeFetch, the same Cloudflare ruleset family as ohiosos.gov. The
 *   adapter does not work around it and records an unproductive run.
 *
 * What's on the 2026 GA primary ballot (May 19, 2026):
 *   - Governor (incumbent term-limited)
 *   - Statewide row offices (Lt Gov, Sec State, AG, Treasurer, Insurance,
 *     Ag Commissioner, Labor, School Superintendent, PSC seats)
 *   - U.S. Senate (Class II seat)
 *   - U.S. House (14 districts)
 *   - State Senate (all 56 districts) + State House (all 180 districts)
 *   - Court of Appeals + Supreme Court (nonpartisan, but technically
 *     handled by SoS)
 *
 * Day-0 behaviour: fetch the landing page so the data_sources row records
 * provenance + content_hash, return [] from parse so the dispatcher
 * classifies the run as 'partial'. If a permitted data path appears,
 * write parseCandidateList() and feed it through fetchOverride.
 *
 * Alternate paths considered (not yet wired):
 *   - SoS press releases listing qualified candidates (sos.ga.gov/news/) —
 *     same CF wall.
 *   - News-org aggregations (AJC, GPB) — third-party, no machine-readable
 *     feed.
 *   - Ballotpedia state-page scraping — last-resort fallback per the
 *     project's data hierarchy; we don't ingest from third parties when
 *     the SoS publishes the same data, but reservation noted.
 */

import { createHash } from 'node:crypto';

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
import { isCloudflareChallenge } from '../oh/candidacies';

const STATE_FIPS = '13';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-05-19';
const GENERAL_DATE = '2026-11-03';

const DEFAULT_SOURCE_URL =
  'https://sos.ga.gov/election-information/candidate-filing-information';

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export type GaCandidacyRow = CandidacyInsertRow;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type GaCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Test override — return synthetic landing-page HTML. */
  fetchOverride?: () => Promise<{ status: number; body: string; resolvedUrl?: string }>;
  /** Test override — supply parsed rows directly. */
  parseOverride?: (html: string) => GaCandidacyRow[];
};

export function createGaCandidaciesAdapter(
  options: GaCandidaciesAdapterOptions = {},
): SourceAdapter<GaCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);

  const adapter: SourceAdapter<GaCandidacyRow> = {
    name: 'sos-georgia-sos-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<GaCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      const fetchImpl =
        options.fetchOverride ??
        (async () => {
          const res = await politeFetch(sourceUrl, {
            headers: { Accept: 'text/html,*/*' },
          });
          return {
            status: res.status,
            body: await res.text(),
            resolvedUrl: res.url,
          };
        });

      const { status, body, resolvedUrl } = await fetchImpl();
      const contentHash = createHash('sha256').update(body).digest('hex');
      const cfWalled = isCloudflareChallenge(status, body);

      let rows: GaCandidacyRow[] = [];
      if (cfWalled) {
        ctx.logger.warn(
          `${adapter.name}: Cloudflare challenge — returning [] (no workaround attempted for sos.ga.gov)`,
          { status, bytes: body.length, sourceUrl },
        );
      } else if (status >= 400) {
        throw new Error(
          `GA candidacies fetch failed: HTTP ${status} from ${sourceUrl}`,
        );
      } else if (options.parseOverride) {
        rows = options.parseOverride(body);
      } else {
        // Future home of parseGaCandidatesHtml. Today we only ever get a
        // CF page so this is unreachable in production; keep [] so a
        // synthetic-fixture run produces zero false positives.
      }

      return {
        rows,
        expectedMinRows: 1,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'georgia-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            general_date: GENERAL_DATE,
            cloudflare_walled: cfWalled,
            byte_size: body.length,
            note: 'sos.ga.gov is Cloudflare-walled; no automated workaround.',
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
      rows: GaCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertCandidacies(rows, refs, ctx, {
        stateFips: STATE_FIPS,
        source: 'sos-georgia-sos-candidacies',
        electionYear,
      });
    },
  };

  return adapter;
}
