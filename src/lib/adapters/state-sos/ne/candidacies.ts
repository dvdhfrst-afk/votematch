/**
 * Nebraska Secretary of State — 2026 primary candidate-filings adapter (FIPS 31).
 *
 * Primary is 2026-05-12 (open primary; major-party voters get their party's
 * ballot, nonpartisans can request a partisan ballot for federal+state-leg
 * contests since LB76, see neb.rev.stat. § 32-312.04).
 *
 * Source (web-verified 2026-04-25 via politeFetch probe):
 *   https://sos.nebraska.gov/sites/default/files/doc/elections/2026/Statewide_Candidate_Filing_List.xlsx
 *     — Authoritative XLSX from the Nebraska SoS Election Division. Three
 *       sheets:
 *         1. "Primary Election Candidates" (~419 rows, includes header)
 *            Columns: Office | District Name | Term | Vote For |
 *                     Party (if applicable) | Candidate Name |
 *                     City of Residence | Incumbency Status |
 *                     Mailing Address | Phone/Email
 *         2. "General Election Candidates" (~97 rows, mostly nonpartisan
 *            local-board races that bypass the primary).
 *         3. "Circulating Candidate Petitions" (~4 rows, independents still
 *            collecting signatures with a 8/3/26 turn-in deadline).
 *
 *   Discovery path: SoS landing https://sos.nebraska.gov/elections links
 *   directly to this XLSX under "Statewide_Candidate_Filing_List.xlsx".
 *   Same page also publishes a stylized PDF (...Final_Statewide_Primary_
 *   Candidate_Filing_List_3.23.26.pdf, ~107 KB) — we prefer the XLSX
 *   because it's structured.
 *
 * What's on the 2026 NE primary ballot (federal + state):
 *   - U.S. Senator (Class II seat)
 *   - U.S. House districts 1, 2, 3
 *   - Governor (and Lt Gov as joint ticket)
 *   - Secretary of State, Attorney General, Treasurer, Auditor of Public Accounts
 *   - State Senate: Nebraska is unicameral. Half the chamber (odd-numbered
 *     districts) is up in 2026 — formally nonpartisan but partisan
 *     affiliations are widely known and we capture them when reported.
 *   - University of Nebraska Regents (5 of 8 districts)
 *   - State Board of Education (some districts)
 *   - Public Service Commission (some districts)
 *
 * Local races (county/city/school/township) are intentionally skipped here
 * and picked up by Phase 2 adapters when those office rows exist.
 *
 * What this adapter writes (per filed candidate):
 *   1. people row — find-or-create keyed on canonical_key + state scope (NE)
 *   2. elections row — find-or-create for (office_id, 2026-05-12, 'primary')
 *   3. candidacies row — upsert on (election_id, person_id)
 *   4. candidacy_party_lines — upsert primary line (ballot_line_order=1,
 *      nomination_method='primary') mapped to parties.id when party present
 *
 * Idempotent: re-running the adapter updates status+party on existing
 * candidacies rather than duplicating. People rows are deduped by
 * canonical_key + state scope across runs.
 *
 * Differs from the base state-sos adapter factory (base.ts) because that
 * one targets election_results. This adapter produces filed-candidacy rows
 * and owns its own insert(). Mirrors the IN candidacies adapter for
 * consistency.
 */

import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
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

const STATE_FIPS = '31';
const ELECTION_YEAR = 2026;
/** First Tuesday after the second Monday in May per neb.rev.stat. § 32-401. */
const PRIMARY_DATE = '2026-05-12';

const DEFAULT_SOURCE_URL =
  'https://sos.nebraska.gov/sites/default/files/doc/elections/2026/Statewide_Candidate_Filing_List.xlsx';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type NeCandidacyRow = {
  /** As published in the 'Candidate Name' column. */
  reported_name: string;
  /** As published in the 'Office' column ('For Governor', 'For United States Senator'). */
  office_raw: string;
  /** Normalized office name fed to resolveOfficeElection. */
  office_name: string;
  /** District identifier (bare integer string) or null when not applicable. */
  district_identifier: string | null;
  /** Free-form party string ('Republican', 'Democratic', 'Nonpartisan') or null. */
  party_raw: string | null;
  /** True for explicitly-nonpartisan offices (state senate, regents, etc). */
  is_nonpartisan: boolean;
  /** Sheet of origin — used to scope ballot type ('primary' vs 'general' vs 'petition'). */
  sheet: 'primary' | 'general' | 'petition';
  /** Stable per-row id for provenance / dedup. */
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type CreateNeCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Test-only fetch override; pass synthetic XLSX bytes for unit tests. */
  fetch?: (ctx: AdapterContext) => Promise<{ rawBody: Uint8Array; resolvedUrl?: string }>;
  /** Floor below which the run is recorded as 'partial'. NE primary normally
   *  has 100+ rows in the primary sheet; 30 is a generous floor. */
  expectedMinRows?: number;
  electionYear?: number;
};

// ---------------------------------------------------------------------------
// Pure parser (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse the NE Statewide_Candidate_Filing_List.xlsx into NeCandidacyRow[].
 *
 * Reads all three sheets (primary / general / petition). Each row's `sheet`
 * field is set so the dispatcher can later pick which to emit (we currently
 * write all three — primary candidates resolve to 2026-05-12 elections,
 * general/petition candidates resolve to general-election rows when the
 * office exists; otherwise they fall through with a logged ingestion_error).
 *
 * Filters and normalizations:
 *   - Skip header rows + empty rows.
 *   - Trim Office, District Name, Candidate Name, Party fields.
 *   - Convert Office "For United States Senator" → office_name fed into
 *     resolveOfficeElection().
 *   - Pull district number from "District Name" — formats observed:
 *       "" (statewide) | "District 01" | "Subdivision 03 " | "3"
 *   - Mark unicameral state senate + university regents + PSC + state board
 *     as is_nonpartisan=true so we don't try to resolve a party.
 */
export function parseNebraskaXlsx(bytes: Uint8Array): NeCandidacyRow[] {
  if (!bytes || bytes.byteLength < 32) return [];
  const wb = XLSX.read(bytes, { type: 'array' });
  if (!wb.SheetNames.length) return [];

  const rows: NeCandidacyRow[] = [];
  const seen = new Set<string>();

  // Sheet name → which bucket. NE re-uses the same column layout across
  // all three but with slight column drift on the petition sheet. We
  // detect by header row instead of trusting the sheet index.
  const sheetTypes: Record<string, 'primary' | 'general' | 'petition'> = {
    'Primary Election Candidates': 'primary',
    'General Election Candidates': 'general',
    'Circulating Candidate Petitions': 'petition',
  };

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const sheetType = sheetTypes[sheetName] ?? null;
    if (!sheetType) continue;

    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: false,
      defval: null,
    });
    if (!raw.length) continue;

    // Detect column indices from the header row. Header strings vary
    // slightly between sheets (e.g. petition sheet has 'Status' column);
    // we match on substring so the parser is robust to small reorderings.
    const header = (raw[0] as unknown[]).map((c) =>
      c == null ? '' : String(c).trim().toLowerCase(),
    );
    const idx = {
      office: header.findIndex((h) => h === 'office' || h === 'contest'),
      district: header.findIndex(
        (h) => h.startsWith('district') || h === 'subdivision',
      ),
      party: header.findIndex((h) => h.startsWith('party')),
      name: header.findIndex(
        (h) => h.includes('candidate name') || h === 'name',
      ),
    };
    // If we can't find office + name we're looking at the wrong sheet shape.
    if (idx.office < 0 || idx.name < 0) continue;

    for (let r = 1; r < raw.length; r++) {
      const row = raw[r];
      if (!Array.isArray(row)) continue;
      const officeRaw = String(row[idx.office] ?? '').trim();
      const name = String(row[idx.name] ?? '').trim();
      if (!officeRaw || !name) continue;

      const districtRaw =
        idx.district >= 0 ? String(row[idx.district] ?? '').trim() : '';
      const partyRaw =
        idx.party >= 0 ? String(row[idx.party] ?? '').trim() : '';

      // 'Nonpartisan' is the explicit string NE uses on petition + state
      // senate + most local boards.
      const isNonpartisan =
        !partyRaw ||
        /nonpartisan/i.test(partyRaw) ||
        isInherentlyNonpartisan(officeRaw);

      const district = extractDistrictId(districtRaw);
      const officeName = normalizeNeOfficeForResolver(officeRaw);

      const sourceRowId = `ne-${sheetType}-${officeRaw}|${districtRaw}|${partyRaw}|${name}`
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

      if (seen.has(sourceRowId)) continue;
      seen.add(sourceRowId);

      rows.push({
        reported_name: name,
        office_raw: officeRaw,
        office_name: officeName,
        district_identifier: district,
        party_raw: partyRaw || null,
        is_nonpartisan: isNonpartisan,
        sheet: sheetType,
        source_row_id: sourceRowId,
      });
    }
  }
  return rows;
}

/**
 * Pull a bare integer district id out of strings like:
 *   "District 01"      → "1"
 *   "Subdivision 03 "  → "3"
 *   "3"                → "3"
 *   ""                 → null
 */
export function extractDistrictId(raw: string): string | null {
  if (!raw) return null;
  // Try "District NN" / "Subdivision NN" prefixes first.
  const m = /(?:district|subdivision)\s+0*(\d{1,3})\b/i.exec(raw);
  if (m && m[1]) return m[1];
  // Bare integer.
  const trim = raw.trim();
  if (/^0*\d{1,3}$/.test(trim)) return String(parseInt(trim, 10));
  return null;
}

/**
 * Normalize a NE Office string into the form resolveOfficeElection() expects.
 * NE prefixes most offices with "For " — strip that. Common rewrites:
 *   "For United States Senator" → "United States Senator"
 *   "For Representative in Congress" → "United States Representative"
 *   "For Governor" → "Governor"
 *   "For Member of the Legislature" → "State Senator" (NE unicameral)
 */
export function normalizeNeOfficeForResolver(raw: string): string {
  let s = raw.replace(/^\s*for\s+/i, '').trim();
  // Re-write a couple of NE-specific phrasings to match our office_types.
  s = s.replace(/^representative in congress$/i, 'United States Representative');
  s = s.replace(/^member of the legislature$/i, 'State Senator');
  s = s.replace(/^state senator/i, 'State Senator');
  s = s.replace(/^regent of the university of nebraska/i, 'University of Nebraska Regent');
  s = s.replace(/^member of the state board of education/i, 'State Board of Education');
  s = s.replace(/^member of the public service commission/i, 'Public Service Commissioner');
  return s;
}

/** Offices that are statutorily nonpartisan in NE regardless of label. */
function isInherentlyNonpartisan(officeRaw: string): boolean {
  return (
    /legislature/i.test(officeRaw) ||
    /state senator/i.test(officeRaw) ||
    /regent/i.test(officeRaw) ||
    /board of education/i.test(officeRaw) ||
    /public service commission/i.test(officeRaw) ||
    /natural resources district/i.test(officeRaw) ||
    /power district/i.test(officeRaw) ||
    /educational service unit/i.test(officeRaw) ||
    /school district/i.test(officeRaw) ||
    /reclamation district/i.test(officeRaw)
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNeCandidaciesAdapter(
  options: CreateNeCandidaciesAdapterOptions = {},
): SourceAdapter<NeCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 30;
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
          `NE candidacies fetch failed: HTTP ${res.status} from ${sourceUrl}`,
        );
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      return { rawBody: buf, resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<NeCandidacyRow> = {
    name: 'sos-nebraska-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<NeCandidacyRow>> {
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

      const rows = parseNebraskaXlsx(rawBody);

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        bySheet: summarizeSheet(rows),
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'nebraska-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
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
      if (!row.office_name || !row.office_name.trim()) {
        return 'missing office_name';
      }
      return null;
    },

    async insert(
      rows: NeCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertNeCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert (people + candidacies + candidacy_party_lines)
// ---------------------------------------------------------------------------

async function insertNeCandidacies(
  rows: NeCandidacyRow[],
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

  // Office cache: avoid re-resolving the same office for every candidate.
  const officeCache = new Map<string, { office_id: string; election_id: string } | null>();

  for (const row of rows) {
    try {
      // Petition / general-election rows resolve against general-election
      // dates rather than the primary date. We still call the office
      // resolver — it accepts any year and returns the first matching
      // election. For Phase 1 we accept whatever election_id the resolver
      // hands back; downstream consumers can disambiguate by election_date.
      const cacheKey = `${row.office_name}|${row.district_identifier ?? ''}`;
      let resolved = officeCache.get(cacheKey);
      if (resolved === undefined) {
        resolved = await resolveOfficeElection(ctx.pg, {
          state_fips: STATE_FIPS,
          office_name: row.office_name,
          district_identifier: row.district_identifier,
          election_year: electionYear,
        });
        officeCache.set(cacheKey, resolved);
      }

      if (!resolved) {
        stats.rowsSkipped += 1;
        await logIngestionError(
          ctx,
          refs.ingestionRunId,
          'validation',
          `NE office not resolved: office="${row.office_name}" district=${row.district_identifier ?? '-'} (raw="${row.office_raw}")`,
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
        source: 'sos-nebraska-candidacies',
        dataSourceId: refs.dataSourceId,
      });

      // Idempotent candidacy upsert.
      const candidacyRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
        `INSERT INTO candidacies
           (election_id, person_id, party, status, meta)
         VALUES ($1, $2, $3, 'active', $4::jsonb)
         ON CONFLICT (election_id, person_id) DO UPDATE
           SET party = COALESCE(EXCLUDED.party, candidacies.party),
               meta = candidacies.meta || EXCLUDED.meta
         RETURNING id, (xmax = 0) AS inserted`,
        [
          resolved.election_id,
          personId,
          row.party_raw,
          JSON.stringify({
            source: 'sos-nebraska-candidacies',
            sheet: row.sheet,
            reported_office: row.office_raw,
            reported_district: row.district_identifier,
            is_nonpartisan: row.is_nonpartisan,
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
        stats.errors.push({
          type: 'other',
          message: 'NE candidacy upsert returned no id',
          rawInput: row,
        });
        continue;
      }
      if (wasInserted) stats.rowsInserted += 1;
      else stats.rowsUpdated += 1;

      // Party line — only for partisan rows.
      if (row.party_raw && !row.is_nonpartisan) {
        const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);
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
              JSON.stringify({
                source: 'sos-nebraska-candidacies',
                reported_party: row.party_raw,
              }),
            ],
          );
        } else {
          await logIngestionError(
            ctx,
            refs.ingestionRunId,
            'validation',
            `NE party not resolved: "${row.party_raw}" for ${row.reported_name}`,
            { ...row, candidacy_id: candidacyId },
          );
        }
      }
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({
        type: 'other',
        message: `NE row insert: ${msg}`,
        rawInput: row,
      });
      ctx.logger.warn(`sos-nebraska-candidacies: row insert failed`, {
        error: msg,
        row: { name: row.reported_name, office: row.office_name },
      });
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeSheet(rows: NeCandidacyRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.sheet] = (out[r.sheet] ?? 0) + 1;
  return out;
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
    ctx.logger.warn('sos-nebraska-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
