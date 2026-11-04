/**
 * Maryland State Board of Elections — 2026 Gubernatorial Primary
 * candidate-filings adapter (FIPS 24).
 *
 * Primary is 2026-06-23 (closed; party voters only).
 *
 * Source (web-verified 2026-04-25):
 *   Primary candidate listing index:
 *     https://elections.maryland.gov/elections/2026/primary_candidates/index.html
 *
 *   Authoritative CSV downloads (linked from the index page):
 *     statewide  → 2026_GP_statewide_candidatelist.csv
 *     local      → 2026_GP_all_counties_candidatelist.csv
 *
 *   Plus per-office CSVs for finer-grained ingest (Governor/LtGov,
 *   Comptroller, AG, US House by district, State Senate by district,
 *   House of Delegates by district, Circuit Court). The default fetch
 *   pulls the two consolidated files because they're the canonical
 *   superset used by SBE.
 *
 * Schema (verified by sniffing a CSV header 2026-04-25 — 35 columns):
 *   Office Name, Contest Run By District Name and Number,
 *   Candidate Ballot Last Name and Suffix, Candidate First Name and
 *   Middle Name, Additional Information, Office Political Party,
 *   Candidate Residential Jurisdiction, Candidate Gender,
 *   Candidate Status, Filing Type and Date, Campaign Mailing Address,
 *   Campaign Mailing City State and Zip, Public Phone, Email, Website,
 *   Facebook, X, Other, Committee Name, Has Related Candidate,
 *   Related Candidate Last Name and Suffix, ... (running-mate fields)
 *
 *   Joint tickets (Governor/LtGov) emit ONE row per ticket with
 *   running-mate cells populated; the adapter therefore emits two
 *   candidacy rows per ticket (top-of-ticket + LtGov person) so each
 *   person gets their own people row + candidacy.
 *
 *   Cloudflare-fronted (the index returns CF-styled headers) but the
 *   CSV endpoints serve plaintext directly with no challenge.
 */

import { createHash } from 'node:crypto';

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

const STATE_FIPS = '24';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-06-23';

const STATEWIDE_CSV_URL =
  'https://elections.maryland.gov/elections/2026/primary_candidates/2026_GP_statewide_candidatelist.csv';
const LOCAL_CSV_URL =
  'https://elections.maryland.gov/elections/2026/primary_candidates/2026_GP_all_counties_candidatelist.csv';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type MdCandidacyRow = {
  reported_name: string;
  office_name: string;
  /** "State Of Maryland" / "Allegany County" / "1st" (district) — kept raw. */
  contest_district_raw: string;
  district_identifier: string | null;
  party_raw: string;
  county: string | null;
  status_raw: string;
  date_filed: string | null;
  filing_type: string | null;
  is_running_mate: boolean;
  /** Top-of-ticket person id when this row is the running mate. */
  related_to_name: string | null;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type MdCandidaciesAdapterOptions = {
  statewideUrl?: string;
  localUrl?: string;
  electionYear?: number;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Inject CSV body fetcher (tests). */
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  /** Inject parser override (tests). */
  parseOverride?: (csv: string, source: 'statewide' | 'local') => MdCandidacyRow[];
  /** Skip the 'local' CSV (huge — 1.6MB). Default: include both. */
  skipLocal?: boolean;
};

// ---------------------------------------------------------------------------
// CSV parser (header-driven, RFC4180 quoting)
// ---------------------------------------------------------------------------

/** Robust CSV parser: handles quoted fields with embedded commas/newlines. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuote = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuote = true;
      } else if (c === ',') {
        row.push(cur);
        cur = '';
      } else if (c === '\n') {
        row.push(cur);
        out.push(row);
        row = [];
        cur = '';
      } else if (c === '\r') {
        // skip — handled with \n
      } else {
        cur += c;
      }
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    out.push(row);
  }
  return out;
}

export function parseMarylandCsv(
  csv: string,
  source: 'statewide' | 'local',
): MdCandidacyRow[] {
  if (!csv || csv.length < 64) return [];
  const cells = parseCsv(csv);
  if (cells.length < 2) return [];
  const header = cells[0]!.map((s) => s.trim());

  const idx = (label: string) =>
    header.findIndex((h) => h.toLowerCase() === label.toLowerCase());
  const I = {
    office: idx('Office Name'),
    contest: idx('Contest Run By District Name and Number'),
    last: idx('Candidate Ballot Last Name and Suffix'),
    first: idx('Candidate First Name and Middle Name'),
    addl: idx('Additional Information'),
    party: idx('Office Political Party'),
    juris: idx('Candidate Residential Jurisdiction'),
    status: idx('Candidate Status'),
    filing: idx('Filing Type and Date'),
    hasRelated: idx('Has Related Candidate'),
    relLast: idx('Related Candidate Last Name and Suffix'),
    relFirst: idx('Related Candidate First Name and Middle Name'),
    relStatus: idx('Related Candidate Status'),
    relFiling: idx('Related Candidate Filing Type and Date'),
    relParty: idx('Related Office Political Party'),
    relJuris: idx('Related Candidate County of Residence'),
  };

  const out: MdCandidacyRow[] = [];
  let counter = 0;

  for (let r = 1; r < cells.length; r++) {
    const row = cells[r];
    if (!row || row.length < 5) continue;
    const office = (row[I.office] ?? '').trim();
    if (!office) continue;
    const contest = (row[I.contest] ?? '').trim();
    const last = (row[I.last] ?? '').trim();
    const first = (row[I.first] ?? '').trim();
    if (!last && !first) continue;
    const name = [first, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

    const filing = (row[I.filing] ?? '').trim();
    const { type: filingType, date: filedDate } = parseFilingTypeAndDate(filing);
    const status = (row[I.status] ?? '').trim();
    const party = (row[I.party] ?? '').trim();
    const juris = (row[I.juris] ?? '').trim();
    const county = source === 'local' ? juris : null;
    const district = extractDistrictFromContest(contest, office);

    out.push({
      reported_name: name,
      office_name: office,
      contest_district_raw: contest,
      district_identifier: district,
      party_raw: party,
      county,
      status_raw: status,
      date_filed: filedDate,
      filing_type: filingType,
      is_running_mate: false,
      related_to_name: null,
      source_row_id: `md-${source}-r${counter++}-${last.toLowerCase()}`,
    });

    // Running-mate row (Governor/LtGov pattern)
    if (I.hasRelated >= 0 && (row[I.hasRelated] ?? '').trim().toLowerCase() === 'yes') {
      const relLast = (row[I.relLast] ?? '').trim();
      const relFirst = (row[I.relFirst] ?? '').trim();
      if (relLast || relFirst) {
        const relName = [relFirst, relLast].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        const relFiling = (row[I.relFiling] ?? '').trim();
        const { type: relType, date: relDate } = parseFilingTypeAndDate(relFiling);
        out.push({
          reported_name: relName,
          office_name: office,
          contest_district_raw: contest,
          district_identifier: district,
          party_raw: (row[I.relParty] ?? party).trim(),
          county: source === 'local' ? (row[I.relJuris] ?? '').trim() || null : null,
          status_raw: (row[I.relStatus] ?? status).trim(),
          date_filed: relDate ?? filedDate,
          filing_type: relType ?? filingType,
          is_running_mate: true,
          related_to_name: name,
          source_row_id: `md-${source}-r${counter++}-${relLast.toLowerCase()}-rm`,
        });
      }
    }
  }
  return out;
}

function parseFilingTypeAndDate(s: string): {
  type: string | null;
  date: string | null;
} {
  // Common shape: "Regular - 02/13/2026" or "Petition - 04/16/2026"
  if (!s) return { type: null, date: null };
  const m = /^(.+?)\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})$/.exec(s);
  if (m) {
    return { type: m[1]!.trim(), date: normalizeDate(m[2]!) };
  }
  const m2 = /^(\d{1,2}\/\d{1,2}\/\d{2,4})$/.exec(s);
  if (m2) return { type: null, date: normalizeDate(m2[1]!) };
  return { type: s, date: null };
}

function normalizeDate(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw.trim());
  if (!m) return null;
  const mm = m[1]!.padStart(2, '0');
  const dd = m[2]!.padStart(2, '0');
  const yyyy = m[3]!.length === 2 ? `20${m[3]!}` : m[3]!;
  return `${yyyy}-${mm}-${dd}`;
}

function extractDistrictFromContest(contest: string, office: string): string | null {
  // Examples:
  //   "Congressional District 3" → "3"
  //   "Legislative District 12B"  → "12B"
  //   "Circuit 1, Allegany County" → null (court, no numeric district)
  //   "State Of Maryland" → null
  const m = /\b(?:Congressional|Legislative)\s+District\s+(\d+[A-Z]?)/i.exec(contest);
  if (m) return m[1]!;
  const m2 = /\bDistrict\s+(\d+[A-Z]?)\b/i.exec(`${office} ${contest}`);
  if (m2) return m2[1]!;
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMdCandidaciesAdapter(
  options: MdCandidaciesAdapterOptions = {},
): SourceAdapter<MdCandidacyRow> {
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const statewideUrl = options.statewideUrl ?? STATEWIDE_CSV_URL;
  const localUrl = options.localUrl ?? LOCAL_CSV_URL;

  const fetchImpl =
    options.fetchOverride ??
    (async (url: string) => {
      const r = await politeFetch(url, {
        headers: { Accept: 'text/csv,application/octet-stream,*/*' },
      });
      return { status: r.status, body: await r.text() };
    });

  const parser = options.parseOverride ?? parseMarylandCsv;

  const adapter: SourceAdapter<MdCandidacyRow> = {
    name: 'sos-maryland-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<MdCandidacyRow>> {
      const allRows: MdCandidacyRow[] = [];
      const hashes: string[] = [];
      let totalBytes = 0;

      const sources: Array<{ url: string; label: 'statewide' | 'local' }> = [
        { url: statewideUrl, label: 'statewide' },
      ];
      if (!options.skipLocal) {
        sources.push({ url: localUrl, label: 'local' });
      }

      for (const s of sources) {
        await bucket.acquire();
        ctx.logger.info(`${adapter.name}: fetching`, {
          url: s.url,
          source: s.label,
        });
        const { status, body } = await fetchImpl(s.url);
        if (status !== 200) {
          ctx.logger.warn(`${adapter.name}: fetch ${s.label} failed`, { status });
          continue;
        }
        totalBytes += body.length;
        hashes.push(createHash('sha256').update(body).digest('hex'));
        const rows = parser(body, s.label);
        ctx.logger.info(`${adapter.name}: parsed ${s.label}`, {
          bytes: body.length,
          rows: rows.length,
        });
        allRows.push(...rows);
      }

      const aggregateHash = createHash('sha256').update(hashes.join('|')).digest('hex');

      return {
        rows: allRows,
        // Statewide alone is ~50 candidates (Gov tickets + Comp + AG +
        // 8 US House districts × ~6 + state legislators by district);
        // Floor at 30 to allow partial-window runs to be accepted.
        expectedMinRows: 30,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'maryland-sos-candidacies',
          url: statewideUrl,
          contentHash: aggregateHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            byte_size: totalBytes,
            sources_fetched: hashes.length,
            sources: sources.map((x) => x.label),
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name?.trim()) return 'missing reported_name';
      if (!row.office_name) return 'missing office_name';
      return null;
    },

    async insert(
      rows: MdCandidacyRow[],
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

      for (const row of rows) {
        try {
          const officeInfo = await resolveOfficeElection(ctx.pg, {
            state_fips: STATE_FIPS,
            office_name: row.office_name,
            district_identifier: row.district_identifier,
            election_year: electionYear,
          });
          if (!officeInfo) {
            stats.rowsSkipped += 1;
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `MD office not resolved: "${row.office_name}" district=${row.district_identifier ?? '-'} contest="${row.contest_district_raw}"`,
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
            source: 'sos-maryland-candidacies',
            dataSourceId: refs.dataSourceId,
          });

          const dbStatus = mapStatus(row.status_raw);
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
              dbStatus,
              row.date_filed,
              JSON.stringify({
                source: 'sos-maryland-candidacies',
                contest_district_raw: row.contest_district_raw,
                county: row.county,
                filing_type: row.filing_type,
                is_running_mate: row.is_running_mate,
                related_to_name: row.related_to_name,
                status_raw: row.status_raw,
                source_row_id: row.source_row_id,
                data_source_id: refs.dataSourceId,
              }),
            ],
          );
          const candidacyId = candidacyRes.rows[0]!.id;
          if (candidacyRes.rows[0]!.inserted) stats.rowsInserted += 1;
          else stats.rowsUpdated += 1;

          const partyId = row.party_raw
            ? await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS)
            : null;
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
                JSON.stringify({ source: 'sos-maryland-candidacies' }),
              ],
            );
          }
        } catch (err) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: `MD candidacy insert: ${err instanceof Error ? err.message : String(err)}`,
            rawInput: row,
          });
        }
      }
      return stats;
    },
  };

  return adapter;
}

function mapStatus(raw: string): 'active' | 'withdrew' | 'disqualified' | 'deceased' {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('withdrew') || s.includes('withdrawn')) return 'withdrew';
  if (s.includes('disqualified')) return 'disqualified';
  if (s.includes('deceased')) return 'deceased';
  return 'active';
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
    ctx.logger.warn('sos-maryland-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
