/**
 * U.S. Virgin Islands Joint Board of Elections (VIVOTE) — candidate-filings
 * adapter (FIPS 78).
 *
 * Source (verified 2026-04-25):
 *   https://vivote.gov/                            (200, 197KB)
 *   https://vivote.gov/candidates/                 (200, 143KB)
 *   https://vivote.gov/candidates/candidate-forms/ (200, 159KB)
 *   https://vivote.gov/elections/                  (200, 144KB)
 *   https://electionarchive.vivote.gov/            (200; historical)
 *
 * Status: DORMANT.
 * ----------------
 * USVI's 2026 cycle has the November 3, 2026 general election (no
 * primary). Per Ballotpedia + the VIVOTE candidates page: filing window
 * opens 2026-04-19 (first day to circulate nominating petitions); filing
 * deadline 2026-05-19. As of 2026-04-25 the candidates page references
 * 2026 dates but does NOT yet host a structured filed-candidate roster —
 * that's typical; rosters appear post-deadline (late May).
 *
 * 2026 USVI ballot
 * ----------------
 *   - 1 × Delegate to U.S. House (At-large, non-voting; incumbent plus four challengers reported)
 *   - 1 × Governor + Lt. Governor (joint ticket; runoff Nov 17 if needed)
 *   - 15 × Senator (unicameral 36th Legislature; 7 from St. Croix
 *     district, 7 from St. Thomas/St. John, 1 at-large from St. John)
 *   - Board of Elections seats (separate per-district)
 *
 * The Doctor will probe `vivote.gov/candidates/` weekly through May/June
 * 2026 and flip `adapter_status='productive'` once a structured roster
 * lands. Until then this returns 0 rows.
 *
 * Office contact:
 *   Joint Board of Elections, U.S. Virgin Islands
 *   Web:   https://vivote.gov/
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

const STATE_FIPS = '78';
const DEFAULT_SOURCE_URL = 'https://vivote.gov/candidates/';

export type ViCandidacyRow = AsCandidacyRow;

export function parseUsviCandidates(rawBody: string): ViCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  const $ = cheerio.load(rawBody);
  const rows: ViCandidacyRow[] = [];
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
      (h) => h.includes('district') || h.includes('island'),
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
        source_row_id: `vi-t${tableIdx}-r${rowIdx}`,
      });
    });
  });
  return rows;
}

export type CreateViCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => ViCandidacyRow[];
};

export function createViCandidaciesAdapter(
  options: CreateViCandidaciesAdapterOptions = {},
): SourceAdapter<ViCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? new Date().getUTCFullYear();
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<ViCandidacyRow> = {
    name: 'sos-usvi-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<ViCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('vi-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      let status = 0;
      let rawBody = '';
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
        ctx.logger.warn('vi-candidacies: fetch threw — returning empty', {
          error: err instanceof Error ? err.message : String(err),
          url: sourceUrl,
        });
      }

      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      const parser = options.parseOverride ?? parseUsviCandidates;
      const rows = rawBody ? parser(rawBody) : [];

      ctx.logger.info('vi-candidacies: parsed', {
        rowCount: rows.length,
        bytes: rawBody.length,
      });

      return {
        rows,
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'usvi-vivote-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            byte_size: rawBody.length,
            http_status: status,
            adapter_status_hint: 'dormant',
            note:
              'USVI Joint Board of Elections has not yet published a 2026 filed-candidate roster ' +
              '(filing deadline 2026-05-19). Doctor probes weekly through June.',
            office_contact: {
              name: 'Joint Board of Elections, U.S. Virgin Islands',
              web: 'https://vivote.gov/',
            },
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
      rows: ViCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertTerritoryCandidacies(
        STATE_FIPS,
        'vi-sos-candidacies',
        rows,
        refs,
        ctx,
        electionYear,
      );
    },
  };

  return adapter;
}
