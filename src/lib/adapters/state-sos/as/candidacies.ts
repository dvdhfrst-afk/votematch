/**
 * American Samoa Election Office — candidate-filings adapter (FIPS 60).
 *
 * Source (verified 2026-04-25):
 *   https://www.aselectionoffice.gov/                       (landing — 200 OK)
 *   https://www.aselectionoffice.gov/candidates-information (200 OK)
 *
 * Status: DORMANT for now.
 * ------------------------
 * American Samoa's 2026 cycle has a single statewide November 3, 2026
 * general election (no separate primary). Filing deadline is
 * September 1, 2026. Offices on the ballot:
 *   - 1 × Delegate to the U.S. House (At-large, non-voting)
 *   - 1 × Governor + Lt. Governor (joint ticket)
 *   - 21 × Fono House of Representatives (all 20 elected seats; the
 *     Swains Island delegate is appointed)
 *   - Some Fono Senate seats are selected by traditional county councils
 *     (matai), not popular vote — those are not adapter targets.
 *
 * Why empty body
 * --------------
 * As of 2026-04-25 the Election Office has NOT published a public
 * filed-candidate list. The candidates-information page (probed via
 * politeFetch above) contains procedural / form text only — no tables,
 * no PDF rosters, no machine-readable feed. The Doctor will probe this
 * adapter periodically; once a roster appears, swap in
 * `parseAmericanSamoaCandidates()` and bump expectedMinRows.
 *
 * Office contact for status checks:
 *   American Samoa Election Office
 *   Web:  https://www.aselectionoffice.gov/
 *
 * Adapter is registered as DORMANT (adapter_status='dormant') so the
 * dispatcher and Doctor know to ping the candidates-information page on
 * a slow cadence, look for a newly-published roster, and flip to
 * 'productive' once one lands.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '60';
const DEFAULT_SOURCE_URL =
  'https://www.aselectionoffice.gov/candidates-information';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type AsCandidacyRow = {
  reported_name: string;
  party_abbreviation: string | null;
  office_name: string;
  district_identifier: string | null;
  is_write_in: boolean;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Parse (dormant — no published roster yet)
// ---------------------------------------------------------------------------

/**
 * Stub parser. Returns [] until AS Election Office begins publishing a
 * machine-readable candidate roster. Exported so tests can feed synthetic
 * HTML once we design the post-deadline format.
 */
export function parseAmericanSamoaCandidates(rawBody: string): AsCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  // Defensive: if a future page DOES carry tables, try the same generic
  // header-driven approach used by the OH adapter so we degrade gracefully
  // the moment the site starts publishing structured data.
  const $ = cheerio.load(rawBody);
  const rows: AsCandidacyRow[] = [];
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
    const districtCol = headerCells.findIndex((h) => h.includes('district'));

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
        officeCol >= 0 && cells[officeCol]
          ? cells[officeCol]
          : officeFromHeader;
      if (!office) return;
      rows.push({
        reported_name: name,
        party_abbreviation:
          partyCol >= 0 && cells[partyCol] ? cells[partyCol]! : null,
        office_name: office,
        district_identifier:
          districtCol >= 0 && cells[districtCol] ? cells[districtCol]! : null,
        is_write_in: /write[-\s]*in/i.test(name),
        source_row_id: `as-t${tableIdx}-r${rowIdx}`,
      });
    });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Options / factory
// ---------------------------------------------------------------------------

export type CreateAsCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  /** Test-only synchronous fetch override. */
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => AsCandidacyRow[];
};

export function createAsCandidaciesAdapter(
  options: CreateAsCandidaciesAdapterOptions = {},
): SourceAdapter<AsCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? new Date().getUTCFullYear();
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<AsCandidacyRow> = {
    name: 'sos-american-samoa-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<AsCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('as-candidacies: fetching', {
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
        // AS Election Office's host is intermittently down. Treat as
        // empty (dormant) rather than failed so the run records 'partial'.
        ctx.logger.warn('as-candidacies: fetch threw — returning empty', {
          error: err instanceof Error ? err.message : String(err),
          url: sourceUrl,
        });
        rawBody = '';
        status = 0;
      }

      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      const parser = options.parseOverride ?? parseAmericanSamoaCandidates;
      const rows = rawBody ? parser(rawBody) : [];

      ctx.logger.info('as-candidacies: parsed', {
        rowCount: rows.length,
        bytes: rawBody.length,
      });

      return {
        rows,
        // Dormant until AS publishes a roster. expectedMinRows=0 keeps the
        // run from being marked 'partial' for an honestly-empty source.
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'american-samoa-election-office-candidacies',
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
              'AS Election Office does not publish a public filed-candidate list as of 2026-04-25. ' +
              'Filing deadline 2026-09-01; Doctor probes periodically to detect publication.',
            office_contact: {
              name: 'American Samoa Election Office',
              web: 'https://www.aselectionoffice.gov/',
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
      rows: AsCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertTerritoryCandidacies(
        STATE_FIPS,
        'as-sos-candidacies',
        rows,
        refs,
        ctx,
        electionYear,
      );
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert (people + candidacies + candidacy_party_lines)
// ---------------------------------------------------------------------------

/**
 * Shared territory insert path. Mirrors the IN/OH candidacy insert pipeline
 * but lives here so each territory adapter is self-contained for now;
 * once we have ≥3 territories shipping productive data we can lift this
 * into a `territories/shared.ts` helper.
 */
export async function insertTerritoryCandidacies(
  stateFips: string,
  source: string,
  rows: AsCandidacyRow[],
  refs: InsertRefs,
  ctx: AdapterContext,
  electionYear: number,
): Promise<InsertStats> {
  const stats: InsertStats = {
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    errors: [],
  };
  if (rows.length === 0) return stats;

  for (const row of rows) {
    try {
      const officeInfo = await resolveOfficeElection(ctx.pg, {
        state_fips: stateFips,
        office_name: row.office_name,
        district_identifier: row.district_identifier,
        election_year: electionYear,
      });
      if (!officeInfo) {
        stats.rowsSkipped += 1;
        continue;
      }

      const personId = await findOrCreateStatePerson(ctx.pg, {
        name: row.reported_name,
        state_fips: stateFips,
        electionYear,
        source,
        dataSourceId: refs.dataSourceId,
      });

      const candidacyRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
        `INSERT INTO candidacies
           (election_id, person_id, party, status, meta)
         VALUES ($1, $2, $3, 'active', $4::jsonb)
         ON CONFLICT (election_id, person_id) DO UPDATE
           SET meta = candidacies.meta
         RETURNING id, (xmax = 0) AS inserted`,
        [
          officeInfo.election_id,
          personId,
          row.party_abbreviation,
          JSON.stringify({
            source,
            reported_office: row.office_name,
            reported_district: row.district_identifier,
            data_source_id: refs.dataSourceId,
            ingestion_run_id: refs.ingestionRunId,
            source_row_id: row.source_row_id,
          }),
        ],
      );

      const candidacyId = candidacyRes.rows[0]?.id;
      const wasInserted = candidacyRes.rows[0]?.inserted === true;
      if (!candidacyId) {
        stats.rowsFailed += 1;
        continue;
      }
      if (wasInserted) stats.rowsInserted += 1;
      else stats.rowsUpdated += 1;

      if (row.party_abbreviation) {
        const partyId = await resolvePartyId(
          ctx.pg,
          row.party_abbreviation,
          stateFips,
        );
        if (partyId) {
          await ctx.pg.query(
            `INSERT INTO candidacy_party_lines
               (candidacy_id, party_id, ballot_line_order,
                nomination_method, data_source_id, meta)
             VALUES ($1, $2, 1, 'primary', $3, $4::jsonb)
             ON CONFLICT (candidacy_id, party_id) DO NOTHING`,
            [
              candidacyId,
              partyId,
              refs.dataSourceId,
              JSON.stringify({ source, reported_party: row.party_abbreviation }),
            ],
          );
        }
      }
    } catch (err) {
      stats.rowsFailed += 1;
      stats.errors.push({
        type: 'other',
        message: `row: ${err instanceof Error ? err.message : String(err)}`,
        rawInput: row,
      });
    }
  }

  return stats;
}
