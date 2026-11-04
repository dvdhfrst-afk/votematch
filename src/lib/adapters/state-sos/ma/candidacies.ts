/**
 * Massachusetts Secretary of the Commonwealth — 2026 candidate-filings
 * adapter (FIPS 25).
 *
 * State Primary is 2026-09-01; State Election (general) is 2026-11-03.
 *
 * Source landing page (web-verified 2026-04-25):
 *   https://www.sec.state.ma.us/divisions/elections/candidate-information/candidate-information.htm
 *   https://www.sec.state.ma.us/divisions/elections/getting-on-the-ballot/how-to-run-for-office-2026.htm
 *
 * Source format — DOCUMENTED BLOCKER
 * -----------------------------------
 * The MA SoS website is fronted by Imperva / Incapsula bot protection.
 * Every direct fetch via politeFetch (Chrome/Firefox UAs included) is
 * intercepted at the edge:
 *
 *   GET https://www.sec.state.ma.us/divisions/elections/candidate-information/candidate-information.htm
 *     → 200 OK with a 212-byte body, all of which is the
 *       `<iframe src="/_Incapsula_Resource?...">` challenge wrapper:
 *       "Request unsuccessful. Incapsula incident ID: ..."
 *
 *   GET https://www.sec.state.ma.us/divisions/elections/elections-and-voting.htm
 *     → 200 OK, identical 212-byte Incapsula iframe wrapper.
 *
 *   GET https://www.sec.state.ma.us/divisions/elections/recent-updates/upcoming-elections.htm
 *     → 200 OK with an 845-byte iframe-only Incapsula challenge.
 *
 * Imperva uses a token cookie issued by an embedded JS challenge, so the
 * page is not fetched automatically. This adapter does not work around
 * it. Separately, as of 2026-04-25 the MA Sec of Commonwealth had NOT yet
 * posted a consolidated 2026 statewide-primary candidate list (the filing
 * deadline is May 26, 2026 for state offices, and the list is typically
 * released ~early June).
 *
 * What this adapter does today:
 *   1. Fetches the landing page via politeFetch and records the SHA-256
 *      of the Imperva challenge body (so a change is detectable by
 *      content hash).
 *   2. Returns ZERO rows (parser is a stub that exits on the Imperva
 *      sentinel string).
 *   3. Logs a CLEAR blocker on the ingestion run.
 *
 * Special elections linked off the special-elections page, for a future
 * implementer:
 *   - 2026 Special State Primary, Fifth Essex Representative District
 *   - 2026 Special State Election, First Middlesex Senate District
 * Both pages are also Imperva-walled in the same fashion.
 *
 * What's on the 2026 MA primary ballot (per
 *   https://www.sec.state.ma.us/divisions/elections/getting-on-the-ballot/how-to-run-for-office-2026.htm
 *   web-verified 2026-04-25):
 *   - Governor / Lt. Governor (joint ticket)
 *   - Attorney General
 *   - Secretary of the Commonwealth
 *   - State Treasurer
 *   - State Auditor
 *   - 9 U.S. Representatives
 *   - 1 Class III U.S. Senator
 *   - All 40 State Senators
 *   - All 160 State Representatives
 *   - 8 Governor's Council
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

const STATE_FIPS = '25';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-09-01';

const DEFAULT_SOURCE_URL =
  'https://www.sec.state.ma.us/divisions/elections/candidate-information/candidate-information.htm';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type MaCandidacyRow = {
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

export type MaCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (html: string) => MaCandidacyRow[];
};

// ---------------------------------------------------------------------------
// Imperva detection + parser stub
// ---------------------------------------------------------------------------

/** Detect MA's Imperva challenge body. */
export function isImpervaChallenge(body: string): boolean {
  if (typeof body !== 'string' || body.length === 0) return false;
  const head = body.slice(0, 4096);
  return (
    head.includes('Incapsula') ||
    head.includes('_Incapsula_Resource') ||
    head.includes('incident_id') ||
    head.includes('Request unsuccessful')
  );
}

/**
 * Parse MA candidate-information HTML. Currently returns [] for Imperva-
 * challenge bodies; once real candidate HTML is available, this parser
 * becomes the cheerio-driven extraction that mirrors OH's table walk.
 */
export function parseMassachusettsHtml(html: string): MaCandidacyRow[] {
  if (!html || isImpervaChallenge(html)) return [];
  // Phase-2: cheerio walk of the candidate listing tables. The MA SoS
  // typically publishes the 2026 statewide-primary list as one HTML page
  // with per-office tables. Until real HTML is available, we return [].
  return [];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMaCandidaciesAdapter(
  options: MaCandidaciesAdapterOptions = {},
): SourceAdapter<MaCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const electionYear = options.electionYear ?? ELECTION_YEAR;

  const fetchImpl =
    options.fetchOverride ??
    (async (url: string) => {
      const r = await politeFetch(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },
      });
      return { status: r.status, body: await r.text() };
    });

  const parser = options.parseOverride ?? parseMassachusettsHtml;

  const adapter: SourceAdapter<MaCandidacyRow> = {
    name: 'sos-massachusetts-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<MaCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      const { status, body } = await fetchImpl(sourceUrl);
      const contentHash = createHash('sha256').update(body).digest('hex');
      const imperva = isImpervaChallenge(body);

      ctx.logger.info(`${adapter.name}: fetched`, {
        http_status: status,
        bytes: body.length,
        contentHash: contentHash.slice(0, 12),
        imperva_walled: imperva,
      });

      let rows: MaCandidacyRow[] = [];
      if (imperva) {
        ctx.logger.warn(
          `${adapter.name}: Imperva challenge body detected — returning []. ` +
            'See file header for the blocker explanation.',
          { sourceUrl, bytes: body.length },
        );
      } else if (status >= 400) {
        throw new Error(`${adapter.name}: HTTP ${status} from ${sourceUrl}`);
      } else {
        rows = parser(body);
      }

      return {
        rows,
        // 0 expected: the page is Imperva-walled and the post-deadline
        // candidate list publishes ~early June (filing deadline
        // 2026-05-26).
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'massachusetts-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            byte_size: body.length,
            http_status: status,
            imperva_walled: imperva,
            blocker: imperva ? 'imperva_bot_protection' : null,
            blocker_doc:
              'MA Sec of Commonwealth fronted by Imperva; not fetched ' +
              'automatically. Filing deadline 2026-05-26; list publishes ' +
              '~early June.',
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
      rows: MaCandidacyRow[],
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
              `MA office not resolved: "${row.office_name}" district=${row.district_identifier ?? '-'}`,
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
            source: 'sos-massachusetts-candidacies',
            dataSourceId: refs.dataSourceId,
          });
          const candidacyRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
            `INSERT INTO candidacies
               (election_id, person_id, party, status, filed_on, meta)
             VALUES ($1, $2, $3, 'active', $4::date, $5::jsonb)
             ON CONFLICT (election_id, person_id) DO UPDATE
               SET party = EXCLUDED.party
             RETURNING id, (xmax = 0) AS inserted`,
            [
              officeInfo.election_id,
              personId,
              row.party_raw,
              row.date_filed,
              JSON.stringify({
                source: 'sos-massachusetts-candidacies',
                source_row_id: row.source_row_id,
                data_source_id: refs.dataSourceId,
              }),
            ],
          );
          const candidacyId = candidacyRes.rows[0]!.id;
          if (candidacyRes.rows[0]!.inserted) stats.rowsInserted += 1;
          else stats.rowsUpdated += 1;
          if (row.party_raw) {
            const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);
            if (partyId) {
              await ctx.pg.query(
                `INSERT INTO candidacy_party_lines
                   (candidacy_id, party_id, ballot_line_order, nomination_method,
                    data_source_id, meta)
                 VALUES ($1, $2, 1, 'primary', $3::uuid, $4::jsonb)
                 ON CONFLICT (candidacy_id, party_id) DO NOTHING`,
                [
                  candidacyId,
                  partyId,
                  refs.dataSourceId ?? null,
                  JSON.stringify({ source: 'sos-massachusetts-candidacies' }),
                ],
              );
            }
          }
        } catch (err) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: `MA candidacy insert: ${err instanceof Error ? err.message : String(err)}`,
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
    ctx.logger.warn('sos-massachusetts-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
