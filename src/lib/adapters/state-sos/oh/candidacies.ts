/**
 * Ohio Secretary of State — candidate filings adapter (FIPS 39).
 *
 * Mission
 * -------
 * Populate `people` + `candidacies` + `candidacy_party_lines` for every
 * candidate on the May 5, 2026 OH primary ballot:
 *   - 1 × U.S. Senate
 *   - 15 × U.S. House
 *   - ~33 × State Senate (odd-numbered districts on the 2026 cycle; full
 *     33 if all seats are contested — typical primary count ~17)
 *   - 99 × State House
 *   - 1–3 × Supreme Court Justice seats (partisan in OH since 2021)
 *   - Statewide executives (Governor/Lt. Governor joint ticket, AG, SoS,
 *     Treasurer, Auditor)
 *
 * Expected ~150–200 primary candidacies.
 *
 * Source URLs (web-verified 2026-04-24)
 * -------------------------------------
 * Candidate filing information page:
 *   https://www.ohiosos.gov/elections/candidates/candidate-information/
 *
 * Press releases announcing qualified candidate lists (the most up-to-date
 * consolidated lists for statewide + federal):
 *   https://www.ohiosos.gov/media-center/press-releases/2026/2026-02-04/
 *   https://www.ohiosos.gov/media-center/press-releases/2026/2026-02-19/
 *
 * Candidate requirement guide (PDF, ~5 MB):
 *   https://www.ohiosos.gov/globalassets/publications/election/2026_crg.pdf
 *
 * Cloudflare status (observed 2026-04-24 via politeFetch probe)
 * -------------------------------------------------------------
 * Every URL on www.ohiosos.gov AND assets.ohiosos.gov returns HTTP 403
 * with a 1.2 MB Cloudflare challenge page to an honest politeFetch
 * request. Only `liveresults.ohiosos.gov` (the election-night XML
 * endpoint; see live-results.ts) serves plaintext.
 *
 * When the page is walled, the adapter returns empty rows so the
 * ingestion run records `partial` rather than `failed`. No workaround
 * is attempted; the fetch boundary is `fetchCandidateFilingPage()`.
 *
 * Shape stays correct
 * -------------------
 * Even though fetch() currently returns a Cloudflare wall, the full
 * adapter shape (parse → resolve → insert) is wired so that when a
 * permitted data path is available (for example a published export):
 *   1. parseCandidateList() ingests HTML or PDF-extracted text
 *   2. resolveCandidaciesForOh() hydrates people + candidacies
 *   3. insert() upserts with ON CONFLICT DO NOTHING via
 *      candidacies (election_id, person_id) UNIQUE constraint.
 *
 * Tests therefore assert against a synthetic HTML fixture — the parser
 * + resolver contract is already provable even without live data.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  normalizeOfficeName,
  resolveOfficeElection,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import { canonicalKey } from '../base';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '39';

/** Primary landing page for candidate filing information. */
const CANDIDATE_INFO_URL =
  'https://www.ohiosos.gov/elections/candidates/candidate-information/';

/**
 * Consolidated candidate press-release URLs. These are the pages the OH SoS
 * uses to publish the qualified-candidate list immediately after the filing
 * deadline passes. We fetch the post-cure (Feb 19) release because it
 * reflects disqualifications from protest hearings.
 */
const STATEWIDE_QUALIFIED_URL =
  'https://www.ohiosos.gov/media-center/press-releases/2026/2026-02-19/';

/**
 * Default URL used for `data_sources.url` provenance. Points at the
 * canonical landing page because candidate lists are distributed across
 * several press releases + PDFs — one row per adapter run.
 */
const DEFAULT_SOURCE_URL = CANDIDATE_INFO_URL;

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/**
 * One reported candidate filing. All string fields are raw as published by
 * the SoS; resolution happens in insert(). A fusion candidate (rare in OH
 * — no fusion voting here, but keep room for a Libertarian + Independent
 * cross-endorsement) would produce multiple rows with the same person_id
 * later in the pipeline; for 2026 Ohio this is effectively always 1:1.
 */
export type OhCandidacyRow = {
  reported_name: string;
  party_abbreviation: string | null;
  office_name: string;
  district_identifier: string | null;
  /** True if the filed office is a write-in-only designation. OH: rare. */
  is_write_in: boolean;
  /** Stable source key for dedup inside a single adapter run. */
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options / factory
// ---------------------------------------------------------------------------

export type CreateOhCandidaciesAdapterOptions = {
  /** Override landing URL for tests; production uses CANDIDATE_INFO_URL. */
  sourceUrl?: string;
  /**
   * Election year. Defaults to the adapter-run year. Candidacies are
   * resolved against elections in this year; for 2026 primary set to 2026.
   */
  electionYear?: number;
  /**
   * Test-only synchronous fetch override. When provided, skips network.
   * Production factory callers should leave this undefined.
   */
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  /**
   * Custom parser override for tests (e.g. feed a synthetic HTML string).
   * Production callers should leave this undefined.
   */
  parseOverride?: (rawBody: string) => OhCandidacyRow[];
};

/**
 * Factory — returns a SourceAdapter<OhCandidacyRow> that plugs into
 * runAdapter() from ../../run.ts.
 *
 * The base createStateSosAdapter() is deliberately NOT used here: that
 * factory's insert() writes to `election_results`, not candidacies.
 * Candidacies have a different resolution pipeline (we must CREATE
 * people when none exist, rather than only linking to existing ones).
 */
export function createOhCandidaciesAdapter(
  options: CreateOhCandidaciesAdapterOptions = {},
): SourceAdapter<OhCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? new Date().getUTCFullYear();

  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<OhCandidacyRow> = {
    name: 'sos-ohio-sos-candidate-filings',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<OhCandidacyRow>> {
      await bucket.acquire();

      ctx.logger.info('oh-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      const fetchImpl =
        options.fetchOverride ?? fetchCandidateFilingPage;

      let status = 0;
      let rawBody = '';
      try {
        const res = await fetchImpl(sourceUrl);
        status = res.status;
        rawBody = res.body;
      } catch (err) {
        // Network-level throw (DNS, TCP reset). Let the runner classify
        // as failed so retry logic / alerting picks it up.
        throw new Error(
          `oh-candidacies: fetch threw for ${sourceUrl}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const contentHash = createHash('sha256')
        .update(rawBody)
        .digest('hex');

      ctx.logger.info('oh-candidacies: fetched', {
        http_status: status,
        bytes: rawBody.length,
        contentHash: contentHash.slice(0, 12),
      });

      // Cloudflare challenge page detection. The OH CF wall serves
      // 200-like-status for a subset of endpoints but 403 is the
      // documented case for this host. Either way, if we got an HTML
      // body that doesn't smell like a candidate list, log + return [].
      const parser = options.parseOverride ?? parseCandidateList;

      let rows: OhCandidacyRow[] = [];
      if (isCloudflareChallenge(status, rawBody)) {
        // fetchCandidateFilingPage returned a CF challenge body. Log +
        // return [] so the ingestion run records `partial` rather than
        // `failed`.
        ctx.logger.warn(
          'oh-candidacies: Cloudflare challenge received — returning []',
          { status, bytes: rawBody.length, sourceUrl },
        );
      } else if (status >= 400) {
        throw new Error(
          `oh-candidacies: HTTP ${status} from ${sourceUrl}`,
        );
      } else {
        rows = parser(rawBody);
      }

      return {
        rows,
        // OH primary has 150-200 expected candidacies across all
        // offices. 50 is a generous floor — below that the run is
        // genuinely partial (stale press release, walled source,
        // etc.). Parser-only runs against small fixtures
        // are explicitly dry-run so the partial flag is expected.
        expectedMinRows: 50,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'ohio-sos-candidate-filings',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            http_status: status,
            byte_size: rawBody.length,
            cloudflare_walled: isCloudflareChallenge(status, rawBody),
            statewide_qualified_url: STATEWIDE_QUALIFIED_URL,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || row.reported_name.trim().length === 0) {
        return 'missing reported_name';
      }
      if (!row.office_name || row.office_name.trim().length === 0) {
        return 'missing office_name';
      }
      return null;
    },

    async insert(
      rows: OhCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertOhCandidacies(
        rows,
        refs,
        ctx,
        electionYear,
      );
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Real-network fetch via politeFetch. A Cloudflare challenge response
 * (403/503) is returned to the caller as-is; the adapter then records
 * rows=[] with cloudflare_walled=true in the run meta.
 */
export async function fetchCandidateFilingPage(
  url: string,
): Promise<{ status: number; body: string }> {
  const res = await politeFetch(url, {
    headers: {
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  const body = await res.text();
  return { status: res.status, body };
}

/**
 * Detect Cloudflare challenge pages. CF serves either:
 *   - HTTP 403 with a ~1.2MB HTML challenge body, OR
 *   - HTTP 503 during JS challenge rotation, OR
 *   - HTTP 200 but with body containing cf-chl / __cf_chl markers
 *
 * Any of these → treat as "not a real candidate list" and bail out.
 */
export function isCloudflareChallenge(
  status: number,
  body: string,
): boolean {
  if (status === 403 || status === 503) return true;
  if (typeof body !== 'string' || body.length === 0) return false;
  const snippet = body.slice(0, 8192).toLowerCase();
  return (
    snippet.includes('__cf_chl') ||
    snippet.includes('cf-chl-bypass') ||
    snippet.includes('cf-browser-verification') ||
    (snippet.includes('cloudflare') && snippet.includes('challenge')) ||
    snippet.includes('just a moment')
  );
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse OH SoS candidate-list HTML.
 *
 * The SoS publishes lists in two shapes depending on the page:
 *   1. A structured `<table>` per office — rows look like
 *      "Name | Party | District | County". This is the happy case.
 *   2. Free-form `<p>`/`<ul>` text, typically in press releases —
 *      "Governor and Lieutenant Governor: Alex Sample + Jordan Example (D); ...".
 *
 * We handle (1) structurally and fall back to (2) via a
 * paragraph-oriented regex extractor. Both feed the same OhCandidacyRow
 * shape.
 *
 * Exported for tests.
 */
export function parseCandidateList(rawBody: string): OhCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  const trimmed = rawBody.trimStart();
  if (!trimmed.startsWith('<')) return [];
  if (isCloudflareChallenge(200, rawBody)) return [];

  const $ = cheerio.load(rawBody);
  const rows: OhCandidacyRow[] = [];

  // -- Shape 1: tables with 'candidate'/'name' + 'party' headers ----------
  $('table').each((tableIdx, tableEl) => {
    const $table = $(tableEl);
    const headerCells = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((_i, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headerCells.length === 0) return;

    const nameCol = headerCells.findIndex(
      (h) => h.includes('candidate') || h === 'name',
    );
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    const districtCol = headerCells.findIndex(
      (h) => h.includes('district') || h === 'dist.',
    );
    if (nameCol < 0) return;

    // Office name from preceding header or <caption>.
    let officeName = '';
    const $prev = $table.prevAll('h1,h2,h3,h4,caption').first();
    if ($prev.length) officeName = $prev.text().trim();
    const $caption = $table.find('caption').first();
    if (!officeName && $caption.length) {
      officeName = $caption.text().trim();
    }
    if (!officeName) return; // unknown office → skip table

    $table.find('tr').each((rowIdx, trEl) => {
      if (rowIdx === 0) return;
      const cells = $(trEl)
        .find('td')
        .map((_i, el) => $(el).text().trim())
        .get();
      if (cells.length === 0) return;
      const name = cells[nameCol];
      if (!name) return;
      const party = partyCol >= 0 ? cells[partyCol] || null : null;
      const district = districtCol >= 0 ? cells[districtCol] || null : null;

      rows.push({
        reported_name: name,
        party_abbreviation: party,
        office_name: officeName,
        district_identifier: normalizeDistrict(district),
        is_write_in: /write[-\s]*in/i.test(name),
        source_row_id: `oh-t${tableIdx}-r${rowIdx}`,
      });
    });
  });

  if (rows.length > 0) return rows;

  // -- Shape 2: press-release paragraphs ---------------------------------
  // Pattern: each paragraph opens with an office name followed by a colon,
  // then a semicolon-separated list of candidate entries. Each entry is
  // "Name (PARTY)" or "Name and RunningMate (PARTY)" for joint tickets.
  //
  // Example from the Feb 19 2026 OH SoS release:
  //   "U.S. Senate: Alex Sample (D), Jordan Example (R), Pat Placeholder (L);"
  //
  // We treat each entry as a candidacy of the first named person; joint
  // tickets map to the top-of-ticket office (Governor) and drop the LG
  // per candidate_party_line modeling — 2026 Ohio candidacies file
  // statewide exec tickets jointly but DB stores per-seat.
  $('p, li').each((_i, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const m = text.match(/^([^:]{3,80}):\s*(.+)$/);
    if (!m) return;
    const officeRaw = m[1].trim();
    const body = m[2];
    const officeNorm = normalizeOfficeName(officeRaw);
    if (!OFFICE_KEYWORDS.some((kw) => officeNorm.includes(kw))) return;

    // Entries separated by ';' OR ','. Primary split is ';' when present;
    // otherwise fall back to ',' for shorter lists. We err on the side of
    // ';' — OH SoS consistently uses that as the entry separator.
    const separators = body.includes(';') ? ';' : ',';
    const entries = body.split(separators).map((s) => s.trim()).filter(Boolean);

    entries.forEach((entry, idx) => {
      // Party parens: "(D)" / "(R)" / "(L)".
      const pm = entry.match(/^(.+?)\s*\(([A-Z]{1,4})\)\s*\.?$/);
      if (!pm) return;
      const nameField = pm[1].trim();
      const party = pm[2];

      // Joint tickets: "Alex Sample and Jordan Example" — keep top of ticket.
      const primaryName = nameField.split(/\s+and\s+/i)[0].trim();
      if (!primaryName) return;

      rows.push({
        reported_name: primaryName,
        party_abbreviation: party,
        office_name: officeRaw,
        district_identifier: extractDistrictFromText(officeRaw),
        is_write_in: /write[-\s]*in/i.test(primaryName),
        source_row_id: `oh-p-${canonicalKey(officeRaw)}-${idx}`,
      });
    });
  });

  return rows;
}

/**
 * Office-name keyword gate. We only pick up paragraphs whose normalized
 * office name includes one of these tokens — prevents accidental
 * absorption of unrelated paragraphs that happen to use ':' syntax
 * (e.g. "Key dates:", "Contact:", etc).
 */
const OFFICE_KEYWORDS: readonly string[] = [
  'governor',
  'senator',
  'senate',
  'representative',
  'house',
  'attorney general',
  'secretary',
  'treasurer',
  'auditor',
  'justice',
  'supreme court',
  'assembly',
  'president',
];

/**
 * "District 7" / "7th District" / " 7 " → "7". Mirrors the helper used in
 * nist-xml-parser.ts so OH candidacy rows and OH result rows share one
 * district-identifier vocabulary.
 */
function normalizeDistrict(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const anchored = raw.match(/\bdist(?:rict)?\.?\s+(\d+)/i);
  if (anchored) return anchored[1];
  const trailing = raw.match(/(\d+)(?:st|nd|rd|th)?\s*$/i);
  if (trailing) return trailing[1];
  const pure = raw.trim().match(/^(\d+)$/);
  if (pure) return pure[1];
  return null;
}

function extractDistrictFromText(officeName: string): string | null {
  return normalizeDistrict(officeName);
}

// ---------------------------------------------------------------------------
// Insert (people + candidacies + candidacy_party_lines)
// ---------------------------------------------------------------------------

/**
 * Writes rows into people/candidacies/candidacy_party_lines with full
 * dedup semantics.
 *
 * For each input row:
 *   1. Resolve office + election via resolveOfficeElection. Skip rows we
 *      can't place.
 *   2. Find-or-create the person by canonical_key. Existing rows are
 *      reused without modification; new rows are inserted with
 *      canonical_name = reported_name.
 *   3. Upsert the candidacy ON CONFLICT (election_id, person_id) DO
 *      NOTHING — the UNIQUE constraint guarantees idempotency.
 *   4. If party resolved, upsert the candidacy_party_lines row with
 *      ballot_line_order=1, ON CONFLICT (candidacy_id, party_id) DO
 *      NOTHING.
 *
 * All DB writes go through ctx.pg so they share the runner's transaction
 * and honor dry-run rollback.
 */
export async function insertOhCandidacies(
  rows: OhCandidacyRow[],
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
          `office not resolved: state=${STATE_FIPS} office="${row.office_name}" district=${row.district_identifier ?? '-'}`,
          row,
        );
        continue;
      }

      const personId = await findOrCreatePerson(
        ctx,
        row.reported_name,
        refs.dataSourceId,
      );

      // Insert candidacy idempotently via UNIQUE (election_id, person_id).
      const candidacyRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
        `INSERT INTO candidacies
           (election_id, person_id, party, status, meta)
         VALUES ($1, $2, $3, 'active', $4::jsonb)
         ON CONFLICT (election_id, person_id) DO UPDATE
           -- touch updated_at by setting meta; real no-op for dedup.
           SET meta = candidacies.meta
         RETURNING id,
           (xmax = 0) AS inserted`,
        [
          officeInfo.election_id,
          personId,
          row.party_abbreviation,
          JSON.stringify({
            source: 'oh-sos-candidate-filings',
            reported_office: row.office_name,
            reported_district: row.district_identifier,
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
          message: 'candidacy upsert returned no id',
          rawInput: row,
        });
        continue;
      }

      if (wasInserted) {
        stats.rowsInserted += 1;
      } else {
        stats.rowsUpdated += 1;
      }

      // Party line.
      if (row.party_abbreviation) {
        const partyId = await resolvePartyId(
          ctx.pg,
          row.party_abbreviation,
          STATE_FIPS,
        );
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
                source: 'oh-sos-candidate-filings',
                reported_party: row.party_abbreviation,
              }),
            ],
          );
        } else {
          // Unknown party — log for human review but don't fail the row.
          await logIngestionError(
            ctx,
            refs.ingestionRunId,
            'validation',
            `party not resolved: "${row.party_abbreviation}"`,
            { ...row, candidacy_id: candidacyId },
          );
        }
      }
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({
        type: 'other',
        message: `row: ${msg}`,
        rawInput: row,
      });
      ctx.logger.warn('oh-candidacies: row insert failed', {
        error: msg,
        row: { name: row.reported_name, office: row.office_name },
      });
    }
  }

  return stats;
}

/**
 * Find-or-create a person row, ALWAYS scoped to OH (FIPS 39) so two
 * unrelated "John Smith"s in different states get distinct rows.
 * Delegates to the shared state-disambiguated helper in
 * candidate-resolver.ts (council 2026-04-25 finding DE#3).
 */
async function findOrCreatePerson(
  ctx: AdapterContext,
  reportedName: string,
  dataSourceId: string | undefined,
): Promise<string> {
  return findOrCreateStatePerson(ctx.pg, {
    name: reportedName,
    state_fips: STATE_FIPS,
    electionYear: 2026,
    source: 'oh-sos-candidate-filings',
    dataSourceId,
  });
}

/**
 * Best-effort ingestion_errors insert. Failures here are swallowed so the
 * main insert loop keeps moving.
 */
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
    ctx.logger.warn('oh-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
