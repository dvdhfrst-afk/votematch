/**
 * Comisión Estatal de Elecciones de Puerto Rico (CEE) — candidate-filings
 * adapter (FIPS 72).
 *
 * Source (verified 2026-04-25):
 *   https://ww2.ceepur.org/                                  (200, 31KB)
 *   https://individuo.cee.pr.gov/Public/Default.aspx         (200, SIEN portal)
 *
 * SIEN = Sistema de Notificación de Intención de Aspirar a una Candidatura
 * y Sistema de Endosos. It's the official intake system for candidate
 * notifications + endorsements. Public landing page exists but the actual
 * candidate query requires a logged-in `Número Electoral`.
 *
 * Status: DORMANT (no statewide PR cycle in 2026).
 * ------------------------------------------------
 * Puerto Rico's statewide cycle aligns with U.S. presidential years:
 * primaries June 2024, generals November 2024, NEXT cycle 2028. There is
 * no PR-wide primary or general on the 2026 calendar; only ad-hoc special
 * elections (e.g., the 2025 PNP House District 31 special). The seed file
 * marks `primary_date_2026: null`. This adapter therefore ships
 * empty-but-correct so a continuous-ingest poll during 2026 returns 0
 * rows without error.
 *
 * Despite the dormant status, the parser is Spanish-aware:
 *   - Header detection accepts 'candidato', 'aspirante', 'partido',
 *     'distrito', 'municipio', 'precinto'.
 *   - Names are normalized via the diacritic-folding canonicalKey so
 *     "Ana Garcia" and "Ana García" canonicalize identically
 *     against people.canonical_key (matches DB unaccent() trigger).
 *   - Pre-seeded parties (PNP, PPD, MVC, PIP, PD) live in the parties
 *     table per migration 20260425000002; resolvePartyId() uses
 *     stateFips=72 + abbrev/canonical_key match.
 *
 * When CEE publishes a roster (next: 2028 primary, ~April 2028) we'll
 * replace `parsePuertoRicoCandidates()` with a real Spanish-source HTML/
 * PDF parser. Until then it returns [] safely.
 *
 * Office contact:
 *   Comisión Estatal de Elecciones
 *   Web:   https://ww2.ceepur.org/
 *   SIEN:  https://individuo.cee.pr.gov/Public/Default.aspx
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

import { politeFetch } from '../../fetch-polite';
import { canonicalKey } from '../base';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

const STATE_FIPS = '72';
const DEFAULT_SOURCE_URL = 'https://ww2.ceepur.org/';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type PrCandidacyRow = {
  reported_name: string;
  /** Spanish or English party token. PNP/PPD/MVC/PIP/PD seeded for FIPS 72. */
  party_abbreviation: string | null;
  office_name: string;
  district_identifier: string | null;
  is_write_in: boolean;
  /** Detected language hint for downstream extractor / audit. */
  language: 'es' | 'en';
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Parse — Spanish-aware
// ---------------------------------------------------------------------------

/**
 * Parse CEE roster HTML. Detects Spanish and English headers; tolerates
 * both because some CEE press materials are bilingual. Returns [] when
 * no recognizable candidate table is found (the dormant case).
 *
 * Header tokens we accept:
 *   name        — 'candidato', 'aspirante', 'nombre', 'candidate', 'name'
 *   party       — 'partido', 'party'
 *   office      — 'cargo', 'oficina', 'office'
 *   district    — 'distrito', 'precinto', 'municipio', 'district', 'precinct'
 */
export function parsePuertoRicoCandidates(rawBody: string): PrCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  const $ = cheerio.load(rawBody);
  const rows: PrCandidacyRow[] = [];

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
      (h) =>
        h.includes('candidato') ||
        h.includes('aspirante') ||
        h.includes('nombre') ||
        h.includes('candidate') ||
        h === 'name',
    );
    if (nameCol < 0) return;

    const partyCol = headerCells.findIndex(
      (h) => h.includes('partido') || h.includes('party'),
    );
    const officeCol = headerCells.findIndex(
      (h) =>
        h.includes('cargo') ||
        h.includes('oficina') ||
        h.includes('puesto') ||
        h.includes('office'),
    );
    const districtCol = headerCells.findIndex(
      (h) =>
        h.includes('distrito') ||
        h.includes('precinto') ||
        h.includes('municipio') ||
        h.includes('district') ||
        h.includes('precinct'),
    );

    let officeFromHeader = '';
    const $prev = $table.prevAll('h1,h2,h3,h4,caption').first();
    if ($prev.length) officeFromHeader = $prev.text().trim();

    $table.find('tr').each((rowIdx, trEl) => {
      if (rowIdx === 0) return;
      const cells = $(trEl)
        .find('td')
        .map((_i, el) => $(el).text().trim())
        .get();
      if (cells.length === 0) return;
      const name = cells[nameCol];
      if (!name) return;
      const office =
        officeCol >= 0 && cells[officeCol] ? cells[officeCol]! : officeFromHeader;
      if (!office) return;

      // Naive language detection — we infer 'es' from any of the Spanish
      // header tokens having matched. Production uses
      // detectSourceLanguage() in src/lib/extractors when extractors run;
      // adapters write a coarse hint into meta only.
      const isSpanish =
        headerCells.some(
          (h) =>
            h.includes('candidato') ||
            h.includes('partido') ||
            h.includes('distrito') ||
            h.includes('cargo') ||
            h.includes('aspirante') ||
            h.includes('precinto') ||
            h.includes('municipio'),
        ) ||
        /[ñáéíóú¿¡]/i.test(`${name} ${office}`);

      rows.push({
        reported_name: name,
        party_abbreviation:
          partyCol >= 0 && cells[partyCol] ? cells[partyCol]! : null,
        office_name: office,
        district_identifier:
          districtCol >= 0 && cells[districtCol] ? cells[districtCol]! : null,
        is_write_in:
          /write[-\s]*in|nominaci[oó]n directa|por\s+nominaci/i.test(name),
        language: isSpanish ? 'es' : 'en',
        source_row_id: `pr-t${tableIdx}-r${rowIdx}-${canonicalKey(name).slice(0, 24)}`,
      });
    });
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Options / factory
// ---------------------------------------------------------------------------

export type CreatePrCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => PrCandidacyRow[];
};

export function createPrCandidaciesAdapter(
  options: CreatePrCandidaciesAdapterOptions = {},
): SourceAdapter<PrCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? new Date().getUTCFullYear();
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<PrCandidacyRow> = {
    name: 'sos-puerto-rico-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<PrCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('pr-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      let status = 0;
      let rawBody = '';
      try {
        if (options.fetchOverride) {
          const r = await options.fetchOverride(sourceUrl);
          status = r.status;
          rawBody = r.body;
        } else {
          const res = await politeFetch(sourceUrl, {
            // Negotiate Spanish content first; fall back to */*.
            headers: {
              Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
              'Accept-Language': 'es-PR,es;q=0.9,en;q=0.6',
            },
          });
          status = res.status;
          rawBody = await res.text();
        }
      } catch (err) {
        ctx.logger.warn('pr-candidacies: fetch threw — returning empty', {
          error: err instanceof Error ? err.message : String(err),
          url: sourceUrl,
        });
      }

      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      const parser = options.parseOverride ?? parsePuertoRicoCandidates;
      const rows = rawBody ? parser(rawBody) : [];

      ctx.logger.info('pr-candidacies: parsed', {
        rowCount: rows.length,
        bytes: rawBody.length,
      });

      return {
        rows,
        // Dormant — no statewide PR cycle in 2026; flips productive in 2028.
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'puerto-rico-cee-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            byte_size: rawBody.length,
            http_status: status,
            language_hint: 'es',
            adapter_status_hint: 'dormant',
            note:
              'PR statewide cycle is presidential-year aligned. Next primary 2028; ' +
              '2026 carries only ad-hoc special elections. Diacritic-folding ' +
              'canonicalKey + Spanish-header parser already wired.',
            sien_url: 'https://individuo.cee.pr.gov/Public/Default.aspx',
            office_contact: {
              name: 'Comisión Estatal de Elecciones',
              web: 'https://ww2.ceepur.org/',
            },
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) {
        return 'missing reported_name';
      }
      if (!row.office_name || !row.office_name.trim()) {
        return 'missing office_name';
      }
      return null;
    },

    async insert(
      rows: PrCandidacyRow[],
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
            continue;
          }

          // Spanish names: findOrCreatePerson normalizes via canonicalKey
          // which folds diacritics — "José" → "jose" — keeping
          // canonical_key stable against the DB unaccent() trigger.
          const personId = await findOrCreateStatePerson(ctx.pg, {
            name: row.reported_name,
            state_fips: STATE_FIPS,
            electionYear,
            source: 'pr-sos-candidacies',
            dataSourceId: refs.dataSourceId,
          });

          const candidacyRes = await ctx.pg.query<{
            id: string;
            inserted: boolean;
          }>(
            `INSERT INTO candidacies
               (election_id, person_id, party, status, meta)
             VALUES ($1, $2, $3, 'active', $4::jsonb)
             ON CONFLICT (election_id, person_id) DO UPDATE
               SET meta = candidacies.meta
             RETURNING id, (xmax = 0) AS inserted`,
            [
              officeInfo.election_id,
              personId,
              row.party_abbreviation,
              JSON.stringify({
                source: 'pr-sos-candidacies',
                reported_office: row.office_name,
                reported_district: row.district_identifier,
                language: row.language,
                data_source_id: refs.dataSourceId,
                ingestion_run_id: refs.ingestionRunId,
                source_row_id: row.source_row_id,
              }),
            ],
          );

          const candidacyId = candidacyRes.rows[0]?.id;
          if (!candidacyId) {
            stats.rowsFailed += 1;
            continue;
          }
          if (candidacyRes.rows[0]?.inserted) stats.rowsInserted += 1;
          else stats.rowsUpdated += 1;

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
                    source: 'pr-sos-candidacies',
                    reported_party: row.party_abbreviation,
                  }),
                ],
              );
            }
          }
        } catch (err) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: `row: ${err instanceof Error ? err.message : String(err)}`,
            rawInput: row,
          });
        }
      }

      return stats;
    },
  };

  return adapter;
}
