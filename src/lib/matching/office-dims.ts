/**
 * Helper to look up office-level relevant_dimensions for a set of races.
 *
 * Used by the matching algorithm (gated by MATCHING_RESPECT_OFFICE_DIMS)
 * to intersect the level-scope filter with the office's own dimension set —
 * so a school-board candidate isn't scored on foreign policy, etc.
 *
 * Handles both legacy (races.id → races.election_id → offices) and new-graph
 * (race.id IS election.id → offices) lookups in one helper.
 *
 * Feature flag policy (decided 2026-05-23):
 *   • MATCHING_RESPECT_OFFICE_DIMS = 'true'  → on
 *   • MATCHING_RESPECT_OFFICE_DIMS = 'false' → off
 *   • unset → on in dev (NODE_ENV !== 'production'), off in prod
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Module-level override for respectOfficeDimsEnabled().
 *
 * Why this exists (work-order 1B item 3): algorithm.ts reads the office-dims
 * flag ONLY through respectOfficeDimsEnabled() (it does not accept the flag as
 * a parameter, and algorithm.ts is edit-locked). In the browser, `process.env`
 * is a static, inert object — the real server flag is not present and cannot be
 * written. So the CLIENT matcher would fall back to the production-OFF default
 * and under-score. The positions bundle carries the SERVER-resolved flag; the
 * client's match-client sets this override from that value before invoking the
 * matcher and clears it after, so both sides evaluate the identical branch.
 *
 * null = no override (use the env/NODE_ENV resolution below). Server code never
 * sets this; it is exercised only by the client scoring path and its tests.
 */
let officeDimsOverride: boolean | null = null;

/**
 * Set (or clear, with null) the office-dims flag override. Documented mechanism
 * the client match engine uses instead of mutating process.env. See the module
 * comment above. Returns the previous override so a caller can restore it.
 */
export function setOfficeDimsOverride(value: boolean | null): boolean | null {
  const prev = officeDimsOverride;
  officeDimsOverride = value;
  return prev;
}

export function respectOfficeDimsEnabled(): boolean {
  if (officeDimsOverride !== null) return officeDimsOverride;
  const v = process.env.MATCHING_RESPECT_OFFICE_DIMS;
  if (v === "true") return true;
  if (v === "false") return false;
  return process.env.NODE_ENV !== "production";
}

/**
 * Given a list of race rows, returns a Map<race_id, relevant_dimensions[]>.
 *
 * Walks the tiered hierarchy (most-specific first; first match wins):
 *   1. offices.relevant_dimensions          (per-seat override; ~1% coverage)
 *   2. office_type_state_overrides          (office_type × state)
 *   3. office_types.relevant_dimensions     (national baseline; ~100% coverage)
 *
 * For legacy races, callers should pass the already-resolved election_id
 * (from `races.election_id`). For new-graph races, race.id IS the election
 * id, so pass that as election_id too.
 *
 * Returns an empty map (and logs) on any error, so matching always degrades
 * gracefully to the level-scope filter alone.
 */
export async function loadRaceOfficeDimensions(
  supabase: SupabaseClient,
  rows: Array<{ race_id: string; election_id: string | null }>,
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!rows || rows.length === 0) return map;

  const electionToRace = new Map<string, string>();
  const electionIds: string[] = [];
  for (const r of rows) {
    if (!r.election_id) continue;
    electionToRace.set(r.election_id, r.race_id);
    electionIds.push(r.election_id);
  }
  if (electionIds.length === 0) return map;

  try {
    // PostgREST embeds many-to-one relationships as arrays in the JS client
    // typing even though they're 0-or-1. Unwrap defensively.
    type EmbedSingle<T> = T | T[] | null | undefined;
    function pickOne<T>(v: EmbedSingle<T>): T | undefined {
      if (Array.isArray(v)) return v[0];
      return v ?? undefined;
    }

    // ── First pass: pull elections → offices → office_type + jurisdiction.
    // We need office_type_id + fips_state per race to consult the tier-2
    // (office_type × state) overrides table next.
    type ResolvedRace = {
      raceId: string;
      seatDims: string[] | null;       // tier-1: offices.relevant_dimensions
      officeTypeId: string | null;
      fipsState: string | null;
      baselineDims: string[] | null;   // tier-3: office_types.relevant_dimensions
    };
    const resolved: ResolvedRace[] = [];
    const BATCH = 300;
    for (let i = 0; i < electionIds.length; i += BATCH) {
      const slice = electionIds.slice(i, i + BATCH);
      const { data, error } = await supabase
        .from("elections")
        .select(
          `id, office:offices(
             relevant_dimensions, office_type_id,
             office_type:office_types(relevant_dimensions),
             jurisdiction:jurisdictions!offices_jurisdiction_id_fkey(fips_state)
           )`,
        )
        .in("id", slice);
      if (error) throw error;
      for (const e of (data as any[]) || []) {
        const raceId = electionToRace.get(e.id);
        if (!raceId) continue;
        const office = pickOne<any>(e.office);
        const officeType = pickOne<{ relevant_dimensions: string[] | null }>(office?.office_type);
        const juris = pickOne<{ fips_state: string | null }>(office?.jurisdiction);
        resolved.push({
          raceId,
          seatDims: office?.relevant_dimensions ?? null,
          officeTypeId: office?.office_type_id ?? null,
          fipsState: juris?.fips_state ?? null,
          baselineDims: officeType?.relevant_dimensions ?? null,
        });
      }
    }

    // ── Tier-2: batch-fetch office_type_state_overrides for the
    // (office_type_id, fips_state) pairs we actually need.
    const stateOverrides = new Map<string, string[]>(); // key = `${officeTypeId}|${fipsState}`
    const needTier2 = resolved.filter(
      (r) =>
        // Only fetch when tier-1 didn't already provide a value AND we have
        // both the office_type + state to look up.
        (r.seatDims == null || r.seatDims.length === 0) &&
        r.officeTypeId &&
        r.fipsState,
    );
    if (needTier2.length > 0) {
      const officeTypeIds = [...new Set(needTier2.map((r) => r.officeTypeId!))];
      try {
        const { data: overrides, error: oErr } = await supabase
          .from("office_type_state_overrides")
          .select("office_type_id, fips_state, relevant_dimensions")
          .in("office_type_id", officeTypeIds)
          .order("office_type_id")
          .range(0, 9999);
        if (oErr) {
          // Table missing or other error — silently skip tier 2.
          if (!/relation .* does not exist/i.test(oErr.message)) {
            console.warn("[loadRaceOfficeDimensions] tier-2 lookup failed:", oErr.message);
          }
        } else {
          for (const o of (overrides as any[]) || []) {
            const key = `${o.office_type_id}|${o.fips_state}`;
            const dims = o.relevant_dimensions;
            if (Array.isArray(dims) && dims.length > 0) stateOverrides.set(key, dims);
          }
        }
      } catch (e2) {
        console.warn("[loadRaceOfficeDimensions] tier-2 exception:", e2);
      }
    }

    // ── Final resolution: tier-1 (seat) > tier-2 (state-override) > tier-3 (baseline).
    for (const r of resolved) {
      if (r.seatDims && r.seatDims.length > 0) {
        map.set(r.raceId, r.seatDims);
        continue;
      }
      if (r.officeTypeId && r.fipsState) {
        const tier2 = stateOverrides.get(`${r.officeTypeId}|${r.fipsState}`);
        if (tier2 && tier2.length > 0) {
          map.set(r.raceId, tier2);
          continue;
        }
      }
      if (r.baselineDims && r.baselineDims.length > 0) {
        map.set(r.raceId, r.baselineDims);
      }
    }
  } catch (err) {
    // Schema or join failure — degrade gracefully. Matching algorithm
    // falls back to the level-scope filter alone.
    // eslint-disable-next-line no-console
    console.warn("[loadRaceOfficeDimensions] degrading:", err);
  }

  return map;
}
