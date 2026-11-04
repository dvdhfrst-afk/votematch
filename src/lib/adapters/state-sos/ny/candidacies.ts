/**
 * New York State Board of Elections — 2026 candidate-filings adapter (FIPS 36).
 *
 * Source (web-verified 2026-04-25):
 *   https://www.elections.ny.gov/CandidatesNominees.html
 *     — Authoritative landing page for candidates/nominees lists. NYSBOE
 *       publishes per-cycle "List of Candidates" PDFs/Excel files linked
 *       from this page after the petition-acceptance window closes.
 *
 *   https://www.elections.ny.gov/RunningOffice.html
 *     — Companion page with filing instructions + downloadable templates.
 *
 * Cloudflare wall (verified 2026-04-25)
 * -------------------------------------
 * Both elections.ny.gov pages return HTTP 403 with a "Just a moment..."
 * Cloudflare challenge body when fetched via politeFetch. The same domain
 * serves the public results pages on election night, so the wall is
 * structural, not adapter-specific.
 *
 * Strategy:
 *   1. Fetch via politeFetch.
 *   2. If we get a CF challenge body → log warning, return empty rows (run
 *      records as `partial`, not `failed`). The data_sources row still
 *      gets written with the challenge body's content_hash so we have
 *      provenance for when the wall lifts.
 *   3. When a real HTML/CSV body lands, parseNyCandidatesList() takes over.
 *
 * Fusion-voting handling (NY-specific)
 * ------------------------------------
 * NY is one of ~7 states with codified fusion voting: a single candidate
 * may appear on the ballot under MULTIPLE PARTY LINES for the same office
 * (e.g. one candidate listed as Democratic + Working Families). Our schema
 * already supports this via candidacy_party_lines: ONE candidacies row +
 * MANY candidacy_party_lines rows, each with a distinct party_id and
 * ballot_line_order.
 *
 * The parser groups source rows by (office_name, district_identifier,
 * canonical_key(name)) and emits one NyCandidacyRow per group with a
 * party_lines: NyPartyLine[] list. The insert() call upserts the
 * candidacies row once and then upserts each party line in turn,
 * preserving ballot_line_order from the source.
 *
 * 2026 NY primary date: 2026-06-23 (state + congressional);
 * general 2026-11-03.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
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
  canonicalKey,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '36';
const ELECTION_YEAR = 2026;

const DEFAULT_SOURCE_URL = 'https://www.elections.ny.gov/CandidatesNominees.html';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/** One ballot line (party endorsement) for a NY fusion candidacy. */
export type NyPartyLine = {
  /** Raw party label as published, e.g. 'Democratic', 'Working Families', 'Conservative'. */
  party_raw: string;
  /** 1-indexed line order on the ballot. Higher = lower priority line. */
  ballot_line_order: number;
};

/**
 * One NY candidacy. Fusion-aware: party_lines may have len >= 1. Single-
 * party (typical) candidacies emit one entry; cross-endorsed (fusion)
 * candidates emit multiple.
 */
export type NyCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  /** Election date (ISO yyyy-mm-dd). Defaults to NY 2026 primary if missing. */
  election_date: string;
  party_lines: NyPartyLine[];
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type NyCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetch?: (
    ctx: AdapterContext,
  ) => Promise<{ status: number; rawBody: string; resolvedUrl?: string }>;
  expectedMinRows?: number;
  electionYear?: number;
};

// ---------------------------------------------------------------------------
// Cloudflare detection (mirrors oh/candidacies.ts)
// ---------------------------------------------------------------------------

export function isCloudflareChallenge(status: number, body: string): boolean {
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
// Pure parser — grouped by candidate to fold fusion lines
// ---------------------------------------------------------------------------

/**
 * Parse a NY candidate-list HTML body into fusion-aware NyCandidacyRow[].
 *
 * Expected source shapes (NYSBOE publishes any of these depending on cycle):
 *   1. HTML <table> with header row "Office | Candidate | Party" and
 *      potentially "District" / "Ballot Line".
 *   2. Plaintext "Office: ... — Candidate (Party1, Party2)" rendered in <p>.
 *
 * Both feed the same NyCandidacyRow shape. When a candidate's name +
 * office + district triplet recurs across rows with different party
 * labels, those rows fuse into one NyCandidacyRow with multiple
 * party_lines (preserving the order they appear in the source —
 * NYSBOE prints major party first, then cross-endorsing parties).
 *
 * Exported for tests.
 */
export function parseNyCandidatesList(
  rawBody: string,
  defaultElectionDate = '2026-06-23',
): NyCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  const trimmed = rawBody.trimStart();
  if (!trimmed.startsWith('<')) return [];
  if (isCloudflareChallenge(200, rawBody)) return [];

  const $ = cheerio.load(rawBody);
  // Stage 1: gather (office, district, name, party, line) tuples.
  type Tuple = {
    office: string;
    district: string | null;
    name: string;
    party: string;
    line: number;
    sourceTag: string;
  };
  const tuples: Tuple[] = [];

  // -- Tables -------------------------------------------------------------
  $('table').each((tIdx, tableEl) => {
    const $tbl = $(tableEl);
    const headers = $tbl
      .find('tr').first()
      .find('th,td')
      .map((_, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headers.length === 0) return;
    const colName = headers.findIndex((h) => /candidate|name/.test(h) && !/party/.test(h));
    const colParty = headers.findIndex((h) => /party|line/.test(h));
    const colOffice = headers.findIndex((h) => /office|contest/.test(h));
    const colDistrict = headers.findIndex((h) => /district|dist\b/.test(h));
    const colLineOrder = headers.findIndex((h) => /\bline\b|order/.test(h));
    if (colName < 0) return;

    // Office may also live in a heading sibling.
    let officeFromHeading = '';
    const $prev = $tbl.prevAll('h1,h2,h3,h4,caption').first();
    if ($prev.length) officeFromHeading = $prev.text().trim();

    $tbl.find('tr').each((rIdx, trEl) => {
      if (rIdx === 0) return;
      const cells = $(trEl).find('td').map((_, el) => $(el).text().trim()).get();
      if (cells.length === 0) return;
      const name = cells[colName] ?? '';
      const party = colParty >= 0 ? cells[colParty] ?? '' : '';
      const officeRaw = colOffice >= 0 ? cells[colOffice] ?? officeFromHeading : officeFromHeading;
      const districtRaw = colDistrict >= 0 ? cells[colDistrict] ?? '' : '';
      const lineOrderRaw = colLineOrder >= 0 ? cells[colLineOrder] ?? '' : '';
      if (!name || !officeRaw) return;

      const district = normalizeNyDistrict(districtRaw) ?? extractNyDistrictFromText(officeRaw);
      const line = parseLineOrder(lineOrderRaw) ?? 1;

      tuples.push({
        office: officeRaw,
        district,
        name,
        party: party || 'UNKNOWN',
        line,
        sourceTag: `ny-t${tIdx}-r${rIdx}`,
      });
    });
  });

  // -- Plain text fallback (paragraph entries) ----------------------------
  if (tuples.length === 0) {
    $('p, li').each((idx, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      // "Office: Name (Party1, Party2)"
      const m = text.match(/^([^:]{3,80}):\s*(.+)$/);
      if (!m) return;
      const officeRaw = m[1].trim();
      const body = m[2];
      // Split entries by ';' (NYSBOE convention) or ',' fallback.
      const sep = body.includes(';') ? ';' : ',';
      const entries = body.split(sep).map((s) => s.trim()).filter(Boolean);
      entries.forEach((entry, eIdx) => {
        const pm = entry.match(/^(.+?)\s*\(([^)]+)\)\s*\.?$/);
        if (!pm) return;
        const name = pm[1].trim();
        // (Democratic, Working Families) → ['Democratic','Working Families']
        const partyList = pm[2].split(/[,/]/).map((p) => p.trim()).filter(Boolean);
        partyList.forEach((party, pIdx) => {
          tuples.push({
            office: officeRaw,
            district: extractNyDistrictFromText(officeRaw),
            name,
            party,
            line: pIdx + 1,
            sourceTag: `ny-p-${idx}-${eIdx}-${pIdx}`,
          });
        });
      });
    });
  }

  // Stage 2: fold tuples by (canonical name + office + district).
  const groups = new Map<string, NyCandidacyRow>();
  for (const t of tuples) {
    const key = `${canonicalKey(t.name)}|${t.office.toLowerCase()}|${t.district ?? '-'}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        reported_name: t.name,
        office_name: t.office,
        district_identifier: t.district,
        election_date: defaultElectionDate,
        party_lines: [],
        source_row_id: `ny::${key}`,
      };
      groups.set(key, group);
    }
    // Don't add a duplicate party line.
    if (!group.party_lines.some((pl) => pl.party_raw.toLowerCase() === t.party.toLowerCase())) {
      group.party_lines.push({ party_raw: t.party, ballot_line_order: t.line });
    }
  }
  // Sort party lines by ballot_line_order for deterministic output.
  for (const g of groups.values()) {
    g.party_lines.sort((a, b) => a.ballot_line_order - b.ballot_line_order);
  }
  return [...groups.values()];
}

function parseLineOrder(raw: string): number | null {
  const m = /^\s*(\d+)\s*$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeNyDistrict(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /district\s+0*(\d{1,3})\b/i.exec(raw);
  if (m && m[1]) return m[1];
  const pure = /^\s*(\d{1,3})\s*$/.exec(raw);
  if (pure) return pure[1];
  return null;
}

export function extractNyDistrictFromText(officeName: string): string | null {
  return normalizeNyDistrict(officeName);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNyCandidaciesAdapter(
  options: NyCandidaciesAdapterOptions = {},
): SourceAdapter<NyCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 0;
  const electionYear = options.electionYear ?? ELECTION_YEAR;

  // Plain politeFetch. If the site serves a Cloudflare challenge, the
  // adapter logs it and returns [].
  const fetchImpl =
    options.fetch ??
    (async () => {
      const res = await politeFetch(sourceUrl, {
        headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
      });
      const body = await res.text();
      return { status: res.status, rawBody: body, resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<NyCandidacyRow> = {
    name: 'sos-new-york-sboe-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<NyCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      const { status, rawBody, resolvedUrl } = await fetchImpl(ctx);
      const contentHash = createHash('sha256').update(rawBody).digest('hex');

      const cfWalled = isCloudflareChallenge(status, rawBody);
      let rows: NyCandidacyRow[] = [];
      if (cfWalled) {
        ctx.logger.warn(
          `${adapter.name}: Cloudflare challenge — returning [] (source requires a browser; skipped)`,
          { status, bytes: rawBody.length, sourceUrl },
        );
      } else if (status >= 400) {
        throw new Error(`${adapter.name}: HTTP ${status} from ${sourceUrl}`);
      } else {
        rows = parseNyCandidatesList(rawBody);
      }

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        cfWalled,
        fusionGroups: rows.filter((r) => r.party_lines.length > 1).length,
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'new-york-sboe-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            byte_size: rawBody.length,
            http_status: status,
            cloudflare_walled: cfWalled,
            fusion_aware: true,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name?.trim()) return 'missing reported_name';
      if (!row.office_name?.trim()) return 'missing office_name';
      if (!row.party_lines || row.party_lines.length === 0) {
        return 'missing party_lines (NY requires >= 1 ballot line)';
      }
      return null;
    },

    async insert(rows, refs, ctx): Promise<InsertStats> {
      return insertNyCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert (people + candidacies + N candidacy_party_lines per candidacy)
// ---------------------------------------------------------------------------

async function insertNyCandidacies(
  rows: NyCandidacyRow[],
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
          `NY office not resolved: state=${STATE_FIPS} office="${row.office_name}" district=${row.district_identifier ?? '-'}`,
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
        source: 'ny-sboe-candidacies',
        dataSourceId: refs.dataSourceId,
      });

      // Use the party_raw of the FIRST line as the candidacies.party
      // text — for fusion candidates this matches NYSBOE's convention
      // of leading with the major-party endorsement. The full set of
      // endorsements is recorded in candidacy_party_lines.
      const primaryParty = row.party_lines[0]?.party_raw ?? null;

      const candRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
        `INSERT INTO candidacies
           (election_id, person_id, party, status, meta)
         VALUES ($1, $2, $3, 'active', $4::jsonb)
         ON CONFLICT (election_id, person_id) DO UPDATE
           SET party = COALESCE(EXCLUDED.party, candidacies.party),
               status = CASE WHEN candidacies.status IN ('withdrew','disqualified')
                             THEN candidacies.status ELSE 'active' END
         RETURNING id, (xmax = 0) AS inserted`,
        [
          officeInfo.election_id,
          personId,
          primaryParty,
          JSON.stringify({
            source: 'ny-sboe-candidacies',
            reported_office: row.office_name,
            reported_district: row.district_identifier,
            data_source_id: refs.dataSourceId,
            ingestion_run_id: refs.ingestionRunId,
            source_row_id: row.source_row_id,
            ballot_line_count: row.party_lines.length,
            fusion: row.party_lines.length > 1,
          }),
        ],
      );

      const candidacyId = candRes.rows[0]?.id;
      const created = candRes.rows[0]?.inserted === true;
      if (!candidacyId) {
        stats.rowsFailed += 1;
        stats.errors.push({ type: 'other', message: 'NY candidacy upsert returned no id', rawInput: row });
        continue;
      }
      if (created) stats.rowsInserted += 1;
      else stats.rowsUpdated += 1;

      // One row per ballot line — fusion-aware. Multiple party_id
      // values land under the same candidacy_id, distinguished by
      // ballot_line_order.
      for (const line of row.party_lines) {
        const partyId = await resolvePartyId(ctx.pg, line.party_raw, STATE_FIPS);
        if (!partyId) {
          await logIngestionError(
            ctx,
            refs.ingestionRunId,
            'validation',
            `NY party not resolved: "${line.party_raw}" (line ${line.ballot_line_order})`,
            { ...row, candidacy_id: candidacyId, party_line: line },
          );
          continue;
        }
        await ctx.pg.query(
          `INSERT INTO candidacy_party_lines
             (candidacy_id, party_id, ballot_line_order, nomination_method, data_source_id, meta)
           VALUES ($1, $2, $3, 'primary', $4::uuid, $5::jsonb)
           ON CONFLICT (candidacy_id, party_id) DO UPDATE
             SET ballot_line_order = EXCLUDED.ballot_line_order,
                 data_source_id = COALESCE(EXCLUDED.data_source_id, candidacy_party_lines.data_source_id)`,
          [
            candidacyId,
            partyId,
            line.ballot_line_order,
            refs.dataSourceId ?? null,
            JSON.stringify({
              source: 'ny-sboe-candidacies',
              reported_party: line.party_raw,
              fusion: row.party_lines.length > 1,
            }),
          ],
        );
      }
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({ type: 'other', message: `NY row: ${msg}`, rawInput: row });
      ctx.logger.warn('ny-candidacies: row insert failed', {
        error: msg,
        row: { name: row.reported_name, office: row.office_name },
      });
    }
  }

  return stats;
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
    ctx.logger.warn('ny-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
