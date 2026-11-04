/**
 * NIST Election Results Common Data Format (1500-100 v2) parser.
 *
 * Spec: https://pages.nist.gov/ElectionResultsReporting/
 *
 * Used by Ohio's SoS results feed; the format is also available (as an
 * export option) from several other states as of 2026. When any state
 * adopts the spec this parser becomes their feed adapter with no new code.
 *
 * Structure we consume (simplified):
 *   ElectionReport
 *     Election
 *       Contest                    (CandidateContest)
 *         Name                    # office as reported
 *         ElectoralDistrictId     # references a GpUnit
 *         ContestSelection         (CandidateSelection; one per candidate)
 *           CandidateIds           # one or more candidate @ObjectId refs
 *           VoteCounts
 *             Count                # int
 *             Type                 # "total" | "early" | "absentee" | ...
 *             OtherType            # for "other" Type values
 *         VotesAllowed
 *       Candidate                  (flat list under Election, referenced by id)
 *         BallotName               # candidate display name
 *         PartyId                  # refs Party
 *         IsIncumbent
 *         IsWriteIn
 *     Party                         (flat list under ElectionReport)
 *       Abbreviation
 *       Name
 *     GpUnit                        (flat list under ElectionReport)
 *       Name
 *       Type                        # "state" | "county" | "precinct" | "congressional" ...
 *
 * NIST uses @ObjectId as the primary key on reference-able elements and
 * references them via ElectoralDistrictId, CandidateIds, PartyId. We
 * build three lookup maps (candidate, party, gpunit) up front and then
 * walk contests.
 *
 * Edge cases handled:
 *   - Contests can appear as CandidateContest (what we care about) or
 *     BallotMeasureContest (we ignore for now — results go in a different
 *     table).
 *   - A CandidateSelection can list multiple CandidateIds (joint tickets
 *     like Pres/VP). We emit one row per selection using the first
 *     candidate's BallotName + the combined party.
 *   - VoteCounts can contain multiple sub-counts (early + absentee +
 *     election-day); we sum the "total" type OR sum all if no explicit
 *     total.
 *   - Percent reporting appears either as `Contest/PctReporting` or as
 *     `Election/PctReporting`; some feeds omit it entirely.
 */

import { XMLParser } from 'fast-xml-parser';
import type { StateResultRow, StateReportingLevel } from './base';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type NistParseOptions = {
  /**
   * 'unofficial_partial' | 'unofficial_complete' | 'state_certified'.
   * SoS feeds often don't self-describe this — caller provides based on
   * the URL / certification status.
   */
  reportingLevel?: StateReportingLevel;
  /**
   * Include write-in "selection" rows. Default true — downstream consumers
   * can filter.
   */
  includeWriteIns?: boolean;
  /**
   * If true, throw on malformed XML. Default true — base adapter catches
   * and logs. Pass false when you want a best-effort partial parse.
   */
  strict?: boolean;
};

/**
 * Parse a NIST 1500-100 XML document. Returns an empty array when the
 * document has no CandidateContests (e.g., the XML is a BallotMeasure-only
 * file). Throws on fundamentally malformed XML.
 */
export function parseNistXml(
  xmlBody: string,
  opts: NistParseOptions = {},
): StateResultRow[] {
  const reportingLevel = opts.reportingLevel ?? 'unofficial_partial';
  const includeWriteIns = opts.includeWriteIns ?? true;
  const strict = opts.strict ?? true;

  if (typeof xmlBody !== 'string' || xmlBody.length < 32) {
    if (strict) throw new Error('parseNistXml: empty or too-short body');
    return [];
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    // NIST uses qualified element names like "ElectionReport" without
    // namespace prefixes in the official schema but some vendors add
    // them (ns0:, oh:). Strip to the local name for resilience.
    removeNSPrefix: true,
    // We want multi-occurrence elements coerced to arrays for safety.
    isArray: (name: string) => NIST_ARRAY_NAMES.has(name),
  });

  let obj: NistDoc;
  try {
    obj = parser.parse(xmlBody) as NistDoc;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`parseNistXml: XML parse failed: ${msg}`);
  }

  const report = obj.ElectionReport;
  if (!report) {
    if (strict) throw new Error('parseNistXml: no <ElectionReport> root found');
    return [];
  }

  const elections = asArray(report.Election);
  if (elections.length === 0) {
    if (strict) throw new Error('parseNistXml: no <Election> children');
    return [];
  }

  // Build top-level lookups (Party, GpUnit). Candidates live under
  // Election/Candidate so we build those per-election.
  const partyById = indexBy(asArray(report.Party));
  const gpUnitById = indexBy(asArray(report.GpUnit));

  const rows: StateResultRow[] = [];

  for (const election of elections) {
    const candidateById = indexBy(asArray(election.Candidate));
    const contests = asArray(election.Contest);

    for (const contest of contests) {
      // Only CandidateContest — BallotMeasureContest lives in a different
      // table. xsi:type may be stripped by namespace removal above, fall
      // back to element shape (has CandidateSelection).
      const xsiType = (contest['@type'] ?? contest['@xsi:type'] ?? '').toString();
      const isCandidateContest =
        xsiType.includes('CandidateContest') ||
        (!!contest.ContestSelection && !!asArray(contest.ContestSelection).length);
      if (!isCandidateContest) continue;

      const officeName = textOf(contest.Name) ?? '';
      if (!officeName) continue;

      const districtName = gpUnitById[textOf(contest.ElectoralDistrictId) ?? '']?.Name
        ? textOf(gpUnitById[textOf(contest.ElectoralDistrictId) ?? ''].Name)
        : null;
      const districtIdentifier = extractDistrictIdentifier(
        officeName,
        districtName,
      );

      const pctReporting = toNumOrNull(
        textOf(contest.PctReporting) ??
          textOf(contest.VoteCountsPctReporting) ??
          textOf(election.PctReporting),
      );

      const selections = asArray(contest.ContestSelection);
      for (const sel of selections) {
        // CandidateSelection only.
        const selType = (sel['@type'] ?? sel['@xsi:type'] ?? '').toString();
        const isCandidateSelection =
          selType.includes('CandidateSelection') ||
          !!sel.CandidateIds;
        if (!isCandidateSelection) continue;

        // CandidateIds is space-separated or a single id string.
        const candIds = parseIdList(textOf(sel.CandidateIds));
        if (candIds.length === 0) continue;

        const primaryCand = candidateById[candIds[0]];
        if (!primaryCand) continue;

        const isWriteIn =
          truthy(textOf(primaryCand.IsWriteIn)) || truthy(textOf(sel.IsWriteIn));
        if (isWriteIn && !includeWriteIns) continue;

        // Party: prefer the candidate's PartyId; fall back to the
        // selection's EndorsementPartyIds[0] if present (fusion).
        const partyIdRef =
          textOf(primaryCand.PartyId) ??
          textOf(sel.EndorsementPartyIds) ??
          null;
        const partyRow = partyIdRef ? partyById[partyIdRef] : undefined;
        const partyAbbr =
          textOf(partyRow?.Abbreviation) ??
          textOf(partyRow?.Name) ??
          null;

        const voteCount = sumVoteCounts(sel.VoteCounts);
        const reportedName =
          textOf(primaryCand.BallotName) ??
          textOf(primaryCand.Name) ??
          '';

        if (!reportedName) continue;

        const selectionObjectId = (sel['@ObjectId'] ?? '').toString();
        const contestObjectId = (contest['@ObjectId'] ?? '').toString();

        rows.push({
          reported_name: reportedName,
          party_abbreviation: partyAbbr,
          office_name: officeName,
          district_identifier: districtIdentifier,
          vote_count: voteCount,
          vote_percentage: null,
          pct_precincts_reporting: pctReporting,
          is_winner: truthy(textOf(sel.IsWinner)),
          is_runoff_advancer: false,
          is_write_in: isWriteIn,
          reporting_level: reportingLevel,
          source_row_id: `${contestObjectId || officeName}::${selectionObjectId || reportedName}`,
        });
      }
    }
  }

  return rows;
}

/**
 * Strict wrapper used by adapters that want parse failures to bubble up.
 * Identical semantics as parseNistXml({ strict: true }) but reads nicer in
 * code.
 */
export function parseNistXmlOrThrow(
  xmlBody: string,
  opts: Omit<NistParseOptions, 'strict'> = {},
): StateResultRow[] {
  return parseNistXml(xmlBody, { ...opts, strict: true });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// Elements that may repeat; coerce to arrays even when only one appears.
// Note: CandidateIds / OfficeIds / EndorsementPartyIds are deliberately
// NOT coerced — NIST encodes them as a single element with space-separated
// IDs inside. `parseIdList()` splits the text.
const NIST_ARRAY_NAMES = new Set<string>([
  'Election',
  'Contest',
  'ContestSelection',
  'Candidate',
  'Party',
  'GpUnit',
  'VoteCounts',
  'OtherCounts',
]);

type NistDoc = {
  ElectionReport?: {
    Election?: NistElection | NistElection[];
    Party?: NistParty | NistParty[];
    GpUnit?: NistGpUnit | NistGpUnit[];
  };
};

type NistElection = {
  Candidate?: NistCandidate | NistCandidate[];
  Contest?: NistContest | NistContest[];
  PctReporting?: unknown;
};

type NistCandidate = {
  '@ObjectId'?: string;
  BallotName?: unknown;
  Name?: unknown;
  PartyId?: unknown;
  IsIncumbent?: unknown;
  IsWriteIn?: unknown;
};

type NistParty = {
  '@ObjectId'?: string;
  Abbreviation?: unknown;
  Name?: unknown;
};

type NistGpUnit = {
  '@ObjectId'?: string;
  Name?: unknown;
  Type?: unknown;
};

type NistContest = {
  '@ObjectId'?: string;
  '@type'?: string;
  '@xsi:type'?: string;
  Name?: unknown;
  ElectoralDistrictId?: unknown;
  PctReporting?: unknown;
  VoteCountsPctReporting?: unknown;
  ContestSelection?: NistSelection | NistSelection[];
};

type NistSelection = {
  '@ObjectId'?: string;
  '@type'?: string;
  '@xsi:type'?: string;
  CandidateIds?: unknown;
  EndorsementPartyIds?: unknown;
  IsWinner?: unknown;
  IsWriteIn?: unknown;
  VoteCounts?: NistVoteCounts | NistVoteCounts[];
};

type NistVoteCounts = {
  Count?: unknown;
  Type?: unknown;
  OtherType?: unknown;
};

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Some XML producers wrap text in { "#text": "…" }.
  if (typeof v === 'object') {
    const anyV = v as Record<string, unknown>;
    if (typeof anyV['#text'] === 'string') return (anyV['#text'] as string).trim() || null;
  }
  return null;
}

function toNumOrNull(s: string | null): number | null {
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function truthy(s: string | null): boolean {
  if (s === null) return false;
  return ['true', 'yes', '1'].includes(s.toLowerCase());
}

function indexBy<T extends { '@ObjectId'?: string }>(arr: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of arr) {
    const id = item['@ObjectId'];
    if (id) out[id] = item;
  }
  return out;
}

function parseIdList(s: string | null): string[] {
  if (!s) return [];
  return s.split(/\s+/).filter((x) => x.length > 0);
}

/**
 * Sum vote totals across VoteCounts children. Strategy:
 *   - If any entry has Type='total', prefer those exclusively.
 *   - Otherwise sum all entries (early + absentee + election-day + ...).
 */
function sumVoteCounts(
  vc: NistVoteCounts | NistVoteCounts[] | undefined,
): number | null {
  const arr = asArray(vc);
  if (arr.length === 0) return null;

  const totals = arr.filter((x) => {
    const t = textOf(x.Type)?.toLowerCase();
    return t === 'total' || t === 'totalvotes';
  });
  const source = totals.length > 0 ? totals : arr;

  let sum = 0;
  let any = false;
  for (const entry of source) {
    const n = toNumOrNull(textOf(entry.Count));
    if (n !== null) {
      sum += n;
      any = true;
    }
  }
  return any ? sum : null;
}

/**
 * Best-effort district number extraction. Tries the GpUnit Name first
 * ("Congressional District 1" -> "1") then falls back to the contest name
 * ("U.S. House District 3" -> "3"). Returns null if no integer is found.
 */
function extractDistrictIdentifier(
  contestName: string,
  districtName: string | null,
): string | null {
  const haystacks = [districtName, contestName].filter(
    (x): x is string => !!x,
  );
  for (const h of haystacks) {
    // Prefer "District N" / "DIST N" anchored match first.
    const anchored = h.match(/\bdist(?:rict)?\.?\s+(\d+)/i);
    if (anchored) return anchored[1];
    const trailing = h.match(/(\d+)(?:st|nd|rd|th)?\s*$/i);
    if (trailing) return trailing[1];
  }
  return null;
}
