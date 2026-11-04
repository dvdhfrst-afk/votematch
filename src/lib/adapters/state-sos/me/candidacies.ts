/**
 * Maine Secretary of State — 2026 primary candidate-filings adapter (FIPS 23).
 *
 * Primary is 2026-06-09 (semi-closed; party voters only, plus unenrolled).
 *
 * Source (web-verified 2026-04-25):
 *   https://www.maine.gov/sos/sites/maine.gov.sos/files/inline-files/2026%20Primary%20Candidate%20List%20posting%20FINAL%203.16.26.xlsx
 *
 *   Single XLSX from the Maine Bureau of Corporations, Elections and
 *   Commissions. Sheet name is the primary date ("June 9, 2026"). Columns:
 *     Office, Dist, County, Party, Date Filed, Last Name, First Name,
 *     Middle Name, Suffix, Residence Municipality
 *
 *   Office codes (verified by enumerating unique values 2026-04-25):
 *     US  → U.S. Senator / U.S. Representative (Dist 1 / Dist 2)
 *     GOV → Governor
 *     SS  → State Senator
 *     SR  → State Representative
 *     CC  → County Commissioner
 *     CG  → County Charter Commission
 *     CT  → County Treasurer
 *     DA  → District Attorney
 *     JP  → Judge of Probate
 *     RD  → Register of Deeds
 *     RP  → Register of Probate
 *     SH  → Sheriff
 *
 *   Party codes: D, R, G (Green Independent), L (Libertarian).
 *
 * The non-party (independent) general-election candidates live in a
 * sibling XLSX ("2026 Non-Party Candidate List-posting-4.21.xlsx") that
 * the same adapter shape can ingest by overriding `sourceUrl`.
 */

import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';

import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
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

const STATE_FIPS = '23';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-06-09';

const DEFAULT_SOURCE_URL =
  'https://www.maine.gov/sos/sites/maine.gov.sos/files/inline-files/2026%20Primary%20Candidate%20List%20posting%20FINAL%203.16.26.xlsx';

/**
 * Office-code → human + slug mapping. The XLSX uses 2-3 letter abbreviations.
 * `slug` matches the office_types.slug used elsewhere in the office graph.
 * Trailing-whitespace variants (e.g. "JP " with one space) are normalized
 * by trim() before lookup.
 */
const OFFICE_CODE_MAP: Record<
  string,
  { name: string; slug: string; tier: 'federal' | 'state' | 'county' }
> = {
  US: { name: 'U.S. Senator / U.S. Representative', slug: 'us_congressional', tier: 'federal' },
  GOV: { name: 'Governor', slug: 'governor', tier: 'state' },
  SS: { name: 'State Senator', slug: 'state_senator', tier: 'state' },
  SR: { name: 'State Representative', slug: 'state_representative', tier: 'state' },
  CC: { name: 'County Commissioner', slug: 'county_commissioner', tier: 'county' },
  CG: { name: 'County Charter Commission', slug: 'county_charter_commission', tier: 'county' },
  CT: { name: 'County Treasurer', slug: 'county_treasurer', tier: 'county' },
  DA: { name: 'District Attorney', slug: 'district_attorney', tier: 'county' },
  JP: { name: 'Judge of Probate', slug: 'judge_of_probate', tier: 'county' },
  RD: { name: 'Register of Deeds', slug: 'register_of_deeds', tier: 'county' },
  RP: { name: 'Register of Probate', slug: 'register_of_probate', tier: 'county' },
  SH: { name: 'Sheriff', slug: 'sheriff', tier: 'county' },
};

/**
 * Party-code → human label. The framework's resolvePartyId() handles both
 * single-letter and full-name forms; passing the full name gives the
 * resolver the most context.
 */
const PARTY_CODE_MAP: Record<string, string> = {
  D: 'Democratic',
  R: 'Republican',
  G: 'Green Independent',
  L: 'Libertarian',
  I: 'Independent',
};

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type MeCandidacyRow = {
  reported_name: string;
  /** Raw office code from XLSX ("US", "GOV", "SS", "SR", "CC"...). */
  office_code: string;
  /** Resolved canonical name from OFFICE_CODE_MAP. */
  office_name: string;
  office_slug: string;
  office_tier: 'federal' | 'state' | 'county';
  district_identifier: string | null;
  county: string | null;
  party_raw: string;
  party_code: string;
  date_filed: string | null;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type MeCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetch?: (
    ctx: AdapterContext,
  ) => Promise<{ rawBody: Uint8Array; resolvedUrl?: string }>;
  parseOverride?: (bytes: Uint8Array) => MeCandidacyRow[];
  /** Filter to a specific tier (default: federal + state; county = Phase 2). */
  tiers?: Array<'federal' | 'state' | 'county'>;
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse the Maine 2026 Primary Candidate List XLSX into MeCandidacyRow[].
 *
 * Filters: by default keeps federal + state rows; county-level seats are
 * deferred to Phase 2 county adapters (mirrors IN's TARGET_OFFICES filter).
 * Override via the `tiers` option.
 */
export function parseMaineXlsx(
  bytes: Uint8Array,
  tiers: Array<'federal' | 'state' | 'county'> = ['federal', 'state'],
): MeCandidacyRow[] {
  if (!bytes || bytes.byteLength < 32) return [];
  const wb = XLSX.read(bytes, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: false,
    defval: null,
  });

  const out: MeCandidacyRow[] = [];
  let counter = 0;

  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    if (!Array.isArray(row)) continue;
    const officeRaw = (row[0] == null ? '' : String(row[0])).trim().toUpperCase();
    if (!officeRaw || officeRaw === 'OFFICE') continue;

    const officeMeta = OFFICE_CODE_MAP[officeRaw];
    if (!officeMeta) continue; // unknown code → skip
    if (!tiers.includes(officeMeta.tier)) continue;

    const dist = (row[1] == null ? '' : String(row[1])).trim();
    const county = (row[2] == null ? '' : String(row[2])).trim() || null;
    const partyCode = (row[3] == null ? '' : String(row[3])).trim().toUpperCase();
    const dateFiled = (row[4] == null ? '' : String(row[4])).trim();
    const last = (row[5] == null ? '' : String(row[5])).trim();
    const first = (row[6] == null ? '' : String(row[6])).trim();
    const middle = (row[7] == null ? '' : String(row[7])).trim();
    const suffix = (row[8] == null ? '' : String(row[8])).trim();

    if (!last || !first) continue;
    if (!partyCode) continue;

    const reportedName = [first, middle, last, suffix].filter(Boolean).join(' ');
    // Office name disambiguation: ME's "US" code lumps Senator + House.
    // Without a sub-code the row alone can't pick — use district presence:
    //   - dist empty → Senator
    //   - dist 1 / 2 → Representative
    let officeName = officeMeta.name;
    if (officeRaw === 'US') {
      officeName = dist ? 'U.S. Representative' : 'U.S. Senator';
    }

    out.push({
      reported_name: reportedName,
      office_code: officeRaw,
      office_name: officeName,
      office_slug: officeMeta.slug,
      office_tier: officeMeta.tier,
      district_identifier: dist || null,
      county,
      party_raw: PARTY_CODE_MAP[partyCode] ?? partyCode,
      party_code: partyCode,
      date_filed: normalizeDate(dateFiled),
      source_row_id: `me-r${counter++}-${officeRaw}-${last.toLowerCase()}-${first.toLowerCase()}`,
    });
  }
  return out;
}

function normalizeDate(raw: string): string | null {
  if (!raw) return null;
  // Common shape "3/16/26"
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw);
  if (m) {
    const mm = m[1]!.padStart(2, '0');
    const dd = m[2]!.padStart(2, '0');
    const yyyy = m[3]!.length === 2 ? `20${m[3]!}` : m[3]!;
    return `${yyyy}-${mm}-${dd}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMeCandidaciesAdapter(
  options: MeCandidaciesAdapterOptions = {},
): SourceAdapter<MeCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const tiers = options.tiers ?? ['federal', 'state'];

  const fetchBytes =
    options.fetch ??
    (async () => {
      const r = await politeFetch(sourceUrl, {
        headers: {
          Accept:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*',
        },
      });
      if (!r.ok) {
        throw new Error(
          `ME candidacies fetch failed: HTTP ${r.status} from ${sourceUrl}`,
        );
      }
      return { rawBody: new Uint8Array(await r.arrayBuffer()), resolvedUrl: r.url };
    });

  const parser = options.parseOverride ?? ((bytes: Uint8Array) => parseMaineXlsx(bytes, tiers));

  const adapter: SourceAdapter<MeCandidacyRow> = {
    name: 'sos-maine-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<MeCandidacyRow>> {
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

      const rows = parser(rawBody);

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        tiers,
      });

      return {
        rows,
        // Federal+state scope alone is ~370 rows (4 US + 13 GOV + 70 SS +
        // 292 SR). Floor at 80 to allow for a partial mid-window run.
        expectedMinRows: 80,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'maine-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            byte_size: rawBody.byteLength,
            tiers,
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
      rows: MeCandidacyRow[],
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

      const officeCache = new Map<string, string | null>();

      for (const row of rows) {
        try {
          const cacheKey = `${row.office_name}|${row.district_identifier ?? ''}|${row.county ?? ''}`;
          let officeInfo = officeCache.has(cacheKey)
            ? officeCache.get(cacheKey)
              ? { election_id: officeCache.get(cacheKey) ?? '', office_id: '' }
              : null
            : null;
          if (!officeInfo) {
            const fb = await resolveOfficeElection(ctx.pg, {
              state_fips: STATE_FIPS,
              office_name: row.office_name,
              district_identifier: row.district_identifier,
              election_year: electionYear,
            });
            officeCache.set(cacheKey, fb?.election_id ?? null);
            officeInfo = fb;
          }
          if (!officeInfo) {
            stats.rowsSkipped += 1;
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `ME office not resolved: code=${row.office_code} office="${row.office_name}" district=${row.district_identifier ?? '-'} county=${row.county ?? '-'}`,
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
            source: 'sos-maine-candidacies',
            dataSourceId: refs.dataSourceId,
          });
          const candidacyRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
            `INSERT INTO candidacies
               (election_id, person_id, party, status, filed_on, meta)
             VALUES ($1, $2, $3, 'active', $4::date, $5::jsonb)
             ON CONFLICT (election_id, person_id) DO UPDATE
               SET party = EXCLUDED.party,
                   filed_on = COALESCE(candidacies.filed_on, EXCLUDED.filed_on)
             RETURNING id, (xmax = 0) AS inserted`,
            [
              officeInfo.election_id,
              personId,
              row.party_raw,
              row.date_filed,
              JSON.stringify({
                source: 'sos-maine-candidacies',
                me_office_code: row.office_code,
                county: row.county,
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
                JSON.stringify({ source: 'sos-maine-candidacies', party_code: row.party_code }),
              ],
            );
          } else {
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `ME party not resolved: code=${row.party_code} ("${row.party_raw}") for ${row.reported_name}`,
              row,
            );
          }
        } catch (err) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: `ME candidacy insert: ${err instanceof Error ? err.message : String(err)}`,
            rawInput: row,
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
    ctx.logger.warn('sos-maine-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
