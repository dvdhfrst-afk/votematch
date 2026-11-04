/**
 * Per-race data-quality tier computation.
 *
 * We surface this to voters as a badge on every RaceCard so they can tell
 * when the match is built on thin evidence. The rule is intentionally strict
 * after 2026-05-02 — user testing turned up "Well-documented" badges on
 * candidates with <10 sources or 0 sources at all (just because they had
 * 5 low-confidence stub positions classified). New definition:
 *
 *   A candidate is "well-covered" iff ALL of:
 *     • ≥ MIN_HIGH_CONF_POSITIONS positions at confidence in
 *       ('high','medium')  — not low-confidence stubs
 *     • ≥ MIN_SOURCES rows in candidate_sources                   — actual cited sources
 *     • ≥ MIN_SOURCE_TYPES distinct source_type values            — diversity, not 5 tweets
 *
 *   Tier rolls up from there:
 *     - A: ≥70% of candidates well-covered
 *     - B: ≥50% have any data, OR ≥2 well-covered
 *     - C: thin — most candidates have <3 classified sub-dimensions
 *     - D: zero — we have no classifications for any candidate in this race
 *
 * Thresholds are exported so the per-candidate `wellDocumented` flag in
 * `app/src/app/ballot/page.tsx` can apply the SAME triple-check and stay
 * in sync with the per-race tier.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { unstable_cache } from 'next/cache';
import { createHash } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/server';

export type DataQualityTier = 'A' | 'B' | 'C' | 'D';

export interface RaceDataQuality {
  tier: DataQualityTier;
  candidateCount: number;
  /** How many candidates pass the well-documented triple-check. */
  wellCovered: number;
  /** How many candidates have ≥1 classified sub-dim but fail the well-covered bar. */
  partial: number;
  /** How many candidates have 0 positions at all. */
  uncovered: number;
  /** Human-facing sentence to show under the badge. */
  blurb: string;
}

/**
 * Tunable thresholds. Exported because the per-candidate well-documented
 * computation in `app/src/app/ballot/page.tsx` reuses them — keeping them
 * in one place prevents the badge and the tier from drifting apart.
 */
export const MIN_HIGH_CONF_POSITIONS = 10;
export const MIN_SOURCES = 5;
export const MIN_SOURCE_TYPES = 2;

/** Confidence levels that count toward MIN_HIGH_CONF_POSITIONS. */
const COUNTING_CONFIDENCES = ['high', 'medium', 'candidate_direct'] as const;

export interface CandidateQualityCounts {
  /** Distinct sub-dimensions covered by counting-confidence positions. */
  highConfPositions: number;
  /** Total candidate_sources rows. */
  sourceCount: number;
  /** Distinct source_type values across those rows. */
  sourceTypeCount: number;
}

export function isWellDocumented(c: CandidateQualityCounts): boolean {
  return (
    c.highConfPositions >= MIN_HIGH_CONF_POSITIONS &&
    c.sourceCount >= MIN_SOURCES &&
    c.sourceTypeCount >= MIN_SOURCE_TYPES
  );
}

function computeTier(params: {
  candidateCount: number;
  wellCovered: number;
  partial: number;
  uncovered: number;
}): DataQualityTier {
  const { candidateCount, wellCovered, partial, uncovered: _uncovered } = params;
  if (candidateCount === 0) return 'D';
  const withData = wellCovered + partial;
  if (withData === 0) return 'D';
  if (wellCovered / candidateCount >= 0.7) return 'A';
  if (withData / candidateCount >= 0.5 || wellCovered >= 2) return 'B';
  return 'C';
}

function blurbFor(tier: DataQualityTier, candidateCount: number): string {
  switch (tier) {
    case 'A':
      return 'Strong data — most candidates have 10+ classified positions, multiple cited sources, and source diversity.';
    case 'B':
      return 'Partial data — some candidates are well-documented, others are thin.';
    case 'C':
      return 'Thin data — we don\'t have enough public positions to match reliably yet.';
    case 'D':
      return candidateCount === 0
        ? 'No candidates listed for this race yet.'
        : 'We haven\'t built positions for this race yet — filings are in but sourcing/classification is pending.';
  }
}

/**
 * Stable hash of a candidate-id list for use as a cache key fragment.
 * Sorted before hashing so caller order doesn't fragment the cache.
 */
function hashIds(ids: string[]): string {
  const sorted = [...ids].sort();
  return createHash('sha1').update(sorted.join(',')).digest('hex');
}

/**
 * Uncached implementation. Two queries (positions and candidate_sources)
 * chunked at 20 to stay under the PostgREST URL limit.
 *
 * Returned map is keyed by candidate_id. Candidates with no rows in either
 * table get a zero record — caller can treat absence as zero or pass through.
 */
async function computeCandidateQualityCountsBulkUncached(
  supabase: SupabaseClient,
  candidateIds: string[],
): Promise<Map<string, CandidateQualityCounts>> {
  const out = new Map<string, CandidateQualityCounts>();
  if (candidateIds.length === 0) return out;

  // Initialize zero records so callers don't have to null-check.
  for (const id of candidateIds) {
    out.set(id, { highConfPositions: 0, sourceCount: 0, sourceTypeCount: 0 });
  }

  // ---- positions: count distinct sub_dimensions at high|medium confidence ----
  // Distinct sub_dimensions per candidate (not raw rows) — two-view stated +
  // inferred on the same sub_dim shouldn't double-count.
  const posDimsByCand = new Map<string, Set<string>>();
  for (let i = 0; i < candidateIds.length; i += 20) {
    const chunk = candidateIds.slice(i, i + 20);
    const { data } = await supabase
      .from('positions')
      .select('candidate_id, sub_dimension_id, confidence')
      .in('candidate_id', chunk)
      .in('confidence', COUNTING_CONFIDENCES as unknown as string[]);
    for (const r of data ?? []) {
      const row = r as {
        candidate_id: string;
        sub_dimension_id: string;
        confidence: string;
      };
      const set = posDimsByCand.get(row.candidate_id) ?? new Set<string>();
      set.add(row.sub_dimension_id);
      posDimsByCand.set(row.candidate_id, set);
    }
  }
  for (const [cid, set] of posDimsByCand) {
    const rec = out.get(cid)!;
    rec.highConfPositions = set.size;
  }

  // ---- candidate_sources: total count + distinct source_type ----
  const srcTypesByCand = new Map<string, Set<string>>();
  const srcCountByCand = new Map<string, number>();
  for (let i = 0; i < candidateIds.length; i += 20) {
    const chunk = candidateIds.slice(i, i + 20);
    const { data } = await supabase
      .from('candidate_sources')
      .select('candidate_id, source_type')
      .in('candidate_id', chunk);
    for (const r of data ?? []) {
      const row = r as { candidate_id: string; source_type: string | null };
      srcCountByCand.set(
        row.candidate_id,
        (srcCountByCand.get(row.candidate_id) ?? 0) + 1,
      );
      if (row.source_type) {
        const s = srcTypesByCand.get(row.candidate_id) ?? new Set<string>();
        s.add(row.source_type);
        srcTypesByCand.set(row.candidate_id, s);
      }
    }
  }
  for (const [cid, count] of srcCountByCand) {
    const rec = out.get(cid)!;
    rec.sourceCount = count;
  }
  for (const [cid, set] of srcTypesByCand) {
    const rec = out.get(cid)!;
    rec.sourceTypeCount = set.size;
  }

  return out;
}

/**
 * Cached wrapper. Caches per (sorted-id-list hash) for 300s. Returns plain
 * entries inside the cache layer (Maps don't survive Next.js cache
 * serialization), then rehydrates to a Map for the caller.
 *
 * Tag: ['data-quality'] — invalidate after an ingestion run that may have
 * changed positions/sources for any candidate.
 */
export async function computeCandidateQualityCountsBulk(
  // _supabase param kept for API compatibility — the cached implementation
  // builds its own service client because cookies()-based clients can't be
  // captured inside an unstable_cache scope. Positions + candidate_sources
  // are public-read so service-role is safe.
  _supabase: SupabaseClient,
  candidateIds: string[],
): Promise<Map<string, CandidateQualityCounts>> {
  if (candidateIds.length === 0) return new Map();
  const key = hashIds(candidateIds);
  const cached = unstable_cache(
    async () => {
      const sb = await createServiceClient();
      const m = await computeCandidateQualityCountsBulkUncached(
        sb,
        candidateIds,
      );
      // Map → entries so structured cloning preserves the data shape.
      return [...m.entries()] as Array<[string, CandidateQualityCounts]>;
    },
    ['candidate-quality-counts-v1', key],
    { revalidate: 300, tags: ['data-quality'] },
  );
  const entries = await cached();
  return new Map(entries);
}

/**
 * Uncached race-quality rollup. See cached wrapper below.
 */
async function computeRaceDataQualityBulkUncached(
  supabase: SupabaseClient,
  candidateIdsByRace: Map<string, string[]>,
): Promise<Map<string, RaceDataQuality>> {
  const allIds = [...candidateIdsByRace.values()].flat();
  const out = new Map<string, RaceDataQuality>();

  if (allIds.length === 0) {
    for (const [raceId, ids] of candidateIdsByRace) {
      const tier: DataQualityTier = 'D';
      out.set(raceId, {
        tier,
        candidateCount: ids.length,
        wellCovered: 0,
        partial: 0,
        uncovered: ids.length,
        blurb: blurbFor(tier, ids.length),
      });
    }
    return out;
  }

  const counts = await computeCandidateQualityCountsBulk(supabase, allIds);

  for (const [raceId, ids] of candidateIdsByRace) {
    let wellCovered = 0;
    let partial = 0;
    let uncovered = 0;
    for (const id of ids) {
      const rec = counts.get(id) ?? {
        highConfPositions: 0,
        sourceCount: 0,
        sourceTypeCount: 0,
      };
      if (isWellDocumented(rec)) wellCovered++;
      else if (rec.highConfPositions > 0 || rec.sourceCount > 0) partial++;
      else uncovered++;
    }
    const tier = computeTier({
      candidateCount: ids.length,
      wellCovered,
      partial,
      uncovered,
    });
    out.set(raceId, {
      tier,
      candidateCount: ids.length,
      wellCovered,
      partial,
      uncovered,
      blurb: blurbFor(tier, ids.length),
    });
  }
  return out;
}

/**
 * Compute data-quality tier for many races in one round-trip. `candidateIdsByRace`
 * maps race_id → candidate_ids (only published candidates — caller filters).
 *
 * Cached for 300s, keyed on a hash of (race_id → candidate_id) pairs.
 * Tag: ['data-quality'] — invalidate after ingestion runs.
 */
export async function computeRaceDataQualityBulk(
  // _supabase kept for API compatibility — see note on the bulk-counts wrapper.
  _supabase: SupabaseClient,
  candidateIdsByRace: Map<string, string[]>,
): Promise<Map<string, RaceDataQuality>> {
  if (candidateIdsByRace.size === 0) return new Map();
  // Stable key: serialize sorted (race_id → sorted candidate ids).
  const sortedRaces = [...candidateIdsByRace.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const keyMaterial = sortedRaces
    .map(([rid, ids]) => `${rid}:${[...ids].sort().join(',')}`)
    .join('|');
  const key = createHash('sha1').update(keyMaterial).digest('hex');

  const cached = unstable_cache(
    async () => {
      const sb = await createServiceClient();
      const m = await computeRaceDataQualityBulkUncached(
        sb,
        candidateIdsByRace,
      );
      return [...m.entries()] as Array<[string, RaceDataQuality]>;
    },
    ['race-data-quality-v1', key],
    { revalidate: 300, tags: ['data-quality'] },
  );
  const entries = await cached();
  return new Map(entries);
}
