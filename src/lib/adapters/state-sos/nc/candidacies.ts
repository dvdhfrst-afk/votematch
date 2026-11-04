/**
 * North Carolina State Board of Elections — 2026 candidate-filings adapter (FIPS 37).
 *
 * Source (web-verified 2026-04-25):
 *   https://s3.amazonaws.com/dl.ncsbe.gov/Elections/2026/Candidate%20Filing/Candidate_Listing_2026.csv
 *     — Authoritative CSV from NCSBE (linked from
 *       https://www.ncsbe.gov/voting/upcoming-election and from
 *       https://vt.ncsbe.gov/CandList/). One row per (county, contest, candidate)
 *       — county is per-residence not per-jurisdiction, and statewide contests
 *       (e.g. US Senate) appear once per county. We dedup at the parse layer
 *       to one candidacy per (contest_name, name_on_ballot, party_candidate).
 *
 *   Columns (verified 2026-04-25):
 *     election_dt,county_name,contest_name,name_on_ballot,first_name,middle_name,
 *     last_name,name_suffix_lbl,nick_name,street_address,city,state,zip_code,
 *     phone,office_phone,business_phone,email,candidacy_dt,party_contest,
 *     party_candidate,is_unexpired,has_primary,is_partisan,vote_for,term
 *
 *   PII note: NCSBE publishes home addresses + phone + email in the open
 *   CSV. We capture only fields needed for candidacy display
 *   (name_on_ballot, contest_name, party, district extracted from contest);
 *   PII is dropped at the parse layer (never lands in our DB).
 *
 * Differs from oh/in: we have rich structured data, so we resolve via
 * resolveOfficeElection() + the standard people/candidacies/party-line
 * write path. No PDF or XLSX parsing required.
 *
 * 2026 NC primary date: 2026-03-03 (closed primary); general 2026-11-03.
 */

import { createHash } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
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
import { insertCandidacies, type CandidacyInsertRow } from '../shared/candidacies-insert';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '37';
const ELECTION_YEAR = 2026;

const DEFAULT_SOURCE_URL =
  'https://s3.amazonaws.com/dl.ncsbe.gov/Elections/2026/Candidate%20Filing/Candidate_Listing_2026.csv';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type NcCandidacyRow = {
  reported_name: string;
  /** Free-form contest as published by NCSBE, e.g. 'US SENATE', 'NC HOUSE OF REPRESENTATIVES DISTRICT 9'. */
  office_name: string;
  /** Bare integer string ('9') when the contest carries a district, else null. */
  district_identifier: string | null;
  /** Per-candidate party — 'DEM','REP','LIB','GRE','CST','NLB','UNA',… */
  party_abbreviation: string | null;
  /** Election date (ISO yyyy-mm-dd) for this candidacy — primary or general. */
  election_date: string;
  /** Date the candidate filed (ISO yyyy-mm-dd) if parseable. */
  date_filed: string | null;
  /** Stable per-row id for idempotent dedup within a run. */
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type NcCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Inject a fetcher for tests (returns raw CSV bytes/string + url). */
  fetch?: (
    ctx: AdapterContext,
  ) => Promise<{ rawBody: string; resolvedUrl?: string }>;
  expectedMinRows?: number;
  electionYear?: number;
};

// ---------------------------------------------------------------------------
// Pure parser (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse the NCSBE 2026 Candidate Listing CSV. Dedup on
 * (election_dt | contest_name | name_on_ballot | party_candidate).
 * One row per unique candidacy is emitted; the CSV's per-county fan-out
 * (which exists only because NCSBE includes the candidate's home county)
 * is collapsed.
 */
export function parseNcCandidaciesCsv(rawBody: string): NcCandidacyRow[] {
  if (!rawBody || rawBody.length < 32) return [];
  let records: Record<string, string>[];
  try {
    records = parseCsv(rawBody, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
    }) as Record<string, string>[];
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const out: NcCandidacyRow[] = [];

  for (const r of records) {
    const electionRaw = (r['election_dt'] ?? '').trim();
    const contest = (r['contest_name'] ?? '').trim();
    const nameOnBallot = (r['name_on_ballot'] ?? '').trim();
    const partyCand = ((r['party_candidate'] ?? r['party_contest']) ?? '').trim() || null;
    const filedRaw = (r['candidacy_dt'] ?? '').trim();

    if (!electionRaw || !contest || !nameOnBallot) continue;

    const electionDate = normalizeNcDate(electionRaw);
    if (!electionDate) continue;

    const dedupKey = `${electionDate}|${contest.toUpperCase()}|${nameOnBallot.toUpperCase()}|${(partyCand ?? '').toUpperCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    out.push({
      reported_name: nameOnBallot,
      office_name: contest,
      district_identifier: extractNcDistrict(contest),
      party_abbreviation: partyCand,
      election_date: electionDate,
      date_filed: normalizeNcDate(filedRaw),
      source_row_id: dedupKey,
    });
  }

  return out;
}

/** Pull a bare integer out of NC contest names like 'NC HOUSE OF REPRESENTATIVES DISTRICT 9'. */
export function extractNcDistrict(contest: string): string | null {
  if (!contest) return null;
  const m = /district\s+0*(\d{1,3})\b/i.exec(contest);
  if (m && m[1]) return m[1];
  // Some federal contests use '7TH CONGRESSIONAL DISTRICT' phrasing.
  const ord = /\b0*(\d{1,3})(?:st|nd|rd|th)\b/i.exec(contest);
  if (ord && ord[1]) return ord[1];
  return null;
}

/** NCSBE publishes dates as 'MM/DD/YYYY'. Return ISO yyyy-mm-dd or null. */
export function normalizeNcDate(raw: string): string | null {
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return raw;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (us) {
    const mm = us[1]!.padStart(2, '0');
    const dd = us[2]!.padStart(2, '0');
    return `${us[3]}-${mm}-${dd}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNcCandidaciesAdapter(
  options: NcCandidaciesAdapterOptions = {},
): SourceAdapter<NcCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 50;
  const electionYear = options.electionYear ?? ELECTION_YEAR;

  const fetchImpl =
    options.fetch ??
    (async () => {
      const res = await politeFetch(sourceUrl, {
        headers: { Accept: 'text/csv,application/octet-stream,*/*' },
      });
      if (!res.ok) {
        throw new Error(
          `NC candidacies fetch failed: HTTP ${res.status} from ${sourceUrl}`,
        );
      }
      return { rawBody: await res.text(), resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<NcCandidacyRow> = {
    name: 'sos-north-carolina-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<NcCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      const { rawBody, resolvedUrl } = await fetchImpl(ctx);
      const contentHash = createHash('sha256').update(rawBody).digest('hex');

      ctx.logger.info(`${adapter.name}: fetched`, {
        bytes: rawBody.length,
        contentHash: contentHash.slice(0, 12),
      });

      const rows = parseNcCandidaciesCsv(rawBody);

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        elections: summarizeElections(rows),
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'north-carolina-sboe-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            byte_size: rawBody.length,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name?.trim()) return 'missing reported_name';
      if (!row.office_name?.trim()) return 'missing office_name';
      if (!row.election_date) return 'missing election_date';
      return null;
    },

    async insert(rows, refs, ctx): Promise<InsertStats> {
      return insertNcCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert (people + candidacies + candidacy_party_lines)
//
// Migrated 2026-04-26 to use the shared insertCandidacies helper. The shared
// helper carries the new local-races resolver fallback (school board / mayor /
// city council / county commissioner / sheriff / DA / ...) — without it,
// 510K+ NC candidate filings were failing to resolve into election rows.
//
// Behavioral changes vs. the bespoke implementation:
//   - Uses findOrCreateElection (auto-creates the election when one doesn't
//     exist), enabling local races whose 2026 elections weren't pre-seeded.
//   - Uses the shared resolveLocalOffice() fallback after the federal+state
//     ILIKE-on-canonical_name path fails; this is what brings school_board /
//     mayor / city_council / county_commissioner / sheriff candidacies in.
//   - Falls through to the same logIngestionError() pattern for unresolved
//     rows, preserving downstream observability.
// ---------------------------------------------------------------------------

async function insertNcCandidacies(
  rows: NcCandidacyRow[],
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
    party_raw: r.party_abbreviation,
    date_filed: r.date_filed,
    election_date: r.election_date,
    // NCSBE primary is closed (DEM/REP); general is nonpartisan-feeling but
    // recorded as 'general'. The election_date string drives the choice.
    election_type: r.election_date.endsWith('-03-03') ? 'primary' : 'general',
    source_row_id: r.source_row_id,
  }));

  return insertCandidacies(insertRows, refs, ctx, {
    stateFips: STATE_FIPS,
    source: 'nc-sboe-candidacies',
    electionYear,
  });
}

function summarizeElections(rows: NcCandidacyRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.election_date] = (out[r.election_date] ?? 0) + 1;
  return out;
}
