/**
 * Kentucky Secretary of State — 2026 primary candidate-filings adapter (FIPS 21).
 *
 * Primary is 2026-05-19 (closed primary).
 *
 * Source (web-verified 2026-04-25):
 *   https://web.sos.ky.gov/CandidateFilings/Default.aspx?id=<N>
 *
 *   Live ASP.NET candidate-filings webapp from the KY SoS. The landing page
 *   (`Default.aspx`) lists category counts; per-category lists are reached
 *   by `?id=<N>`. Each category page is a single HTML response with a
 *   well-formed candidate table.
 *
 *   Statewide + federal categories (verified 2026-04-25):
 *     id=3   US Senator                    (20 candidates)
 *     id=4   US Representative             (43)
 *     id=11  State Senator                 (42)
 *     id=12  State Representative          (188)
 *     id=13  Commonwealth's Attorney       (1)
 *     id=14  Justice of the Supreme Court  (1)
 *     id=15  Judge of the Court of Appeals (3)
 *     id=16  Circuit Judge                 (4)
 *     id=17  District Judge                (130)
 *     id=20  Circuit Judge — Family Court  (5)
 *
 *   `id=3,4,11,12` cover federal + state-leg races (the BB tier-1 scope).
 *   Judicial categories (13-17, 20) are also fetched here because Kentucky
 *   judges are partisan-elected and qualify for matching surfaces. County
 *   filings live behind a separate `countyfilings.aspx` page (Phase 2).
 *
 * Schema of each per-category page (cheerio walk):
 *   - The candidate table sits inside a single `<table>` with class
 *     hooks `.candidates` / `gvCandidates`. Each candidate row has cells:
 *       Name / Running Mate    POBox/Email   Office   District/Division
 *       Party                  Date Filed
 *   - The page also has a "Withdrawn / Deceased / Disqualified" sub-table
 *     surfaced via `Default.aspx?withdrawn=1` — this adapter DOES walk
 *     in-scope withdrawn rows and marks them with `status='withdrew'`.
 *
 * The endpoint serves real HTML + plaintext rows; no Cloudflare or Imperva
 * walls observed. A plain politeFetch is enough.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { Pool } from 'pg';

import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '21';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-05-19';

const BASE_URL = 'https://web.sos.ky.gov/CandidateFilings/';

/**
 * SoS-defined category IDs for the 2026 primary. Ordered by ballot
 * importance — federal first, state-leg next, judicial last.
 *
 * `office_type_slug` is the canonical office_types.slug we resolve each
 * row to. `us_senate_class` only applies to US Senate (KY has 2 Senate
 * seats, only ONE of which is on any given ballot — Class II in 2026).
 */
const CATEGORY_IDS: Array<{
  id: number;
  office: string;
  office_type_slug: string;
  us_senate_class?: 'II' | 'III';
}> = [
  // US Senator on the 2026 ballot is Class II.
  { id: 3, office: 'US Senator', office_type_slug: 'us_senator', us_senate_class: 'II' },
  { id: 4, office: 'US Representative', office_type_slug: 'us_representative' },
  { id: 11, office: 'State Senator', office_type_slug: 'state_senator' },
  { id: 12, office: 'State Representative', office_type_slug: 'state_representative' },
  // Note: in our office_types catalog, KY DAs are slug='district_attorney'
  // (Commonwealth's Attorney is the KY-specific name; the office_type maps).
  { id: 13, office: "Commonwealth's Attorney", office_type_slug: 'district_attorney' },
  // Judicial offices use the catalog-canonical 'judge_*' slug naming.
  // These will silently skip on this run (KY has 0 judicial offices
  // currently seeded in `offices`); once judicial seeding lands, the
  // existing resolver path lights up automatically.
  { id: 14, office: 'Justice of the Supreme Court', office_type_slug: 'state_supreme_court_justice' },
  { id: 15, office: 'Judge of the Court of Appeals', office_type_slug: 'judge_court_of_appeals' },
  { id: 16, office: 'Circuit Judge', office_type_slug: 'judge_circuit_court' },
  { id: 17, office: 'District Judge', office_type_slug: 'judge_district_court' },
  // KY's "Family Court" is functionally a circuit-court judge sitting in
  // a family-court division. Keep them on judge_circuit_court until we
  // add a dedicated `judge_family_court` office_type.
  { id: 20, office: 'Circuit Judge — Family Court', office_type_slug: 'judge_circuit_court' },
];

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type KyCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string;
  date_filed: string | null;
  is_write_in: boolean;
  status: 'active' | 'withdrew' | 'disqualified' | 'deceased';
  source_row_id: string;
  /**
   * Canonical office_types.slug this category resolves to. Set by the
   * adapter loop from CATEGORY_IDS, not by the parser. Lets the insert
   * path skip the brittle name-text resolveOfficeElection() and look up
   * the office row directly by (slug, fips_state, district).
   */
  office_type_slug?: string;
  /**
   * For US Senator only: which seat is on the 2026 ballot ('II' or 'III').
   * Used to distinguish KY's two senate offices.
   */
  us_senate_class?: 'II' | 'III';
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type KyCandidaciesAdapterOptions = {
  /** Override per-category URLs (tests pass synthetic HTML paths). */
  categoryUrlBuilder?: (id: number) => string;
  electionYear?: number;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Inject a synchronous fetcher (tests). Returns full per-category HTML keyed by id. */
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  /** Inject a parser override for tests. */
  parseOverride?: (html: string, officeHint: string) => KyCandidacyRow[];
};

// ---------------------------------------------------------------------------
// Parser (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse one KY category-filing HTML page into KyCandidacyRow[].
 *
 * Strategy:
 *   1. Walk every `<tr>` whose text matches the canonical row shape
 *      "Name ... Office ... District ... Party ... Date".
 *   2. Use the page's `Office` column as the canonical office name (each
 *      KY page is single-office, but the table column is authoritative).
 *   3. Distinguish Active vs Withdrawn rows by detecting the "Withdrawn /
 *      Deceased / Disqualified" header that precedes withdrawn rows.
 */
export function parseKentuckyCandidatePage(
  html: string,
  officeHint: string,
): KyCandidacyRow[] {
  if (!html || html.length < 64) return [];
  const $ = cheerio.load(html);
  const rows: KyCandidacyRow[] = [];

  // The candidates and the withdrawn list are both tables. Walk every
  // table; flip a "isWithdrawn" flag once we cross the WDD header.
  let isWithdrawn = false;
  let rowCounter = 0;

  $('table').each((_tableIdx, tableEl) => {
    const $table = $(tableEl);
    // Detect WDD by header text inside or immediately preceding the table
    const tableText = $table.text();
    const prevText = $table.prev().text();
    if (/withdrawn\s*\/\s*deceased\s*\/\s*disqualified/i.test(prevText) ||
        /withdrawn\s*\/\s*deceased\s*\/\s*disqualified/i.test(tableText.slice(0, 200))) {
      isWithdrawn = true;
    }

    const headerCells = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((_i, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headerCells.length === 0) return;

    const nameCol = headerCells.findIndex(
      (h) => h.startsWith('name') || h.includes('candidate'),
    );
    const officeCol = headerCells.findIndex((h) => h === 'office' || h.startsWith('office'));
    const districtCol = headerCells.findIndex(
      (h) => h.includes('district') || h.includes('division'),
    );
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    const dateCol = headerCells.findIndex(
      (h) => h.includes('date') && (h.includes('filed') || h === 'date filed'),
    );
    if (nameCol < 0) return;

    $table.find('tr').each((rowIdx, trEl) => {
      if (rowIdx === 0) return;
      const cells = $(trEl)
        .find('td')
        .map((_i, el) => $(el).text().trim())
        .get();
      if (cells.length < 2) return;
      const name = (cells[nameCol] ?? '').trim();
      if (!name) return;
      // KY tables embed sub-rows with email/PO box; first line is name
      const firstName = name.split(/\n/)[0]?.trim() ?? name;
      const office = officeCol >= 0 ? (cells[officeCol] ?? officeHint) : officeHint;
      const district = districtCol >= 0 ? cells[districtCol] || null : null;
      const party = partyCol >= 0 ? cells[partyCol] || '' : '';
      const dateRaw = dateCol >= 0 ? cells[dateCol] || '' : '';

      rows.push({
        reported_name: firstName,
        office_name: office || officeHint,
        district_identifier: normalizeDistrict(district),
        party_raw: party,
        date_filed: normalizeDate(dateRaw),
        is_write_in: /write[-\s]*in/i.test(party),
        status: isWithdrawn ? 'withdrew' : 'active',
        source_row_id: `ky-${officeHint.replace(/\W+/g, '_').toLowerCase()}-${rowCounter++}`,
      });
    });
  });

  return rows;
}

function normalizeDistrict(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)(?:st|nd|rd|th)?/);
  return m?.[1] ?? null;
}

function normalizeDate(raw: string): string | null {
  if (!raw) return null;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw.trim());
  if (us) {
    const mm = us[1]!.padStart(2, '0');
    const dd = us[2]!.padStart(2, '0');
    const yyyy = us[3]!.length === 2 ? `20${us[3]!}` : us[3]!;
    return `${yyyy}-${mm}-${dd}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createKyCandidaciesAdapter(
  options: KyCandidaciesAdapterOptions = {},
): SourceAdapter<KyCandidacyRow> {
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const urlBuilder =
    options.categoryUrlBuilder ?? ((id: number) => `${BASE_URL}Default.aspx?id=${id}`);
  const fetchImpl =
    options.fetchOverride ??
    (async (url: string) => {
      const r = await politeFetch(url, {
        headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      });
      const body = await r.text();
      return { status: r.status, body };
    });
  const parser = options.parseOverride ?? parseKentuckyCandidatePage;

  const adapter: SourceAdapter<KyCandidacyRow> = {
    name: 'sos-kentucky-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<KyCandidacyRow>> {
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        categoryCount: CATEGORY_IDS.length,
      });

      const allRows: KyCandidacyRow[] = [];
      const hashes: string[] = [];
      let totalBytes = 0;
      let lastError: string | null = null;

      for (const cat of CATEGORY_IDS) {
        await bucket.acquire();
        const url = urlBuilder(cat.id);
        try {
          const { status, body } = await fetchImpl(url);
          if (status >= 400) {
            lastError = `HTTP ${status} on category ${cat.office} (id=${cat.id})`;
            ctx.logger.warn(`${adapter.name}: ${lastError}`);
            continue;
          }
          totalBytes += body.length;
          hashes.push(createHash('sha256').update(body).digest('hex'));
          const catRows = parser(body, cat.office);
          // Attach canonical office_type slug + senate class to every row
          // produced by this category. Parser stays slug-free — slugs are
          // an ingestion-side concept tied to the database catalog.
          for (const r of catRows) {
            r.office_type_slug = cat.office_type_slug;
            if (cat.us_senate_class) r.us_senate_class = cat.us_senate_class;
          }
          ctx.logger.info(`${adapter.name}: category fetched`, {
            id: cat.id,
            office: cat.office,
            bytes: body.length,
            rows: catRows.length,
          });
          allRows.push(...catRows);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(`${adapter.name}: category fetch failed`, {
            id: cat.id,
            office: cat.office,
            error: lastError,
          });
        }
      }

      // Aggregate hash across all categories so re-runs are stable.
      const aggregateHash = createHash('sha256')
        .update(hashes.join('|'))
        .digest('hex');

      return {
        rows: allRows,
        // KY 2026 has 20 + 43 + 42 + 188 = 293 rows in the federal+state
        // leg scope alone; floor at 100 to catch a major data outage but
        // still allow a partial-published run during early filing windows.
        expectedMinRows: 100,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'kentucky-sos-candidacies',
          url: `${BASE_URL}Default.aspx`,
          contentHash: aggregateHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            byte_size: totalBytes,
            categories_fetched: hashes.length,
            categories_attempted: CATEGORY_IDS.length,
            last_error: lastError,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name?.trim()) return 'missing reported_name';
      if (!row.office_name) return 'missing office_name';
      if (!row.party_raw) return 'missing party_raw';
      return null;
    },

    async insert(
      rows: KyCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      const stats: InsertStats = {
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        errors: [],
      };
      if (rows.length === 0) return stats;

      // Cache the full resolveOfficeElection() result so cache hits short-
      // circuit correctly. Storing only `election_id` and reconstructing
      // {election_id, office_id:''} on hit produced an empty-string uuid that
      // postgres rejected with "invalid input syntax for type uuid" — every
      // KY row failed at insert (2026-04-26 regression). A `null` value
      // means we already tried this key and got no match.
      const officeCache = new Map<string, { election_id: string; office_id: string } | null>();

      for (const row of rows) {
        try {
          const cacheKey = `${row.office_type_slug ?? row.office_name}|${row.district_identifier ?? ''}|${row.us_senate_class ?? ''}`;
          let officeInfo: { election_id: string; office_id: string } | null;
          if (officeCache.has(cacheKey)) {
            officeInfo = officeCache.get(cacheKey) ?? null;
          } else {
            // KY-specific resolver: matches by office_type slug + state +
            // district (avoiding the cross-pollination from text-tokens
            // like "state senator" matching "United States Senator from
            // Kentucky"), and creates the 2026 primary election if the
            // office row exists but no election row does (most KY state-
            // leg + judicial offices are seeded without 2026 election
            // records).
            officeInfo = await resolveKyOfficeAndEnsurePrimary(
              ctx.pg,
              {
                office_type_slug: row.office_type_slug,
                district_identifier: row.district_identifier,
                us_senate_class: row.us_senate_class,
                election_year: electionYear,
                primary_date: PRIMARY_DATE,
                ctx,
              },
            );
            officeCache.set(cacheKey, officeInfo);
          }

          if (!officeInfo) {
            stats.rowsSkipped += 1;
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `KY office not resolved: "${row.office_name}" district=${row.district_identifier ?? '-'} slug=${row.office_type_slug ?? '-'}`,
              row,
            );
            continue;
          }

          if (ctx.dryRun) {
            stats.rowsInserted += 1;
            continue;
          }

          const personId = await findOrCreateStatePerson(ctx.pg, {
            name: row.reported_name,
            state_fips: STATE_FIPS,
            electionYear,
            source: 'sos-kentucky-candidacies',
            dataSourceId: refs.dataSourceId,
          });

          const candidacyRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
            `INSERT INTO candidacies
               (election_id, person_id, party, status, filed_on, meta)
             VALUES ($1, $2, $3, $4, $5::date, $6::jsonb)
             ON CONFLICT (election_id, person_id) DO UPDATE
               SET party = EXCLUDED.party,
                   status = EXCLUDED.status,
                   filed_on = COALESCE(candidacies.filed_on, EXCLUDED.filed_on)
             RETURNING id, (xmax = 0) AS inserted`,
            [
              officeInfo.election_id,
              personId,
              row.party_raw,
              row.status,
              row.date_filed,
              JSON.stringify({
                source: 'sos-kentucky-candidacies',
                reported_office: row.office_name,
                reported_district: row.district_identifier,
                source_row_id: row.source_row_id,
                data_source_id: refs.dataSourceId,
              }),
            ],
          );
          const candidacyId = candidacyRes.rows[0]!.id;
          if (candidacyRes.rows[0]!.inserted) stats.rowsInserted += 1;
          else stats.rowsUpdated += 1;

          const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);
          if (partyId) {
            await ctx.pg.query(
              `INSERT INTO candidacy_party_lines
                 (candidacy_id, party_id, ballot_line_order, nomination_method,
                  qualified_on, data_source_id, meta)
               VALUES ($1, $2, 1, 'primary', $3::date, $4::uuid, $5::jsonb)
               ON CONFLICT (candidacy_id, party_id) DO NOTHING`,
              [
                candidacyId,
                partyId,
                row.date_filed,
                refs.dataSourceId ?? null,
                JSON.stringify({ source: 'sos-kentucky-candidacies' }),
              ],
            );
          } else {
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `KY party not resolved: "${row.party_raw}" for ${row.reported_name}`,
              row,
            );
          }
        } catch (err) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: `KY candidacy insert: ${err instanceof Error ? err.message : String(err)}`,
            rawInput: row,
          });
          ctx.logger.warn(`${adapter.name}: insert failed`, {
            error: err instanceof Error ? err.message : String(err),
            row: row.reported_name,
          });
        }
      }
      return stats;
    },
  };

  return adapter;
}

async function logIngestionError(
  ctx: AdapterContext,
  ingestionRunId: string,
  errorType: 'parse' | 'validation' | 'fk_violation' | 'other',
  message: string,
  rawInput: unknown,
): Promise<void> {
  try {
    await ctx.supabase.from('ingestion_errors').insert({
      ingestion_run_id: ingestionRunId,
      error_type: errorType,
      error_message: message.slice(0, 2000),
      raw_input: rawInput,
    });
  } catch (err) {
    ctx.logger.warn('sos-kentucky-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// KY-specific office + election resolution
// ---------------------------------------------------------------------------

type ResolveKyInput = {
  /** office_types.slug (e.g. 'us_representative', 'state_senator'). */
  office_type_slug: string | undefined;
  /** Numeric district extracted by the parser (e.g. '5'). May be null
   *  for statewide offices (US Senator, Justice of the Supreme Court). */
  district_identifier: string | null;
  /** For US Senate only — KY has 2 senate offices and only one is up. */
  us_senate_class?: 'II' | 'III';
  election_year: number;
  /** ISO YYYY-MM-DD primary date used to ensure-create elections. */
  primary_date: string;
  ctx: AdapterContext;
};

/**
 * Resolve the (office_id, election_id) for a KY candidate row, creating
 * a primary election on demand when the office exists but no 2026
 * election row has been seeded. Idempotent (uses the
 * elections_office_id_election_date_election_type_key unique).
 *
 * Strategy:
 *   1. Find the office row by (office_type.slug, fips_state='21',
 *      district_identifier). For US Senator, additionally filter by
 *      seat_designation = 'Senior Seat' (Class II = up in 2026) /
 *      'Junior Seat' (Class III) so we don't ambiguously match both.
 *   2. Look up an existing election for this office in election_year.
 *      Prefer election_type='primary'; fall back to any election in
 *      that year if exactly one exists.
 *   3. If no election exists, INSERT a primary at primary_date
 *      (ON CONFLICT does nothing). This creates a row tagged with
 *      data_quality_tier='compiled' in meta so we can later promote
 *      election seed data to authoritative.
 */
async function resolveKyOfficeAndEnsurePrimary(
  pg: Pool,
  input: ResolveKyInput,
): Promise<{ office_id: string; election_id: string } | null> {
  const slug = input.office_type_slug;
  if (!slug) {
    // Caller didn't tag the row with a slug. Should never happen for
    // KY because every CATEGORY_IDS entry now sets office_type_slug,
    // but keep a safety net for tests + future categories.
    return null;
  }

  // ---- Step 1: find office_id -------------------------------------------
  // For statewide single-seat offices (governor, supreme court justices),
  // there is exactly one office row per slug per state — no district
  // filter needed. For multi-seat offices (state senator, state rep, US
  // House, district judges), filter by district_identifier.
  const district = input.district_identifier?.trim();

  const params: Array<string | number> = [STATE_FIPS, slug];
  let extraWhere = '';

  // KY US Senate special-case: pick the seat that's actually on this
  // primary's ballot. Class II = "Senior Seat" (seeded that way in
  // app/scripts/ingest-federal-incumbents.ts); Class III = "Junior Seat".
  if (slug === 'us_senator' && input.us_senate_class) {
    extraWhere = ` AND o.seat_designation = $${params.length + 1}`;
    params.push(input.us_senate_class === 'II' ? 'Senior Seat' : 'Junior Seat');
  } else if (district && /^\d+$/.test(district)) {
    // Match the office whose seat_designation or canonical_name ends
    // with this district number (avoids matching '1' inside '11').
    extraWhere =
      ` AND (o.seat_designation ~ $${params.length + 1}` +
      ` OR o.canonical_name ~ $${params.length + 1})`;
    // Anchor to non-digit before + end-of-string after. Examples that match:
    //   "Senate District 1", "House District 5", "District 23",
    //   "Kentucky's 4th Congressional District".
    // Examples that do NOT match: "Senate District 11" when district=1.
    params.push(`(^|[^0-9])${district}([^0-9]|$)`);
  }

  const officeSql = `
    SELECT o.id AS office_id, o.canonical_name, o.seat_designation
    FROM offices o
    JOIN jurisdictions j ON j.id = o.jurisdiction_id
    JOIN office_types ot ON ot.id = o.office_type_id
    WHERE j.fips_state = $1
      AND ot.slug = $2
      ${extraWhere}
    LIMIT 5
  `;
  const officeRes = await pg.query<{ office_id: string }>(officeSql, params);
  if (officeRes.rows.length === 0) return null;
  if (officeRes.rows.length > 1) {
    // Multiple offices match — bail rather than pick wrong one.
    input.ctx.logger.warn(
      `sos-kentucky-candidacies: ambiguous office match (${officeRes.rows.length} rows)`,
      { slug, district, us_senate_class: input.us_senate_class },
    );
    return null;
  }
  const officeId = officeRes.rows[0]!.office_id;

  // ---- Step 2: find existing election -----------------------------------
  // Prefer a primary in election_year; tolerate any-type election if
  // exactly one exists for that year.
  const elFind = await pg.query<{ id: string; election_type: string }>(
    `SELECT id, election_type
       FROM elections
      WHERE office_id = $1
        AND EXTRACT(YEAR FROM election_date)::int = $2
      ORDER BY (election_type = 'primary') DESC, election_date ASC
      LIMIT 5`,
    [officeId, input.election_year],
  );
  if (elFind.rows.length > 0) {
    return { office_id: officeId, election_id: elFind.rows[0]!.id };
  }

  // ---- Step 3: create primary on the fly --------------------------------
  // Tagged compiled so the data-quality watcher knows where it came from.
  const elIns = await pg.query<{ id: string }>(
    `INSERT INTO elections
       (office_id, election_date, election_type, meta)
     VALUES ($1, $2::date, 'primary', $3::jsonb)
     ON CONFLICT (office_id, election_date, election_type) DO UPDATE
       SET meta = elections.meta
     RETURNING id`,
    [
      officeId,
      input.primary_date,
      JSON.stringify({
        source: 'sos-kentucky-candidacies',
        data_quality_tier: 'compiled',
        ensured_by: 'sos-kentucky-candidacies@2026-04-25',
      }),
    ],
  );
  if (elIns.rows[0]) {
    return { office_id: officeId, election_id: elIns.rows[0].id };
  }

  // Race recovery: another writer just inserted a matching primary.
  const reread = await pg.query<{ id: string }>(
    `SELECT id FROM elections
      WHERE office_id = $1 AND election_date = $2::date AND election_type = 'primary'
      LIMIT 1`,
    [officeId, input.primary_date],
  );
  if (reread.rows[0]) {
    return { office_id: officeId, election_id: reread.rows[0].id };
  }
  return null;
}
