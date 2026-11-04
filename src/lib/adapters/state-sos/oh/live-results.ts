/**
 * Ohio Secretary of State — live election-night results adapter (FIPS 39).
 *
 * Endpoint (web-verified 2026-04-24 by inspecting liveresults.ohiosos.gov's
 * bundled JS — the `downloadReport()` function in /bundles/all opens
 * `Api/v1/download?filename=VSSC1622XmlFileBlob` in a new tab):
 *
 *   https://liveresults.ohiosos.gov/Api/v1/download?filename=VSSC1622XmlFileBlob
 *
 * The feed is published during election-night canvassing and refreshed every
 * ~3 minutes. Off-cycle it still serves the most-recent election's data
 * (e.g. on 2026-04-24 it returns a mock-election dataset prepared for the
 * May 5, 2026 primary).
 *
 * Why this adapter has its own parser
 * -----------------------------------
 * The shared `nist-xml-parser.ts` implements the FINAL NIST 1500-100 v2
 * specification. Ohio, however, self-identifies as `VendorApplicationId=
 * "Ohio-ENR 1.0.02"` and emits the 2015 **draft** precursor (1622/D1). The
 * two dialects differ in several structural ways that matter:
 *
 *   1. Top-level children are `<GpUnitCollection>`, `<PartyCollection>`,
 *      `<PersonCollection>`, `<OfficeCollection>`, `<CandidateCollection>`,
 *      `<ContestCollection>` wrappers — final-v2 puts these flat.
 *   2. There is no `<Election>` wrapper — Contests live directly inside
 *      `<ContestCollection>`.
 *   3. `<BallotSelection xsi:type="CandidateSelection">` is used instead of
 *      `<ContestSelection xsi:type="CandidateSelection">`.
 *   4. Candidate references inside a selection are `<CandidateId>` child
 *      elements (one per id) rather than a single `<CandidateIds>` element
 *      with whitespace-separated ids.
 *   5. Every name field (`Party/Name`, `Candidate/BallotName`, `GpUnit/Name`,
 *      etc.) is wrapped in `<LanguageString Language="en">...</LanguageString>`.
 *   6. Vote counts are inside `<VoteCountsCollection>` and each `<VoteCounts>`
 *      is tagged with a `<GpUnitId>` pointing to a county/precinct/state unit.
 *      The FIRST row is always the statewide rollup; the rest are county and
 *      precinct aggregations. Consumers MUST filter by `Type="State"`
 *      GpUnit to avoid double-counting.
 *   7. Party affiliation lives on `Person` (via `PartyId`) AND on
 *      `Candidate` (via `PartyId`). We prefer the Candidate's — it reflects
 *      the ballot-listed party for this specific race.
 *   8. Root attributes carry election status: `Status="UnofficialPartial"`,
 *      `IsTest="true"`, `GeneratedDate="<ISO8601>"`. We surface these in
 *      the data_sources meta for provenance.
 *
 * Rather than extend the shared parser with every Ohio-specific fallback
 * (which risks breaking OH when the shared parser evolves to chase future
 * states' quirks), this adapter owns its XML-shape handling. The shared
 * parser remains the canonical reference implementation for the final
 * NIST 1500-100 v2 spec; when a state adopts that spec they use it as-is.
 *
 * Rate limiting: 0.5 rps burst 2. Election-night we'll bump this up to
 * support every-3-minute polling (0.01 rps).
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';

import {
  createStateSosAdapter,
  type StateResultRow,
  type StateReportingLevel,
} from '../base';
import type { AdapterContext, SourceAdapter } from '../../types';
import { POLITE_USER_AGENT } from '../../fetch-polite';

export type OhLiveReportingLevel = StateReportingLevel;

const STATE_FIPS = '39';
const SOURCE_URL =
  'https://liveresults.ohiosos.gov/Api/v1/download?filename=VSSC1622XmlFileBlob';

// Plain fetch with the shared honest User-Agent. If the host answers
// with a 403 the adapter fails with the HTTP status and does not retry.
const USER_AGENT = POLITE_USER_AGENT;

export type CreateOhLiveResultsAdapterOptions = {
  reportingLevel?: OhLiveReportingLevel;
  /** Override for tests; defaults to the real public endpoint. */
  sourceUrl?: string;
  /** If true, rows for `IsWriteIn="true"` selections are included. Default true. */
  includeWriteIns?: boolean;
};

/**
 * Factory — returns a SourceAdapter that plugs into runAdapter() from
 * ../../run.ts. Safe to call with no arguments; all options have sensible
 * defaults for real election-night use.
 */
export function createOhLiveResultsAdapter(
  options: CreateOhLiveResultsAdapterOptions = {},
): SourceAdapter<StateResultRow> {
  const reportingLevel: OhLiveReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  const url = options.sourceUrl ?? SOURCE_URL;
  const includeWriteIns = options.includeWriteIns ?? true;

  const adapter = createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'ohio-sos-liveresults-xml',
    sourceUrl: url,
    sourceType: 'sos_results_api',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    // 15 US House districts + 7 statewide rows is a safe floor. On primary
    // day the number will be much higher (state leg + local) but we don't
    // want a light off-cycle hit to partial-flag a healthy run.
    expectedMinRows: 15,
    fetch: async () => {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/xml,text/xml,*/*',
        },
      });
      if (!res.ok) {
        throw new Error(
          `OH live fetch failed: HTTP ${res.status} from ${url}`,
        );
      }
      const rawBody = await res.text();
      return {
        rawBody,
        // res.url is '' in Node fetch mocks; only surface a real value.
        resolvedUrl: res.url && res.url.length > 0 ? res.url : undefined,
        meta: {
          http_status: res.status,
          last_modified: res.headers.get('last-modified') ?? null,
          etag: res.headers.get('etag') ?? null,
          // Root-level election attributes get populated during parse.
        },
      };
    },
    parse: async (rawBody, ctx) =>
      parseOhNistXml(rawBody, { reportingLevel, includeWriteIns }, ctx),
  });

  adapter.costService = 'other';
  return adapter;
}

// ---------------------------------------------------------------------------
// Ohio-specific XML parsing (1622/D1 draft)
// ---------------------------------------------------------------------------

type OhParseOptions = {
  reportingLevel: OhLiveReportingLevel;
  includeWriteIns: boolean;
};

/**
 * Entry point. Returns [] on non-XML or empty bodies (the runner will flag
 * the run `partial` since expectedMinRows > 0). Throws on malformed XML so
 * the runner can record `failed`.
 */
export function parseOhNistXml(
  rawBody: string,
  opts: OhParseOptions,
  ctx?: AdapterContext,
): StateResultRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];

  const trimmed = rawBody.trimStart();
  // Tolerate BOM / leading whitespace. Reject HTML (Cloudflare challenge
  // wall, off-cycle landing pages, 403 error page).
  if (!trimmed.startsWith('<?xml') && !trimmed.startsWith('<ElectionReport')) {
    ctx?.logger.info(
      'oh-live-results: non-XML body (HTML wall or off-cycle landing)',
      { byteSize: rawBody.length },
    );
    return [];
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    removeNSPrefix: true,
    isArray: (name) => OH_ARRAY_NAMES.has(name),
  });

  // fast-xml-parser's parse() is lenient by default and will happily accept
  // a truncated document. Run the structural validator first so that
  // genuinely malformed bodies fail loudly — the adapter runner catches
  // this and records ingestion_runs.status='failed'.
  const validation = XMLValidator.validate(rawBody, {
    allowBooleanAttributes: true,
  });
  if (validation !== true) {
    const err = validation.err;
    throw new Error(
      `parseOhNistXml: XML parse failed: ${err.msg} (line ${err.line}, col ${err.col})`,
    );
  }

  let doc: OhDoc;
  try {
    doc = parser.parse(rawBody) as OhDoc;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`parseOhNistXml: XML parse failed: ${msg}`);
  }

  const report = doc.ElectionReport;
  if (!report) return [];

  // ---- Index: GpUnits (find the statewide unit) ----
  const gpUnits = asArray(report.GpUnitCollection?.GpUnit);
  const gpUnitById: Record<string, OhGpUnit> = {};
  let stateGpUnitId: string | null = null;
  for (const g of gpUnits) {
    const id = g['@ObjectId'];
    if (!id) continue;
    gpUnitById[id] = g;
    if ((g['@Type'] ?? '').toString().toLowerCase() === 'state') {
      stateGpUnitId = id;
    }
  }
  if (!stateGpUnitId) {
    // No statewide aggregation available — the feed is probably partial
    // scaffolding. Record nothing rather than emit per-county rows which
    // would break our (election_id, reported_name, party_abbreviation)
    // uniqueness.
    ctx?.logger.warn(
      'oh-live-results: no Type="State" GpUnit found; returning []',
    );
    return [];
  }

  // ---- Index: Parties ----
  const parties = asArray(report.PartyCollection?.Party);
  const partyById: Record<string, OhParty> = {};
  for (const p of parties) {
    const id = p['@ObjectId'];
    if (id) partyById[id] = p;
  }

  // ---- Index: Persons (for fallback PartyId lookup) ----
  const persons = asArray(report.PersonCollection?.Person);
  const personById: Record<string, OhPerson> = {};
  for (const p of persons) {
    const id = p['@ObjectId'];
    if (id) personById[id] = p;
  }

  // ---- Index: Candidates + collect Contests ----
  // OH wraps CandidateCollection + ContestCollection inside <Election>.
  // The shared-NIST final-v2 spec puts them flat under <ElectionReport>.
  // Handle both — walk Elections first and merge, then fall back to
  // top-level collections (synthetic fixtures, future spec-strict
  // producers).
  const elections = asArray(report.Election);
  const candidateById: Record<string, OhCandidate> = {};
  const contests: OhContest[] = [];
  for (const election of elections) {
    for (const c of asArray(election.CandidateCollection?.Candidate)) {
      const id = c['@ObjectId'];
      if (id) candidateById[id] = c;
    }
    for (const k of asArray(election.ContestCollection?.Contest)) {
      contests.push(k);
    }
  }
  // Fall back to top-level if the producer didn't wrap in Election.
  for (const c of asArray(report.CandidateCollection?.Candidate)) {
    const id = c['@ObjectId'];
    if (id && !candidateById[id]) candidateById[id] = c;
  }
  for (const k of asArray(report.ContestCollection?.Contest)) {
    contests.push(k);
  }

  // ---- Walk contests ----
  const rows: StateResultRow[] = [];

  for (const contest of contests) {
    // Only CandidateContest. Skip BallotMeasure + any retention/party flavors.
    const xsiType = (contest['@type'] ?? contest['@xsi:type'] ?? '').toString();
    if (xsiType && !xsiType.includes('CandidateContest')) continue;

    const officeName = (contest['@Name'] ?? '').toString().trim();
    if (!officeName) continue;

    // GpUnit Name can live on @Name (real OH XML) or in a LanguageString
    // wrapper (spec-strict producers). Try both.
    const districtGp = gpUnitById[textOf(contest.ElectoralDistrictId) ?? ''];
    const districtName =
      (districtGp?.['@Name'] ?? '').toString().trim() ||
      textOfName(districtGp?.Name) ||
      null;
    const districtIdentifier = extractDistrictIdentifier(
      officeName,
      districtName,
    );

    const selections = asArray(contest.BallotSelection);

    for (const sel of selections) {
      const selType = (sel['@type'] ?? sel['@xsi:type'] ?? '').toString();
      if (selType && !selType.includes('CandidateSelection')) continue;

      const candIds = asArray(sel.CandidateId).map((v) =>
        textOf(v) ?? '',
      ).filter((s) => s.length > 0);
      if (candIds.length === 0) continue;

      const primaryCand = candidateById[candIds[0]];
      if (!primaryCand) continue;

      const isWriteIn = truthy(
        (primaryCand['@IsWriteIn'] ?? sel['@IsWriteIn']) as string | undefined,
      );
      if (isWriteIn && !opts.includeWriteIns) continue;

      // Resolve name. BallotName is usually wrapped in LanguageString.
      const reportedName = textOfName(primaryCand.BallotName);
      if (!reportedName) continue;

      // Resolve party: candidate → person fallback. The PartyCollection
      // row's Abbreviation attribute is preferred; fall back to the
      // LanguageString Name if Abbreviation is absent.
      const partyIdRef =
        textOf(primaryCand.PartyId) ??
        (primaryCand.PersonId
          ? textOf(personById[textOf(primaryCand.PersonId) ?? '']?.PartyId)
          : null) ??
        null;
      const partyRow = partyIdRef ? partyById[partyIdRef] : undefined;
      const partyAbbr =
        (partyRow?.['@Abbreviation'] ?? '').toString().trim() ||
        textOfName(partyRow?.Name) ||
        null;

      // Statewide total vote count: pick the VoteCounts entry whose
      // GpUnitId matches the state GpUnit. If the feed hasn't populated
      // that row yet, fall back to 0 (explicit) rather than null.
      const voteCount = extractStatewideVoteCount(
        sel.VoteCountsCollection,
        stateGpUnitId,
      );

      const selectionObjectId = (sel['@ObjectId'] ?? '').toString();
      const contestObjectId = (contest['@ObjectId'] ?? '').toString();

      rows.push({
        reported_name: reportedName,
        party_abbreviation: partyAbbr,
        office_name: officeName,
        district_identifier: districtIdentifier,
        vote_count: voteCount,
        vote_percentage: null,
        pct_precincts_reporting: null,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: isWriteIn,
        reporting_level: opts.reportingLevel,
        source_row_id: `${contestObjectId || officeName}::${selectionObjectId || reportedName}`,
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// Element names that may repeat — coerce to arrays even when only one
// occurrence appears in the document. BallotSelection and VoteCounts are
// the hot path.
const OH_ARRAY_NAMES = new Set<string>([
  'Election',
  'GpUnit',
  'Party',
  'Person',
  'Candidate',
  'Contest',
  'BallotSelection',
  'VoteCounts',
  'CandidateId',
  'Code',
  'SummaryCounts',
  'Office',
]);

type OhDoc = {
  ElectionReport?: {
    '@GeneratedDate'?: string;
    '@Status'?: string;
    '@IsTest'?: string;
    GpUnitCollection?: { GpUnit?: OhGpUnit | OhGpUnit[] };
    PartyCollection?: { Party?: OhParty | OhParty[] };
    PersonCollection?: { Person?: OhPerson | OhPerson[] };
    /**
     * In OH-ENR 1.0.02 Candidate/Contest collections live under Election;
     * spec-strict producers (and our synthetic test fixture) put them flat
     * under ElectionReport. Both shapes are merged in parseOhNistXml.
     */
    Election?: OhElection | OhElection[];
    CandidateCollection?: { Candidate?: OhCandidate | OhCandidate[] };
    ContestCollection?: { Contest?: OhContest | OhContest[] };
  };
};

type OhElection = {
  '@Date'?: string;
  '@Type'?: string;
  CandidateCollection?: { Candidate?: OhCandidate | OhCandidate[] };
  ContestCollection?: { Contest?: OhContest | OhContest[] };
};

type OhGpUnit = {
  '@ObjectId'?: string;
  '@Name'?: string;
  '@Type'?: string;
  Name?: unknown;
};

type OhParty = {
  '@ObjectId'?: string;
  '@Abbreviation'?: string;
  Name?: unknown;
};

type OhPerson = {
  '@ObjectId'?: string;
  PartyId?: unknown;
  FirstName?: unknown;
  LastName?: unknown;
};

type OhCandidate = {
  '@ObjectId'?: string;
  '@IsWriteIn'?: string;
  BallotName?: unknown;
  PartyId?: unknown;
  PersonId?: unknown;
};

type OhContest = {
  '@ObjectId'?: string;
  '@type'?: string;
  '@xsi:type'?: string;
  '@Name'?: string;
  ElectoralDistrictId?: unknown;
  BallotSelection?: OhBallotSelection | OhBallotSelection[];
};

type OhBallotSelection = {
  '@ObjectId'?: string;
  '@type'?: string;
  '@xsi:type'?: string;
  '@IsWriteIn'?: string;
  CandidateId?: unknown | unknown[];
  VoteCountsCollection?: {
    VoteCounts?: OhVoteCounts | OhVoteCounts[];
  };
};

type OhVoteCounts = {
  '@Type'?: string;
  '@Count'?: string;
  GpUnitId?: unknown;
};

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Resolve a possibly-nested text value. Handles:
 *   - primitive strings / numbers
 *   - fast-xml-parser `{ "#text": "..." }` wrappings
 *   - `LanguageString` wrappers (OH wraps every Name in one).
 */
function textOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const anyV = v as Record<string, unknown>;
    if (typeof anyV['#text'] === 'string') {
      const s = (anyV['#text'] as string).trim();
      if (s) return s;
    }
    // LanguageString can be a single obj or an array of them.
    if (anyV.LanguageString) {
      return textOfLanguageString(anyV.LanguageString);
    }
  }
  return null;
}

/**
 * Extract text from an `<Foo><LanguageString Language="en">Text</LanguageString></Foo>`
 * style wrapper. Prefers en; falls back to the first entry.
 */
function textOfName(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    const anyV = v as Record<string, unknown>;
    if (anyV.LanguageString) return textOfLanguageString(anyV.LanguageString);
    if (typeof anyV['#text'] === 'string') {
      return (anyV['#text'] as string).trim() || null;
    }
  }
  return null;
}

function textOfLanguageString(v: unknown): string | null {
  const arr = Array.isArray(v) ? v : [v];
  for (const entry of arr) {
    if (typeof entry === 'string') {
      const t = entry.trim();
      if (t) return t;
      continue;
    }
    if (entry && typeof entry === 'object') {
      const anyE = entry as Record<string, unknown>;
      const lang = (anyE['@Language'] ?? '').toString().toLowerCase();
      const text = typeof anyE['#text'] === 'string'
        ? (anyE['#text'] as string).trim()
        : '';
      if (text && (lang === 'en' || lang === '')) return text;
    }
  }
  // Fall back to any non-empty value.
  for (const entry of arr) {
    if (entry && typeof entry === 'object') {
      const anyE = entry as Record<string, unknown>;
      const text = typeof anyE['#text'] === 'string'
        ? (anyE['#text'] as string).trim()
        : '';
      if (text) return text;
    }
  }
  return null;
}

function truthy(v: string | undefined | null): boolean {
  if (!v) return false;
  return ['true', 'yes', '1'].includes(v.toLowerCase());
}

function toIntOrZero(s: string | null | undefined): number {
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Among the VoteCounts children, find the one whose GpUnitId equals the
 * statewide GpUnit. If none matches (e.g. feed hasn't populated the
 * aggregation row yet), return the first `Type="Total"` entry or null.
 */
function extractStatewideVoteCount(
  coll:
    | { VoteCounts?: OhVoteCounts | OhVoteCounts[] }
    | undefined,
  stateGpUnitId: string,
): number | null {
  const entries = asArray(coll?.VoteCounts);
  if (entries.length === 0) return null;
  for (const vc of entries) {
    const gpId = textOf(vc.GpUnitId);
    const type = (vc['@Type'] ?? '').toString().toLowerCase();
    if (gpId === stateGpUnitId && (type === 'total' || type === '')) {
      return toIntOrZero(vc['@Count']);
    }
  }
  // Fallback: first Total-type row if statewide aggregation is missing.
  for (const vc of entries) {
    const type = (vc['@Type'] ?? '').toString().toLowerCase();
    if (type === 'total') return toIntOrZero(vc['@Count']);
  }
  return null;
}

/**
 * Best-effort district number extraction. Tries the GpUnit Name first
 * ("Congressional District 7" -> "7") then the contest name
 * ("U.S. House District 3" -> "3"). Returns null if no integer is found.
 * Mirrors the helper in nist-xml-parser.ts so OH and NIST-native states
 * stay structurally consistent.
 */
function extractDistrictIdentifier(
  contestName: string,
  districtName: string | null,
): string | null {
  const haystacks = [districtName, contestName].filter(
    (x): x is string => !!x && x.length > 0,
  );
  for (const h of haystacks) {
    const anchored = h.match(/\bdist(?:rict)?\.?\s+(\d+)/i);
    if (anchored) return anchored[1];
    const trailing = h.match(/(\d+)(?:st|nd|rd|th)?\s*$/i);
    if (trailing) return trailing[1];
  }
  return null;
}
