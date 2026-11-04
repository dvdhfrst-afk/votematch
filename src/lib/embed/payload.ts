/**
 * payload.ts - assembles the PUBLIC data payload the Utah embeddable widget
 * renders and scores against on-device.
 *
 * WHAT IT RETURNS (and what it does NOT)
 * ----------------------------------------------------------------------------
 * Public civic + candidate data only: the ballot's races, each candidate's
 * GATE-VISIBLE positions (with source receipts), the office-scoped issue set the
 * voter swipes through, and a lean PositionsBundle for the SAME on-device matcher
 * the main app uses. It NEVER contains voter opinions; the widget never sends an
 * opinion back to build it. The only voter-linked input is the address the voter
 * typed, used exactly as /ballot uses it (resolve which races are on the ballot),
 * and it is never persisted here (loadBallotForAddress only reads).
 *
 * THE GATE
 * ----------------------------------------------------------------------------
 * Every candidate position is filtered through isEmbedVisiblePosition (keyed to
 * the entailment gate's mode). Under ENTAILMENT_GATE=shadow that is stated words
 * + officeholder voting record only; a candidate with none shows an abstain card.
 * The SAME filtered set drives BOTH the receipts we show AND the bundle the
 * device scores against, so every position that moves a match score has a visible
 * receipt. Flip the gate to enforce and the inferred (entailment-passed) band
 * widens both automatically. See lib/embed/display-policy.ts.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import 'server-only';
import { createServiceClient } from '@/lib/supabase/server';
import { loadBallotForAddress } from '@/lib/ballot-lookup/ballot-loader';
import type { BallotCandidate, BallotRace } from '@/lib/ballot-lookup/ballot-loader';
import { raceLevelToScope, applicabilityAt, appliesInRegion } from '@/lib/taxonomy/scope';
import { respectOfficeDimsEnabled } from '@/lib/matching/office-dims';
import { multivariableMatchingEnabled } from '@/lib/matching/algorithm';
import { gateMode } from '@/lib/ingest/entailment-gate';
import {
  isEmbedVisiblePosition,
  isStatedTier,
  isOfficeholderRecordTier,
  embedGateExplainer,
} from '@/lib/embed/display-policy';
import { tierMeta } from '@/lib/provenance';
import {
  POSITIONS_BUNDLE_VERSION,
  type BundleCandidate,
  type BundlePosition,
  type BundleRace,
  type BundleSubDimension,
  type PositionsBundle,
} from '@/lib/device/bundle';
import type { Domain, Position, RaceLevel, SubDimension } from '@/types/database';
import type { GateMode } from '@/lib/ingest/entailment-gate';

// ---------------------------------------------------------------------------
// Public payload shapes (safe to import into client components)
// ---------------------------------------------------------------------------

/** A source receipt shown BEFORE and alongside a candidate position. */
export interface EmbedReceipt {
  /** Verbatim quote backing the position, when we captured one. */
  quote: string | null;
  /** Source URL (opens in a new tab, out of the iframe). */
  url: string | null;
  /** Human title of the source. */
  title: string | null;
  /** Provenance label, e.g. "Candidate-stated" / "Voting record". */
  tierLabel: string;
  /** Short provenance label for tight chips, e.g. "Stated" / "Record". */
  tierShort: string;
}

/** One gate-visible candidate position on one issue, with its receipt. */
export interface EmbedCandidatePosition {
  subDimensionId: string;
  /** 0.0 .. 1.0 candidate stance on this issue's spectrum. */
  score: number;
  viewType: 'stated' | 'inferred' | string;
  confidence: string;
  /** True when this is the candidate's own words; false = official record. */
  stated: boolean;
  record: boolean;
  receipt: EmbedReceipt | null;
}

export interface EmbedCandidate {
  id: string;
  name: string;
  party: string | null;
  tier: 'A' | 'B' | 'C';
  /** Only gate-visible positions (the display + receipt set). */
  visiblePositions: EmbedCandidatePosition[];
  /**
   * False when the candidate has NO gate-visible position at all: the widget
   * renders the abstain-honest card ("has not stated a public position; we are
   * still gathering") instead of a stance list.
   */
  hasVisibleStance: boolean;
}

export interface EmbedRace {
  id: string;
  name: string;
  level: RaceLevel;
  district: string | null;
  electionDate: string;
  candidates: EmbedCandidate[];
}

/** One issue in the office-scoped calibration deck the voter swipes through. */
export interface EmbedIssue {
  /** sub_dimensions.id (the issueId the on-device matcher keys on). */
  id: string;
  domain: Domain;
  name: string;
  /** The "disagree" pole label. */
  spectrumLow: string;
  /** The "agree" pole label (the card statement is this pole, verbatim). */
  spectrumHigh: string;
  /** A composed neutral one-liner (for aria-label / accessibility). */
  statement: string;
  /** Names of races on THIS ballot where the issue counts (the on-ballot banner). */
  onBallotRaceNames: string[];
}

export interface EmbedPayload {
  address: string;
  generatedAt: string;
  gateMode: GateMode;
  gateExplainer: ReturnType<typeof embedGateExplainer>;
  /** The lean bundle the device scores against (gate-visible positions only). */
  bundle: PositionsBundle;
  /** Display + receipts, grouped by race (top-to-bottom ballot order). */
  races: EmbedRace[];
  /** The office-scoped swipe deck (capped). */
  swipeIssues: EmbedIssue[];
  counts: {
    races: number;
    candidates: number;
    visiblePositions: number;
    abstainCandidates: number;
  };
}

export type EmbedResult =
  | { ok: true; payload: EmbedPayload }
  | { ok: false; reason: 'no_address' | 'no_coverage' | 'error'; message: string };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Utah pilot. The region gate keeps the swipe deck to Utah-applicable issues. */
const EMBED_REGION = 'US-UT';
/** Cap on the calibration deck (V2 spec: ~15-20 cards before on-ballot reveal). */
const MAX_SWIPE_ISSUES = 18;

// Ballot top-to-bottom order.
const LEVEL_ORDER: RaceLevel[] = [
  'federal',
  'state',
  'county',
  'municipal',
  'school',
  'special',
  'judicial',
];

// ---------------------------------------------------------------------------
// Statement rendering (no dedicated helper existed; this is the one place)
// ---------------------------------------------------------------------------

/**
 * Compose a neutral one-line statement from a sub_dimension for aria-labels.
 * The card UI renders the two poles as a two-sided choice (agree = high pole,
 * disagree = low pole) so this is only the accessible summary, never a leading
 * assertion. One proposition, no negation, per V2 statement-wording rules.
 */
export function subDimensionToStatement(sd: {
  name: string;
  spectrum_high: string;
}): string {
  return `${sd.name}: do you favor ${sd.spectrum_high.trim()}?`;
}

// ---------------------------------------------------------------------------
// Positions read (mirrors live-provider's dual candidate_id + person_id path)
// ---------------------------------------------------------------------------

async function fetchPositions(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  candidateLookupIds: string[],
  personIds: string[],
): Promise<{ byCandidateId: Map<string, Position[]>; byPersonId: Map<string, Position[]> }> {
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

// ---------------------------------------------------------------------------
// Receipt from a position's citations
// ---------------------------------------------------------------------------

function receiptFor(p: Position): EmbedReceipt | null {
  const meta = tierMeta((p.source_tier as string | null) ?? (p.view_type === 'stated' ? 'candidate_stated_current' : 'ml_inferred_from_corpus'));
  const cites = p.source_citations ?? [];
  // Prefer the first citation that carries a real quote; else the first with a URL.
  const withQuote = cites.find((c) => c.quote && c.quote.trim());
  const withUrl = cites.find((c) => c.url && c.url.trim());
  const chosen = withQuote ?? withUrl ?? null;
  if (!chosen && !p.ai_summary) return { quote: null, url: null, title: null, tierLabel: meta.label, tierShort: meta.short };
  return {
    quote: (withQuote?.quote ?? null)?.trim() ?? null,
    url: chosen?.url && chosen.url.trim() ? chosen.url.trim() : null,
    title: chosen?.title?.trim() ?? (chosen?.url ? 'Source' : null),
    tierLabel: meta.label,
    tierShort: meta.short,
  };
}

// ---------------------------------------------------------------------------
// Bundle projection (only gate-visible positions)
// ---------------------------------------------------------------------------

function toBundlePosition(p: Position): BundlePosition {
  const cites = p.source_citations ?? [];
  return {
    id: p.id,
    sub_dimension_id: p.sub_dimension_id,
    score: p.score,
    view_type: p.view_type,
    confidence: p.confidence,
    source_tier: (p.source_tier as string | null) ?? null,
    created_at: p.created_at,
    citationCount: cites.length,
    hasCitationUrl: cites.some((c) => !!c.url),
  };
}

// ---------------------------------------------------------------------------
// The assembler
// ---------------------------------------------------------------------------

export async function buildEmbedPayload(rawAddress: string): Promise<EmbedResult> {
  const address = (rawAddress ?? '').trim();
  if (!address) return { ok: false, reason: 'no_address', message: 'Enter your address to see your ballot.' };

  let loaded: Awaited<ReturnType<typeof loadBallotForAddress>>;
  try {
    loaded = await loadBallotForAddress(address);
  } catch {
    return { ok: false, reason: 'error', message: 'We could not look up that address just now. Please try again.' };
  }
  const ballotRaces: BallotRace[] = loaded?.races ?? [];
  if (ballotRaces.length === 0) {
    return {
      ok: false,
      reason: 'no_coverage',
      message:
        'We could not find races for that address yet. Re-enter your full home street address (not a P.O. box), or check back as we add coverage.',
    };
  }

  const supabase = await createServiceClient();
  const mode = gateMode();

  // Taxonomy (public-read). Need scope_applicability + applicable_regions for the deck.
  const { data: subDimData } = await supabase
    .from('sub_dimensions')
    .select('id, domain, name, spectrum_low, spectrum_high, display_order, scope_applicability, applicable_regions, editorial_salience, active');
  const allSubDims = ((subDimData ?? []) as SubDimension[]).filter((sd) => sd.active !== false);
  const subDimById = new Map(allSubDims.map((sd) => [sd.id, sd]));

  // Positions for every candidate across the ballot (two round-trips).
  const candidateLookupIds: string[] = [];
  const personIds: string[] = [];
  for (const r of ballotRaces) {
    for (const c of r.candidates) {
      candidateLookupIds.push(c.positionLookupId ?? c.id);
      if (c.personId) personIds.push(c.personId);
    }
  }
  const { byCandidateId, byPersonId } = await fetchPositions(supabase, candidateLookupIds, personIds);

  // Assemble races (display + receipts) and the gate-visible bundle in parallel.
  const orderedRaces = [...ballotRaces].sort(
    (a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level),
  );

  const races: EmbedRace[] = [];
  const bundleRaces: BundleRace[] = [];
  let visiblePositionCount = 0;
  let abstainCount = 0;
  let candidateCount = 0;

  // Track which issues are "on the ballot" (matching at some race's scope) and
  // for which race names, to power both the swipe deck and its on-ballot banner.
  const onBallotRaceNames = new Map<string, Set<string>>();

  for (const br of orderedRaces) {
    const scope = raceLevelToScope(br.level);

    // Which issues count at this race's scope (and apply in Utah)?
    for (const sd of allSubDims) {
      if (applicabilityAt(sd, scope) !== 'matching') continue;
      if (!appliesInRegion(sd, EMBED_REGION)) continue;
      const set = onBallotRaceNames.get(sd.id) ?? new Set<string>();
      set.add(br.name);
      onBallotRaceNames.set(sd.id, set);
    }

    const embedCandidates: EmbedCandidate[] = [];
    const bundleCandidates: BundleCandidate[] = [];

    for (const bc of br.candidates) {
      candidateCount += 1;
      const raw = mergePositions(bc, byCandidateId, byPersonId);
      const visible = raw.filter((p) => isEmbedVisiblePosition(p, mode));

      // Keep the newest gate-visible row per sub_dimension for display.
      const byDim = new Map<string, Position>();
      for (const p of visible) {
        const cur = byDim.get(p.sub_dimension_id);
        if (!cur || p.created_at > cur.created_at) byDim.set(p.sub_dimension_id, p);
      }
      const dedupVisible = [...byDim.values()];

      const positions: EmbedCandidatePosition[] = dedupVisible.map((p) => ({
        subDimensionId: p.sub_dimension_id,
        score: p.score,
        viewType: p.view_type,
        confidence: p.confidence,
        stated: isStatedTier(p),
        record: isOfficeholderRecordTier(p),
        receipt: receiptFor(p),
      }));
      visiblePositionCount += positions.length;
      const hasVisibleStance = positions.length > 0;
      if (!hasVisibleStance) abstainCount += 1;

      const tier: 'A' | 'B' | 'C' = bc.wellDocumented ? 'A' : hasVisibleStance ? 'B' : 'C';

      embedCandidates.push({
        id: bc.id,
        name: bc.name,
        party: bc.party,
        tier,
        visiblePositions: positions,
        hasVisibleStance,
      });

      bundleCandidates.push({
        id: bc.id,
        name: bc.name,
        party: bc.party,
        tier,
        // The device scores against the SAME gate-visible set (dedup per dim).
        positions: dedupVisible.map(toBundlePosition),
      });
    }

    races.push({
      id: br.id,
      name: br.name,
      level: br.level,
      district: br.district ?? null,
      electionDate: br.election_date,
      candidates: embedCandidates,
    });

    bundleRaces.push({
      id: br.id,
      name: br.name,
      level: br.level,
      district: br.district ?? null,
      election_date: br.election_date,
      type: br.type,
      relevant_dimensions: br.relevant_dimensions ?? null,
      candidates: bundleCandidates,
    });
  }

  // Build the office-scoped swipe deck: issues that count somewhere on this
  // ballot, ranked by (how many races they touch) then editorial salience then
  // display order, capped. This is the voter's self-positioning calibration set.
  const rankedIssues = [...onBallotRaceNames.entries()]
    .map(([id, raceNames]) => {
      const sd = subDimById.get(id);
      if (!sd) return null;
      const issue: EmbedIssue = {
        id,
        domain: sd.domain,
        name: sd.name,
        spectrumLow: sd.spectrum_low,
        spectrumHigh: sd.spectrum_high,
        statement: subDimensionToStatement(sd),
        onBallotRaceNames: [...raceNames],
      };
      return {
        issue,
        rank: raceNames.size,
        salience: sd.editorial_salience ?? 0.5,
        order: sd.display_order ?? 999,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.rank - a.rank || b.salience - a.salience || a.order - b.order)
    .slice(0, MAX_SWIPE_ISSUES);
  const swipeIssues: EmbedIssue[] = rankedIssues.map((r) => r.issue);

  // Only ship the sub-dimension metadata the client needs (deck issues + any
  // dim a visible position lands on), so the on-device matcher can scope + label.
  const neededDimIds = new Set<string>(swipeIssues.map((i) => i.id));
  for (const r of bundleRaces) {
    for (const c of r.candidates) {
      for (const p of c.positions) neededDimIds.add(p.sub_dimension_id);
    }
  }
  const bundleSubDimensions: BundleSubDimension[] = allSubDims
    .filter((sd) => neededDimIds.has(sd.id))
    .map((sd) => ({
      id: sd.id,
      domain: sd.domain,
      name: sd.name,
      spectrum_low: sd.spectrum_low,
      spectrum_high: sd.spectrum_high,
      display_order: sd.display_order,
      scope_applicability: sd.scope_applicability ?? {},
    }));

  const bundle: PositionsBundle = {
    version: POSITIONS_BUNDLE_VERSION,
    generatedAt: new Date().toISOString(),
    races: bundleRaces,
    subDimensions: bundleSubDimensions,
    matchingFlags: {
      respectOfficeDims: respectOfficeDimsEnabled(),
      multivariable: multivariableMatchingEnabled(),
    },
  };

  return {
    ok: true,
    payload: {
      address,
      generatedAt: new Date().toISOString(),
      gateMode: mode,
      gateExplainer: embedGateExplainer(mode),
      bundle,
      races,
      swipeIssues,
      counts: {
        races: races.length,
        candidates: candidateCount,
        visiblePositions: visiblePositionCount,
        abstainCandidates: abstainCount,
      },
    },
  };
}
