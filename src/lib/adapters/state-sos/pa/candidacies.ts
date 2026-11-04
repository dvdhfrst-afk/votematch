/**
 * Pennsylvania Department of State — 2026 candidate-filings adapter (FIPS 42).
 *
 * 2026 PA primary date: 2026-05-19. General: 2026-11-03.
 *
 * Source (web-verified 2026-04-25):
 *   https://www.pavoterservices.pa.gov/ElectionInfo/ElectionInfo.aspx
 *
 * The page is a SharePoint/ASP.NET application that ships the full
 * candidate roster as a JSON array embedded in a hidden form field
 * (`<input id='dataJson' type='hidden' value='[...]'/>`). At verification
 * time (2026-04-25) the page returned a ~960KB body containing
 * approved candidates for the 2026 cycle (governor, lt gov, US House,
 * state senate, state house, state committee).
 *
 * Per-row fields observed:
 *   CandidateID, CandidateIDNum, CandidateName ("LAST, FIRST"),
 *   PartyName ("Democratic" | "Republican" | ...),
 *   CandidateStatusValue ("Approved" | "Withdrawn" | "Removed"),
 *   CandidateTypeValue ("Petition" | "Nomination" | ...),
 *   OfficeName, DistrictName ("Statewide" | "10th Congressional District" |
 *   "100th Legislative District" | "10th Senatorial District" | ...),
 *   ElectionName ("2026 General Election" — primary candidates roll into
 *   the same view post-primary), CountyName, ObjectionID,
 *   PrimaryResult, GeneralResult, CommitteeID.
 *
 * Out-of-scope this adapter:
 *   - "MEMBER OF DEMOCRATIC/REPUBLICAN STATE COMMITTEE" — party-internal,
 *     intentionally skipped.
 *   - Withdrawn / removed filings — only Approved rows are inserted.
 *   - County / municipal candidates not in the dataJson payload.
 *
 * Adapter health: the portal was publicly fetchable until 2026-04-25,
 * when it began serving an Imperva interstitial. If the interstitial is
 * returned, the adapter parses nothing, records 0 rows and reports
 * 'no_table' (unproductive). When the page is served normally, a run
 * produced 1260 dataJson rows → 464 eligible after the statewide-office
 * filter → 193 inserted.
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

const STATE_FIPS = '42';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-05-19';

const SOURCE_URL =
  'https://www.pavoterservices.pa.gov/ElectionInfo/ElectionInfo.aspx';

/**
 * Office classification — PA uses verbose office names. We map to the
 * same office_types.slug vocabulary used elsewhere; "Senator In The
 * General Assembly" → state_senator, "Representative In The General
 * Assembly" → state_representative, "Representative In Congress" →
 * us_representative.
 */
const OFFICE_TYPE_MAP: Array<{ pattern: RegExp; slug: string; districted: boolean }> = [
  { pattern: /^GOVERNOR\b/i, slug: 'governor', districted: false },
  { pattern: /^LIEUTENANT\s+GOVERNOR\b/i, slug: 'lieutenant_governor', districted: false },
  { pattern: /^ATTORNEY\s+GENERAL\b/i, slug: 'attorney_general', districted: false },
  { pattern: /^AUDITOR\s+GENERAL\b/i, slug: 'state_auditor', districted: false },
  { pattern: /^STATE\s+TREASURER\b/i, slug: 'state_treasurer', districted: false },
  { pattern: /^U\.?\s*S\.?\s*SENATOR\b/i, slug: 'us_senator', districted: false },
  { pattern: /^REPRESENTATIVE\s+IN\s+CONGRESS\b/i, slug: 'us_representative', districted: true },
  { pattern: /^SENATOR\s+IN\s+THE\s+GENERAL\s+ASSEMBLY\b/i, slug: 'state_senator', districted: true },
  { pattern: /^REPRESENTATIVE\s+IN\s+THE\s+GENERAL\s+ASSEMBLY\b/i, slug: 'state_representative', districted: true },
];

const SKIP_OFFICE_PATTERNS: RegExp[] = [
  /MEMBER\s+OF\s+(DEMOCRATIC|REPUBLICAN|LIBERTARIAN|GREEN)\s+STATE\s+COMMITTEE/i,
  /DELEGATE\s+TO\s+/i,
  /ALTERNATE\s+DELEGATE/i,
];

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type PaCandidacyRow = {
  reported_name: string;
  party_raw: string;
  office_raw: string;
  office_type_slug: string;
  district_identifier: string | null;
  /** Filing status (Approved | Pending | Withdrawn | Removed). */
  status_raw: string;
  /** Pa-specific candidate ID like '2026C0403' — used as source_row_id. */
  candidate_id_num: string;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type PaCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Inject for tests. */
  fetch?: (ctx: AdapterContext) => Promise<{
    rawHtml: string;
    contentHash: string;
    resolvedUrl?: string;
  }>;
  expectedMinRows?: number;
};

// ---------------------------------------------------------------------------
// Pure parser (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Pull the dataJson hidden field out of the raw HTML and parse it.
 * Returns [] if the field is missing or unparseable.
 */
export function extractDataJson(rawHtml: string): unknown[] {
  if (!rawHtml || rawHtml.length < 64) return [];
  // The page uses single-quoted attribute values; the JSON itself uses
  // double quotes. Match conservatively to the *first* unescaped single
  // quote, which is the closing one for value=' ... '.
  // Use [\s\S] in lieu of the `s` flag for ES2017 compat.
  const m = /id=['"]dataJson['"][^>]*value=['"](\[[\s\S]*?\])['"]/.exec(rawHtml);
  if (!m) return [];
  const decoded = m[1]!
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'");
  try {
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parsePaCandidate(raw: unknown): PaCandidacyRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const status = typeof r.CandidateStatusValue === 'string' ? r.CandidateStatusValue : '';
  if (status && !/approved|active/i.test(status)) return null;

  const office = typeof r.OfficeName === 'string' ? r.OfficeName.trim() : '';
  if (!office) return null;
  if (SKIP_OFFICE_PATTERNS.some((p) => p.test(office))) return null;

  const slugInfo = resolvePaOfficeSlug(office);
  if (!slugInfo) return null;

  const districtRaw = typeof r.DistrictName === 'string' ? r.DistrictName.trim() : '';
  const district = slugInfo.districted ? extractPaDistrict(districtRaw) : null;
  if (slugInfo.districted && !district) return null;

  const rawName = typeof r.CandidateName === 'string' ? r.CandidateName.trim() : '';
  if (!rawName) return null;
  const reportedName = normalizePaName(rawName);

  const party = typeof r.PartyName === 'string' ? r.PartyName.trim() : '';
  if (!party) return null;

  const candId =
    typeof r.CandidateIDNum === 'string' && r.CandidateIDNum.trim()
      ? r.CandidateIDNum.trim()
      : String(r.CandidateID ?? '');
  if (!candId) return null;

  return {
    reported_name: reportedName,
    party_raw: party,
    office_raw: office,
    office_type_slug: slugInfo.slug,
    district_identifier: district,
    status_raw: status,
    candidate_id_num: candId,
    source_row_id: `pa-${candId}`,
  };
}

export function parsePaCandidates(raw: unknown[]): PaCandidacyRow[] {
  const out: PaCandidacyRow[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const row = parsePaCandidate(item);
    if (!row) continue;
    if (seen.has(row.source_row_id)) continue;
    seen.add(row.source_row_id);
    out.push(row);
  }
  return out;
}

export function resolvePaOfficeSlug(
  office: string,
): { slug: string; districted: boolean } | null {
  for (const entry of OFFICE_TYPE_MAP) {
    if (entry.pattern.test(office)) {
      return { slug: entry.slug, districted: entry.districted };
    }
  }
  return null;
}

/** "10th Congressional District" / "100th Legislative District" → "10" / "100". */
export function extractPaDistrict(raw: string): string | null {
  if (!raw) return null;
  const m = /^(\d{1,3})(?:st|nd|rd|th)\b/i.exec(raw.trim());
  if (m) return m[1]!;
  const m2 = /\bdistrict\s+(\d{1,3})\b/i.exec(raw);
  if (m2) return m2[1]!;
  return null;
}

/**
 * "SAMPLETON, JORDAN D" → "JORDAN D SAMPLETON".
 * Drop trailing single-letter middle initials only when collapsing
 * comma form; keep full middle names. Empty input → "".
 */
export function normalizePaName(raw: string): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const commaIdx = cleaned.indexOf(',');
  if (commaIdx < 0) return cleaned;
  const last = cleaned.slice(0, commaIdx).trim();
  const rest = cleaned.slice(commaIdx + 1).trim();
  if (!rest) return last;
  return `${rest} ${last}`.trim();
}

// ---------------------------------------------------------------------------
// Default fetch
// ---------------------------------------------------------------------------

/**
 * Detect the Imperva / Incapsula "Pardon Our Interruption" interstitial.
 * Body is small (~4.5KB) and contains the literal phrase plus a noscript
 * `<title>Pardon Our Interruption</title>` tag.
 */
export function isImpervaChallenge(html: string): boolean {
  if (!html || html.length === 0) return false;
  // Both phrasings observed across PA / MA / NV (April 2026).
  if (html.includes('Pardon Our Interruption')) return true;
  if (html.includes('Incapsula incident ID')) return true;
  if (html.includes('_Incapsula_Resource')) return true;
  return false;
}

async function defaultFetch(): Promise<{
  rawHtml: string;
  contentHash: string;
  resolvedUrl: string;
  imperva_walled: boolean;
}> {
  // Plain politeFetch. An Imperva interstitial is returned as-is and
  // yields 0 rows downstream (imperva_walled is recorded in the meta).
  const res = await politeFetch(SOURCE_URL, {
    headers: { Accept: 'text/html,*/*' },
  });
  const rawHtml = await res.text();
  const resolvedUrl = res.url ?? SOURCE_URL;

  if (!res.ok && !isImpervaChallenge(rawHtml)) {
    throw new Error(`PA candidacies fetch failed: HTTP ${res.status}`);
  }

  const contentHash = createHash('sha256').update(rawHtml).digest('hex');
  return {
    rawHtml,
    contentHash,
    resolvedUrl,
    imperva_walled: isImpervaChallenge(rawHtml),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPaCandidaciesAdapter(
  options: PaCandidaciesAdapterOptions = {},
): SourceAdapter<PaCandidacyRow> {
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 50;
  const sourceUrl = options.sourceUrl ?? SOURCE_URL;

  const adapter: SourceAdapter<PaCandidacyRow> = {
    name: 'sos-pennsylvania-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<PaCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      let outcome: {
        rawHtml: string;
        contentHash: string;
        resolvedUrl?: string;
        imperva_walled?: boolean;
      };
      try {
        outcome = options.fetch ? await options.fetch(ctx) : await defaultFetch();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`${adapter.name}: fetch failed — returning empty`, {
          error: msg,
        });
        return {
          rows: [],
          expectedMinRows,
          source: {
            sourceType: 'sos_candidate_filing',
            name: 'pennsylvania-sos-candidacies',
            url: sourceUrl,
            contentHash: createHash('sha256').update('').digest('hex'),
            license,
            stateFips: STATE_FIPS,
            meta: {
              election_year: ELECTION_YEAR,
              primary_date: PRIMARY_DATE,
              fetch_error: msg.slice(0, 500),
            },
          },
          parserSignal: 'parse_failed',
        };
      }

      const dataJson = extractDataJson(outcome.rawHtml);
      const rows = parsePaCandidates(dataJson);

      ctx.logger.info(`${adapter.name}: parsed`, {
        dataJsonRows: dataJson.length,
        eligibleRows: rows.length,
        offices: summarizeBySlug(rows),
        imperva_walled: outcome.imperva_walled ?? false,
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'pennsylvania-sos-candidacies',
          url: outcome.resolvedUrl ?? sourceUrl,
          contentHash: outcome.contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: ELECTION_YEAR,
            primary_date: PRIMARY_DATE,
            html_size: outcome.rawHtml.length,
            data_json_rows: dataJson.length,
            imperva_walled: outcome.imperva_walled ?? false,
          },
        },
        parserSignal: dataJson.length === 0 ? 'no_table' : 'ok',
      };
    },

    validateRow(row) {
      if (!row.reported_name?.trim()) return 'missing reported_name';
      if (!row.office_type_slug) return 'missing office_type_slug';
      if (!row.party_raw) return 'missing party_raw';
      return null;
    },

    async insert(
      rows: PaCandidacyRow[],
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
          officeId = await resolveOfficeBySlug(ctx.pg, {
            office_type_slug: row.office_type_slug,
            district_identifier: row.district_identifier,
          });
          if (!officeId) {
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
            `PA office not resolved: slug=${row.office_type_slug} district=${row.district_identifier ?? '-'} raw="${row.office_raw}"`,
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
            refs.dataSourceId,
            row.source_row_id,
          );

          const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);
          if (partyId) {
            await upsertPartyLine(ctx, candidacyId, partyId, refs.dataSourceId);
          } else {
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `PA party not resolved: "${row.party_raw}" for ${row.reported_name}`,
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
            message: `PA candidacy insert: ${msg}`,
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

async function resolveOfficeBySlug(
  pg: Pool,
  input: { office_type_slug: string; district_identifier: string | null },
): Promise<string | null> {
  if (input.district_identifier) {
    const sql = `
      SELECT o.id FROM offices o
      JOIN office_types ot ON ot.id = o.office_type_id
      JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE j.fips_state = $1
        AND ot.slug = $2
        AND (
          o.seat_designation ILIKE $3
          OR o.seat_designation ILIKE $4
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
      SELECT o.id FROM offices o
      JOIN office_types ot ON ot.id = o.office_type_id
      JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE j.fips_state = $1 AND ot.slug = $2
      ORDER BY o.created_at ASC LIMIT 1
    `;
    const res = await pg.query<{ id: string }>(sql, [
      STATE_FIPS,
      input.office_type_slug,
    ]);
    if (res.rows[0]) return res.rows[0].id;
  }
  return null;
}

async function findOrCreateElection(
  ctx: AdapterContext,
  officeId: string,
  electionDate: string,
  dataSourceId: string | undefined,
): Promise<string> {
  const sel = await ctx.pg.query<{ id: string }>(
    `SELECT id FROM elections WHERE office_id = $1 AND election_date = $2::date LIMIT 1`,
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
        source: 'sos-pennsylvania-candidacies',
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
  dataSourceId: string | undefined,
  sourceRowId: string,
): Promise<{ candidacyId: string; created: boolean }> {
  const sel = await ctx.pg.query<{ id: string }>(
    `SELECT id FROM candidacies WHERE election_id = $1 AND person_id = $2 LIMIT 1`,
    [electionId, personId],
  );
  if (sel.rows[0]) {
    await ctx.pg.query(
      `UPDATE candidacies
          SET party = $1,
              status = CASE WHEN status IN ('withdrew','disqualified') THEN status ELSE 'active' END
        WHERE id = $2`,
      [partyRaw, sel.rows[0].id],
    );
    return { candidacyId: sel.rows[0].id, created: false };
  }
  const ins = await ctx.pg.query<{ id: string }>(
    `INSERT INTO candidacies (election_id, person_id, party, status, meta)
     VALUES ($1, $2, $3, 'active', $4::jsonb)
     RETURNING id`,
    [
      electionId,
      personId,
      partyRaw,
      JSON.stringify({
        source: 'sos-pennsylvania-candidacies',
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
  dataSourceId: string | undefined,
): Promise<void> {
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
      JSON.stringify({ source: 'sos-pennsylvania-candidacies' }),
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
    ctx.logger.warn('sos-pennsylvania-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function summarizeBySlug(rows: PaCandidacyRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.office_type_slug] = (out[r.office_type_slug] ?? 0) + 1;
  return out;
}
