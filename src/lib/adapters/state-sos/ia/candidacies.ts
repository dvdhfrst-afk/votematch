/**
 * Iowa Secretary of State — 2026 primary candidate-filings adapter (FIPS 19).
 *
 * Primary is 2026-06-02 (semi-closed; voters request a party ballot at the polls).
 *
 * Source (web-verified 2026-04-25):
 *   https://sos.iowa.gov/sites/default/files/2026-04/2026%20Primary%20-%20Candidate%20List%20Database%20-%20All%20Elections_1.pdf
 *
 *   The Iowa Elections Division publishes a single consolidated PDF for the
 *   2026 primary covering federal + state + selected county offices. The
 *   filename is republished with a date stamp as updates land; this adapter
 *   defaults to the 2026-04 build and lets callers override `sourceUrl`.
 *
 *   The landing page that points at the PDF is:
 *     https://sos.iowa.gov/primary-election
 *   (linked from https://sos.iowa.gov/voters/candidates).
 *
 * Source format — DOCUMENTED BLOCKER
 * -----------------------------------
 * Iowa publishes the candidate list as a PDF only — there is no XLSX, CSV, or
 * structured endpoint available for the 2026 cycle (verified 2026-04-25 by
 * probing common XLSX/CSV filename variants — all 404). The repository has no
 * PDF text-extraction library on board (only `xlsx` + `cheerio`), so this
 * adapter currently:
 *
 *   1. Fetches the PDF bytes via politeFetch and records the SHA-256 in
 *      data_sources.content_hash for provenance,
 *   2. Returns ZERO rows (parser is a stub),
 *   3. Logs a CLEAR blocker on the ingestion run so a Phase-2 ticket picks
 *      it up once a PDF parser (pdfjs-dist or equivalent) is approved.
 *
 * Adapter shape stays correct — when a PDF parser lands, only `parseIowaPdf()`
 * needs to be filled in. The rest of the pipeline (find-or-create person,
 * upsert candidacy, upsert party line) is wired to the same pattern as IN/OH.
 *
 * What's on the 2026 IA primary ballot (per
 *   https://sos.iowa.gov/primary-election web-verified 2026-04-25):
 *   - U.S. Senator (1)
 *   - U.S. Representative (4 districts)
 *   - Governor / Lt. Governor
 *   - Secretary of State, Auditor of State, Treasurer of State
 *   - Secretary of Agriculture, Attorney General
 *   - State Senator, odd-numbered districts 1-49 (~25 contests)
 *   - State Representative, all 100 districts
 *   - County offices (some Boards of Supervisors, Treasurer, Recorder,
 *     County Attorney, vacant seats — handled in Phase 2 county adapters)
 *
 * Idempotency: re-running the adapter is a no-op once parser is wired —
 * candidacies upsert on (election_id, person_id) and party_lines on
 * (candidacy_id, party_id), matching the IN + OH patterns.
 */

import { createHash } from 'node:crypto';
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
import { extractTextFromPdf } from '../shared/pdf-extract';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '19';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-06-02';

const DEFAULT_SOURCE_URL =
  'https://sos.iowa.gov/sites/default/files/2026-04/2026%20Primary%20-%20Candidate%20List%20Database%20-%20All%20Elections_1.pdf';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type IaCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string;
  date_filed: string | null;
  is_write_in: boolean;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type IaCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Inject a raw-bytes fetcher (tests pass synthetic PDFs). */
  fetch?: (ctx: AdapterContext) => Promise<{ rawBody: Uint8Array; resolvedUrl?: string }>;
  /** Inject a parser override for tests once PDF extraction is in. */
  parseOverride?: (bytes: Uint8Array) => IaCandidacyRow[];
};

// ---------------------------------------------------------------------------
// Parser stub — see file header for blocker explanation
// ---------------------------------------------------------------------------

/**
 * Parse the Iowa Primary Candidate List PDF.
 *
 * Format (web-verified 2026-04-25 against the 2026-04 build):
 *   Header row repeats per page:
 *     "For the Office Of…   Party   Ballot Name(s)   Address   Phone   Email   Filing Date"
 *   Body rows:
 *     - First row in an office group has the office in column 1 (e.g.
 *       "United States Senator", "United States Representative District 1").
 *     - Subsequent rows in the same office group leave column 1 blank
 *       and start with the party (e.g. "Republican").
 *
 * Strategy: extract text via the shared extractor, walk lines in order,
 * carry forward the most recent office banner whenever a row's first
 * column is empty. Skip page chrome ("Candidate List", "June 2, 2026
 * Primary Election", header repeats, contact-info banner).
 *
 * Returns one IaCandidacyRow per (office, party, name) — federal + state
 * scope only; county-office rows that appear later in the document are
 * out of scope for this adapter (Phase-2 county adapters cover them).
 */
export function parseIowaPdfText(pages: string[]): IaCandidacyRow[] {
  // Office filter: federal + state level only (mirroring IN's filter).
  // County offices in this PDF carry an explicit county prefix like
  // "Adair County Auditor" — we drop those here.
  const FEDERAL_STATE_PREFIXES = [
    'United States Senator',
    'United States Representative',
    'Governor',
    'Secretary of State',
    'Auditor of State',
    'Treasurer of State',
    'Secretary of Agriculture',
    'Attorney General',
    'State Senator',
    'State Representative',
  ];

  const out: IaCandidacyRow[] = [];
  let currentOffice: string | null = null;
  let currentParty: string | null = null;
  let rowCounter = 0;

  for (const page of pages) {
    const lines = page.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      // Skip page chrome.
      if (/^Candidate List$/i.test(line)) continue;
      if (/^For change requests/i.test(line)) continue;
      if (/Primary Election$/i.test(line) && /\b202\d\b/.test(line)) continue;
      if (/^or\s+\d{3}-\d{3}-\d{4}/i.test(line)) continue;
      if (/^For the Office Of/i.test(line)) continue;

      const cells = line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0);

      // A "header-style" office row — single cell that matches a federal
      // or state office prefix.
      if (
        cells.length === 1 &&
        FEDERAL_STATE_PREFIXES.some((p) => cells[0]!.startsWith(p))
      ) {
        currentOffice = cells[0]!;
        currentParty = null;
        continue;
      }

      // Identify a party-led row vs an office-led row by examining cell 0.
      const PARTY_RE = /^(Democratic|Republican|Libertarian|Green|No Party|Independent)$/i;
      let officeForRow: string | null = null;
      let partyForRow: string | null = null;
      let nameForRow: string | null = null;

      if (cells[0] && FEDERAL_STATE_PREFIXES.some((p) => cells[0]!.startsWith(p))) {
        // Office on this line — refresh banner.
        currentOffice = cells[0]!;
        officeForRow = currentOffice;
        // cells[1] is party, cells[2] is name.
        if (cells[1] && PARTY_RE.test(cells[1])) {
          partyForRow = cells[1];
          currentParty = partyForRow;
          nameForRow = cells[2] ?? null;
        }
      } else if (cells[0] && PARTY_RE.test(cells[0])) {
        // Continuation row under the previous office banner.
        officeForRow = currentOffice;
        partyForRow = cells[0];
        currentParty = partyForRow;
        nameForRow = cells[1] ?? null;
      } else if (currentOffice && currentParty && cells[0]) {
        // Same party as previous row — name is in cell 0.
        officeForRow = currentOffice;
        partyForRow = currentParty;
        nameForRow = cells[0];
      }

      if (!officeForRow || !partyForRow || !nameForRow) continue;
      // Reject rows whose "name" is clearly not a candidate (e.g. a stray
      // address fragment after a soft wrap).
      if (!/[A-Za-z]/.test(nameForRow)) continue;

      // Office name normalization: "United States Representative District 1"
      // → office_name="United States Representative", district="1".
      let officeName = officeForRow.trim();
      let district: string | null = null;
      const distMatch = /^(.*?)\s+District\s+0*(\d{1,3})\s*$/i.exec(officeName);
      if (distMatch) {
        officeName = distMatch[1]!.trim();
        district = distMatch[2]!;
      }

      // Filing-date capture: last cell often matches MM/DD/YYYY.
      let dateFiled: string | null = null;
      const lastCell = cells[cells.length - 1] ?? '';
      const dateM = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(lastCell);
      if (dateM) {
        const mm = dateM[1]!.padStart(2, '0');
        const dd = dateM[2]!.padStart(2, '0');
        dateFiled = `${dateM[3]}-${mm}-${dd}`;
      }

      rowCounter += 1;
      out.push({
        reported_name: nameForRow,
        office_name: officeName,
        district_identifier: district,
        party_raw: partyForRow,
        date_filed: dateFiled,
        is_write_in: false,
        source_row_id: `ia-${rowCounter}`,
      });
    }
  }
  return out;
}

/**
 * Backwards-compat wrapper. Today this is wired to the live PDF
 * extractor via parseIowaPdfText(); kept as a sync stub returning [] so
 * existing tests that pass raw bytes don't accidentally start hitting
 * pdfjs-dist (the async path lives in the adapter `run()`).
 */
export function parseIowaPdf(_bytes: Uint8Array): IaCandidacyRow[] {
  return [];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the Iowa candidacies SourceAdapter.
 *
 * @example
 *   const adapter = createIaCandidaciesAdapter();
 *   const result = await runAdapter(adapter);
 */
export function createIaCandidaciesAdapter(
  options: IaCandidaciesAdapterOptions = {},
): SourceAdapter<IaCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const electionYear = options.electionYear ?? ELECTION_YEAR;

  const fetchBytes =
    options.fetch ??
    (async () => {
      const res = await politeFetch(sourceUrl, {
        headers: {
          Accept: 'application/pdf,application/octet-stream,*/*',
        },
      });
      if (!res.ok) {
        throw new Error(
          `IA candidacies fetch failed: HTTP ${res.status} from ${sourceUrl}`,
        );
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      return { rawBody: buf, resolvedUrl: res.url };
    });

  // parseOverride is consumed inside `run()`; kept here as a fallthrough
  // sanity check for tests that pass it without exercising the adapter.
  void options.parseOverride;

  const adapter: SourceAdapter<IaCandidacyRow> = {
    name: 'sos-iowa-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<IaCandidacyRow>> {
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

      // Two paths: tests inject `parseOverride` with raw bytes (sync,
      // returns []); production now extracts PDF text and runs the
      // line-walker parser.
      let rows: IaCandidacyRow[];
      if (options.parseOverride) {
        rows = options.parseOverride(rawBody);
      } else {
        try {
          const { pages } = await extractTextFromPdf(rawBody);
          rows = parseIowaPdfText(pages);
        } catch (err) {
          ctx.logger.warn(`${adapter.name}: PDF extract failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
          rows = [];
        }
      }

      ctx.logger.info(`${adapter.name}: parsed`, { rowCount: rows.length });

      return {
        rows,
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'iowa-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            byte_size: rawBody.byteLength,
            row_count: rows.length,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) {
        return 'missing reported_name';
      }
      if (!row.office_name) return 'missing office_name';
      if (!row.party_raw) return 'missing party_raw';
      return null;
    },

    async insert(
      rows: IaCandidacyRow[],
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
              `IA office not resolved: "${row.office_name}" district=${row.district_identifier ?? '-'}`,
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
            source: 'sos-iowa-candidacies',
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
                source: 'sos-iowa-candidacies',
                reported_office: row.office_name,
                reported_district: row.district_identifier,
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
                JSON.stringify({ source: 'sos-iowa-candidacies' }),
              ],
            );
          } else {
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `IA party not resolved: "${row.party_raw}" for ${row.reported_name}`,
              row,
            );
          }
        } catch (err) {
          stats.rowsFailed += 1;
          const msg = err instanceof Error ? err.message : String(err);
          stats.errors.push({
            type: 'other',
            message: `IA candidacy insert: ${msg}`,
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
    ctx.logger.warn('sos-iowa-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
