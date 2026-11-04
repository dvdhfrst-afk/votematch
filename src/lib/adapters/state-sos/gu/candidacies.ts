/**
 * Guam Election Commission (GEC) — candidate-filings adapter (FIPS 66).
 *
 * Source (verified 2026-04-25):
 *   https://gec.guam.gov/                          (TLS chain validation
 *                                                   FAILS via politeFetch)
 *   https://gec.guam.gov/2026-important-dates/     (same chain)
 *   https://gec.guam.gov/category/for-candidates/  (same chain)
 *
 * Status: DORMANT.
 * ----------------
 * gec.guam.gov ships an intermediate cert that Node's default trust store
 * doesn't accept (`fetch failed` w/ no further detail; OpenSSL chain not
 * verifiable). The site IS reachable from a browser. Tier-1 politeFetch
 * does NOT relax cert verification (and shouldn't — that's a security
 * regression for the rest of the platform). Two viable upgrades:
 *
 *   1. Pin the GEC intermediate into a per-host CA bundle and feed it via
 *      `tls.createSecureContext({ ca: [...] })` on a Node Agent. Council
 *      decision pending — this is the right long-term fix.
 *   2. Tier-2 Playwright fallback (already used by the OH adapter for
 *      Cloudflare); Chromium's trust store accepts the GEC chain. We can
 *      route GEC through `playwrightFetch` once tier-2 is stable on the
 *      ingestion worker.
 *
 * Until one of those lands, the adapter records the dormant status with
 * the office contact in source.meta so the Doctor can flip it to
 * 'productive' the moment fetch succeeds.
 *
 * Guam 2026 ballot
 * ----------------
 *   - 1 × Delegate to U.S. House (At-large, non-voting)
 *   - 1 × Governor + Lt. Governor (joint ticket)
 *   - 15 × Senator (unicameral Legislature, ALL seats every 2 yrs)
 *   - 19 × Mayor / Vice-Mayor (per-village)
 *   - Attorney General (separately elected)
 *   - Public Auditor (4-yr; 2026 cycle)
 *   - Consolidated Commission on Utilities, Guam Education Board, etc.
 *
 * Primary date: 2026-08-01. Filing deadline TBD per GEC; historical
 * pattern places deadline 90 days before the primary (~2026-05-04).
 *
 * Office contact:
 *   Guam Election Commission
 *   Web:   https://gec.guam.gov/
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

import { politeFetch } from '../../fetch-polite';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';
import { insertTerritoryCandidacies, type AsCandidacyRow } from '../as/candidacies';

const STATE_FIPS = '66';
const DEFAULT_SOURCE_URL = 'https://gec.guam.gov/category/for-candidates/';

export type GuCandidacyRow = AsCandidacyRow;

/** Defensive parser — same shape as AS so the moment a fetch succeeds we
 *  can extract candidate rows from any well-formed table on the page. */
export function parseGuamCandidates(rawBody: string): GuCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  const $ = cheerio.load(rawBody);
  const rows: GuCandidacyRow[] = [];
  $('table').each((tableIdx, tableEl) => {
    const $table = $(tableEl);
    const headerCells = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((_i, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headerCells.length === 0) return;
    const nameCol = headerCells.findIndex(
      (h) => h.includes('candidate') || h === 'name',
    );
    if (nameCol < 0) return;
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    const officeCol = headerCells.findIndex((h) => h.includes('office'));
    const districtCol = headerCells.findIndex(
      (h) => h.includes('district') || h.includes('village'),
    );

    let officeFromHeader = '';
    const $prev = $table.prevAll('h1,h2,h3,h4,caption').first();
    if ($prev.length) officeFromHeader = $prev.text().trim();

    $table.find('tr').each((rowIdx, trEl) => {
      if (rowIdx === 0) return;
      const cells = $(trEl)
        .find('td')
        .map((_i, el) => $(el).text().trim())
        .get();
      if (cells.length === 0) return;
      const name = cells[nameCol];
      if (!name) return;
      const office =
        officeCol >= 0 && cells[officeCol] ? cells[officeCol]! : officeFromHeader;
      if (!office) return;
      rows.push({
        reported_name: name,
        party_abbreviation:
          partyCol >= 0 && cells[partyCol] ? cells[partyCol]! : null,
        office_name: office,
        district_identifier:
          districtCol >= 0 && cells[districtCol] ? cells[districtCol]! : null,
        is_write_in: /write[-\s]*in/i.test(name),
        source_row_id: `gu-t${tableIdx}-r${rowIdx}`,
      });
    });
  });
  return rows;
}

export type CreateGuCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => GuCandidacyRow[];
};

export function createGuCandidaciesAdapter(
  options: CreateGuCandidaciesAdapterOptions = {},
): SourceAdapter<GuCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? new Date().getUTCFullYear();
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<GuCandidacyRow> = {
    name: 'sos-guam-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<GuCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('gu-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      let status = 0;
      let rawBody = '';
      let fetchErr: string | null = null;
      try {
        if (options.fetchOverride) {
          const r = await options.fetchOverride(sourceUrl);
          status = r.status;
          rawBody = r.body;
        } else {
          const res = await politeFetch(sourceUrl, {
            headers: { Accept: 'text/html,*/*;q=0.8' },
          });
          status = res.status;
          rawBody = await res.text();
        }
      } catch (err) {
        fetchErr = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(
          'gu-candidacies: fetch failed (likely TLS chain) — returning empty',
          { error: fetchErr, url: sourceUrl },
        );
      }

      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      const parser = options.parseOverride ?? parseGuamCandidates;
      const rows = rawBody ? parser(rawBody) : [];

      ctx.logger.info('gu-candidacies: parsed', {
        rowCount: rows.length,
        bytes: rawBody.length,
      });

      return {
        rows,
        // Dormant — TLS chain blocks tier-1 fetch. Doctor / Playwright
        // tier-2 will flip this to productive once a fetch succeeds.
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'guam-election-commission-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            byte_size: rawBody.length,
            http_status: status,
            fetch_error: fetchErr,
            adapter_status_hint: 'dormant',
            note:
              'gec.guam.gov serves an intermediate cert that Node default trust does not accept; ' +
              'switch to Playwright tier-2 or pin the GEC intermediate before flipping productive.',
            office_contact: {
              name: 'Guam Election Commission',
              web: 'https://gec.guam.gov/',
            },
            primary_date_2026: '2026-08-01',
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) {
        return 'missing reported_name';
      }
      if (!row.office_name || !row.office_name.trim()) {
        return 'missing office_name';
      }
      return null;
    },

    async insert(
      rows: GuCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertTerritoryCandidacies(
        STATE_FIPS,
        'gu-sos-candidacies',
        rows,
        refs,
        ctx,
        electionYear,
      );
    },
  };

  return adapter;
}
