/**
 * Florida Division of Elections — 2026 candidate-filings adapter (FIPS 12).
 *
 * Source (web-verified 2026-04-25 via politeFetch probe):
 *   Landing page (form): https://dos.elections.myflorida.com/candidates/downloadcanlist.asp
 *   Tab-delimited extract endpoint:
 *     POST https://dos.elections.myflorida.com/candidates/extractCanList.asp
 *     Form body: elecID=<election-id>
 *   Election ID for the 2026 general cycle: '20261103-GEN'
 *   (Florida pools both primary and general filings under the GEN id;
 *   the August 18, 2026 primary is part of that bundle.) Specials use
 *   their own ids ('20260324-S01', etc.) — we wire these in too so
 *   the dispatcher can fan out across all 2026 contests.
 *
 * What's on the 2026 FL ballot:
 *   - U.S. Senate (Class III seat)
 *   - U.S. House (28 districts)
 *   - Governor + Cabinet (CFO, Attorney General, Commissioner of Agriculture)
 *   - State Senate (half the chamber on the 2026 cycle)
 *   - State House (all 120 districts)
 *   - Justices on retention
 *   - Local races NOT in scope here — county SOEs handle those.
 *
 * Wire format (live-verified 2026-04-25 against the production
 * extractCanList.asp endpoint — header-only row when no candidates have
 * filed yet for the requested cycle). The 2026 candidate extract uses a
 * different column shape from the historical results extract:
 *
 *   AcctNum  VoterID  ElectionID  OfficeCode  OfficeDesc  Juris1num
 *   Juris2num  StatusCode  StatusDesc  PartyCode  PartyDesc  NameLast
 *   NameFirst  NameMiddle  SuppressAddress  Addr1  Addr2  City  State
 *   Zip  County  Phone  TrsNameLast  TrsNameFirst  TrsNameMiddle  Email
 *
 * The parser auto-detects the header row and maps columns by name, so it
 * works with either shape.
 *
 * Idempotent: each row's source_row_id is RaceCode + CandidateFullName;
 * the upsert in shared/candidacies-insert handles re-runs cleanly.
 */

import { createHash } from 'node:crypto';

import { politeFetch } from '../../fetch-polite';
import {
  insertCandidacies,
  type CandidacyInsertRow,
} from '../shared/candidacies-insert';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

const STATE_FIPS = '12';
const ELECTION_YEAR = 2026;
const DEFAULT_PRIMARY_DATE = '2026-08-18';
const DEFAULT_GENERAL_DATE = '2026-11-03';

const EXTRACT_URL =
  'https://dos.elections.myflorida.com/candidates/extractCanList.asp';
const LANDING_URL =
  'https://dos.elections.myflorida.com/candidates/downloadcanlist.asp';

/** FL elecID for the 2026 cycle. Verified live in the form's <option> list. */
const DEFAULT_ELEC_ID = '20261103-GEN';

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export type FlCandidacyRow = CandidacyInsertRow & {
  /** FL TypeOfElection field — PRI / GEN / S01... */
  fl_type_of_election: string;
  /** RaceCode from the extract — used as source_row_id prefix. */
  fl_race_code: string;
  fl_county_name: string | null;
};

// ---------------------------------------------------------------------------
// Pure parser — exported for tests.
// ---------------------------------------------------------------------------

/**
 * Parse the FL tab-delimited candidate extract.
 *
 * The extract's first row may be a header (column names) or may go
 * straight to data; we autodetect by checking whether the first row's
 * "Office Description" column looks like a header label.
 *
 * One row per candidate per contest. State-level contests use blank
 * CountyCode; county-level contests fan out one row per county. We pin
 * to statewide + federal + state-leg + state-cabinet for now (skipping
 * county/municipal which the office-graph handles via separate jurisdictions).
 */
export function parseFloridaTsv(
  body: string,
  opts: { electionDate: string; electionType: CandidacyInsertRow['election_type'] },
): FlCandidacyRow[] {
  if (!body || body.length < 32) return [];
  // Some FL responses are CRLF, some LF. Normalize.
  const lines = body.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  // Header detection — FL spec orders fields predictably even without
  // a header row, so we try header-mapping first and fall back to the
  // documented positional layout.
  const firstCols = lines[0]!.split('\t');
  const looksHeader =
    firstCols.some((c) => /candidate/i.test(c)) ||
    firstCols.some((c) => /office/i.test(c));

  let cols: FlColMap;
  let dataStart = 0;
  if (looksHeader) {
    cols = mapFlHeader(firstCols);
    dataStart = 1;
  } else {
    cols = POSITIONAL_FL_COLS;
  }

  const out: FlCandidacyRow[] = [];
  const seen = new Set<string>();

  for (let i = dataStart; i < lines.length; i++) {
    const cells = lines[i]!.split('\t');
    if (cells.length < 5) continue;

    const dateStr = cell(cells, cols.electionDate);
    const typeOfElection = cell(cells, cols.typeOfElection);
    const officeDesc = cell(cells, cols.officeDesc);
    const district = cell(cells, cols.district) || cell(cells, cols.juris1);
    let candidateFull = cell(cells, cols.candidateFull);
    if (!candidateFull) {
      // Synthesize from First/Middle/Last when the extract uses the
      // 2026+ shape (NameFirst / NameMiddle / NameLast) instead of the
      // legacy CandidateFullName column.
      const f = cell(cells, cols.candidateFirst);
      const m = cell(cells, cols.candidateMiddle);
      const l = cell(cells, cols.candidateLast);
      candidateFull = [f, m, l].filter(Boolean).join(' ').trim();
    }
    const partyCode = cell(cells, cols.partyCode);
    const raceCode = cell(cells, cols.raceCode);
    const countyName = cell(cells, cols.countyName);

    if (!officeDesc || !candidateFull) continue;

    // Statewide contests have blank CountyCode/CountyName; FL emits one row
    // per county for county/municipal — we'll dedup at the contest level
    // for federal/statewide/leg.
    const dedupKey = `fl|${raceCode}|${district}|${partyCode}|${candidateFull.toLowerCase()}|${countyName.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    out.push({
      reported_name: candidateFull,
      office_name: officeDesc,
      district_identifier: district ? stripLeadingZeros(district) : null,
      party_raw: partyCode || null,
      date_filed: parseFlDate(dateStr),
      election_date: opts.electionDate,
      election_type: opts.electionType,
      source_row_id: dedupKey,
      fl_type_of_election: typeOfElection || '',
      fl_race_code: raceCode || '',
      fl_county_name: countyName || null,
    });
  }
  return out;
}

type FlColMap = {
  electionDate: number;
  typeOfElection: number;
  countyCode: number;
  countyName: number;
  raceCode: number;
  officeDesc: number;
  district: number;
  contestName: number;
  fullContestName: number;
  candidateFirst: number;
  candidateLast: number;
  candidateMiddle: number;
  candidateFull: number;
  partyName: number;
  partyCode: number;
  electionId: number;
  juris1: number;
  juris2: number;
};

/**
 * Documented positional layout (per the historical FL DoS extract spec).
 * Used as a last-resort fallback when there's no header row at all.
 * Modern extracts (2026+) use the AcctNum/VoterID/... layout instead;
 * mapFlHeader picks that up correctly.
 */
const POSITIONAL_FL_COLS: FlColMap = {
  electionDate: 0,
  typeOfElection: 1,
  countyCode: 2,
  countyName: 3,
  raceCode: 4,
  officeDesc: 5,
  district: 6,
  contestName: 7,
  fullContestName: 8,
  candidateFirst: 9,
  candidateLast: 10,
  candidateMiddle: -1,
  candidateFull: 11,
  partyName: 12,
  partyCode: 13,
  electionId: -1,
  juris1: -1,
  juris2: -1,
};

function mapFlHeader(headers: string[]): FlColMap {
  const lc = headers.map((h) => h.trim().toLowerCase());
  const find = (...needles: string[]): number => {
    for (let i = 0; i < lc.length; i++) {
      const h = lc[i]!;
      if (needles.some((n) => h === n || h.includes(n))) return i;
    }
    return -1;
  };
  return {
    electionDate: find('electiondate', 'election date'),
    typeOfElection: find('typeofelection', 'type of election'),
    countyCode: find('countycode'),
    countyName: find('countyname', 'county'),
    raceCode: find('racecode', 'officecode'),
    officeDesc: find('officedesc', 'office desc'),
    district: find('district', 'juris1num'),
    contestName: find('contestname'),
    fullContestName: find('fullcontestname'),
    candidateFirst: find('candidatefirstname', 'namefirst', 'firstname'),
    candidateLast: find('candidatelastname', 'namelast', 'lastname'),
    candidateMiddle: find('candidatemiddlename', 'namemiddle', 'middlename'),
    candidateFull: find('candidatefullname', 'fullname', 'candidate full'),
    partyName: find('candidateparty', 'partydesc'),
    partyCode: find('candidatefloridapartycode', 'partycode'),
    electionId: find('electionid'),
    juris1: find('juris1num'),
    juris2: find('juris2num'),
  };
}

function cell(cells: string[], idx: number): string {
  if (idx < 0 || idx >= cells.length) return '';
  return (cells[idx] ?? '').trim();
}

function stripLeadingZeros(s: string): string {
  const m = s.match(/^0*(\d+)$/);
  return m ? m[1]! : s;
}

function parseFlDate(s: string): string | null {
  if (!s) return null;
  // FL emits YYYYMMDD for ElectionDate; candidate-filed dates can come
  // in MM/DD/YYYY in newer extracts.
  const ymd = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const yy = mdy[3]!.length === 2 ? `20${mdy[3]}` : mdy[3]!;
    return `${yy}-${mdy[1]!.padStart(2, '0')}-${mdy[2]!.padStart(2, '0')}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type FlCandidaciesAdapterOptions = {
  /** FL elecID, e.g. '20261103-GEN'. Defaults to the 2026 general cycle. */
  elecId?: string;
  /** Override extract endpoint for tests. */
  extractUrl?: string;
  /** electionDate written into rows. Defaults to 2026 general. */
  electionDate?: string;
  /** electionType written into rows. Most 2026 use 'general'. */
  electionType?: CandidacyInsertRow['election_type'];
  electionYear?: number;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Test override — supply pre-fetched TSV body. */
  fetchTsv?: (elecId: string) => Promise<{ status: number; body: string; resolvedUrl?: string }>;
};

export function createFlCandidaciesAdapter(
  options: FlCandidaciesAdapterOptions = {},
): SourceAdapter<FlCandidacyRow> {
  const elecId = options.elecId ?? DEFAULT_ELEC_ID;
  const extractUrl = options.extractUrl ?? EXTRACT_URL;
  const electionDate = options.electionDate ?? DEFAULT_GENERAL_DATE;
  const electionType: CandidacyInsertRow['election_type'] =
    options.electionType ??
    (elecId.endsWith('-PRI') || elecId.endsWith('PRI') ? 'primary' : 'general');
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);

  const fetchImpl =
    options.fetchTsv ??
    (async (id: string) => {
      // The downloadcanlist.asp form posts FOUR fields, not just elecID.
      // Posting only elecID returns a header-row-only TSV (243B, 0 rows) —
      // verified live 2026-04-26. Sending the full form-default payload
      // (`office=All&status=All&cantype=STA`) returns the populated
      // candidate list. `cantype=STA` covers federal + statewide + state
      // legislative + state-attorney/PD; county/local rows live under
      // `cantype=LOC` and are deferred to county adapters.
      const body =
        `elecID=${encodeURIComponent(id)}` +
        '&office=All' +
        '&status=All' +
        '&cantype=STA' +
        '&FormSubmit=Download+Candidate+List';
      const res = await politeFetch(extractUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/plain,text/tab-separated-values,*/*',
          Referer: LANDING_URL,
          Origin: 'https://dos.elections.myflorida.com',
        },
        body,
      });
      const text = await res.text();
      return { status: res.status, body: text, resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<FlCandidacyRow> = {
    name: 'sos-florida-doe-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<FlCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: extractUrl,
        elecId,
      });

      const { status, body, resolvedUrl } = await fetchImpl(elecId);
      if (status >= 400) {
        throw new Error(
          `FL candidacies fetch failed: HTTP ${status} for elecID=${elecId}`,
        );
      }
      const contentHash = createHash('sha256').update(body).digest('hex');

      // FL serves text/html on the landing page if elecID is missing /
      // unrecognized — guard against that returning [] rather than
      // throwing, since election ids change cycle to cycle.
      let rows: FlCandidacyRow[] = [];
      if (body.trimStart().startsWith('<')) {
        ctx.logger.warn(
          `${adapter.name}: extract endpoint returned HTML — likely invalid elecID`,
          { elecId, bytes: body.length },
        );
      } else {
        rows = parseFloridaTsv(body, {
          electionDate,
          electionType,
        });
      }

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        bytes: body.length,
      });

      return {
        rows,
        expectedMinRows: 1,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'florida-doe-candidacies',
          url: resolvedUrl ?? extractUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            elec_id: elecId,
            election_date: electionDate,
            election_type: electionType,
            byte_size: body.length,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) return 'missing reported_name';
      if (!row.office_name || !row.office_name.trim()) return 'missing office_name';
      return null;
    },

    async insert(
      rows: FlCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertCandidacies(rows, refs, ctx, {
        stateFips: STATE_FIPS,
        source: 'sos-florida-doe-candidacies',
        electionYear,
      });
    },
  };

  return adapter;
}
