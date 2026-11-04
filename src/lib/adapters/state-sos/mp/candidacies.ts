/**
 * Commonwealth Election Commission, CNMI — candidate-filings adapter
 * (FIPS 69).
 *
 * Source (verified 2026-04-25):
 *   https://www.votecnmi.gov.mp/                             (200, 134KB)
 *   https://www.votecnmi.gov.mp/downloads/2026/2026_GE_Candidates_Pamphlet-v2.pdf
 *                                                            (200, 768KB PDF)
 *   https://www.votecnmi.gov.mp/downloads/2026/2026_GE_Important_Dates.pdf
 *                                                            (key dates)
 *
 * Status: DORMANT.
 * ----------------
 * CNMI's filing deadline (per 2026 CEC schedule) is 2026-08-05 (90 days
 * before the November 3, 2026 general). As of 2026-04-25 the CEC has NOT
 * published a filed-candidate roster — the homepage carries the
 * Candidates Pamphlet (rules + forms, not a roster) and the Important
 * Dates PDF only. The filed-candidate roster has historically been
 * published as a press release / PDF in mid-August.
 *
 * 2026 CNMI ballot
 * ----------------
 *   - 1 × Delegate to U.S. House (At-large, non-voting)
 *   - 1 × Governor + Lt. Governor (joint ticket; runoff if no majority)
 *   - 9 × Senate (3 senators × 3 senatorial districts on the cycle)
 *   - 20 × House of Representatives (all 20 seats every 2 yrs)
 *   - 2 × State Board of Education seats
 *   - Mayoral races (Saipan, Tinian/Aguigan, Rota, Northern Islands)
 *   - Municipal Council seats per island
 *
 * When the CEC publishes the roster — typically as a press release or a
 * PDF posted to /downloads/2026/ — replace `parseCnmiCandidates()` below
 * with a real parser. Until then this adapter records dormant and
 * returns 0 rows.
 *
 * Office contact:
 *   Commonwealth Election Commission
 *   Web:   https://www.votecnmi.gov.mp/
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

const STATE_FIPS = '69';
const DEFAULT_SOURCE_URL = 'https://www.votecnmi.gov.mp/';

export type MpCandidacyRow = AsCandidacyRow;

export function parseCnmiCandidates(rawBody: string): MpCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  const $ = cheerio.load(rawBody);
  const rows: MpCandidacyRow[] = [];
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
      (h) => h.includes('district') || h.includes('precinct') || h.includes('island'),
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
        source_row_id: `mp-t${tableIdx}-r${rowIdx}`,
      });
    });
  });
  return rows;
}

export type CreateMpCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => MpCandidacyRow[];
};

export function createMpCandidaciesAdapter(
  options: CreateMpCandidaciesAdapterOptions = {},
): SourceAdapter<MpCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? new Date().getUTCFullYear();
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<MpCandidacyRow> = {
    name: 'sos-cnmi-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<MpCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('mp-candidacies: fetching', {
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
        ctx.logger.warn('mp-candidacies: fetch threw — returning empty', {
          error: err instanceof Error ? err.message : String(err),
          url: sourceUrl,
        });
      }

      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      const parser = options.parseOverride ?? parseCnmiCandidates;
      const rows = rawBody ? parser(rawBody) : [];

      ctx.logger.info('mp-candidacies: parsed', {
        rowCount: rows.length,
        bytes: rawBody.length,
      });

      return {
        rows,
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'cnmi-cec-candidacies',
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
              'CNMI Commonwealth Election Commission has not published a 2026 filed-candidate roster ' +
              'as of 2026-04-25. Filing deadline 2026-08-05; Doctor probes weekly through August.',
            candidates_pamphlet_url:
              'https://www.votecnmi.gov.mp/downloads/2026/2026_GE_Candidates_Pamphlet-v2.pdf',
            important_dates_url:
              'https://www.votecnmi.gov.mp/downloads/2026/2026_GE_Important_Dates.pdf',
            office_contact: {
              name: 'Commonwealth Election Commission',
              web: 'https://www.votecnmi.gov.mp/',
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
      rows: MpCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertTerritoryCandidacies(
        STATE_FIPS,
        'mp-sos-candidacies',
        rows,
        refs,
        ctx,
        electionYear,
      );
    },
  };

  return adapter;
}
