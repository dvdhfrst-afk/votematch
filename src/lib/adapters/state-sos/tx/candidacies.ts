/**
 * Texas Secretary of State — 2026 primary candidate-filings adapter (FIPS 48).
 *
 * P0 priority — TX 2026 primary was March 3, 2026. Runoffs on May 26, 2026.
 *
 * Source (web-verified 2026-04-25):
 *   https://goelect.txelections.civixapps.com/ivis-cbp-ui/candidate-information
 *
 * Underlying API (Civix-hosted Angular SPA → JSON over POST):
 *   GET  /api-ivis-cbp/api/cbp/getElectionsByYear/{year}
 *   POST /api-ivis-cbp/api/cbp/findQualifiedCandidates  body: { electionId, ... }
 *
 * 2026 elections (as published):
 *   - 53814: 2026 DEMOCRATIC PRIMARY ELECTION (2026-03-03)
 *   - 53813: 2026 REPUBLICAN PRIMARY ELECTION (2026-03-03)
 *
 * Per-row fields the API returns (probed 2026-04-25):
 *   idCandidate, cdParty (D/R), idElection, idOffice, txOfficeName,
 *   cdOfficeType (FD/SR/CN/...), txOfficeTypeName, txFullNameBallot,
 *   txFirstNameBallot, txLastNameBallot, dtFiled, cdFilingStatus
 *   (IP=in primary, IR=in runoff, AC=accepted, WD=withdrew, ...),
 *   cdDeclarationStatus (A=approved), flIncmbntGen, mailingAddress, ...
 *
 * Filing volume: ~3,300 Dem + ~5,500 Rep = ~8,800 rows total. Includes
 * federal + state + judicial + state board of education. County-level
 * primary candidacies are loaded via the same API but require iterating
 * over countyId — out of scope for v1 (ALL ~455K offices is a Phase 2
 * target).
 *
 * Strategy:
 *   1. Look up the Dem + Rep election ids via getElectionsByYear/2026.
 *   2. POST findQualifiedCandidates per election with electionId only.
 *   3. Parse the JSON arrays into TxCandidacyRow[].
 *   4. Filter to statewide offices we recognize (federal + state) — same
 *      conservative filter Indiana applies in TARGET_OFFICES.
 *   5. Resolve office via slug + district, then upsert people +
 *      candidacies + candidacy_party_lines (idempotent).
 *
 * District extraction: TX uses txOfficeName like
 *   "U. S. SENATOR ", "U. S. REPRESENTATIVE DISTRICT 1", "STATE SENATOR
 *   DISTRICT 12", "STATE REPRESENTATIVE DISTRICT 5", "GOVERNOR",
 *   "LIEUTENANT GOVERNOR", "ATTORNEY GENERAL", "COMPTROLLER OF PUBLIC
 *   ACCOUNTS", "COMMISSIONER OF THE GENERAL LAND OFFICE", "COMMISSIONER
 *   OF AGRICULTURE", "RAILROAD COMMISSIONER", "STATE BOARD OF EDUCATION
 *   DISTRICT N", and judicial seats. We extract district where present.
 */

import { createHash } from 'node:crypto';
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

const STATE_FIPS = '48';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-03-03';
const PRIMARY_RUNOFF_DATE = '2026-05-26';

const API_BASE =
  'https://goelect.txelections.civixapps.com/api-ivis-cbp/api/cbp';
const PORTAL_URL =
  'https://goelect.txelections.civixapps.com/ivis-cbp-ui/candidate-information';

/**
 * Office-name → office_type slug. We're conservative: only seats that
 * map cleanly to a single office_types row in our seed today. Anything
 * else (county, judicial sub-seats, party committee posts) gets skipped
 * and queued for Phase 2.
 */
const OFFICE_TYPE_SLUGS: Array<{ pattern: RegExp; slug: string; districted: boolean }> = [
  { pattern: /^U\.?\s*S\.?\s*SENATOR\b/i, slug: 'us_senator', districted: false },
  { pattern: /^U\.?\s*S\.?\s*REPRESENTATIVE\b/i, slug: 'us_representative', districted: true },
  { pattern: /^GOVERNOR\b/i, slug: 'governor', districted: false },
  { pattern: /^LIEUTENANT\s+GOVERNOR\b/i, slug: 'lieutenant_governor', districted: false },
  { pattern: /^ATTORNEY\s+GENERAL\b/i, slug: 'attorney_general', districted: false },
  { pattern: /^COMPTROLLER\b/i, slug: 'state_comptroller', districted: false },
  { pattern: /^COMMISSIONER\s+OF\s+THE\s+GENERAL\s+LAND\s+OFFICE\b/i, slug: 'state_land_commissioner', districted: false },
  { pattern: /^COMMISSIONER\s+OF\s+AGRICULTURE\b/i, slug: 'state_agriculture_commissioner', districted: false },
  { pattern: /^RAILROAD\s+COMMISSIONER\b/i, slug: 'state_railroad_commissioner', districted: false },
  { pattern: /^STATE\s+SENATOR\b/i, slug: 'state_senator', districted: true },
  { pattern: /^STATE\s+REPRESENTATIVE\b/i, slug: 'state_representative', districted: true },
  { pattern: /^STATE\s+BOARD\s+OF\s+EDUCATION\b/i, slug: 'state_board_of_education', districted: true },
];

/**
 * Statuses that count as an active filing. Anything else (withdrew,
 * deceased, declared ineligible, rejected) is skipped — we don't want
 * dead candidacies in the public-facing roster.
 */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'IP', // In Primary
  'IR', // In Runoff
  'AC', // Accepted
  'CG', // Candidate in the General Election
]);

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type TxCandidacyRow = {
  reported_name: string;
  /** TX uses 'D' / 'R' / 'L' / 'G' codes via cdParty. */
  party_raw: string;
  /** Original txOfficeName from the API. */
  office_raw: string;
  /** Resolved canonical slug used against office_types.slug. */
  office_type_slug: string;
  /** District as bare integer string ('1', '23'); null for statewide. */
  district_identifier: string | null;
  /** Filing status code from the API (IP, IR, AC, CG). */
  filing_status: string;
  /** ISO date filed (yyyy-mm-dd) when present. */
  date_filed: string | null;
  /** TX civix idCandidate; used for source_row_id idempotency. */
  candidate_id: number;
  /** Source election id (D=53814, R=53813 for 2026). */
  election_id: number;
  /** Stable per-row dedup key. */
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type TxCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Inject for tests. Returns the merged JSON array of all candidates. */
  fetch?: (ctx: AdapterContext) => Promise<{
    rows: unknown[];
    contentHash: string;
    resolvedUrl?: string;
    meta?: Record<string, unknown>;
  }>;
  expectedMinRows?: number;
};

// ---------------------------------------------------------------------------
// Pure parser (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Convert one civix candidate JSON object → TxCandidacyRow (or null when
 * the office is out of scope or filing is inactive).
 */
export function parseTxCandidate(raw: unknown): TxCandidacyRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const name =
    typeof r.txFullNameBallot === 'string' && r.txFullNameBallot.trim()
      ? r.txFullNameBallot.trim()
      : combineName(
          r.txFirstNameBallot,
          r.txMiddleNameBallot,
          r.txLastNameBallot,
        );
  if (!name) return null;

  const office = typeof r.txOfficeName === 'string' ? r.txOfficeName.trim() : '';
  if (!office) return null;

  const status =
    typeof r.cdFilingStatus === 'string' ? r.cdFilingStatus.toUpperCase() : '';
  if (status && !ACTIVE_STATUSES.has(status)) return null;

  const party =
    typeof r.cdParty === 'string' && r.cdParty.trim() ? r.cdParty.trim() : '';
  if (!party) return null;

  const slugInfo = resolveOfficeSlug(office);
  if (!slugInfo) return null;

  const district = slugInfo.districted ? extractTxDistrict(office) : null;
  // Districted offices that don't carry a district are unusable.
  if (slugInfo.districted && !district) return null;

  const candidateId =
    typeof r.idCandidate === 'number' ? r.idCandidate : Number(r.idCandidate);
  if (!Number.isFinite(candidateId)) return null;
  const electionId =
    typeof r.idElection === 'number' ? r.idElection : Number(r.idElection);

  const dtFiled = typeof r.dtFiled === 'string' ? r.dtFiled.slice(0, 10) : null;
  const dateFiled = dtFiled && /^\d{4}-\d{2}-\d{2}$/.test(dtFiled) ? dtFiled : null;

  return {
    reported_name: name,
    party_raw: party,
    office_raw: office,
    office_type_slug: slugInfo.slug,
    district_identifier: district,
    filing_status: status || 'AC',
    date_filed: dateFiled,
    candidate_id: candidateId,
    election_id: Number.isFinite(electionId) ? electionId : 0,
    source_row_id: `tx-${electionId}-${candidateId}`,
  };
}

export function parseTxCandidatesJson(raw: string | unknown[]): TxCandidacyRow[] {
  let arr: unknown[] = [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      return [];
    }
  } else if (Array.isArray(raw)) {
    arr = raw;
  }
  const out: TxCandidacyRow[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const row = parseTxCandidate(item);
    if (!row) continue;
    if (seen.has(row.source_row_id)) continue;
    seen.add(row.source_row_id);
    out.push(row);
  }
  return out;
}

function combineName(first: unknown, middle: unknown, last: unknown): string {
  const parts: string[] = [];
  if (typeof first === 'string' && first.trim()) parts.push(first.trim());
  if (typeof middle === 'string' && middle.trim()) parts.push(middle.trim());
  if (typeof last === 'string' && last.trim()) parts.push(last.trim());
  return parts.join(' ');
}

export function resolveOfficeSlug(
  office: string,
): { slug: string; districted: boolean } | null {
  const trimmed = office.trim();
  for (const entry of OFFICE_TYPE_SLUGS) {
    if (entry.pattern.test(trimmed)) {
      return { slug: entry.slug, districted: entry.districted };
    }
  }
  return null;
}

export function extractTxDistrict(office: string): string | null {
  const m = /\bDISTRICT\s+0*(\d{1,3})\b/i.exec(office);
  if (m && m[1]) return m[1];
  // Fallback: trailing integer
  const m2 = /\b(\d{1,3})\s*$/.exec(office.trim());
  if (m2 && m2[1]) return m2[1];
  return null;
}

// ---------------------------------------------------------------------------
// Office resolution
// ---------------------------------------------------------------------------

async function resolveTxOfficeBySlug(
  pg: Pool,
  input: { office_type_slug: string; district_identifier: string | null },
): Promise<string | null> {
  if (input.district_identifier) {
    const sql = `
      SELECT o.id
      FROM offices o
      JOIN office_types ot ON ot.id = o.office_type_id
      JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE j.fips_state = $1
        AND ot.slug = $2
        AND (
          o.seat_designation ILIKE $3
          OR o.seat_designation ILIKE $4
          OR o.canonical_name ILIKE $3
          OR (o.meta->>'district_name') = $5
        )
      ORDER BY (o.seat_designation ILIKE $4)::int DESC, o.created_at ASC
      LIMIT 1
    `;
    const d = input.district_identifier;
    const res = await pg.query<{ id: string }>(sql, [
      STATE_FIPS,
      input.office_type_slug,
      `%District ${d}%`,
      `District ${d}`,
      d,
    ]);
    if (res.rows[0]) return res.rows[0].id;
  } else {
    const sql = `
      SELECT o.id
      FROM offices o
      JOIN office_types ot ON ot.id = o.office_type_id
      JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE j.fips_state = $1
        AND ot.slug = $2
      ORDER BY o.created_at ASC
      LIMIT 1
    `;
    const res = await pg.query<{ id: string }>(sql, [
      STATE_FIPS,
      input.office_type_slug,
    ]);
    if (res.rows[0]) return res.rows[0].id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Network fetch (default impl)
// ---------------------------------------------------------------------------

async function defaultFetch(): Promise<{
  rows: unknown[];
  contentHash: string;
  resolvedUrl: string;
  meta: Record<string, unknown>;
}> {
  const headers = {
    Accept: 'application/json',
    Referer: PORTAL_URL,
    Origin: 'https://goelect.txelections.civixapps.com',
  };

  // 1. Get the 2026 elections list
  const listRes = await politeFetch(
    `${API_BASE}/getElectionsByYear/${ELECTION_YEAR}`,
    { headers },
  );
  if (!listRes.ok) {
    throw new Error(
      `TX getElectionsByYear failed: HTTP ${listRes.status}`,
    );
  }
  const elections = (await listRes.json()) as Array<{
    idElection: number;
    txElectionName: string;
    cdElectionType: string;
    dtElectionDate: string;
  }>;

  // Pick all PRIMARY (P) elections in 2026 — there are typically 2 (D + R).
  const primaries = elections.filter(
    (e) =>
      e.cdElectionType === 'P' &&
      typeof e.dtElectionDate === 'string' &&
      e.dtElectionDate.startsWith(`${ELECTION_YEAR}-`),
  );

  // 2. Fetch candidates per election. Retry transient 5xx — the Civix
  //    backend periodically returns HTTP 500 under load (observed
  //    2026-04-26) but the same payload succeeds on a fresh connection.
  //    Three tries with exponential backoff (1s, 2s, 4s) covers the
  //    typical recovery window without delaying the run more than ~7s
  //    in the worst case. 4xx is NOT retried — those represent a
  //    semantically wrong request (e.g. invalid electionId).
  const allRows: unknown[] = [];
  const electionMeta: Array<{ id: number; name: string; rowCount: number }> = [];

  for (const el of primaries) {
    const body = {
      electionId: el.idElection,
      countyId: null,
      party: '',
      officeId: '',
      officeType: '',
      status: '',
      source: 'TX',
    };

    let res: Awaited<ReturnType<typeof politeFetch>> | null = null;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await politeFetch(`${API_BASE}/findQualifiedCandidates`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      lastStatus = res.status;
      if (res.ok) break;
      if (res.status >= 400 && res.status < 500) break; // not transient
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    if (!res || !res.ok) {
      throw new Error(
        `TX findQualifiedCandidates failed for ${el.idElection}: HTTP ${lastStatus} (after retries)`,
      );
    }
    const rows = (await res.json()) as unknown[];
    if (!Array.isArray(rows)) continue;
    allRows.push(...rows);
    electionMeta.push({
      id: el.idElection,
      name: el.txElectionName,
      rowCount: rows.length,
    });
  }

  const serialized = JSON.stringify(allRows);
  const contentHash = createHash('sha256').update(serialized).digest('hex');
  return {
    rows: allRows,
    contentHash,
    resolvedUrl: PORTAL_URL,
    meta: { primaries: electionMeta },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTxCandidaciesAdapter(
  options: TxCandidaciesAdapterOptions = {},
): SourceAdapter<TxCandidacyRow> {
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 100;
  const sourceUrl = options.sourceUrl ?? PORTAL_URL;

  const adapter: SourceAdapter<TxCandidacyRow> = {
    name: 'sos-texas-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<TxCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      let fetchOutcome: {
        rows: unknown[];
        contentHash: string;
        resolvedUrl?: string;
        meta?: Record<string, unknown>;
      };
      try {
        fetchOutcome = options.fetch ? await options.fetch(ctx) : await defaultFetch();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`${adapter.name}: fetch failed — returning empty`, {
          error: msg,
        });
        // Return a stable, empty result so the runner records 'partial'
        // rather than 'failed'. TX is high-priority but we never want a
        // CivixApps outage to crash the dispatcher.
        const emptyHash = createHash('sha256').update('').digest('hex');
        return {
          rows: [],
          expectedMinRows,
          source: {
            sourceType: 'sos_candidate_filing',
            name: 'texas-sos-candidacies',
            url: sourceUrl,
            contentHash: emptyHash,
            license,
            stateFips: STATE_FIPS,
            meta: {
              election_year: ELECTION_YEAR,
              primary_date: PRIMARY_DATE,
              primary_runoff_date: PRIMARY_RUNOFF_DATE,
              fetch_error: msg.slice(0, 500),
            },
          },
          parserSignal: 'parse_failed',
        };
      }

      const rows = parseTxCandidatesJson(fetchOutcome.rows);
      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        offices: summarizeBySlug(rows),
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'texas-sos-candidacies',
          url: fetchOutcome.resolvedUrl ?? sourceUrl,
          contentHash: fetchOutcome.contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: ELECTION_YEAR,
            primary_date: PRIMARY_DATE,
            primary_runoff_date: PRIMARY_RUNOFF_DATE,
            ...(fetchOutcome.meta ?? {}),
            byte_size: JSON.stringify(fetchOutcome.rows).length,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name?.trim()) return 'missing reported_name';
      if (!row.office_type_slug) return 'missing office_type_slug';
      if (!row.party_raw) return 'missing party_raw';
      return null;
    },

    async insert(
      rows: TxCandidacyRow[],
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
        const cacheKey = `${row.office_type_slug}|${row.district_identifier ?? '-'}`;
        let officeId = officeCache.get(cacheKey) ?? null;
        if (!officeCache.has(cacheKey)) {
          officeId = await resolveTxOfficeBySlug(ctx.pg, {
            office_type_slug: row.office_type_slug,
            district_identifier: row.district_identifier,
          });
          if (!officeId) {
            // Fallback to the shared resolver for offices that aren't
            // seeded under our exact slug.
            const fb = await resolveOfficeElection(ctx.pg, {
              state_fips: STATE_FIPS,
              office_name: row.office_raw,
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
            `TX office not resolved: slug=${row.office_type_slug} district=${row.district_identifier ?? '-'} raw="${row.office_raw}"`,
            row,
          );
          continue;
        }

        if (ctx.dryRun) {
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
          const personId = await findOrCreateStatePerson(ctx.pg, {
            name: row.reported_name,
            state_fips: STATE_FIPS,
            electionYear: ELECTION_YEAR,
            source: adapter.name,
            dataSourceId: refs.dataSourceId,
          });
          const { candidacyId, created } = await upsertCandidacy(
            ctx,
            electionId,
            personId,
            row.party_raw,
            row.date_filed,
            refs.dataSourceId,
            row.source_row_id,
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
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `TX party not resolved: "${row.party_raw}" for ${row.reported_name}`,
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
            message: `TX candidacy insert: ${msg}`,
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
// DB helpers (pattern matches in/candidacies.ts)
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
        source: 'sos-texas-candidacies',
        data_source_id: dataSourceId ?? null,
      }),
    ],
  );
  return ins.rows[0]!.id;
}

async function upsertCandidacy(
  ctx: AdapterContext,
  electionId: string,
  personId: string,
  partyRaw: string,
  dateFiled: string | null,
  dataSourceId: string | undefined,
  sourceRowId: string,
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
        source: 'sos-texas-candidacies',
        data_source_id: dataSourceId ?? null,
        source_row_id: sourceRowId,
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
      JSON.stringify({ source: 'sos-texas-candidacies' }),
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
    ctx.logger.warn('sos-texas-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function summarizeBySlug(rows: TxCandidacyRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.office_type_slug] = (out[r.office_type_slug] ?? 0) + 1;
  return out;
}
