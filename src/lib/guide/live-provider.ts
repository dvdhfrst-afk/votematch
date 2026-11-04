/**
 * Live guide provider — the real, DB-backed implementation of GuideProvider.
 *
 * Wiring: served when NEXT_PUBLIC_GUIDE_PROVIDER=live (see ./provider.ts). The
 * /guide/* routes never import this directly; they only touch the provider
 * surface, so this module is free to talk to Supabase and the office-graph.
 *
 * WHAT IT DELEGATES TO (reuse, never reinvent — REDESIGN-MAP A1):
 *   - Ballot resolution  : loadBallotForSession() in lib/ballot-lookup/ballot-loader,
 *       the SAME address→precinct→BallotRace[] pipeline `/ballot` uses (identical
 *       v_voter_* reads, legacy↔graph bridge, dedup, nearest-upcoming collapse,
 *       BALLOT_CACHE_VERSION). The guide and /ballot therefore always agree on
 *       which races a voter has.
 *   - Two-view selection : selectPositionsForView() in lib/matching/algorithm —
 *       honors the user's stated/inferred/both preference + the source-tier and
 *       empty-citation guards, exactly as /api/match does.
 *   - Scope gating       : scope_applicability via lib/taxonomy/scope + the
 *       display-gate's renderable-position rule (lib/candidate/display-gate).
 *   - Weights            : deriveWeights() in lib/matching/weights — the same
 *       normalized domain-weight vector /api/match derives.
 *   - Score math         : buildMatchBreakdown() in lib/guide/scoring — the
 *       weighted-L1 (Manhattan) re-expression that IS the contract adapter for
 *       the DB matcher. Distance = Σ w·|Δ| / Σ w; score = 100·(1−distance),
 *       byte-compatible with weightedL1Score's formula. Using one builder keeps
 *       the headline and every drill-down depth mathematically consistent.
 *   - Session            : getSessionUser() in lib/session.
 *   - Display formatting : formatCandidateName + sanitizeDisplayName (applied
 *       inside the ballot loader) carry through.
 *
 * HONEST DEGRADATION (DEFINITION-OF-WORKING criterion 1):
 *   - No stated position for an issue → the IssueDiff carries a null
 *     candidateScore; buildMatchBreakdown never imputes.
 *   - A candidate with no renderable positions → coverageTier 'C', empty
 *     stances, and buildMatchBreakdown emits the low-coverage caveat + a
 *     0-of-N counted breakdown the guide renders as its designed empty state.
 *   - Overlap below MIN_OVERLAP_FOR_SCORE → we force confidence to 'no_data'
 *     and add an insufficient-overlap caveat, so the small number is never
 *     presented as trustworthy. The contract's overallScore is non-nullable,
 *     so this is the contract-level expression of "not a number".
 *   - No voter profile (quick-match not done) → getVoterProfile returns null
 *     and matches fall back to a zero-weight/zero-stance profile that yields
 *     the "answer some questions" empty states, never fabricated scores.
 */

import 'server-only';
import { unstable_cache } from 'next/cache';
import type {
  BallotPlan,
  Candidate,
  CandidateStance,
  Issue,
  IssueRelevance,
  MatchBreakdown,
  MatchCaveat,
  OfficeLevel,
  Race,
  Source,
  Stance,
  VoterProfile,
} from './contract';
import { buildMatchBreakdown } from './scoring';
import type { GuideProvider } from './provider';
import { createServiceClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/session';
import {
  loadBallotForSession,
  type BallotRace,
  type BallotCandidate,
} from '@/lib/ballot-lookup/ballot-loader';
import { deriveWeights } from '@/lib/matching/weights';
import { selectPositionsForView } from '@/lib/matching/algorithm';
import { MIN_OVERLAP_FOR_SCORE } from '@/lib/matching/algorithm';
import { isRenderablePosition } from '@/lib/candidate/display-gate';
import { raceLevelToScope, applicabilityAt } from '@/lib/taxonomy/scope';
import type {
  MatchView,
  Position,
  RaceLevel,
  ScopeApplicabilityMode,
  SubDimension,
  User,
} from '@/types/database';

// ---------------------------------------------------------------------------
// Level mapping: office-graph RaceLevel → guide OfficeLevel
// ---------------------------------------------------------------------------
// The office graph stores 'school'/'special'; the guide contract uses the
// scope-style 'school_board'/'special_district' (matching scope_applicability
// keys). Everything else is 1:1.

function toOfficeLevel(level: RaceLevel): OfficeLevel {
  if (level === 'school') return 'school_board';
  if (level === 'special') return 'special_district';
  return level as OfficeLevel;
}

// ---------------------------------------------------------------------------
// Scope resolution → guide IssueRelevance
// ---------------------------------------------------------------------------
// scope_applicability speaks 'matching' | 'informational' | 'not_applicable';
// the guide contract speaks 'counts' | 'context_only' | 'not_applicable'.

function toRelevance(mode: ScopeApplicabilityMode): IssueRelevance {
  if (mode === 'matching') return 'counts';
  if (mode === 'informational') return 'context_only';
  return 'not_applicable';
}

/**
 * Build the guide's per-issue scope map for a given office level from the live
 * sub_dimensions' scope_applicability, keyed by sub_dimension id (== guide
 * Issue id). Absent keys default to not_applicable (the strict opt-in default,
 * per lib/taxonomy/scope), so an issue only counts where the taxonomy says so.
 */
function scopeMapForLevel(
  subDims: SubDimension[],
  officeLevel: OfficeLevel,
): Record<string, IssueRelevance> {
  const scope = raceLevelToScope(officeLevelToRaceLevel(officeLevel));
  const map: Record<string, IssueRelevance> = {};
  for (const sd of subDims) {
    map[sd.id] = toRelevance(applicabilityAt(sd, scope));
  }
  return map;
}

/** Inverse of toOfficeLevel, for feeding raceLevelToScope. */
function officeLevelToRaceLevel(level: OfficeLevel): RaceLevel {
  if (level === 'school_board') return 'school';
  if (level === 'special_district') return 'special';
  return level as RaceLevel;
}

// ---------------------------------------------------------------------------
// sub_dimensions → guide Issue[]
// ---------------------------------------------------------------------------

function subDimsToIssues(subDims: SubDimension[]): Issue[] {
  return subDims.map((sd) => ({
    id: sd.id,
    name: sd.name,
    domain: sd.domain,
    spectrum: { low: sd.spectrum_low, high: sd.spectrum_high },
  }));
}

// ---------------------------------------------------------------------------
// DB Position → guide Source[] + CandidateStance
// ---------------------------------------------------------------------------
// A position's source_citations become guide Sources. The citation tier
// ('primary' | 'reported' | 'paraphrase') is derived from the position's
// view_type/source_tier so the drill-down's "Based on N sources" and the
// stated/inferred visual treatment are honest.

function citationTier(pos: Position): Source['tier'] {
  // Stated positions from the candidate's own words = primary.
  if (pos.view_type === 'stated') return 'primary';
  // Inferred positions built from reporting / the public record = reported
  // (the guide's DomainIssueList already softens language + adds the dashed
  // inferred treatment off `candidateConfidence`, so this is just the source
  // provenance label).
  return 'reported';
}

function positionSources(pos: Position): Source[] {
  const cites = pos.source_citations ?? [];
  const tier = citationTier(pos);
  return cites
    // Drop empty-URL placeholder citations (the swarm-era pattern the matcher
    // also filters). A citation with neither url nor title carries no signal.
    .filter((c) => !!c.url || !!c.title)
    .map<Source>((c) => ({
      url: c.url ?? '',
      title: c.title ?? c.url ?? 'Source',
      date: c.date ?? undefined,
      tier,
    }));
}

/**
 * Normalize a DB Confidence to the guide's Confidence union. The DB has extra
 * values ('candidate_direct', 'insufficient_overlap') the guide contract does
 * not; map them to their nearest guide meaning.
 */
function toGuideConfidence(c: string): Stance['confidence'] {
  switch (c) {
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    case 'candidate_direct':
      // The candidate's own affirmed words — highest authenticity. Present it
      // as high confidence (stated) in the guide, which has no 'candidate_direct'.
      return 'high';
    default:
      // 'no_data' / 'insufficient_overlap' / anything unrecognized → no_data.
      return 'no_data';
  }
}

/**
 * Turn a candidate's raw DB positions into guide CandidateStances, honoring the
 * voter's match_view (stated/inferred/both) via selectPositionsForView — the
 * SAME selection /api/match uses — then filtering to renderable positions
 * (display-gate rule: self-stated OR high/medium confidence). One stance per
 * sub_dimension.
 */
function positionsToStances(
  candidateId: string,
  rawPositions: Position[],
  matchView: MatchView,
): { stances: CandidateStance[]; renderableCount: number; hasAnyPosition: boolean } {
  // Two-view selection produces one PositionVector (sub_dimension_id, score,
  // confidence) per sub_dim. We need the underlying Position rows for the
  // summary + sources, so we bucket the raw rows by sub_dim to pair them up.
  const { positions: selected } = selectPositionsForView(rawPositions, matchView);

  // Map sub_dim → the best raw position for the selected view, so we can pull
  // summary + citations. Prefer the row whose view matches, most recent wins.
  const rawByDim = new Map<string, Position>();
  for (const p of rawPositions) {
    const cur = rawByDim.get(p.sub_dimension_id);
    if (!cur) {
      rawByDim.set(p.sub_dimension_id, p);
      continue;
    }
    // Prefer stated over inferred when the user asked for stated/both; prefer
    // the newer row otherwise. This only affects which summary/citations show,
    // not the selected score (that came from selectPositionsForView).
    const preferNew = p.created_at > cur.created_at;
    if (preferNew) rawByDim.set(p.sub_dimension_id, p);
  }

  const stances: CandidateStance[] = [];
  let renderableCount = 0;
  for (const vec of selected) {
    const raw = rawByDim.get(vec.sub_dimension_id);
    const confidence = toGuideConfidence(vec.confidence ?? raw?.confidence ?? 'no_data');
    // Apply the display gate: only surface positions the trust pipeline earned
    // (self-stated OR high/medium confidence). Sub-threshold rows are omitted
    // — they degrade to the "no stated position" honest empty state per issue,
    // never a fabricated low-confidence guess presented as a stance.
    const gate = {
      view_type: raw?.view_type ?? 'inferred',
      confidence: raw?.confidence ?? 'no_data',
    };
    if (!isRenderablePosition(gate)) continue;
    renderableCount += 1;

    stances.push({
      candidateId,
      issueId: vec.sub_dimension_id,
      score: vec.score,
      confidence,
      summary: raw?.ai_summary ?? null,
      sources: raw ? positionSources(raw) : [],
      reasoning: raw?.nuance_notes ?? undefined,
    });
  }

  return { stances, renderableCount, hasAnyPosition: rawPositions.length > 0 };
}

// ---------------------------------------------------------------------------
// Coverage tier
// ---------------------------------------------------------------------------
// The ballot loader already computed a strict "well-documented" flag per
// candidate (≥10 hi/med positions AND ≥5 sources AND ≥2 source types). Reuse it
// as the A/B/C tier signal:
//   - wellDocumented              → A
//   - has ≥1 renderable position  → B
//   - otherwise                   → C (the low-coverage / gathering state)

function coverageTier(
  cand: BallotCandidate,
  renderableCount: number,
): Candidate['coverageTier'] {
  if (cand.wellDocumented) return 'A';
  if (renderableCount > 0) return 'B';
  return 'C';
}

// ---------------------------------------------------------------------------
// Assembled guide data (cached per session)
// ---------------------------------------------------------------------------

interface GuideData {
  races: Race[];
  issues: Issue[];
  scopeByLevel: Partial<Record<OfficeLevel, Record<string, IssueRelevance>>>;
  voter: VoterProfile | null;
  subDims: SubDimension[];
}

/**
 * Fetch every raw position for a set of position-lookup ids (legacy candidate
 * ids) and person ids, keyed both ways — mirrors /api/match's dual read path so
 * new-graph candidacies whose positions are person-native are not missed.
 */
async function fetchPositions(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  candidateLookupIds: string[],
  personIds: string[],
): Promise<{
  byCandidateId: Map<string, Position[]>;
  byPersonId: Map<string, Position[]>;
}> {
  const byCandidateId = new Map<string, Position[]>();
  const byPersonId = new Map<string, Position[]>();

  if (candidateLookupIds.length > 0) {
    const { data } = await supabase
      .from('positions')
      .select('*')
      .in('candidate_id', [...new Set(candidateLookupIds)]);
    for (const p of (data ?? []) as Array<Position & { candidate_id: string }>) {
      const arr = byCandidateId.get(p.candidate_id) ?? [];
      arr.push(p);
      byCandidateId.set(p.candidate_id, arr);
    }
  }

  if (personIds.length > 0) {
    const { data } = await supabase
      .from('positions')
      .select('*')
      .in('person_id', [...new Set(personIds)]);
    for (const p of (data ?? []) as Array<Position & { person_id: string }>) {
      const arr = byPersonId.get(p.person_id) ?? [];
      arr.push(p);
      byPersonId.set(p.person_id, arr);
    }
  }

  return { byCandidateId, byPersonId };
}

/**
 * Merge the two position read paths for one candidate, deduped by position id
 * (a legacy row carrying both candidate_id and person_id is reachable from both
 * maps and must not double-count). Same merge /api/match performs.
 */
function mergePositions(
  cand: BallotCandidate,
  byCandidateId: Map<string, Position[]>,
  byPersonId: Map<string, Position[]>,
): Position[] {
  const lookup = cand.positionLookupId ?? cand.id;
  const candPositions = byCandidateId.get(lookup) ?? [];
  const personPositions = cand.personId ? byPersonId.get(cand.personId) ?? [] : [];
  const seen = new Set<string>();
  const out: Position[] = [];
  for (const p of [...candPositions, ...personPositions]) {
    if (p.id && seen.has(p.id)) continue;
    if (p.id) seen.add(p.id);
    out.push(p);
  }
  return out;
}

/**
 * Build the voter's guide VoterProfile from the session user's stored
 * quick_match_answers. Returns null when the user hasn't completed quick-match
 * (no domains) — the honest "profile not built yet" state. domainWeights use
 * the SAME deriveWeights vector /api/match derives so the guide's emphasis
 * matches the results page exactly.
 */
function buildVoterProfile(user: User | null): VoterProfile | null {
  const qma = user?.quick_match_answers;
  if (!qma || !Array.isArray(qma.domains) || qma.domains.length === 0) {
    return null;
  }
  const domainWeights = deriveWeights(qma);
  const stances: Stance[] = (qma.positions ?? []).map((p) => ({
    issueId: p.sub_dimension_id,
    score: p.score,
    confidence: 'high',
    summary: null,
    sources: [],
  }));
  return {
    id: user?.id ?? 'voter',
    stances,
    domainWeights,
    source: 'manual',
    updatedAt: user?.first_match_completed_at ?? new Date().toISOString(),
  };
}

/**
 * The dynamic, session-derived inputs the cached assembler needs. Resolved
 * OUTSIDE the cache (via getSessionUser → cookies()) and passed in, because
 * Next 16 forbids reading cookies() inside unstable_cache. Everything the
 * assembler does with these is deterministic given this snapshot, so caching on
 * the session token is sound.
 */
interface SessionSnapshot {
  user: User | null;
  matchView: MatchView;
}

/**
 * Assemble the full guide dataset for the current session: the resolved ballot
 * (adapted to contract Races with candidate stances), the issue taxonomy, the
 * per-level scope maps, and the voter profile.
 *
 * Cached per (session-token) for 300s so the 3+ provider calls a single page
 * render makes (listRaces + getVoterProfile + listMatchesForRace × N) share one
 * DB round-trip. The session user is passed IN (resolved outside the cache) so
 * this function never touches cookies() — required inside unstable_cache.
 */
async function assembleGuideDataUncached(
  snapshot: SessionSnapshot,
): Promise<GuideData> {
  const { user, matchView } = snapshot;

  const supabase = await createServiceClient();

  // 1. Resolve the ballot exactly as /ballot does for this session.
  const loaded = await loadBallotForSession(user);
  const ballotRaces: BallotRace[] = loaded?.races ?? [];

  // 2. Load the issue taxonomy once.
  const { data: subDimData } = await supabase.from('sub_dimensions').select('*');
  const subDims = (subDimData ?? []) as SubDimension[];
  const issues = subDimsToIssues(subDims);

  // 3. Fetch positions for every candidate across the ballot in two round-trips.
  const candidateLookupIds: string[] = [];
  const personIds: string[] = [];
  for (const r of ballotRaces) {
    for (const c of r.candidates) {
      candidateLookupIds.push(c.positionLookupId ?? c.id);
      if (c.personId) personIds.push(c.personId);
    }
  }
  const { byCandidateId, byPersonId } = await fetchPositions(
    supabase,
    candidateLookupIds,
    personIds,
  );

  // 4. Adapt each ballot race → contract Race with candidate stances.
  const scopeByLevel: Partial<Record<OfficeLevel, Record<string, IssueRelevance>>> = {};
  const races: Race[] = ballotRaces.map((br) => {
    const officeLevel = toOfficeLevel(br.level);
    if (!scopeByLevel[officeLevel]) {
      scopeByLevel[officeLevel] = scopeMapForLevel(subDims, officeLevel);
    }

    const candidates: Candidate[] = br.candidates.map((bc) => {
      const raw = mergePositions(bc, byCandidateId, byPersonId);
      const { stances, renderableCount } = positionsToStances(bc.id, raw, matchView);
      return {
        id: bc.id,
        name: bc.name,
        party: bc.party,
        photoUrl: bc.photo_url ?? null,
        bio: bc.bio ?? null,
        websiteUrl: bc.website_url ?? null,
        coverageTier: coverageTier(bc, renderableCount),
        stances,
      };
    });

    return {
      id: br.id,
      name: br.name,
      officeLevel,
      district: br.district ?? null,
      electionDate: br.election_date,
      candidates,
    };
  });

  const voter = buildVoterProfile(user);

  return { races, issues, scopeByLevel, voter, subDims };
}

/**
 * Cache wrapper. Keyed on the session token + a coarse day bucket so the
 * assembled ballot refreshes at least daily even without an explicit
 * invalidation (the underlying ballot loader has its own 600s tag-based cache;
 * this outer cache just coalesces the several provider calls of a single
 * render). Falls back to an uncached read when there is no session.
 */
async function assembleGuideData(): Promise<GuideData> {
  // Resolve the session OUTSIDE any cache scope — getSessionUser reads
  // cookies(), which Next 16 forbids inside unstable_cache. We pass the
  // resolved user into the cached assembler as a plain argument.
  const user = await getSessionUser();
  const matchView: MatchView =
    user?.quick_match_answers?.match_view ?? user?.match_view ?? 'inferred';
  const token = user?.session_token ?? null;

  if (!token) {
    // No session → no per-voter cache key. Serve an uncached (empty-profile)
    // dataset. The ballot loader still resolves from any address on the user,
    // but with no session there is neither address nor precinct, so races=[].
    return assembleGuideDataUncached({ user, matchView });
  }

  // Cache key = session token. The user snapshot is passed as data, not as part
  // of the key, but the token uniquely identifies the user, and the inner reads
  // (ballot, positions) are deterministic given it. The ballot loader has its
  // own tag-based invalidation; this outer 300s cache just coalesces the
  // several provider calls of a single render.
  const cached = unstable_cache(
    async (_t: string, snap: SessionSnapshot) => assembleGuideDataUncached(snap),
    ['guide-data-v1', token],
    { revalidate: 300, tags: ['guide', `guide:${token}`] },
  );
  return cached(token, { user, matchView });
}

// ---------------------------------------------------------------------------
// Match breakdown builder (contract-level)
// ---------------------------------------------------------------------------
// buildMatchBreakdown does the weighted-L1 math + the full byDomain/byIssue
// drill-down. We wrap it to (a) supply a zero-profile when the voter hasn't
// answered, and (b) enforce the MIN_OVERLAP_FOR_SCORE honest-degrade: below the
// floor we force confidence to no_data and add an insufficient-overlap caveat
// so the small number is never presented as trustworthy.

function emptyVoterProfile(profileId: string): VoterProfile {
  return {
    id: profileId,
    stances: [],
    domainWeights: {},
    source: 'manual',
    updatedAt: new Date().toISOString(),
  };
}

function breakdownFor(
  data: GuideData,
  race: Race,
  candidate: Candidate,
): MatchBreakdown {
  const voter = data.voter ?? emptyVoterProfile('voter');
  const scopeMap = data.scopeByLevel[race.officeLevel] ?? {};
  const breakdown = buildMatchBreakdown({
    voter,
    candidate,
    race,
    issues: data.issues,
    scopeMap,
    raceCandidates: race.candidates,
  });

  // Honest-degrade: insufficient overlap → not a trustworthy number. The
  // contract's overallScore is non-nullable, so we express this via confidence
  // + a caveat rather than a null. Mirrors MIN_OVERLAP_FOR_SCORE in the DB
  // matcher (council #29): a 1-4 dim coincidence must not read as a real match.
  if (breakdown.countedIssuesCount < MIN_OVERLAP_FOR_SCORE) {
    const notes: MatchCaveat[] = [
      {
        type: 'low_candidate_coverage',
        message:
          breakdown.countedIssuesCount === 0
            ? 'Not enough overlapping positions to score this candidate yet. Answer more questions or check back as we gather positions.'
            : `Only ${breakdown.countedIssuesCount} issue${breakdown.countedIssuesCount === 1 ? '' : 's'} overlap so far — too few to score reliably. Treat this as indicative, not a real match.`,
      },
      ...breakdown.notes.filter((n) => n.type !== 'low_candidate_coverage'),
    ];
    return { ...breakdown, confidence: 'no_data', notes };
  }

  return breakdown;
}

// ---------------------------------------------------------------------------
// Provider surface
// ---------------------------------------------------------------------------

export const liveProvider: GuideProvider = {
  async listRaces(): Promise<Race[]> {
    const data = await assembleGuideData();
    return data.races;
  },

  async getRace(raceId: string): Promise<Race | null> {
    const data = await assembleGuideData();
    return data.races.find((r) => r.id === raceId) ?? null;
  },

  async getCandidate(candidateId: string): Promise<Candidate | null> {
    const data = await assembleGuideData();
    for (const race of data.races) {
      const hit = race.candidates.find((c) => c.id === candidateId);
      if (hit) return hit;
    }
    return null;
  },

  async getVoterProfile(): Promise<VoterProfile | null> {
    const data = await assembleGuideData();
    return data.voter;
  },

  async getMatch(raceId: string, candidateId: string): Promise<MatchBreakdown | null> {
    const data = await assembleGuideData();
    const race = data.races.find((r) => r.id === raceId);
    if (!race) return null;
    const candidate = race.candidates.find((c) => c.id === candidateId);
    if (!candidate) return null;
    return breakdownFor(data, race, candidate);
  },

  async listMatchesForRace(raceId: string): Promise<MatchBreakdown[]> {
    const data = await assembleGuideData();
    const race = data.races.find((r) => r.id === raceId);
    if (!race) return [];
    const breakdowns = race.candidates.map((c) => breakdownFor(data, race, c));
    // Sort by score descending. Candidates flagged insufficient (confidence
    // no_data) sink to the bottom — they carry no comparable signal — matching
    // the DB matcher's null-score-sorts-last behavior.
    breakdowns.sort((a, b) => {
      const aInsufficient = a.confidence === 'no_data';
      const bInsufficient = b.confidence === 'no_data';
      if (aInsufficient !== bInsufficient) return aInsufficient ? 1 : -1;
      return b.overallScore - a.overallScore;
    });
    return breakdowns;
  },

  async getBallotPlan(): Promise<BallotPlan> {
    const data = await assembleGuideData();
    const picks = await Promise.all(
      data.races.map(async (race) => {
        const matches = await this.listMatchesForRace(race.id);
        // The top scorable match. A race whose only candidates are
        // insufficient-overlap (confidence no_data) surfaces as an undecided
        // pick (candidateId null) — the designed "decide at the booth" state,
        // never a fabricated recommendation.
        const top = matches.find((m) => m.confidence !== 'no_data') ?? null;
        const candidateName = top
          ? race.candidates.find((c) => c.id === top.candidateId)?.name ?? null
          : null;
        return {
          raceId: race.id,
          raceName: race.name,
          candidateId: top?.candidateId ?? null,
          candidateName,
          matchScore: top?.overallScore ?? null,
        };
      }),
    );
    return {
      profileId: data.voter?.id ?? 'voter',
      generatedAt: new Date().toISOString(),
      picks,
    };
  },
};
