/**
 * Virginia Department of Elections — 2026 candidate-filings adapter (FIPS 51).
 *
 * Virginia is a Tuesday-after-the-3rd-Monday-of-June primary state, but the
 * 2026 calendar shifted the federal/statewide-aware primary to August 2026
 * (per the ELECT.virginia.gov 2026 calendar). The Department of Elections
 * (ELECT, the state agency that subsumed the SoS election function) publishes
 * the qualified-candidate list as TWO XLSX files — one per party — under
 * /media/castyourballot/candidatelist/2026/ on www.elections.virginia.gov.
 *
 * Sources (web-verified 2026-04-25):
 *   https://www.elections.virginia.gov/casting-a-ballot/candidate-list/   (landing)
 *   https://www.elections.virginia.gov/media/castyourballot/candidatelist/2026/2026-Aug-Dem-Primary-Candidates-List-4-17-2026.xlsx
 *   https://www.elections.virginia.gov/media/castyourballot/candidatelist/2026/2026-Aug-Rep-Primary-Candidates-List-4-17-2026.xlsx
 *
 * The filenames embed the publication date (4-17-2026), so they tick forward
 * as ELECT republishes after withdrawals / disqualifications. Treat the
 * default URLs as the most recent snapshot — the adapter accepts a
 * sourceUrl override so a future scheduler can swap in `5-1-2026` etc.
 *
 * Schema (XLSX columns, observed 2026-04-25; column count varies by party
 * file but the leading columns are stable):
 *   Office Title | Locality | District Type | District | Statewide Office |
 *   At Large | Number of Seats | Term | Special | Special Office Term Exp |
 *   Political Party | Candidate Name | Independent Candidate Filing Date |
 *   Incumbent | Candidate Status | Candidate Email | Candidate Phone |
 *   Candidate Website | ... (street/city/state/zip continue thereafter)
 *
 * The Republican file omits 'Locality' (statewide-only at the time of
 * snapshot). The parser handles both shapes by reading the header row and
 * mapping by header text rather than column index.
 *
 * 2026 cycle dates (federal/statewide):
 *   Primary  2026-08-04  (rescheduled — was historically Tue after 3rd Mon Jun)
 *   General  2026-11-03
 *
 * Adapter health (2026-04-26 verification): dry-run produces 24 rows
 * (21 D + 3 R) from the 2026-04-17 snapshot. NOT in the no_table cluster
 * — operating correctly. Re-verify when ELECT republishes the snapshot
 * (typically rolls forward weekly through the petition-challenge window).
 *
 * What this adapter writes:
 *   1. people row (find-or-create, state-disambiguated)
 *   2. elections row for the party-specific primary (one election per office;
 *      D and R candidates share the same primary election row).
 *   3. candidacies row (election_id, person_id) ON CONFLICT DO UPDATE.
 *   4. candidacy_party_lines mapped via resolvePartyId.
 */

import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import type { Pool } from 'pg';

import { politeFetch } from '../../fetch-polite';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';
import {
  insertCandidacies,
  type CandidacyInsertRow,
} from '../shared/candidacies-insert';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '51';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-08-04';

const DEFAULT_DEM_URL =
  'https://www.elections.virginia.gov/media/castyourballot/candidatelist/2026/2026-Aug-Dem-Primary-Candidates-List-4-17-2026.xlsx';
const DEFAULT_REP_URL =
  'https://www.elections.virginia.gov/media/castyourballot/candidatelist/2026/2026-Aug-Rep-Primary-Candidates-List-4-17-2026.xlsx';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type VaCandidacyRow = {
  reported_name: string;
  /** Free-form office title, e.g. "Member, United States Senate". */
  office_name: string;
  /** Locality name when present (county / city), else null. */
  locality: string | null;
  /** District identifier when set, e.g. "DALE DISTRICT" or "1st CD" — kept raw. */
  district_identifier: string | null;
  /** 'Democratic' | 'Republican' (raw string). */
  party_raw: string;
  /** Candidate Status from source: 'Qualified' / 'Withdrawn' / etc. */
  status_raw: string;
  /** Stable id for the run. */
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type VaCandidaciesAdapterOptions = {
  /** Override Dem XLSX URL (filename embeds publication date). */
  demSourceUrl?: string;
  /** Override Rep XLSX URL. */
  repSourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Test-only: inject a synthetic fetch that returns both files. */
  fetch?: (
    ctx: AdapterContext,
    url: string,
  ) => Promise<{ rawBody: Uint8Array; resolvedUrl?: string }>;
  expectedMinRows?: number;
  electionYear?: number;
};

// ---------------------------------------------------------------------------
// Pure parser (exported for tests)
// ---------------------------------------------------------------------------

const HEADER_ALIASES: Record<string, string[]> = {
  office_title: ['office title', 'office'],
  locality: ['locality'],
  district_type: ['district type'],
  district: ['district'],
  party: ['political party', 'party'],
  candidate_name: ['candidate name', 'name'],
  status: ['candidate status', 'status'],
};

/**
 * Parse one VA candidate-list XLSX (single sheet).
 *
 * Header row is row 0. Subsequent rows are candidate filings until the first
 * fully-blank row.
 */
export function parseVirginiaXlsx(
  bytes: Uint8Array,
  sourceTag: string,
): VaCandidacyRow[] {
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
  if (raw.length < 2) return [];

  const headerRow = raw[0]!;
  if (!Array.isArray(headerRow)) return [];
  const headers = headerRow.map((h) =>
    h == null ? '' : String(h).trim().toLowerCase(),
  );
  const colIx = (key: keyof typeof HEADER_ALIASES): number => {
    const aliases = HEADER_ALIASES[key];
    for (const alias of aliases) {
      const idx = headers.indexOf(alias);
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const ix = {
    office: colIx('office_title'),
    locality: colIx('locality'),
    district: colIx('district'),
    party: colIx('party'),
    name: colIx('candidate_name'),
    status: colIx('status'),
  };
  if (ix.office < 0 || ix.name < 0 || ix.party < 0) return [];

  const out: VaCandidacyRow[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    if (!Array.isArray(r)) continue;
    const office = (r[ix.office] == null ? '' : String(r[ix.office])).trim();
    const name = (r[ix.name] == null ? '' : String(r[ix.name])).trim();
    const party = (r[ix.party] == null ? '' : String(r[ix.party])).trim();
    if (!office || !name || !party) continue;

    const locality =
      ix.locality >= 0 && r[ix.locality] != null
        ? String(r[ix.locality]).trim() || null
        : null;
    const district =
      ix.district >= 0 && r[ix.district] != null
        ? String(r[ix.district]).trim() || null
        : null;
    const status =
      ix.status >= 0 && r[ix.status] != null
        ? String(r[ix.status]).trim()
        : '';

    const dedupKey = `${office.toLowerCase()}|${(locality ?? '').toLowerCase()}|${(district ?? '').toLowerCase()}|${party.toLowerCase()}|${name.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    out.push({
      reported_name: name,
      office_name: office,
      locality,
      district_identifier: district,
      party_raw: party,
      status_raw: status,
      source_row_id: `${sourceTag}|${dedupKey}`,
    });
  }
  return out;
}

/** Map "Qualified" → 'active'; "Withdrawn"/"Disqualified" → 'withdrew'. */
export function mapVaStatus(raw: string): 'active' | 'withdrew' {
  const s = raw.toLowerCase();
  if (s.includes('withdraw') || s.includes('disqualif')) return 'withdrew';
  return 'active';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVaCandidaciesAdapter(
  options: VaCandidaciesAdapterOptions = {},
): SourceAdapter<VaCandidacyRow> {
  const demUrl = options.demSourceUrl ?? DEFAULT_DEM_URL;
  const repUrl = options.repSourceUrl ?? DEFAULT_REP_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 5;
  const electionYear = options.electionYear ?? ELECTION_YEAR;

  const fetchOne =
    options.fetch ??
    (async (_ctx: AdapterContext, url: string) => {
      const res = await politeFetch(url, {
        headers: {
          Accept:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*',
        },
      });
      if (!res.ok) {
        throw new Error(`VA candidacies fetch failed: HTTP ${res.status} from ${url}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      return { rawBody: buf, resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<VaCandidacyRow> = {
    name: 'sos-virginia-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<VaCandidacyRow>> {
      await bucket.acquire();

      const { rawBody: dem, resolvedUrl: demResolved } = await fetchOne(ctx, demUrl);
      await bucket.acquire();
      const { rawBody: rep, resolvedUrl: repResolved } = await fetchOne(ctx, repUrl);

      const demRows = parseVirginiaXlsx(dem, 'va-dem');
      const repRows = parseVirginiaXlsx(rep, 'va-rep');
      const rows = [...demRows, ...repRows];

      // Combined hash so re-runs that touch either party file invalidate.
      const contentHash = createHash('sha256')
        .update(dem)
        .update(rep)
        .digest('hex');

      ctx.logger.info(`${adapter.name}: parsed`, {
        demRows: demRows.length,
        repRows: repRows.length,
        total: rows.length,
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'virginia-elect-candidacies',
          // Use the landing page as the canonical "url"; the two XLSXs are
          // listed in meta.
          url: 'https://www.elections.virginia.gov/casting-a-ballot/candidate-list/',
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            dem_url: demResolved ?? demUrl,
            rep_url: repResolved ?? repUrl,
            dem_byte_size: dem.byteLength,
            rep_byte_size: rep.byteLength,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) return 'missing reported_name';
      if (!row.office_name || !row.office_name.trim()) return 'missing office_name';
      if (!row.party_raw) return 'missing party_raw';
      return null;
    },

    async insert(rows, refs, ctx): Promise<InsertStats> {
      return insertVaCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert — delegates to the shared insertCandidacies helper which carries
// the local-office resolver fallback (city council / sheriff / board of
// supervisors). VA's locality column is a perfect locality_hint for the
// resolver — it already classifies office_type from the office_name and
// then uses locality_hint to pick the right jurisdiction (e.g. ARLINGTON
// COUNTY vs CHESTERFIELD COUNTY for "Member Board of Supervisors").
// ---------------------------------------------------------------------------

export async function insertVaCandidacies(
  rows: VaCandidacyRow[],
  refs: InsertRefs,
  ctx: AdapterContext,
  electionYear: number,
): Promise<InsertStats> {
  if (rows.length === 0) {
    return { rowsInserted: 0, rowsUpdated: 0, rowsSkipped: 0, rowsFailed: 0, errors: [] };
  }

  const insertRows: CandidacyInsertRow[] = rows.map((r) => ({
    reported_name: r.reported_name,
    office_name: r.office_name,
    district_identifier: r.district_identifier,
    party_raw: r.party_raw,
    date_filed: null,
    election_date: PRIMARY_DATE,
    election_type: 'primary',
    source_row_id: r.source_row_id,
    locality_hint: r.locality,
  }));

  return insertCandidacies(insertRows, refs, ctx, {
    stateFips: STATE_FIPS,
    source: 'sos-virginia-candidacies',
    electionYear,
  });
}

export type { Pool };
