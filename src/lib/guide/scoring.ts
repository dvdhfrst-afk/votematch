/**
 * Match scoring, reimplemented against the UX contract.
 *
 * This is a thin, readable re-expression of the same weighted-L1 math used
 * by `src/lib/matching/algorithm.ts` — decoupled from the DB shape so the
 * UX can iterate while the real matcher evolves. When the DB-facing matcher
 * stabilises, we can replace this with an adapter that invokes the canonical
 * algorithm and returns a MatchBreakdown.
 *
 * Math (weighted L1 / Manhattan):
 *   distance = Σ w_i · |voter_i − cand_i|  /  Σ w_i
 *   score    = round(100 · (1 − distance))
 *
 * Every step of that computation is preserved in `byIssue` so the UI can
 * show "this domain pulled your score down by 4 points" honestly, not as
 * marketing language.
 */

import type {
  Candidate,
  CandidateStance,
  DomainBreakdown,
  Issue,
  IssueDiff,
  IssueRelevance,
  MatchBreakdown,
  MatchCaveat,
  Race,
  Source,
  Stance,
  VoterProfile,
} from './contract';

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Look up relevance for one issue at one office level. Default = not_applicable
 * to match the strict-opt-in convention from `src/lib/taxonomy/scope.ts` —
 * spurious matches erode trust more than missed matches.
 */
export function resolveRelevance(
  issueId: string,
  officeLevel: Race['officeLevel'],
  scopeMap: Partial<Record<string, IssueRelevance>>,
): IssueRelevance {
  return scopeMap[issueId] ?? 'not_applicable';
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

/**
 * Spread each domain's weight evenly across its member issues, so a
 * big-tent domain doesn't get implicit extra pull just for having more
 * sub-issues. Mirrors resolveSubDimensionWeights in the live matcher.
 */
function resolveIssueWeights(
  domainWeights: Record<string, number>,
  issues: Issue[],
): Map<string, number> {
  const byDomain = new Map<string, Issue[]>();
  for (const iss of issues) {
    const bucket = byDomain.get(iss.domain) ?? [];
    bucket.push(iss);
    byDomain.set(iss.domain, bucket);
  }
  const out = new Map<string, number>();
  for (const [domain, members] of byDomain) {
    const w = domainWeights[domain] ?? 0;
    const perIssue = members.length > 0 ? w / members.length : 0;
    for (const iss of members) out.set(iss.id, perIssue);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-issue diff
// ---------------------------------------------------------------------------

function buildIssueDiff(
  issue: Issue,
  voterStance: Stance | undefined,
  candidateStance: CandidateStance | undefined,
  relevance: IssueRelevance,
): IssueDiff {
  const voterScore = voterStance?.score ?? null;
  const candidateScore = candidateStance?.score ?? null;
  const delta =
    voterScore !== null && candidateScore !== null
      ? Math.abs(voterScore - candidateScore)
      : null;

  // A diff only counts toward the overall score when:
  //   (1) the issue counts at this office
  //   (2) both voter and candidate have a real position
  //   (3) candidate confidence isn't 'no_data' — we refuse to score noise
  const candidateConfidence = candidateStance?.confidence ?? 'no_data';
  const includedInScore =
    relevance === 'counts' &&
    voterScore !== null &&
    candidateScore !== null &&
    candidateConfidence !== 'no_data';

  const sources: Source[] = candidateStance?.sources ?? [];

  return {
    issueId: issue.id,
    issueName: issue.name,
    domain: issue.domain,
    voterScore,
    candidateScore,
    delta,
    relevance,
    includedInScore,
    candidateConfidence,
    spectrum: issue.spectrum,
    candidateSummary: candidateStance?.summary ?? null,
    candidateSources: sources,
    candidateReasoning: candidateStance?.reasoning,
  };
}

// ---------------------------------------------------------------------------
// Domain breakdown
// ---------------------------------------------------------------------------

function buildDomainBreakdowns(
  diffs: IssueDiff[],
  domainWeights: Record<string, number>,
): DomainBreakdown[] {
  const byDomain = new Map<
    string,
    { counted: IssueDiff[]; total: number }
  >();

  for (const d of diffs) {
    const bucket = byDomain.get(d.domain) ?? { counted: [], total: 0 };
    bucket.total += 1;
    if (d.includedInScore && d.delta !== null) bucket.counted.push(d);
    byDomain.set(d.domain, bucket);
  }

  const out: DomainBreakdown[] = [];
  for (const [domain, { counted, total }] of byDomain) {
    // Alignment within this domain = 100 · (1 − avg_delta). Per-issue
    // weight is uniform inside a domain (the domain weight handles
    // cross-domain emphasis already).
    let alignment = 0;
    if (counted.length > 0) {
      const avgDelta =
        counted.reduce((sum, d) => sum + (d.delta ?? 0), 0) / counted.length;
      alignment = Math.round(100 * (1 - avgDelta));
      alignment = Math.max(0, Math.min(100, alignment));
    }

    // Contribution = how much this domain's alignment pushed the overall
    // score above/below a neutral 50. Weighted by the voter's domain
    // priority so the UI can honestly say "this is what actually moved
    // the number".
    const w = domainWeights[domain] ?? 0;
    const contribution =
      counted.length > 0 ? Math.round((alignment - 50) * w) : 0;

    out.push({
      domain,
      alignment,
      contribution,
      weight: w,
      countedIssues: counted.length,
      totalIssues: total,
    });
  }

  // Largest absolute contribution first — makes the UI useful at a glance.
  out.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return out;
}

// ---------------------------------------------------------------------------
// Overall score
// ---------------------------------------------------------------------------

function computeOverallScore(
  diffs: IssueDiff[],
  issueWeights: Map<string, number>,
): number {
  let weightedAbsSum = 0;
  let totalWeight = 0;

  for (const d of diffs) {
    if (!d.includedInScore || d.delta === null) continue;
    const w = issueWeights.get(d.issueId) ?? 0;
    if (w === 0) continue;
    weightedAbsSum += w * d.delta;
    totalWeight += w;
  }

  if (totalWeight === 0) return 0;
  const score = Math.round((1 - weightedAbsSum / totalWeight) * 100);
  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// Confidence — coverage on voter's priority domains
// ---------------------------------------------------------------------------

function computeConfidence(
  diffs: IssueDiff[],
  domainWeights: Record<string, number>,
): MatchBreakdown['confidence'] {
  // Domains the voter weighted ≥ 0.6 are "priority"; we want candidate
  // coverage there.
  const priorityDomains = new Set(
    Object.entries(domainWeights)
      .filter(([, w]) => w >= 0.6)
      .map(([d]) => d),
  );
  if (priorityDomains.size === 0) return 'medium';

  const priorityDiffs = diffs.filter(
    (d) => priorityDomains.has(d.domain) && d.relevance === 'counts',
  );
  if (priorityDiffs.length === 0) return 'low';

  const covered = priorityDiffs.filter((d) => d.includedInScore).length;
  const ratio = covered / priorityDiffs.length;
  if (ratio >= 0.75) return 'high';
  if (ratio >= 0.4) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Caveats
// ---------------------------------------------------------------------------

function buildCaveats(
  candidate: Candidate,
  diffs: IssueDiff[],
  excludedByOfficeCount: number,
  contextCount: number,
  voter: VoterProfile,
): MatchCaveat[] {
  const notes: MatchCaveat[] = [];

  if (candidate.coverageTier === 'C') {
    notes.push({
      type: 'low_candidate_coverage',
      message:
        'We have limited public sources for this candidate — the match is indicative, not conclusive.',
    });
  }

  if (excludedByOfficeCount > 0) {
    notes.push({
      type: 'office_scope_limited',
      message: `${excludedByOfficeCount} issue${excludedByOfficeCount === 1 ? '' : 's'} excluded because this office can't affect them.`,
    });
  }

  if (contextCount > 0) {
    notes.push({
      type: 'context_excluded',
      message: `${contextCount} issue${contextCount === 1 ? '' : 's'} shown for context but not counted.`,
    });
  }

  const voterAnswered = voter.stances.filter((s) => s.score !== null).length;
  const totalVoter = voter.stances.length;
  if (voterAnswered / Math.max(1, totalVoter) < 0.5) {
    notes.push({
      type: 'profile_incomplete',
      message:
        'Your profile covers fewer than half of the tracked issues — answering more will sharpen the match.',
    });
  }

  return notes;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ScoringInputs {
  voter: VoterProfile;
  candidate: Candidate;
  race: Race;
  issues: Issue[];
  /** Per-office relevance map keyed by issue id */
  scopeMap: Partial<Record<string, IssueRelevance>>;
  /** Candidates in this race, for tied-with detection */
  raceCandidates: Candidate[];
}

export function buildMatchBreakdown(input: ScoringInputs): MatchBreakdown {
  const { voter, candidate, race, issues, scopeMap, raceCandidates } = input;

  const voterById = new Map(voter.stances.map((s) => [s.issueId, s]));
  const candidateById = new Map(candidate.stances.map((s) => [s.issueId, s]));

  // Only issues where relevance != 'not_applicable' are in scope for
  // display. Issues marked 'not_applicable' drop out entirely.
  const visibleIssues = issues.filter(
    (iss) => resolveRelevance(iss.id, race.officeLevel, scopeMap) !== 'not_applicable',
  );

  const diffs: IssueDiff[] = visibleIssues.map((iss) => {
    const relevance = resolveRelevance(iss.id, race.officeLevel, scopeMap);
    return buildIssueDiff(iss, voterById.get(iss.id), candidateById.get(iss.id), relevance);
  });

  const issueWeights = resolveIssueWeights(voter.domainWeights, visibleIssues);
  const overallScore = computeOverallScore(diffs, issueWeights);
  const byDomain = buildDomainBreakdowns(diffs, voter.domainWeights);
  const confidence = computeConfidence(diffs, voter.domainWeights);

  const countedIssuesCount = diffs.filter((d) => d.includedInScore).length;
  const totalCountableIssuesCount = diffs.filter((d) => d.relevance === 'counts').length;
  const contextIssuesCount = diffs.filter((d) => d.relevance === 'context_only').length;
  const excludedByOfficeCount = issues.length - visibleIssues.length;

  // Tied-with: re-score every candidate in the race, find anyone within 5pts.
  // This is O(n·m) but n ≤ ~6 per race; the cost is invisible.
  const allScores = raceCandidates.map((c) => ({
    id: c.id,
    name: c.name,
    score: c.id === candidate.id ? overallScore : scoreCandidateOnly({ ...input, candidate: c }),
  }));
  const topScore = Math.max(...allScores.map((s) => s.score));
  const tiedWith = allScores
    .filter(
      (s) =>
        s.id !== candidate.id &&
        Math.abs(s.score - topScore) <= 5 &&
        Math.abs(overallScore - topScore) <= 5,
    )
    .map((s) => s.name);

  const notes = buildCaveats(
    candidate,
    diffs,
    excludedByOfficeCount,
    contextIssuesCount,
    voter,
  );

  return {
    raceId: race.id,
    candidateId: candidate.id,
    overallScore,
    countedIssuesCount,
    totalCountableIssuesCount,
    contextIssuesCount,
    excludedByOfficeCount,
    confidence,
    tiedWith,
    byDomain,
    byIssue: diffs,
    notes,
  };
}

/**
 * Score-only variant used by buildMatchBreakdown for tied-with detection,
 * so we don't recurse into the full breakdown build for every other
 * candidate in the race.
 */
function scoreCandidateOnly(input: ScoringInputs): number {
  const { voter, candidate, race, issues, scopeMap } = input;
  const voterById = new Map(voter.stances.map((s) => [s.issueId, s]));
  const candidateById = new Map(candidate.stances.map((s) => [s.issueId, s]));

  const visibleIssues = issues.filter(
    (iss) => resolveRelevance(iss.id, race.officeLevel, scopeMap) !== 'not_applicable',
  );

  const diffs: IssueDiff[] = visibleIssues.map((iss) => {
    const relevance = resolveRelevance(iss.id, race.officeLevel, scopeMap);
    return buildIssueDiff(iss, voterById.get(iss.id), candidateById.get(iss.id), relevance);
  });

  const issueWeights = resolveIssueWeights(voter.domainWeights, visibleIssues);
  return computeOverallScore(diffs, issueWeights);
}
