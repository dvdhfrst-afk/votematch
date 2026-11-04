/**
 * Tennessee Secretary of State — 2026 primary candidate-filings adapter (FIPS 47).
 *
 * Primary is 2026-08-06 (state primary + county general). Federal +
 * statewide candidate lists are published as PDF + XLSX on the SoS site
 * after the qualifying deadline (March 10, 2026 noon).
 *
 * Source (web-verified 2026-04-25):
 *   https://sos.tn.gov/elections/2026-candidate-lists
 *
 * Authoritative XLSX URLs (extracted from the page on 2026-04-25):
 *   Governor:   https://sos-prod.tnsosgovfiles.com/s3fs-public/document/Governor_Filed_2026-03-24.xlsx
 *   US Senate:  https://sos-prod.tnsosgovfiles.com/s3fs-public/document/USSenate_Filed_2026-03-24.xlsx
 *   US House:   https://sos-prod.tnsosgovfiles.com/s3fs-public/document/USHouse_Filed_2026-03-24.xlsx
 *   TN Senate:  https://sos-prod.tnsosgovfiles.com/s3fs-public/document/TNSenate_Filed_2026-03-24.xlsx
 *   TN House:   https://sos-prod.tnsosgovfiles.com/s3fs-public/document/TNHouse_Filed_2026-03-24.xlsx
 *
 * The filename embeds the publication date — TN reposts XLSX as new
 * candidates are confirmed and old ones withdraw. We discover the
 * current files by scraping the index page each run; the URL list in
 * code is just the seed/fallback.
 *
 * What's on the 2026 TN primary ballot (state-level):
 *   - Governor (open seat, incumbent term-limited)
 *   - 1 × U.S. Senate (verified via the published lists)
 *   - 9 × U.S. House
 *   - State Senate (half on cycle)
 *   - 99 × State House (all seats)
 *   - State Executive Committee seats (Republican + Democratic) — these
 *     are party-internal, intentionally skipped here
 *
 * Tennessee SoS is on a fast Drupal site. Note from blueprint:
 * "TN ECONNRESETs from Node fetch" — observed historically. We retry
 * once via politeFetch (which handles UA rotation) and surface failures
 * as documented blockers rather than crashing the run.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
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
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import { resolveOrCreateOfficeAndElection } from '../shared/office-resolver';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '47';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-08-06';
const INDEX_URL = 'https://sos.tn.gov/elections/2026-candidate-lists';

/**
 * Map a filename token (US Senate, US House, etc.) → office_types.slug
 * we use in the offices table.
 */
const FILENAME_OFFICE_MAP: Array<{ pattern: RegExp; slug: string; districted: boolean }> = [
  { pattern: /^Governor_/i, slug: 'governor', districted: false },
  { pattern: /^USSenate_/i, slug: 'us_senator', districted: false },
  { pattern: /^USHouse_/i, slug: 'us_representative', districted: true },
  { pattern: /^TNSenate_/i, slug: 'state_senator', districted: true },
  { pattern: /^TNHouse_/i, slug: 'state_representative', districted: true },
];

/**
 * Seed list — used if scraping the index page fails. Keep in sync with
 * the page; the date suffix is the only part that changes between
 * republications.
 */
const SEED_FILES: ReadonlyArray<{ filename: string; slug: string; districted: boolean }> = [
  { filename: 'Governor_Filed_2026-03-24.xlsx', slug: 'governor', districted: false },
  { filename: 'USSenate_Filed_2026-03-24.xlsx', slug: 'us_senator', districted: false },
  { filename: 'USHouse_Filed_2026-03-24.xlsx', slug: 'us_representative', districted: true },
  { filename: 'TNSenate_Filed_2026-03-24.xlsx', slug: 'state_senator', districted: true },
  { filename: 'TNHouse_Filed_2026-03-24.xlsx', slug: 'state_representative', districted: true },
];

const FILE_HOST = 'https://sos-prod.tnsosgovfiles.com/s3fs-public/document';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type TnCandidacyRow = {
  reported_name: string;
  party_raw: string;
  office_type_slug: string;
  /** Bare integer string when districted, null for statewide. */
  district_identifier: string | null;
  /** Full office name as published on the spreadsheet header. */
  office_label: string;
  /** ISO yyyy-mm-dd when extractable from the filename. */
  list_published_on: string | null;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type TnCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Inject for tests — return synthetic file list + bytes. */
  fetch?: (ctx: AdapterContext) => Promise<{
    files: Array<{ url: string; bytes: Uint8Array; slug: string; districted: boolean }>;
    contentHash: string;
    indexHtml?: string;
  }>;
  expectedMinRows?: number;
};

// ---------------------------------------------------------------------------
// Index discovery
// ---------------------------------------------------------------------------

/**
 * Scrape the 2026 candidate-list index for current XLSX URLs. Returns
 * the seed list when scraping yields zero matches (e.g. TN swaps the
 * index layout or our HTML-fetch hits an ECONNRESET).
 */
export function discoverXlsxLinks(html: string): Array<{
  url: string;
  filename: string;
  slug: string;
  districted: boolean;
}> {
  if (!html || html.length < 64) return [];
  const $ = cheerio.load(html);
  const out: Array<{ url: string; filename: string; slug: string; districted: boolean }> = [];
  const seen = new Set<string>();
  $('a[href$=".xlsx"]').each((_i, el) => {
    const href = $(el).attr('href');
    if (!href || !href.endsWith('.xlsx')) return;
    const url = href.startsWith('http') ? href : `${FILE_HOST}/${href.replace(/^.*?document\//, '')}`;
    if (seen.has(url)) return;
    const filenameMatch = /\/([^\/]+\.xlsx)$/i.exec(url);
    const filename = filenameMatch ? filenameMatch[1]! : url;
    for (const entry of FILENAME_OFFICE_MAP) {
      if (entry.pattern.test(filename)) {
        seen.add(url);
        out.push({
          url,
          filename,
          slug: entry.slug,
          districted: entry.districted,
        });
        break;
      }
    }
  });
  return out;
}

function extractListPublishedOn(filename: string): string | null {
  const m = /_Filed_(\d{4}-\d{2}-\d{2})/.exec(filename);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// XLSX parser
// ---------------------------------------------------------------------------

/**
 * Parse one TN XLSX into TnCandidacyRow[].
 *
 * Column layout has historically been:
 *   - Office (sometimes a sheet header), Name, Party, District (when
 *     applicable). Parsing is defensive — we walk rows looking for the
 *     header tokens, then read by column index.
 */
export function parseTennesseeXlsx(
  bytes: Uint8Array,
  slug: string,
  districted: boolean,
  filename: string,
): TnCandidacyRow[] {
  if (!bytes || bytes.byteLength < 32) return [];
  const wb = XLSX.read(bytes, { type: 'array' });
  const out: TnCandidacyRow[] = [];
  const seen = new Set<string>();
  const publishedOn = extractListPublishedOn(filename);

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]!;
    if (!ws) continue;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: false,
      defval: null,
    });

    let nameCol = -1;
    let partyCol = -1;
    let districtCol = -1;
    let officeCol = -1;
    let headerRow = -1;
    let officeLabel = sheetName.trim();

    for (let i = 0; i < raw.length; i += 1) {
      const r = raw[i];
      if (!Array.isArray(r)) continue;
      const lower = r.map((c) => (c == null ? '' : String(c)).trim().toLowerCase());
      // Heuristic: header row contains "name" + (party | district | office)
      const hasName = lower.some((c) => c === 'name' || c === 'candidate' || c.includes('candidate name'));
      if (!hasName) continue;
      const hasContext =
        lower.some((c) => c.includes('party')) ||
        lower.some((c) => c.includes('district')) ||
        lower.some((c) => c.includes('office'));
      if (!hasContext) continue;
      headerRow = i;
      nameCol = lower.findIndex((c) => c === 'name' || c === 'candidate' || c.includes('candidate name'));
      partyCol = lower.findIndex((c) => c.includes('party'));
      districtCol = lower.findIndex((c) => c.includes('district'));
      officeCol = lower.findIndex((c) => c === 'office');
      break;
    }

    if (headerRow < 0 || nameCol < 0) continue;

    for (let i = headerRow + 1; i < raw.length; i += 1) {
      const r = raw[i];
      if (!Array.isArray(r)) continue;
      const name = readCell(r[nameCol]);
      if (!name) continue;
      const party = partyCol >= 0 ? readCell(r[partyCol]) : '';
      const districtRaw = districtCol >= 0 ? readCell(r[districtCol]) : '';
      const officeRaw = officeCol >= 0 ? readCell(r[officeCol]) : officeLabel;

      // 2026 TN XLSX layout note: USHouse / TNSenate / TNHouse files have
      // NO separate district column — the district is embedded inside the
      // 'Office' string ("United States House of Representatives District 1",
      // "Tennessee Senate District 3", "Tennessee House of Representatives
      // District 47"). Pull from the office string when the dedicated
      // district column is missing or empty so we don't drop districted
      // rows. Without this fallback the file silently parses to zero.
      let district: string | null = null;
      if (districted) {
        district = extractDistrict(districtRaw) ?? extractDistrict(officeRaw) ?? extractDistrict(sheetName);
        if (!district) continue;
      }
      if (!party) continue;

      const dedupKey = `tn-${slug}-${district ?? '-'}-${party.toLowerCase()}-${name.toLowerCase()}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      out.push({
        reported_name: name,
        party_raw: party,
        office_type_slug: slug,
        district_identifier: district,
        office_label: officeRaw || officeLabel,
        list_published_on: publishedOn,
        source_row_id: dedupKey,
      });
    }
  }
  return out;
}

function readCell(c: unknown): string {
  if (c == null) return '';
  if (typeof c === 'string') return c.trim();
  return String(c).trim();
}

function extractDistrict(raw: string): string | null {
  if (!raw) return null;
  const m = /\b0*(\d{1,3})\b/.exec(raw);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// Network fetch
// ---------------------------------------------------------------------------

async function defaultFetch(): Promise<{
  files: Array<{ url: string; bytes: Uint8Array; slug: string; districted: boolean }>;
  contentHash: string;
  indexHtml: string;
}> {
  let indexHtml = '';
  let links: Array<{ url: string; filename: string; slug: string; districted: boolean }> = [];

  try {
    const idx = await politeFetch(INDEX_URL, {
      headers: { Accept: 'text/html,*/*' },
    });
    if (idx.ok) {
      indexHtml = await idx.text();
      links = discoverXlsxLinks(indexHtml);
    }
  } catch {
    /* fall through to seeds */
  }

  if (links.length === 0) {
    links = SEED_FILES.map((s) => ({
      url: `${FILE_HOST}/${s.filename}`,
      filename: s.filename,
      slug: s.slug,
      districted: s.districted,
    }));
  }

  const files: Array<{ url: string; bytes: Uint8Array; slug: string; districted: boolean }> = [];
  const hashSeed = createHash('sha256');
  hashSeed.update(indexHtml);

  for (const link of links) {
    try {
      const res = await politeFetch(link.url, {
        headers: {
          Accept:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*',
        },
      });
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      hashSeed.update(buf);
      files.push({
        url: link.url,
        bytes: buf,
        slug: link.slug,
        districted: link.districted,
      });
    } catch {
      // Skip the failing file but continue — TN occasionally drops
      // ECONNRESETs mid-batch.
    }
  }

  return {
    files,
    contentHash: hashSeed.digest('hex'),
    indexHtml,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTnCandidaciesAdapter(
  options: TnCandidaciesAdapterOptions = {},
): SourceAdapter<TnCandidacyRow> {
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 50;
  const sourceUrl = options.sourceUrl ?? INDEX_URL;

  const adapter: SourceAdapter<TnCandidacyRow> = {
    name: 'sos-tennessee-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<TnCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      let outcome: {
        files: Array<{ url: string; bytes: Uint8Array; slug: string; districted: boolean }>;
        contentHash: string;
        indexHtml?: string;
      };
      try {
        outcome = options.fetch ? await options.fetch(ctx) : await defaultFetch();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`${adapter.name}: fetch failed (likely ECONNRESET) — returning empty`, {
          error: msg,
        });
        return {
          rows: [],
          expectedMinRows,
          source: {
            sourceType: 'sos_candidate_filing',
            name: 'tennessee-sos-candidacies',
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

      const allRows: TnCandidacyRow[] = [];
      for (const f of outcome.files) {
        const filename = f.url.split('/').pop() ?? f.url;
        const rows = parseTennesseeXlsx(f.bytes, f.slug, f.districted, filename);
        allRows.push(...rows);
      }

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: allRows.length,
        files: outcome.files.length,
        offices: summarizeBySlug(allRows),
      });

      return {
        rows: allRows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'tennessee-sos-candidacies',
          url: sourceUrl,
          contentHash: outcome.contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: ELECTION_YEAR,
            primary_date: PRIMARY_DATE,
            file_count: outcome.files.length,
            files: outcome.files.map((f) => f.url),
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
      rows: TnCandidacyRow[],
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

      // Cache (office_id, election_id) per (slug, district). The shared
      // resolver auto-creates either the office or the election when
      // missing — this is what fixed the 35/50 partial-insert regression.
      const officeElectionCache = new Map<string, { office_id: string; election_id: string }>();

      for (const row of rows) {
        const cacheKey = `${row.office_type_slug}|${row.district_identifier ?? '-'}`;
        let resolved = officeElectionCache.get(cacheKey) ?? null;
        if (!resolved) {
          try {
            const out = await resolveOrCreateOfficeAndElection(ctx.pg, {
              state_fips: STATE_FIPS,
              office_type_slug: row.office_type_slug,
              office_name: row.office_label,
              district_identifier: row.district_identifier,
              election_year: ELECTION_YEAR,
              election_date: PRIMARY_DATE,
              election_type: 'primary',
              data_source_id: refs.dataSourceId,
              adapter_name: adapter.name,
            });
            resolved = { office_id: out.office_id, election_id: out.election_id };
            officeElectionCache.set(cacheKey, resolved);
          } catch (err) {
            stats.rowsSkipped += 1;
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `TN office not resolved: slug=${row.office_type_slug} district=${row.district_identifier ?? '-'} (${err instanceof Error ? err.message : String(err)})`,
              row,
            );
            continue;
          }
        }

        if (ctx.dryRun) {
          stats.rowsInserted += 1;
          continue;
        }

        try {
          const electionId = resolved.election_id;
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
            row.list_published_on,
            refs.dataSourceId,
            row.source_row_id,
          );

          const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);
          if (partyId) {
            await upsertPartyLine(
              ctx,
              candidacyId,
              partyId,
              row.list_published_on,
              refs.dataSourceId,
            );
          } else {
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `TN party not resolved: "${row.party_raw}" for ${row.reported_name}`,
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
            message: `TN candidacy insert: ${msg}`,
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
// Helpers (DB)
// ---------------------------------------------------------------------------

async function upsertCandidacy(
  ctx: AdapterContext,
  electionId: string,
  personId: string,
  partyRaw: string,
  filedOn: string | null,
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
      [partyRaw, filedOn, sel.rows[0].id],
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
      filedOn,
      JSON.stringify({
        source: 'sos-tennessee-candidacies',
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
      JSON.stringify({ source: 'sos-tennessee-candidacies' }),
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
    ctx.logger.warn('sos-tennessee-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function summarizeBySlug(rows: TnCandidacyRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.office_type_slug] = (out[r.office_type_slug] ?? 0) + 1;
  return out;
}
