/**
 * Louisiana Secretary of State — 2026 candidate-filings adapter (FIPS 22).
 *
 * Louisiana 2026 cycle has TWO relevant elections per the closed-primary
 * legislation enacted in 2024 (Act 312):
 *   - 2026-05-16 closed party primary (election id 342) — major-party
 *     candidates for U.S. Senate, U.S. House, Supreme Court, PSC, BESE
 *   - 2026-11-03 jungle-primary general (election id 344) — every other
 *     office (state legislature, statewide exec, locals) plus the
 *     non-major-party candidates for the offices above
 *
 * This adapter ingests both election dates by default. Callers can scope
 * via the `electionIds` option (see end of file).
 *
 * Source (web-verified 2026-04-25):
 *   https://voterportal.sos.la.gov/CandidateInquiry?electionDate=20260516
 *
 *   The voter portal renders a candidate inquiry tool. The SoS-internal
 *   election IDs are surfaced in the page's `<select id="ElectionId">`
 *   dropdown. The adapter:
 *     1. GETs the inquiry page to (a) capture session cookies and (b)
 *        snapshot the available election IDs.
 *     2. For each requested election, AJAX-fetches the per-election office
 *        list:  POST /CandidateInquiry/StatewideCandidate/OfficeList
 *               with electionId={N}
 *     3. Extracts office-id checkboxes (`id="cb_<NNNNN>"`) from the
 *        OfficeList HTML.
 *     4. AJAX-fetches the candidate list for ALL offices in one call:
 *               POST /CandidateInquiry/StatewideCandidate/CandidateList
 *               with electionId={N} + officeIds={ID}&officeIds={ID}...
 *               (jQuery `traditional: true` array serialization)
 *     5. Parses the resulting HTML.
 *
 *   The LA portal is plaintext (no Cloudflare/Imperva) but DOES require
 *   the X-Requested-With: XMLHttpRequest header AND the session cookies
 *   from step 1; calls without them return HTTP 500.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

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

const STATE_FIPS = '22';
const ELECTION_YEAR = 2026;

const PORTAL_BASE = 'https://voterportal.sos.la.gov';
const INQUIRY_URL = `${PORTAL_BASE}/CandidateInquiry?electionDate=20260516`;
const OFFICE_LIST_URL = `${PORTAL_BASE}/CandidateInquiry/StatewideCandidate/OfficeList`;
const CANDIDATE_LIST_URL = `${PORTAL_BASE}/CandidateInquiry/StatewideCandidate/CandidateList`;

/**
 * Election IDs are SoS-internal integers from the inquiry page dropdown.
 * Verified 2026-04-25 against the live page:
 *   342 → 05/16/2026 (closed party primary)
 *   344 → 11/03/2026 (open primary / general)
 *   347 → 03/14/2026 (mid-cycle special — included for cleanup)
 *   346 → 02/07/2026 (mid-cycle special)
 */
const DEFAULT_ELECTION_IDS = [
  { id: 342, date: '2026-05-16', label: 'closed-primary' },
  { id: 344, date: '2026-11-03', label: 'general' },
];

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type LaCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string;
  date_filed: string | null;
  is_write_in: boolean;
  status: 'active' | 'withdrew' | 'unopposed';
  /** SoS election id this row came from (342, 344, ...). */
  source_election_id: number;
  source_election_date: string;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type LaCandidaciesAdapterOptions = {
  electionYear?: number;
  /** Override election IDs (tests / partial backfills). */
  electionIds?: Array<{ id: number; date: string; label: string }>;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /**
   * Inject the AJAX fetcher (tests). When provided, skips the live portal.
   * The function receives the URL + headers + body; tests return the
   * response body keyed by URL.
   */
  fetchOverride?: (
    url: string,
    init: { method: 'GET' | 'POST'; body?: string; cookie: string },
  ) => Promise<{ status: number; body: string; setCookie?: string | null }>;
  /** Inject a parser override for the CandidateList HTML. */
  parseOverride?: (html: string, electionId: number, electionDate: string) => LaCandidacyRow[];
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse one CandidateList AJAX response into LaCandidacyRow[].
 *
 * The response is a fragment of HTML — repeated blocks of:
 *   `<div class="candidate-top-row">` … office heading
 *   `<div class="candidate-row">` per candidate
 *
 * We use a regex-driven walk because the SoS markup nests inconsistently
 * across offices.
 */
export function parseLaCandidateList(
  html: string,
  electionId: number,
  electionDate: string,
): LaCandidacyRow[] {
  if (!html || html.length < 64) return [];
  const $ = cheerio.load(html);
  const rows: LaCandidacyRow[] = [];
  let rowCounter = 0;

  // Each office section is split by an h-tag containing the office name + party.
  // We walk top-level rows in the rendered DOM order.
  let currentOffice = '';
  let currentParty = '';
  let currentDistrict: string | null = null;

  // The page emits sections like:
  //   <div class="candidate-top-row">
  //     <h3>U. S. Senator</h3>
  //     <h4>Democratic Party</h4>
  //     ...
  //   </div>
  // ...followed by repeating per-candidate blocks.
  // We extract via a sequence walk.

  $('div, h2, h3, h4, h5').each((_i, el) => {
    const $el = $(el);
    const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? '';
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (!text) return;

    // Office heading detection — heuristic: short H3-like text matching
    // a known office prefix, OR explicit class="office".
    if (
      tag === 'h3' ||
      $el.hasClass('office') ||
      /^(U\. S\.|US|State|Associate|PSC|BESE|Member|Judge|District|Justice|Governor|Lieutenant|Secretary|Attorney|Treasurer|Auditor|Commissioner|Mayor|Sheriff|Clerk|Coroner|Assessor|Constable|City|Parish|Council)/i.test(
        text,
      )
    ) {
      // Patterns: "U. S. Senator" / "U. S. Representative, 1st Congressional District"
      currentOffice = text;
      // Pull district out of the office string.
      currentDistrict = extractDistrict(text);
    }

    // Party heading detection — H4 immediately under office heading.
    if (
      tag === 'h4' ||
      $el.hasClass('party') ||
      /^(Democratic Party|Republican Party|Libertarian Party|Independent|No Party|Other|Green Party|Reform Party)$/i.test(
        text,
      )
    ) {
      if (/Democratic|Republican|Libertarian|Green|Reform|No Party|Independent|Other/i.test(text)) {
        currentParty = text;
      }
    }

    // Candidate row detection
    if ($el.hasClass('candidate-top-row') || $el.hasClass('candidate-row')) {
      // Each block contains the candidate's name as the first non-empty
      // text node. Pull the first line.
      const firstLine = text.split(/\s{2,}|\n/).find((s) => s.trim()) ?? '';
      // Skip header blocks ("Name/Address/Phone Filed Date Party/Race/Gender")
      if (/^Name\s*\/\s*Address|Filed Date|Party\s*\/\s*Race/i.test(firstLine)) return;
      // First word(s) are the candidate name; we strip parenthesized markers
      // ("Withdrew", "Unopposed", "Disqualified") that appear in the block.
      const nameMatch = firstLine.match(/^([^\d]+?)(?:\s+\d{1,2}\/\d{1,2}\/\d{2,4}|$)/);
      const namePart = (nameMatch?.[1] ?? firstLine).trim();
      const cleanName = namePart
        .replace(/\b(Unopposed|Withdrew|Withdrawn|Deceased|Disqualified)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!cleanName) return;

      const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      const status: LaCandidacyRow['status'] = /Withdrew|Withdrawn/i.test(text)
        ? 'withdrew'
        : /Unopposed/i.test(text)
          ? 'unopposed'
          : 'active';

      // Heuristic: the visible party is whatever the most recent <h4>
      // showed; some sections embed party in the office heading
      // ("U. S. Senator, Democratic Party") so fall back to splitting.
      let party = currentParty;
      if (!party) {
        const m = currentOffice.match(/,\s*(.+?Party)\s*$/i);
        if (m) party = m[1] ?? '';
      }

      rows.push({
        reported_name: cleanName,
        office_name: stripPartyFromOffice(currentOffice),
        district_identifier: currentDistrict,
        party_raw: party,
        date_filed: dateMatch ? normalizeDate(dateMatch[1]) : null,
        is_write_in: /write[-\s]*in/i.test(text),
        status,
        source_election_id: electionId,
        source_election_date: electionDate,
        source_row_id: `la-e${electionId}-r${rowCounter++}-${cleanName.replace(/\W+/g, '_').toLowerCase().slice(0, 30)}`,
      });
    }
  });

  return rows;
}

function extractDistrict(s: string): string | null {
  const m = s.match(/\b(\d+)(?:st|nd|rd|th)?\s+(?:Congressional\s+District|Senatorial\s+District|Representative\s+District|District|Supreme\s+Court\s+District|Circuit)/i);
  return m?.[1] ?? null;
}

function stripPartyFromOffice(s: string): string {
  return s.replace(/,\s*(?:Democratic Party|Republican Party|Libertarian Party|Independent|No Party|Other|Green Party|Reform Party).*$/i, '').trim();
}

function normalizeDate(raw: string): string | null {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw.trim());
  if (!us) return null;
  const mm = us[1]!.padStart(2, '0');
  const dd = us[2]!.padStart(2, '0');
  const yyyy = us[3]!.length === 2 ? `20${us[3]!}` : us[3]!;
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/** Distill set-cookie header(s) into a Cookie request header. */
function distillCookie(setCookie: string | null | undefined): string {
  if (!setCookie) return '';
  return setCookie
    .split(/, (?=[A-Za-z0-9_-]+=)/)
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLaCandidaciesAdapter(
  options: LaCandidaciesAdapterOptions = {},
): SourceAdapter<LaCandidacyRow> {
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const electionIds = options.electionIds ?? DEFAULT_ELECTION_IDS;
  const parser = options.parseOverride ?? parseLaCandidateList;

  const liveFetch = options.fetchOverride
    ? options.fetchOverride
    : async (url: string, init: { method: 'GET' | 'POST'; body?: string; cookie: string }) => {
        const headers: Record<string, string> = {
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'text/html, */*; q=0.01',
        };
        if (init.cookie) headers.Cookie = init.cookie;
        if (init.method === 'POST') {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        const r = await politeFetch(url, {
          method: init.method,
          headers,
          body: init.body,
        });
        return {
          status: r.status,
          body: await r.text(),
          setCookie: r.headers.get('set-cookie'),
        };
      };

  const adapter: SourceAdapter<LaCandidacyRow> = {
    name: 'sos-louisiana-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<LaCandidacyRow>> {
      ctx.logger.info(`${adapter.name}: starting`, {
        stateFips: STATE_FIPS,
        elections: electionIds.length,
      });

      // Step 1: prime session cookies via inquiry page.
      await bucket.acquire();
      const inquiry = await liveFetch(INQUIRY_URL, { method: 'GET', cookie: '' });
      const cookie = distillCookie(inquiry.setCookie);
      ctx.logger.info(`${adapter.name}: session primed`, {
        status: inquiry.status,
        bytes: inquiry.body.length,
        cookieBytes: cookie.length,
      });

      const allRows: LaCandidacyRow[] = [];
      const hashes: string[] = [];
      let totalBytes = 0;

      for (const e of electionIds) {
        await bucket.acquire();
        // Step 2: OfficeList
        const ol = await liveFetch(`${OFFICE_LIST_URL}?electionId=${e.id}`, {
          method: 'GET',
          cookie,
        });
        if (ol.status !== 200) {
          ctx.logger.warn(`${adapter.name}: OfficeList failed`, {
            electionId: e.id,
            status: ol.status,
          });
          continue;
        }
        const officeIds = [...ol.body.matchAll(/id="cb_(\d+)"/g)].map((m) => m[1]!);
        ctx.logger.info(`${adapter.name}: officeList`, {
          electionId: e.id,
          officeCount: officeIds.length,
        });
        if (officeIds.length === 0) continue;

        // Step 3: CandidateList — POST with officeIds repeated (jQuery traditional)
        const body = new URLSearchParams();
        body.set('electionId', String(e.id));
        for (const id of officeIds) body.append('officeIds', id);

        await bucket.acquire();
        const cl = await liveFetch(CANDIDATE_LIST_URL, {
          method: 'POST',
          body: body.toString(),
          cookie,
        });
        if (cl.status !== 200) {
          ctx.logger.warn(`${adapter.name}: CandidateList failed`, {
            electionId: e.id,
            status: cl.status,
          });
          continue;
        }

        totalBytes += cl.body.length;
        hashes.push(createHash('sha256').update(cl.body).digest('hex'));

        const electionRows = parser(cl.body, e.id, e.date);
        ctx.logger.info(`${adapter.name}: candidateList`, {
          electionId: e.id,
          rows: electionRows.length,
          bytes: cl.body.length,
        });
        allRows.push(...electionRows);
      }

      const aggregateHash = createHash('sha256')
        .update(hashes.join('|'))
        .digest('hex');

      return {
        rows: allRows,
        // LA closed primary alone has 39 statewide offices × ~3 candidates
        // each (~120 rows). Floor at 30 to allow early-window runs to be
        // partial-but-correct.
        expectedMinRows: 30,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'louisiana-sos-candidacies',
          url: INQUIRY_URL,
          contentHash: aggregateHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            byte_size: totalBytes,
            elections_fetched: hashes.length,
            elections_attempted: electionIds.length,
            elections: electionIds,
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
      rows: LaCandidacyRow[],
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
            // LA's closed primary 5/16 and general 11/3 both fall in 2026.
            // resolveOfficeElection picks the matching election by date when
            // multiple exist; we pass the source election's year here.
            election_year: electionYear,
          });
          if (!officeInfo) {
            stats.rowsSkipped += 1;
            await logIngestionError(
              ctx,
              refs.ingestionRunId,
              'validation',
              `LA office not resolved: "${row.office_name}" district=${row.district_identifier ?? '-'} (LA election=${row.source_election_id})`,
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
            source: 'sos-louisiana-candidacies',
            dataSourceId: refs.dataSourceId,
          });
          const dbStatus =
            row.status === 'unopposed' ? 'active' : row.status; // schema only has active/withdrew
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
                source: 'sos-louisiana-candidacies',
                la_election_id: row.source_election_id,
                la_election_date: row.source_election_date,
                la_status_raw: row.status,
                reported_office: row.office_name,
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
                JSON.stringify({ source: 'sos-louisiana-candidacies' }),
              ],
            );
          }
        } catch (err) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: `LA candidacy insert: ${err instanceof Error ? err.message : String(err)}`,
            rawInput: row,
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
    ctx.logger.warn('sos-louisiana-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
