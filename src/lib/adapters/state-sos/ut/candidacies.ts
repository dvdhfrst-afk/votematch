/**
 * Utah Lieutenant Governor — 2026 candidate-filings adapter (FIPS 49).
 *
 * Utah is the project's home state — extra effort here. The Lt. Governor's office
 * (Utah abolished the SoS in 1895) publishes the authoritative roster as an
 * XLSX on vote.utah.gov. There is also a long-standing legacy ingestion
 * script at scripts/ingest-utah-2026-xlsx.ts that targets the older
 * `candidates`+`races` tables; this adapter targets the new office-graph
 * (people + candidacies + candidacy_party_lines) and reuses the same
 * authoritative XLSX URL so the two pipelines stay aligned during the
 * migration window.
 *
 * Source (web-verified 2026-04-25):
 *   https://vote.utah.gov/wp-content/uploads/2026/01/Candidate-Filing-2026.xlsx
 *     — One sheet ('Sheet1') with section-banner rows separating Federal /
 *       State / Utah Senate / Utah House / State School Board / Judicial
 *       Retention. Real candidate rows have four columns:
 *           [Candidate, Office, Party, Status]
 *       Section banners and column-header rows are interleaved among real
 *       data; the parser is structure-agnostic and just looks for rows that
 *       have all four columns populated AND don't match the column header.
 *
 * 2026 cycle dates:
 *   Primary  2026-06-23  (closed primary; Republican-only registered voters)
 *   General  2026-11-03
 *
 * Status semantics (from the XLSX 'Status' column):
 *   'Filed'              → filed, pending convention/primary
 *   'Primary'            → on primary ballot (made it through convention)
 *   'Election Candidate' → on general ballot (past primary, OR direct-to-general)
 *   'Out in Convention'  → eliminated at party convention (mark withdrew)
 *   'Withdrew'           → dropped out (mark withdrew)
 *
 * What this adapter writes (per filed candidate, all status types):
 *   1. people row — find-or-create keyed on canonical_key
 *   2. elections row — find-or-create for (office_id, primary_date, 'primary')
 *      For 'Election Candidate' status (direct-to-general or convention winner),
 *      we ALSO upsert the general election so the candidate appears on the
 *      November ballot. This mirrors the legacy script's behavior.
 *   3. candidacies row — upsert on (election_id, person_id) with status
 *      mapped from the source 'Status' column.
 *   4. candidacy_party_lines — upsert primary line (ballot_line_order=1)
 *      mapped to parties.id via resolvePartyId.
 *
 * Idempotent — re-running refreshes party + status without duplicating.
 */

import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import type { Pool } from 'pg';

import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import {
  resolveOrCreateOfficeAndElection,
  deriveSlugFromName,
} from '../shared/office-resolver';
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

const STATE_FIPS = '49';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-06-23';
const GENERAL_DATE = '2026-11-03';

const DEFAULT_SOURCE_URL =
  'https://vote.utah.gov/wp-content/uploads/2026/01/Candidate-Filing-2026.xlsx';

/** Status strings mapped to candidacies.status values. */
const ACTIVE_STATUSES = new Set(['Filed', 'Primary', 'Election Candidate']);
const WITHDRAWN_STATUSES = new Set(['Out in Convention', 'Withdrew']);

/** Statuses that indicate the candidate is on the GENERAL ballot. */
const GENERAL_BALLOT_STATUSES = new Set(['Election Candidate']);

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type UtCandidacyRow = {
  reported_name: string;
  /** Raw office string from the XLSX, e.g. "U.S. House District 1". */
  office_name: string;
  /** District identifier when present, e.g. "1" / "27" / "SBoE 4". */
  district_identifier: string | null;
  /** Raw party string: 'Republican' / 'Democratic' / 'Libertarian' / etc. */
  party_raw: string;
  /** Raw status from the source. Mapped to candidacies.status downstream. */
  status_raw: string;
  /** Stable id for the run — encoded as office|party|name. */
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type UtCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetch?: (
    ctx: AdapterContext,
  ) => Promise<{ rawBody: Uint8Array; resolvedUrl?: string }>;
  /** UT 2026 xlsx historically has ~360 candidate rows. 80 is a generous floor. */
  expectedMinRows?: number;
  /** Used in find-or-create / office resolution. Defaults to ELECTION_YEAR. */
  electionYear?: number;
};

// ---------------------------------------------------------------------------
// Pure parser (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse the Utah Candidate-Filing XLSX into UtCandidacyRow[].
 *
 * The sheet uses a four-column layout: [Candidate, Office, Party, Status].
 * Section-banner rows have only column 0 populated ("Federal Offices",
 * "State Offices", etc.); column-header rows have all 4 cols but the
 * literal value 'Candidate' in col 0. We skip both.
 */
export function parseUtahCandidaciesXlsx(bytes: Uint8Array): UtCandidacyRow[] {
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

  const out: UtCandidacyRow[] = [];
  const seen = new Set<string>();

  for (const row of raw) {
    if (!Array.isArray(row)) continue;
    const name = (row[0] == null ? '' : String(row[0])).trim();
    const office = (row[1] == null ? '' : String(row[1])).trim();
    const party = (row[2] == null ? '' : String(row[2])).trim();
    const status = (row[3] == null ? '' : String(row[3])).trim();

    // Section banner: only col 0 populated
    if (!name || !office || !party || !status) continue;
    // Column header
    if (name.toLowerCase() === 'candidate') continue;

    const district = extractUtahDistrict(office);
    const dedupKey = `${office.toLowerCase()}|${party.toLowerCase()}|${name.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    out.push({
      reported_name: name,
      office_name: office,
      district_identifier: district,
      party_raw: party,
      status_raw: status,
      source_row_id: dedupKey,
    });
  }
  return out;
}

/**
 * Pull a bare integer district id from common Utah office strings:
 *   "U.S. House District 1"      → "1"
 *   "State Senate District 27"   → "27"
 *   "State House District 042"   → "42"
 *   "State School Board, Distrct 4" (sic — there's a known typo) → "4"
 *   "Governor"                   → null
 */
export function extractUtahDistrict(office: string): string | null {
  if (!office) return null;
  const m = /Dist[rict]*\.?\s*0*(\d{1,3})/i.exec(office);
  return m && m[1] ? m[1] : null;
}

/**
 * Map raw Status string from the XLSX onto the candidacies.status enum.
 *   Filed / Primary / Election Candidate → 'active'
 *   Out in Convention / Withdrew         → 'withdrew'
 *   Anything else                        → 'active' (fail-open; logged)
 */
export function mapStatus(rawStatus: string): 'active' | 'withdrew' {
  if (WITHDRAWN_STATUSES.has(rawStatus)) return 'withdrew';
  if (ACTIVE_STATUSES.has(rawStatus)) return 'active';
  return 'active';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createUtCandidaciesAdapter(
  options: UtCandidaciesAdapterOptions = {},
): SourceAdapter<UtCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 80;
  const electionYear = options.electionYear ?? ELECTION_YEAR;

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
          `UT candidacies fetch failed: HTTP ${res.status} from ${sourceUrl}`,
        );
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      return { rawBody: buf, resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<UtCandidacyRow> = {
    name: 'sos-utah-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<UtCandidacyRow>> {
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

      const rows = parseUtahCandidaciesXlsx(rawBody);

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        offices: summarizeByOffice(rows),
        statuses: summarizeByStatus(rows),
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'utah-lt-gov-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            general_date: GENERAL_DATE,
            byte_size: rawBody.byteLength,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) return 'missing reported_name';
      if (!row.office_name || !row.office_name.trim()) return 'missing office_name';
      if (!row.party_raw) return 'missing party_raw';
      if (!row.status_raw) return 'missing status_raw';
      return null;
    },

    async insert(
      rows: UtCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertUtCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert logic
// ---------------------------------------------------------------------------

export async function insertUtCandidacies(
  rows: UtCandidacyRow[],
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

  // Office resolution cache — multiple candidates per (office, district, election_type).
  // Keyed by `slug|district|type` so primary + general elections for the same
  // candidacy each cache separately.
  const officeElectionCache = new Map<string, { office_id: string; election_id: string }>();

  for (const row of rows) {
    const slug = deriveUtahSlug(row.office_name);

    // Status drives which election rows we touch.
    const elections: Array<{ date: string; type: 'primary' | 'general' }> = [
      { date: PRIMARY_DATE, type: 'primary' },
    ];
    if (GENERAL_BALLOT_STATUSES.has(row.status_raw)) {
      elections.push({ date: GENERAL_DATE, type: 'general' });
    }

    if (ctx.dryRun) {
      // Even in dry-run mode, attempt to resolve at least the primary so we
      // can detect resolution gaps before they ship to prod. Failures here
      // bump rowsSkipped and surface in ingestion_errors as before.
      const cacheKey = `${slug}|${row.district_identifier ?? ''}|primary`;
      try {
        let cached = officeElectionCache.get(cacheKey);
        if (!cached) {
          const out = await resolveOrCreateOfficeAndElection(ctx.pg, {
            state_fips: STATE_FIPS,
            office_type_slug: slug,
            office_name: row.office_name,
            district_identifier: row.district_identifier,
            election_year: electionYear,
            election_date: PRIMARY_DATE,
            election_type: 'primary',
            data_source_id: refs.dataSourceId,
            adapter_name: 'sos-utah-candidacies',
          });
          cached = { office_id: out.office_id, election_id: out.election_id };
          officeElectionCache.set(cacheKey, cached);
        }
        stats.rowsInserted += 1;
      } catch (err) {
        stats.rowsSkipped += 1;
        await logIngestionError(
          ctx,
          refs.ingestionRunId,
          'validation',
          `UT office not resolved: "${row.office_name}" district=${row.district_identifier ?? '-'} (${err instanceof Error ? err.message : String(err)})`,
          row,
        );
      }
      continue;
    }

    try {
      const personId = await findOrCreateStatePerson(ctx.pg, {
        name: row.reported_name,
        state_fips: STATE_FIPS,
        electionYear,
        source: 'sos-utah-candidacies',
        dataSourceId: refs.dataSourceId,
      });

      const status = mapStatus(row.status_raw);
      const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);

      let inserted = false;
      for (const e of elections) {
        const cacheKey = `${slug}|${row.district_identifier ?? ''}|${e.type}`;
        let resolved = officeElectionCache.get(cacheKey);
        if (!resolved) {
          const out = await resolveOrCreateOfficeAndElection(ctx.pg, {
            state_fips: STATE_FIPS,
            office_type_slug: slug,
            office_name: row.office_name,
            district_identifier: row.district_identifier,
            election_year: electionYear,
            election_date: e.date,
            election_type: e.type,
            data_source_id: refs.dataSourceId,
            adapter_name: 'sos-utah-candidacies',
          });
          resolved = { office_id: out.office_id, election_id: out.election_id };
          officeElectionCache.set(cacheKey, resolved);
        }

        const { candidacyId, created } = await upsertCandidacy(
          ctx,
          resolved.election_id,
          personId,
          row.party_raw,
          status,
          refs.dataSourceId,
          row.status_raw,
        );
        if (created) inserted = true;

        if (partyId) {
          await upsertPartyLine(
            ctx,
            candidacyId,
            partyId,
            e.type,
            refs.dataSourceId,
          );
        } else {
          await logIngestionError(
            ctx,
            refs.ingestionRunId,
            'validation',
            `UT party not resolved: "${row.party_raw}" for ${row.reported_name}`,
            row,
          );
        }
      }

      if (inserted) stats.rowsInserted += 1;
      else stats.rowsUpdated += 1;
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({
        type: 'other',
        message: `UT candidacy insert: ${msg}`,
        rawInput: row,
      });
      ctx.logger.warn('sos-utah-candidacies: insert failed', {
        error: msg,
        row: row.reported_name,
      });
    }
  }
  return stats;
}

/**
 * Map Utah's free-form XLSX office strings to canonical office_type slugs.
 *
 * Order matters: the most specific patterns must run first because several
 * UT strings overlap (e.g., "Lt. Governor" must catch "lieutenant_governor"
 * before falling through to the generic "governor" rule).
 */
export function deriveUtahSlug(officeName: string): string {
  const n = officeName.toLowerCase();
  if (/\blt\.?\s*gov\.?(?:ernor)?\b|\blieutenant\s+governor\b/.test(n)) return 'lieutenant_governor';
  if (/\bgovernor\b/.test(n)) return 'governor';
  if (/\battorney\s+general\b/.test(n)) return 'state_attorney_general';
  if (/\bauditor\b/.test(n)) return 'state_auditor';
  if (/\btreasurer\b/.test(n)) return 'state_treasurer';
  if (/\bsecretary\s+of\s+state\b/.test(n)) return 'secretary_of_state';
  if (/\bu\.?s\.?\s+(?:senate|senator)\b/.test(n)) return 'us_senator';
  if (/\bu\.?s\.?\s+(?:house|representative|congress)\b/.test(n)) return 'us_representative';
  if (/\bstate\s+senate\b|\bstate\s+senator\b/.test(n)) return 'state_senator';
  if (/\bstate\s+(?:house|representative)\b/.test(n)) return 'state_representative';
  // UT publishes "State School Board" — sometimes spelled "Distrct" (sic).
  if (/\bschool\s+board\b|\bschool\s+and\s+institutional\s+trust\s+lands\b/.test(n)) return 'state_board_of_education';
  if (/\bsupreme\s+court\b/.test(n)) return 'state_supreme_court_justice';
  if (/\bcourt\s+of\s+appeals\b/.test(n)) return 'judge_court_of_appeals';
  if (/\bjudicial\s+retention\b|\bdistrict\s+court\s+judge\b/.test(n)) return 'judge_district_court';
  // Fall through to the shared deriver as a safety net.
  return deriveSlugFromName(officeName);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function upsertCandidacy(
  ctx: AdapterContext,
  electionId: string,
  personId: string,
  partyRaw: string,
  status: 'active' | 'withdrew',
  dataSourceId: string | undefined,
  rawStatus: string,
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
          SET party = $1, status = $2,
              meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{ut_status}', to_jsonb($3::text), true)
        WHERE id = $4`,
      [partyRaw, status, rawStatus, sel.rows[0].id],
    );
    return { candidacyId: sel.rows[0].id, created: false };
  }

  const ins = await ctx.pg.query<{ id: string }>(
    `INSERT INTO candidacies
       (election_id, person_id, party, status, meta)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      electionId,
      personId,
      partyRaw,
      status,
      JSON.stringify({
        source: 'sos-utah-candidacies',
        data_source_id: dataSourceId ?? null,
        ut_status: rawStatus,
      }),
    ],
  );
  return { candidacyId: ins.rows[0]!.id, created: true };
}

async function upsertPartyLine(
  ctx: AdapterContext,
  candidacyId: string,
  partyId: string,
  electionType: 'primary' | 'general',
  dataSourceId: string | undefined,
): Promise<void> {
  // Both primary and general lines map to nomination_method='primary' for
  // major-party candidates; Utah doesn't fusion vote so each candidacy has
  // exactly one party line at ballot_line_order=1.
  await ctx.pg.query(
    `INSERT INTO candidacy_party_lines
       (candidacy_id, party_id, ballot_line_order, nomination_method, data_source_id, meta)
     VALUES ($1, $2, 1, 'primary', $3::uuid, $4::jsonb)
     ON CONFLICT (candidacy_id, party_id) DO UPDATE
       SET ballot_line_order = 1,
           nomination_method = 'primary',
           data_source_id = COALESCE(EXCLUDED.data_source_id, candidacy_party_lines.data_source_id)`,
    [
      candidacyId,
      partyId,
      dataSourceId ?? null,
      JSON.stringify({
        source: 'sos-utah-candidacies',
        election_type: electionType,
      }),
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
    ctx.logger.warn('sos-utah-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function summarizeByOffice(rows: UtCandidacyRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const key = r.office_name.replace(/\s+District\s*\w+/i, '').trim();
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function summarizeByStatus(rows: UtCandidacyRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status_raw] = (out[r.status_raw] ?? 0) + 1;
  return out;
}

// Re-exports kept type-only for tree-shaking.
export type { Pool };
