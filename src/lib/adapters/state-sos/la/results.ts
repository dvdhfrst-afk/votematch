/**
 * Louisiana Secretary of State — election results adapter (FIPS 22).
 *
 * Primary feed (per state-sos-sources.ts, verified 2026-04-23):
 *   https://www.sos.la.gov/ElectionsAndVoting/Pages/default.aspx
 * Actual data URLs are rendered by the voterportal SPA at
 *   https://voterportal.sos.la.gov/ — per-election JSON is available only
 * when a specific election_code is known. We fetch the landing HTML by
 * default; a caller that knows a specific JSON URL can import the
 * `parseLouisianaResults` helper directly.
 *
 * Louisiana runs a JUNGLE PRIMARY ("Cajun primary"): all candidates
 * regardless of party appear on one ballot. If one candidate takes >50%
 * they win outright; otherwise top-2 (regardless of party) advance to a
 * general/runoff on a separate date.
 *
 * Row-model consequences (enforced by `applyJungleOutcome`):
 *   - `is_winner` ONLY when vote_percentage > 50 (never force-set from
 *     a source-provided flag at <= 50%).
 *   - `is_runoff_advancer` true for the top-2 within a contest otherwise.
 *   - At the runoff/general stage: standard plurality — leader wins.
 */

import { load as loadHtml } from 'cheerio';
import { politeFetch } from '../../fetch-polite';
import {
  createStateSosAdapter,
  type StateResultRow,
  type StateReportingLevel,
} from '../base';

const SOURCE_URL =
  'https://www.sos.la.gov/ElectionsAndVoting/Pages/default.aspx';
const STATE_FIPS = '22';
export type ReportingLevel = StateReportingLevel;

export function createLaResultsAdapter(
  options: { reportingLevel?: ReportingLevel; isRunoffStage?: boolean } = {},
) {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  const isRunoffStage = options.isRunoffStage ?? false;
  return createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'louisiana-sos-results',
    sourceType: 'sos_results_api',
    sourceUrl: SOURCE_URL,
    license: 'state_open_records',
    expectedMinRows: 0,
    tokenBucket: { rps: 0.5, burst: 2 },
    fetch: async () => {
      const res = await politeFetch(SOURCE_URL, {
        headers: {
          Accept: 'application/json,text/html,*/*',
        },
      });
      if (!res.ok) throw new Error(`LA fetch failed: ${res.status}`);
      return { rawBody: await res.text() };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return parseLouisianaResults(rawBody, {
          reportingLevel,
          isRunoffStage,
        });
      }
      // HTML landing — just surface any linked results URLs.
      const links = discoverLouisianaResultLinks(rawBody);
      if (links.length > 0) {
        ctx.logger.info(
          'la-results: HTML landing — tabulation link(s) discovered but not auto-followed',
          { stateFips: STATE_FIPS, count: links.length, sample: links[0] },
        );
      } else {
        ctx.logger.info('la-results: HTML landing, no tabulation links', {
          stateFips: STATE_FIPS,
        });
      }
      return [];
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

export function discoverLouisianaResultLinks(html: string): string[] {
  const $ = loadHtml(html);
  const out: string[] = [];
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href) return;
    if (/voterportal\.sos\.la\.gov/i.test(href) || /\.(json|txt)(?:[?#]|$)/i.test(href)) {
      out.push(href);
    }
  });
  return out;
}

// Wire shape — ES&S / vendor voterportal JSON export.
type LaCandidate = {
  name?: unknown;
  candidateName?: unknown;
  ballotName?: unknown;
  party?: unknown;
  partyCode?: unknown;
  votes?: unknown;
  voteCount?: unknown;
  pct?: unknown;
  percentage?: unknown;
  isWinner?: unknown;
  isWriteIn?: unknown;
};

type LaRace = {
  raceName?: unknown;
  office?: unknown;
  officeName?: unknown;
  district?: unknown;
  districtNumber?: unknown;
  pctReporting?: unknown;
  precinctsReporting?: unknown;
  totalPrecincts?: unknown;
  candidates?: unknown;
  contests?: unknown;
};

type LaDoc = {
  races?: unknown;
  contests?: unknown;
  election?: unknown;
};

function asStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}
function asNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,%\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const s = asStr(v);
  if (!s) return false;
  const low = s.toLowerCase();
  return low === '1' || low === 'true' || low === 'yes' || low === 'y';
}

function extractRaces(obj: LaDoc): LaRace[] {
  if (Array.isArray(obj.races)) return obj.races as LaRace[];
  if (Array.isArray(obj.contests)) return obj.contests as LaRace[];
  const env = obj.election as { races?: unknown } | undefined;
  if (env && typeof env === 'object' && Array.isArray(env.races))
    return env.races.filter((r): r is LaRace => typeof r === 'object' && r !== null);
  return [];
}
function extractCandidates(race: LaRace): LaCandidate[] {
  if (Array.isArray(race.candidates)) return race.candidates as LaCandidate[];
  if (Array.isArray(race.contests)) return race.contests as LaCandidate[];
  return [];
}

/**
 * Jungle-primary outcome flagger. Operates on already-grouped contests
 * by (office, district). See module doc for rules.
 */
export function applyJungleOutcome(
  rows: StateResultRow[],
  isRunoffStage: boolean,
): void {
  const groups = new Map<string, StateResultRow[]>();
  for (const r of rows) {
    const key = `${r.office_name}::${r.district_identifier ?? ''}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  for (const group of groups.values()) {
    for (const r of group) {
      r.is_winner = false;
      r.is_runoff_advancer = false;
    }
    const ranked = [...group].sort((a, b) => {
      const av = a.vote_count ?? -1;
      const bv = b.vote_count ?? -1;
      if (bv !== av) return bv - av;
      return a.reported_name.localeCompare(b.reported_name);
    });
    const leader = ranked[0];
    if (!leader) continue;
    const leaderPct = leader.vote_percentage;

    if (isRunoffStage) {
      leader.is_winner = true;
      continue;
    }
    if (leaderPct !== null && leaderPct > 50) {
      leader.is_winner = true;
      continue;
    }
    const second = ranked[1];
    if (!second) {
      // Only one contestant on the jungle primary — they advance by default.
      leader.is_runoff_advancer = true;
      continue;
    }
    const secondVotes = second.vote_count ?? -1;
    for (const r of ranked) {
      const v = r.vote_count ?? -1;
      if (r === leader) r.is_runoff_advancer = true;
      else if (v >= secondVotes && v >= 0) r.is_runoff_advancer = true;
    }
  }
}

export function parseLouisianaResults(
  body: string,
  opts: { reportingLevel?: ReportingLevel; isRunoffStage?: boolean } = {},
): StateResultRow[] {
  const reportingLevel = opts.reportingLevel ?? 'unofficial_partial';
  const isRunoffStage = opts.isRunoffStage ?? false;
  if (!body || body.trim().length === 0) return [];

  let doc: LaDoc;
  try {
    doc = JSON.parse(body) as LaDoc;
  } catch {
    return [];
  }
  const races = extractRaces(doc);
  const rows: StateResultRow[] = [];

  for (const race of races) {
    const officeName =
      asStr(race.raceName) ??
      asStr(race.office) ??
      asStr(race.officeName);
    if (!officeName) continue;
    const district = asStr(race.district) ?? asStr(race.districtNumber);

    const pr = asNum(race.precinctsReporting);
    const tp = asNum(race.totalPrecincts);
    const pctReporting =
      asNum(race.pctReporting) ??
      (pr !== null && tp !== null && tp > 0
        ? Math.round((pr / tp) * 1000) / 10
        : null);

    for (const cand of extractCandidates(race)) {
      const name =
        asStr(cand.name) ??
        asStr(cand.candidateName) ??
        asStr(cand.ballotName);
      if (!name) continue;
      const voteCount = asNum(cand.votes) ?? asNum(cand.voteCount);
      let pct = asNum(cand.pct) ?? asNum(cand.percentage);
      if (pct !== null && pct > 0 && pct <= 1) pct *= 100;

      rows.push({
        reported_name: name,
        party_abbreviation: asStr(cand.party) ?? asStr(cand.partyCode),
        office_name: officeName,
        district_identifier: district,
        vote_count: voteCount,
        vote_percentage: pct,
        pct_precincts_reporting: pctReporting,
        is_winner: false,
        is_runoff_advancer: false,
        is_write_in: asBool(cand.isWriteIn) || /write[-\s]?in/i.test(name),
        reporting_level: reportingLevel,
        source_row_id: `la::${officeName}::${district ?? ''}::${name}`,
      });
    }
  }

  applyJungleOutcome(rows, isRunoffStage);
  return rows;
}
