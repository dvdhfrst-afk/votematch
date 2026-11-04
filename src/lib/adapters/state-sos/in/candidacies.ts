/**
 * Indiana Secretary of State — 2026 primary candidate-filings adapter (FIPS 18).
 *
 * Primary is 2026-05-05 (open primary; voter requests party ballot at polls).
 *
 * Source (web-verified 2026-04-24):
 *   https://www.in.gov/sos/elections/files/Primary-Candidate-List-3.25.26.xlsx
 *     — Authoritative XLSX from the Indiana Election Division. One sheet
 *       (`Candidate_List_Abbreviated_2026`) listing every filed 2026
 *       primary candidate across all levels (federal → state → local).
 *       Columns: OFFICE, CANDIDATE NAME, POLITICAL PARTY, DISTRICT, DATE
 *       FILED. Filing deadline was 2026-02-06; list is republished as
 *       withdrawals / court orders come in (current snapshot is 3/25).
 *
 * What's on the 2026 IN primary ballot:
 *   - US Representative, Districts 1-9
 *   - State Senator (half the chamber — districts on the 2026 cycle)
 *   - State Representative (all 100 districts)
 *   - NO US Senate (Young, Banks terms run through 2028/2030)
 *   - NO Governor / Lt Gov (Braun term runs through 2028)
 *   - Sec State / AG / Treasurer are NOT primary — selected at state party
 *     conventions in June 2026 per Indiana Code. Ingested separately.
 *   - Local races (township, county, municipal, judicial, delegates,
 *     precinct committeemen) are intentionally skipped — Phase 2.
 *
 * What this adapter writes (per filed candidate):
 *   1. people row — find-or-create keyed on canonical_key
 *      (lower+strip-nonalnum of canonical_name, matches the DB trigger)
 *   2. elections row — find-or-create for (office_id, 2026-05-05, 'primary')
 *   3. candidacies row — upsert on (election_id, person_id)
 *   4. candidacy_party_lines — upsert primary line (ballot_line_order=1,
 *      nomination_method='primary') mapped to parties.id for D/R
 *
 * Differs from the base state-sos adapter factory (base.ts) because that
 * one targets election_results. This adapter produces filed-candidacy rows
 * and owns its own insert() — but reuses resolveOfficeElection()
 * (via the offices table) and resolvePartyId() for state scope 18 → D/R.
 *
 * Idempotent: re-running the adapter updates status+party on existing
 * candidacies rather than duplicating. People rows are deduped by
 * canonical_key across runs (and across states).
 */

import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import type { Pool } from 'pg';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';
import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '18';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-05-05';

const DEFAULT_SOURCE_URL =
  'https://www.in.gov/sos/elections/files/Primary-Candidate-List-3.25.26.xlsx';

/**
 * Offices that appear on the 2026 IN primary ballot (statewide+federal+leg).
 * Anything else in the XLSX (Convention Delegate, Precinct Committeeman,
 * Township/County/Municipal/Judicial) is a local race — skipped here and
 * picked up by a Phase 2 adapter.
 */
const TARGET_OFFICES = new Set<string>([
  'US REPRESENTATIVE',
  'STATE SENATOR',
  'STATE REPRESENTATIVE',
]);

/** Lookup: office slug (matches office_types.slug used elsewhere). */
const OFFICE_TYPE_SLUG: Record<string, string> = {
  'US REPRESENTATIVE': 'us_representative',
  'STATE SENATOR': 'state_senator',
  'STATE REPRESENTATIVE': 'state_representative',
};

/** Words -> district number. Indiana uses both ordinal words (US House) and
 *  zero-padded digits (state leg) — normalize both to the bare integer. */
const ORDINAL_WORDS: Record<string, string> = {
  first: '1',
  second: '2',
  third: '3',
  fourth: '4',
  fifth: '5',
  sixth: '6',
  seventh: '7',
  eighth: '8',
  ninth: '9',
  tenth: '10',
  eleventh: '11',
  twelfth: '12',
  thirteenth: '13',
  fourteenth: '14',
  fifteenth: '15',
  sixteenth: '16',
  seventeenth: '17',
  eighteenth: '18',
  nineteenth: '19',
  twentieth: '20',
};

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type InCandidacyRow = {
  /** As published in the 'CANDIDATE NAME' column. */
  reported_name: string;
  /** 'US REPRESENTATIVE' | 'STATE SENATOR' | 'STATE REPRESENTATIVE' (filtered). */
  office_category: string;
  /** slug used against office_types.slug (us_representative, state_senator, state_representative). */
  office_type_slug: string;
  /** District number as a bare integer string ('1', '8', '42'). */
  district_identifier: string;
  /** 'Democratic' | 'Republican' (raw as printed). */
  party_raw: string;
  /** Date filed (ISO yyyy-mm-dd) if parseable, else null. */
  date_filed: string | null;
  /** Unique per-row id for provenance/idempotency; encoded as office|party|name|district. */
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type InCandidaciesAdapterOptions = {
  /** Override the XLSX URL (useful if Indiana reposts the file under a new name). */
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Inject a raw-bytes fetcher (tests pass synthetic workbooks). */
  fetch?: (ctx: AdapterContext) => Promise<{ rawBody: Uint8Array; resolvedUrl?: string }>;
  /** Expected floor — IN 2026 primary has ~150+ candidacies on federal+state. */
  expectedMinRows?: number;
};

// ---------------------------------------------------------------------------
// Pure parser (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse the Indiana Primary Candidate List XLSX into InCandidacyRow[].
 *
 * Filters to TARGET_OFFICES (federal + state leg). Normalizes district
 * identifier (ordinal words + zero-padded digits → bare integer).
 *
 * Dedups rows that appear twice in the source (same office+district+party+
 * name). Duplicates occasionally show up when a candidate files under a
 * slightly different date; we fold them at the parse layer so downstream
 * upserts see one canonical row.
 */
export function parseIndianaXlsx(bytes: Uint8Array): InCandidacyRow[] {
  if (!bytes || bytes.byteLength < 32) return [];
  const wb = XLSX.read(bytes, { type: 'array' });
  if (!wb.SheetNames.length) return [];
  const ws = wb.Sheets[wb.SheetNames[0]!];
  if (!ws) return [];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: false,
    defval: null,
  });

  const out: InCandidacyRow[] = [];
  const seen = new Set<string>();

  for (const row of raw) {
    if (!Array.isArray(row)) continue;
    const office = (row[0] == null ? '' : String(row[0])).trim().toUpperCase();
    const name = (row[1] == null ? '' : String(row[1])).trim();
    const party = (row[2] == null ? '' : String(row[2])).trim();
    const districtStr = (row[3] == null ? '' : String(row[3])).trim();
    const filed = (row[4] == null ? '' : String(row[4])).trim();

    if (!office || !name || !party) continue;
    if (office === 'OFFICE') continue; // header
    if (!TARGET_OFFICES.has(office)) continue;

    const district = extractDistrictId(districtStr);
    if (!district) continue; // any leg/federal row without a district is unusable

    const slug = OFFICE_TYPE_SLUG[office];
    if (!slug) continue;

    const dedupKey = `${slug}|${district}|${party.toLowerCase()}|${name.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    out.push({
      reported_name: name,
      office_category: office,
      office_type_slug: slug,
      district_identifier: district,
      party_raw: party,
      date_filed: normalizeDateFiled(filed),
      source_row_id: dedupKey,
    });
  }
  return out;
}

/**
 * Pull a bare integer district id out of strings like:
 *   'United States Representative, Eighth District'   → '8'
 *   'State Senator, District 01'                      → '1'
 *   'State Representative, District 042'              → '42'
 */
export function extractDistrictId(raw: string): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();

  // 1. Try "district NN" form (zero-padded digits).
  const mDigits = /district\s+0*(\d{1,3})\b/.exec(s);
  if (mDigits && mDigits[1]) return mDigits[1];

  // 2. Try ordinal-word form, possibly before "district".
  for (const [word, num] of Object.entries(ORDINAL_WORDS)) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(s)) return num;
  }

  // 3. Last-ditch: any trailing integer.
  const mTrailing = /\b0*(\d{1,3})\s*$/.exec(raw);
  if (mTrailing && mTrailing[1]) return mTrailing[1];

  return null;
}

function normalizeDateFiled(raw: string): string | null {
  if (!raw) return null;
  // Common shapes: '1/20/26', '1/20/2026', '2026-01-20'.
  const iso = /^\d{4}-\d{2}-\d{2}$/.exec(raw);
  if (iso) return raw;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw);
  if (us) {
    const mm = us[1]!.padStart(2, '0');
    const dd = us[2]!.padStart(2, '0');
    const yRaw = us[3]!;
    const yyyy = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

/**
 * State-free canonical key matching the DB trigger (migration
 * 20260423000011 + diacritic-folding update in 20260425000006). Must stay
 * in sync with people.canonical_key derivation.
 */
export function canonicalKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Office resolution (slug + state + district → office_id)
// ---------------------------------------------------------------------------

/**
 * Prefer direct slug + jurisdiction + district lookup — more precise than
 * the resolveOfficeElection() substring match because we already have the
 * canonical office_type_slug from the XLSX. Falls back to resolveOfficeElection
 * when nothing hits via slug (e.g., if the slug isn't seeded yet).
 */
export async function resolveInOfficeBySlug(
  pg: Pool,
  input: { office_type_slug: string; district_identifier: string },
): Promise<string | null> {
  const sql = `
    SELECT o.id AS office_id
    FROM offices o
    JOIN office_types ot ON ot.id = o.office_type_id
    JOIN jurisdictions j ON j.id = o.jurisdiction_id
    WHERE j.fips_state = $1
      AND ot.slug = $2
      AND (
        o.seat_designation ILIKE $3
        OR o.seat_designation ILIKE $4
        OR o.canonical_name ILIKE $3
        OR o.canonical_name ILIKE $4
        OR (o.meta->>'district_name') = $5
      )
    ORDER BY
      (o.seat_designation ILIKE $4)::int DESC,  -- exact "District N" seat beats substring hit
      o.created_at ASC
    LIMIT 1
  `;
  const d = input.district_identifier;
  const res = await pg.query<{ office_id: string }>(sql, [
    STATE_FIPS,
    input.office_type_slug,
    `%District ${d}%`,
    `District ${d}`,
    d,
  ]);
  return res.rows[0]?.office_id ?? null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the Indiana candidacies SourceAdapter.
 *
 * @example
 *   const adapter = createInCandidaciesAdapter();
 *   const result = await runAdapter(adapter);
 *   console.log(result.status, result.stats);
 */
export function createInCandidaciesAdapter(
  options: InCandidaciesAdapterOptions = {},
): SourceAdapter<InCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 50;

  const fetchBytes =
    options.fetch ??
    (async () => {
      const res = await politeFetch(sourceUrl, {
        headers: {
          Accept:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*',
        },
      });
      if (!res.ok) {
        throw new Error(
          `IN candidacies fetch failed: HTTP ${res.status} from ${sourceUrl}`,
        );
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      return { rawBody: buf, resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<InCandidacyRow> = {
    name: 'sos-indiana-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<InCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      const { rawBody, resolvedUrl } = await fetchBytes(ctx);
      const contentHash = createHash('sha256').update(rawBody).digest('hex');

      ctx.logger.info(`${adapter.name}: fetched`, {
        bytes: rawBody.byteLength,
        contentHash: contentHash.slice(0, 12),
      });

      const rows = parseIndianaXlsx(rawBody);

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        offices: summarizeByOffice(rows),
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'indiana-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: ELECTION_YEAR,
            primary_date: PRIMARY_DATE,
            byte_size: rawBody.byteLength,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) {
        return 'missing reported_name';
      }
      if (!row.office_type_slug) return 'missing office_type_slug';
      if (!row.district_identifier) return 'missing district_identifier';
      if (!row.party_raw) return 'missing party_raw';
      return null;
    },

    async insert(
      rows: InCandidacyRow[],
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

      // Office dedup cache for the run — avoid re-querying for the same
      // slug+district when we see 12 candidates in State Rep District 42.
      const officeCache = new Map<string, string | null>();

      for (const row of rows) {
        const cacheKey = `${row.office_type_slug}|${row.district_identifier}`;
        let officeId = officeCache.get(cacheKey) ?? null;
        if (!officeCache.has(cacheKey)) {
          // Try the fast direct path first.
          officeId = await resolveInOfficeBySlug(ctx.pg, {
            office_type_slug: row.office_type_slug,
            district_identifier: row.district_identifier,
          });
          // Fallback to the shared resolver for any offices not seeded
          // under the exact slug used here.
          if (!officeId) {
            const fb = await resolveOfficeElection(ctx.pg, {
              state_fips: STATE_FIPS,
              office_name: row.office_category,
              district_identifier: row.district_identifier,
              election_year: ELECTION_YEAR,
            });
            officeId = fb?.office_id ?? null;
          }
          officeCache.set(cacheKey, officeId);
        }

        if (!officeId) {
          stats.rowsSkipped += 1;
          await logIngestionError(
            ctx,
            refs.ingestionRunId,
            'validation',
            `IN office not resolved: slug=${row.office_type_slug} district=${row.district_identifier}`,
            row,
          );
          continue;
        }

        if (ctx.dryRun) {
          // Don't write anything; runner rolls back the outer tx anyway,
          // but we skip the supabase writes to avoid touching audit tables
          // and to keep the stats honest.
          stats.rowsInserted += 1;
          continue;
        }

        try {
          const electionId = await findOrCreateElection(
            ctx,
            officeId,
            PRIMARY_DATE,
            refs.dataSourceId,
          );
          const personId = await findOrCreatePerson(
            ctx,
            row.reported_name,
            STATE_FIPS,
          );
          const { candidacyId, created } = await upsertCandidacy(
            ctx,
            electionId,
            personId,
            row.party_raw,
            row.date_filed,
            refs.dataSourceId,
          );

          const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);
          if (partyId) {
            await upsertPartyLine(
              ctx,
              candidacyId,
              partyId,
              row.date_filed,
              refs.dataSourceId,
            );
          } else {
            // Not fatal — log for human review. Candidacy row stays;
            // UI falls back to candidacies.party text until resolved.
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `IN party not resolved: "${row.party_raw}" for ${row.reported_name}`,
              row,
            );
          }

          if (created) stats.rowsInserted += 1;
          else stats.rowsUpdated += 1;
        } catch (err) {
          stats.rowsFailed += 1;
          const msg = err instanceof Error ? err.message : String(err);
          stats.errors.push({
            type: 'other',
            message: `IN candidacy insert: ${msg}`,
            rawInput: row,
          });
          ctx.logger.warn(`${adapter.name}: insert failed`, {
            error: msg,
            row: row.reported_name,
          });
        }
      }

      return stats;
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function findOrCreateElection(
  ctx: AdapterContext,
  officeId: string,
  electionDate: string,
  dataSourceId: string | undefined,
): Promise<string> {
  const sel = await ctx.pg.query<{ id: string }>(
    `SELECT id FROM elections
      WHERE office_id = $1 AND election_date = $2::date
      LIMIT 1`,
    [officeId, electionDate],
  );
  if (sel.rows[0]) return sel.rows[0].id;

  const ins = await ctx.pg.query<{ id: string }>(
    `INSERT INTO elections (office_id, election_date, election_type, meta)
     VALUES ($1, $2::date, 'primary', $3::jsonb)
     RETURNING id`,
    [
      officeId,
      electionDate,
      JSON.stringify({
        source: 'sos-indiana-candidacies',
        data_source_id: dataSourceId ?? null,
      }),
    ],
  );
  return ins.rows[0]!.id;
}

/**
 * State-disambiguated person find-or-create. Delegates to the shared
 * helper in candidate-resolver.ts so cross-state canonical_key
 * collisions never produce a wrong-state hit (council 2026-04-25 DE#3).
 *
 * The fetch_state / data_quality_tier metadata that the legacy local
 * implementation set is preserved by passing source + dataSourceId
 * through; the shared helper persists them on people.meta when it
 * inserts a new row.
 */
async function findOrCreatePerson(
  ctx: AdapterContext,
  canonicalName: string,
  fetchStateFips: string,
): Promise<string> {
  return findOrCreateStatePerson(ctx.pg, {
    name: canonicalName,
    state_fips: fetchStateFips,
    electionYear: ELECTION_YEAR,
    source: 'sos-indiana-candidacies',
  });
}

async function upsertCandidacy(
  ctx: AdapterContext,
  electionId: string,
  personId: string,
  partyRaw: string,
  dateFiled: string | null,
  dataSourceId: string | undefined,
): Promise<{ candidacyId: string; created: boolean }> {
  const sel = await ctx.pg.query<{ id: string }>(
    `SELECT id FROM candidacies
      WHERE election_id = $1 AND person_id = $2
      LIMIT 1`,
    [electionId, personId],
  );
  if (sel.rows[0]) {
    await ctx.pg.query(
      `UPDATE candidacies
          SET party = $1,
              status = CASE WHEN status IN ('withdrew','disqualified') THEN status ELSE 'active' END,
              filed_on = COALESCE(filed_on, $2::date)
        WHERE id = $3`,
      [partyRaw, dateFiled, sel.rows[0].id],
    );
    return { candidacyId: sel.rows[0].id, created: false };
  }

  const ins = await ctx.pg.query<{ id: string }>(
    `INSERT INTO candidacies
       (election_id, person_id, party, status, filed_on, meta)
     VALUES ($1, $2, $3, 'active', $4::date, $5::jsonb)
     RETURNING id`,
    [
      electionId,
      personId,
      partyRaw,
      dateFiled,
      JSON.stringify({
        source: 'sos-indiana-candidacies',
        data_source_id: dataSourceId ?? null,
      }),
    ],
  );
  return { candidacyId: ins.rows[0]!.id, created: true };
}

async function upsertPartyLine(
  ctx: AdapterContext,
  candidacyId: string,
  partyId: string,
  qualifiedOn: string | null,
  dataSourceId: string | undefined,
): Promise<void> {
  await ctx.pg.query(
    `INSERT INTO candidacy_party_lines
       (candidacy_id, party_id, ballot_line_order, nomination_method, qualified_on, data_source_id, meta)
     VALUES ($1, $2, 1, 'primary', $3::date, $4::uuid, $5::jsonb)
     ON CONFLICT (candidacy_id, party_id) DO UPDATE
       SET ballot_line_order = 1,
           nomination_method = 'primary',
           qualified_on = COALESCE(candidacy_party_lines.qualified_on, EXCLUDED.qualified_on),
           data_source_id = COALESCE(EXCLUDED.data_source_id, candidacy_party_lines.data_source_id)`,
    [
      candidacyId,
      partyId,
      qualifiedOn,
      dataSourceId ?? null,
      JSON.stringify({ source: 'sos-indiana-candidacies' }),
    ],
  );
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
    ctx.logger.warn('sos-indiana-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function summarizeByOffice(rows: InCandidacyRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.office_category] = (out[r.office_category] ?? 0) + 1;
  return out;
}

