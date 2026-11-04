/**
 * South Dakota Secretary of State — 2026 primary candidate-filings adapter (FIPS 46).
 *
 * SD primary date: 2026-06-02. SD selects most state executive
 * candidates at party conventions in June 2026 — only Governor and
 * federal offices appear on the primary ballot. State legislative
 * primaries are also active (typical year ~120 leg races).
 *
 * Source (web-verified 2026-04-25):
 *   https://vip.sdsos.gov/candidatelist.aspx?eid=773
 *
 * The page is a Telerik RadGrid in an ASP.NET WebForms wrapper. The
 * server renders 50 rows at a time (paged via __doPostBack); however,
 * ALL rows include every cell as inline HTML (some hidden via
 * style="display:none;") so we can scrape from one page download per
 * page index. Pagination is via the "ChangePage" command on the
 * grdCandidates RadGrid, which the page exposes as a __doPostBack
 * payload. We iterate pages until rgRow yields fewer rows than the
 * page size (or we hit a configured max).
 *
 * Visible columns (order in tbody):
 *   0: Contest, 1: Name, 2: Party, 3: Petition Filing Date,
 *   4: District (or '&nbsp;'), 5: Ballot Order,
 *   6: (hidden — withdrawn date), 7: Mailing Address, 8+: hidden state.
 *
 * What's on the 2026 SD primary:
 *   - 1 × U.S. Senator
 *   - 1 × U.S. Representative (at-large)
 *   - 1 × Governor
 *   - State Senate (35 districts; half on cycle)
 *   - State Representative (35 districts × 2 = 70 seats)
 *   - Local convention contests: (skipped here)
 *
 * Status handling: rows with "(Withdrawn MM/DD/YYYY)" suffix in the
 * Name cell are filtered out — we only ingest active filings.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
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

const STATE_FIPS = '46';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-06-02';
const SOURCE_URL = 'https://vip.sdsos.gov/candidatelist.aspx?eid=773';

const OFFICE_TYPE_MAP: Array<{ pattern: RegExp; slug: string; districted: boolean }> = [
  { pattern: /^United\s+States\s+Senator\b/i, slug: 'us_senator', districted: false },
  { pattern: /^United\s+States\s+Representative\b/i, slug: 'us_representative', districted: false },
  { pattern: /^Governor\b/i, slug: 'governor', districted: false },
  { pattern: /^Lieutenant\s+Governor\b/i, slug: 'lieutenant_governor', districted: false },
  { pattern: /^Attorney\s+General\b/i, slug: 'attorney_general', districted: false },
  { pattern: /^Secretary\s+of\s+State\b/i, slug: 'secretary_of_state', districted: false },
  { pattern: /^State\s+Auditor\b/i, slug: 'state_auditor', districted: false },
  { pattern: /^State\s+Treasurer\b/i, slug: 'state_treasurer', districted: false },
  { pattern: /^Public\s+Utilities\s+Commissioner\b/i, slug: 'state_public_utilities_commissioner', districted: false },
  { pattern: /^State\s+Senator\b/i, slug: 'state_senator', districted: true },
  { pattern: /^State\s+Representative\b/i, slug: 'state_representative', districted: true },
];

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type SdCandidacyRow = {
  reported_name: string;
  party_raw: string;
  office_raw: string;
  office_type_slug: string;
  district_identifier: string | null;
  date_filed: string | null;
  /** Synthetic per-row dedup key. */
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type SdCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Inject test HTML pages — useful for unit tests. */
  fetch?: (ctx: AdapterContext) => Promise<{
    pages: string[];
    contentHash: string;
    resolvedUrl?: string;
  }>;
  expectedMinRows?: number;
};

// ---------------------------------------------------------------------------
// Pure parser
// ---------------------------------------------------------------------------

/**
 * Extract candidacy rows from one rendered page of the SD candidate
 * list. We only read the visible (non-display:none) columns since the
 * hidden ones repeat data we already have.
 */
export function parseSdCandidatePage(rawHtml: string): SdCandidacyRow[] {
  if (!rawHtml || rawHtml.length < 64) return [];
  const $ = cheerio.load(rawHtml);
  const out: SdCandidacyRow[] = [];

  $('tr.rgRow, tr.rgAltRow').each((_idx, tr) => {
    const cells = $(tr)
      .children('td')
      .map((_i, el) => ({
        text: $(el).text().replace(/ /g, ' ').trim(),
        hidden:
          ($(el).attr('style') ?? '').toLowerCase().includes('display:none') ||
          ($(el).attr('style') ?? '').toLowerCase().includes('display: none'),
      }))
      .get();
    const visible = cells.filter((c) => !c.hidden).map((c) => c.text);
    if (visible.length < 5) return; // need at least Contest/Name/Party/Date/District

    const officeRaw = visible[0] ?? '';
    let nameRaw = visible[1] ?? '';
    const partyRaw = visible[2] ?? '';
    const dateRaw = visible[3] ?? '';
    const districtRaw = visible[4] ?? '';
    if (!officeRaw || !nameRaw || !partyRaw) return;

    // Drop withdrawn rows — they carry "(Withdrawn MM/DD/YYYY)" in the name cell.
    if (/\(\s*Withdrawn\b/i.test(nameRaw)) return;
    nameRaw = nameRaw.replace(/\s*\(Withdrawn[^)]*\)\s*$/i, '').trim();

    const slugInfo = resolveSdOfficeSlug(officeRaw);
    if (!slugInfo) return;

    const district = slugInfo.districted ? extractSdDistrict(districtRaw) : null;
    if (slugInfo.districted && !district) return;

    const dateFiled = normalizeUsDate(dateRaw);

    const sourceRowId = `sd-${slugInfo.slug}-${district ?? '-'}-${partyRaw.toLowerCase()}-${nameRaw.toLowerCase().replace(/\s+/g, '-')}`;

    out.push({
      reported_name: nameRaw,
      party_raw: partyRaw,
      office_raw: officeRaw,
      office_type_slug: slugInfo.slug,
      district_identifier: district,
      date_filed: dateFiled,
      source_row_id: sourceRowId,
    });
  });

  return out;
}

export function resolveSdOfficeSlug(
  office: string,
): { slug: string; districted: boolean } | null {
  const trimmed = office.trim();
  for (const entry of OFFICE_TYPE_MAP) {
    if (entry.pattern.test(trimmed)) {
      return { slug: entry.slug, districted: entry.districted };
    }
  }
  return null;
}

export function extractSdDistrict(raw: string): string | null {
  if (!raw) return null;
  const m = /\bdistrict\s+0*(\d{1,3})\b/i.exec(raw);
  if (m) return m[1]!;
  const m2 = /\b0*(\d{1,3})\b/.exec(raw);
  if (m2) return m2[1]!;
  return null;
}

function normalizeUsDate(raw: string): string | null {
  if (!raw) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw.trim());
  if (!m) return null;
  const mm = m[1]!.padStart(2, '0');
  const dd = m[2]!.padStart(2, '0');
  const yRaw = m[3]!;
  const yyyy = yRaw.length === 2 ? `20${yRaw}` : yRaw;
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Default fetch
// ---------------------------------------------------------------------------

/**
 * Fetch only the first page of the rendered grid. Multi-page pagination
 * via Telerik __doPostBack would require harvesting __VIEWSTATE +
 * __EVENTVALIDATION + __EVENTTARGET / __EVENTARGUMENT and round-tripping
 * each page — which works but doubles the run time and is fragile.
 * The first page covers Governor + US Senate + US House + the alphabet
 * up through ~State Senator District 5 (50 rows). The remaining pages
 * will be picked up by a Phase 2 paging implementation; for now the
 * adapter records partial completeness via expectedMinRows.
 *
 * Tests inject {pages} directly to exercise the multi-page parser.
 */
async function defaultFetch(): Promise<{
  pages: string[];
  contentHash: string;
  resolvedUrl: string;
}> {
  const res = await politeFetch(SOURCE_URL, {
    headers: { Accept: 'text/html,*/*' },
  });
  if (!res.ok) {
    throw new Error(`SD candidacies fetch failed: HTTP ${res.status}`);
  }
  const body = await res.text();
  return {
    pages: [body],
    contentHash: createHash('sha256').update(body).digest('hex'),
    resolvedUrl: res.url,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSdCandidaciesAdapter(
  options: SdCandidaciesAdapterOptions = {},
): SourceAdapter<SdCandidacyRow> {
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 20;
  const sourceUrl = options.sourceUrl ?? SOURCE_URL;

  const adapter: SourceAdapter<SdCandidacyRow> = {
    name: 'sos-south-dakota-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<SdCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      let outcome: { pages: string[]; contentHash: string; resolvedUrl?: string };
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
            name: 'south-dakota-sos-candidacies',
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

      const allRows: SdCandidacyRow[] = [];
      const seen = new Set<string>();
      for (const page of outcome.pages) {
        for (const row of parseSdCandidatePage(page)) {
          if (seen.has(row.source_row_id)) continue;
          seen.add(row.source_row_id);
          allRows.push(row);
        }
      }

      ctx.logger.info(`${adapter.name}: parsed`, {
        pages: outcome.pages.length,
        rowCount: allRows.length,
        offices: summarizeBySlug(allRows),
      });

      return {
        rows: allRows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'south-dakota-sos-candidacies',
          url: outcome.resolvedUrl ?? sourceUrl,
          contentHash: outcome.contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: ELECTION_YEAR,
            primary_date: PRIMARY_DATE,
            page_count: outcome.pages.length,
            partial_pagination_note:
              'Telerik __doPostBack pagination not yet implemented; only the first page is ingested.',
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
      rows: SdCandidacyRow[],
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
            `SD office not resolved: slug=${row.office_type_slug} district=${row.district_identifier ?? '-'}`,
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
              `SD party not resolved: "${row.party_raw}" for ${row.reported_name}`,
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
            message: `SD candidacy insert: ${msg}`,
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
      WHERE j.fips_state = $1 AND ot.slug = $2
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
        source: 'sos-south-dakota-candidacies',
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
    `SELECT id FROM candidacies WHERE election_id = $1 AND person_id = $2 LIMIT 1`,
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
    `INSERT INTO candidacies (election_id, person_id, party, status, filed_on, meta)
     VALUES ($1, $2, $3, 'active', $4::date, $5::jsonb)
     RETURNING id`,
    [
      electionId,
      personId,
      partyRaw,
      dateFiled,
      JSON.stringify({
        source: 'sos-south-dakota-candidacies',
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
      JSON.stringify({ source: 'sos-south-dakota-candidacies' }),
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
    ctx.logger.warn('sos-south-dakota-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function summarizeBySlug(rows: SdCandidacyRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.office_type_slug] = (out[r.office_type_slug] ?? 0) + 1;
  return out;
}
