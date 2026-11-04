/**
 * Shared ballot loader — the single address/precinct → BallotRace[] pipeline.
 *
 * Extracted verbatim from `src/app/ballot/page.tsx` (2026-07) so BOTH the
 * `/ballot` page AND the live `/guide` data provider render the exact same
 * ballot: same `v_voter_races` / `v_voter_candidates` reads, same legacy↔graph
 * bridge, same dedup, same nearest-upcoming-election collapse, same
 * `BALLOT_CACHE_VERSION` cache keying, same data-quality + well-documented
 * computation, same display-name sanitization. Nothing here is guide-specific;
 * the guide provider adapts this common output into the guide contract.
 *
 * Design invariant: there is ONE ballot for an address. The guide must not
 * resolve races differently from `/ballot`, or the two surfaces would disagree
 * on which races a voter has — a trust regression. Keeping the resolution in
 * one module makes that impossible.
 */
import { unstable_cache } from "next/cache";
import type {
  RaceWithCandidates,
  RaceLevel,
  Candidate,
  Race,
  User,
} from "@/types/database";
import { createServiceClient } from "@/lib/supabase/server";
import { geocodeAddress } from "@/lib/ballot-lookup";
import {
  resolveDistrictBallotElectionIds,
  BALLOT_CACHE_VERSION,
} from "@/lib/ballot-lookup/district-lookup";
import {
  computeRaceDataQualityBulk,
  computeCandidateQualityCountsBulk,
  isWellDocumented,
  type RaceDataQuality,
} from "@/lib/data-quality";
import { formatCandidateName } from "@/lib/text/candidate-name";
import { sanitizeDisplayName } from "@/lib/text/sanitize-display";

/**
 * v_voter_races row shape (see migration 20260425000008). The view UNIONs
 * legacy `races` (UT-only) with new office-graph `elections`+`offices`.
 * `is_legacy` discriminates the source.
 */
interface VoterRace {
  id: string;
  name: string;
  level: string; // 'federal' | 'state' | 'county' | 'municipal' | 'school' | 'special' | 'judicial'
  district: string | null;
  election_date: string;
  election_type: string;
  state_fips: string | null;
  office_id: string | null;
  election_id: string | null;
  legacy_race_id: string | null;
  is_legacy: boolean;
}

/**
 * v_voter_candidates row shape (see migration 20260425000008 + 20260502000004).
 * race_id points to v_voter_races.id (legacy races.id when is_legacy=true,
 * elections.id when is_legacy=false).
 */
interface VoterCandidate {
  id: string;
  race_id: string;
  name: string;
  office_name: string | null;
  office_level: string;
  state_fips: string | null;
  district_identifier: string | null;
  party: string | null;
  party_abbreviation: string | null;
  party_color: string | null;
  incumbent: boolean;
  is_legacy: boolean;
  legacy_candidate_id: string | null;
  bioguide_id: string | null;
  person_id: string | null;
  photo_url: string | null;
  bio: string | null;
  website_url: string | null;
  published: boolean;
  withdrew: boolean;
  /** Set when the candidate has affirmed positions via /for-candidates. */
  self_attested: boolean;
  /**
   * Per-party primary date (override). Set when party_primaries has a row
   * for (election_id, canonicalParty(party)). NULL when no override —
   * the UI falls back to the race-level election_date.
   * See migration 20260502000005_party_primaries.sql.
   */
  party_primary_date: string | null;
}

/**
 * Augmented Candidate that carries the voter-view signals (self_attested,
 * well_documented) through to CandidateRow. Mirrors the base type so existing
 * RaceCard render code keeps working while the per-candidate badges render.
 */
export interface BallotCandidate extends Candidate {
  selfAttested: boolean;
  wellDocumented: boolean;
  /**
   * Per-party primary date for THIS candidate's party, when an override
   * exists in `party_primaries`. All candidates in the same party
   * subsection should share this value (same election + same canonical
   * party). Undefined when no override; RaceCard falls back to
   * race.election_date / race.daysUntilElection.
   */
  partyPrimaryDate?: string;
  /**
   * The legacy candidate id (or person id) the positions table is keyed on for
   * THIS candidate — `legacy_candidate_id ?? id`. The guide provider needs it
   * to fetch positions; the `/ballot` page ignores it. Kept optional so the
   * base Candidate render path is unaffected.
   */
  positionLookupId?: string;
  /** person_id, when present — the second positions read path (person-native). */
  personId?: string | null;
}

export interface BallotRace extends Omit<RaceWithCandidates, "candidates"> {
  candidates: BallotCandidate[];
  /**
   * Days until election_date (negative = past). Computed once server-side so
   * RaceCard can render a "Primary in N days" indicator without re-parsing.
   */
  daysUntilElection: number;
  /**
   * Raw election_type from the voter view (e.g. "primary", "general").
   * Race.type collapses this to primary|general; the per-state countdown
   * chip (Council #43/#44) wants the original string. Preserved here.
   */
  election_type: string;
  /** State FIPS from the voter view, for the SoS verify link in the chip. */
  state_fips: string | null;
}

/**
 * Coerce voter-view rows into the augmented BallotRace shape. Filters out
 * unpublished/withdrew candidates and stamps self_attested through.
 * `wellDocumentedIds` is a set of candidate IDs that pass the strict
 * triple-check (≥10 high/medium-confidence positions AND ≥5 sources AND
 * ≥2 source types). See `isWellDocumented()` in lib/data-quality.ts.
 */
function voterRowsToBallotShape(
  vraces: VoterRace[],
  vcandsByRace: Map<string, VoterCandidate[]>,
  wellDocumentedIds: Set<string>,
  today: Date,
): BallotRace[] {
  return vraces.map((vr) => {
    const race: Race = {
      id: vr.id,
      // Sanitize DB-sourced race titles at the render layer: strip em/en dashes
      // ("Arizona State Senator — District 14" -> "... - District 14") per the
      // project's no-dash hard rule. We can't rewrite stored data here.
      name: sanitizeDisplayName(vr.name),
      // RaceLevel covers all six ballot levels (federal|state|county|municipal|
      // school|special|judicial). Preserve the office-graph level verbatim
      // instead of collapsing non-fed/state/county to "county" — the ballot
      // groups races by their true level (Phase 3 criterion #2). Unknown
      // strings fall back to county as a conservative default.
      level: ((): RaceLevel => {
        const L = vr.level;
        if (
          L === "federal" || L === "state" || L === "county" ||
          L === "municipal" || L === "school" || L === "special" ||
          L === "judicial"
        ) {
          return L as RaceLevel;
        }
        return "county";
      })(),
      district: vr.district,
      election_date: vr.election_date,
      type: (vr.election_type === "primary" ? "primary" : "general") as
        | "primary"
        | "general",
    };
    const filtered = (vcandsByRace.get(vr.id) ?? []).filter(
      (c) => c.published && !c.withdrew,
    );
    // Dedup candidates within this race. Same human can appear as multiple
    // VoterCandidate rows because (a) legacy `candidates` + new-graph
    // `candidacies` both surface in the union view, and (b) legacy
    // `candidates` was never deduped — same person appears multiple times
    // with different name capitalizations and different person_ids.
    // Display-level dedup here keeps the visible bug at bay; the deeper fix
    // is a separate intra-state dedup-people pass.
    const dedupedCands = dedupCandidatesInRace(filtered);
    const cands = dedupedCands.map<BallotCandidate>((c) => ({
      id: c.id,
      // Format raw FEC / voter-file names for display ("SAMPLETON, EDGAR J MR"
      // -> "Edgar J Sampleton"). Display transform only; DB data is untouched.
      name: formatCandidateName(c.name),
      party: c.party,
      race_id: vr.id,
      bio: c.bio,
      photo_url: c.photo_url,
      website_url: c.website_url,
      questionnaire_status: "not_invited",
      published: c.published,
      created_at: "",
      updated_at: "",
      selfAttested: c.self_attested === true,
      wellDocumented: wellDocumentedIds.has(c.id),
      partyPrimaryDate: c.party_primary_date ?? undefined,
      positionLookupId: c.legacy_candidate_id ?? c.id,
      personId: c.person_id,
    }));

    // Days until election. Negative for past dates (filtered out upstream
    // but defensively handled here so a stale row doesn't render as Infinity).
    const elecDate = new Date(vr.election_date);
    const daysUntilElection = Math.ceil(
      (elecDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );

    return {
      ...race,
      candidates: cands,
      daysUntilElection,
      election_type: vr.election_type,
      state_fips: vr.state_fips,
    };
  });
}

/**
 * Dedup multiple v_voter_candidates rows within ONE race that refer to the
 * same human. The voter view UNIONs legacy + new-graph candidates, AND the
 * legacy `candidates` table itself was never deduped — so the same
 * candidate can appear 3-7 times with different name capitalizations and
 * different person_ids.
 *
 * Display-level dedup: bucket by `person_id` when present, else by
 * normalized name (lowercase + strip non-alphanumeric). Within each bucket,
 * keep the BEST row by:
 *   1. is_legacy=false beats is_legacy=true (new-graph wins)
 *   2. Has person_id beats no person_id (more identity signal)
 *   3. More populated fields (photo + bio + website) beats less
 *   4. self_attested=true beats false (candidate-affirmed wins)
 *   5. Stable: alphabetical id as last-resort tiebreak
 *
 * The deeper fix — actually merging the multiple `people` rows for the same
 * human — is a separate intra-state dedup-people pass.
 */
function dedupCandidatesInRace(cands: VoterCandidate[]): VoterCandidate[] {
  function normName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function bucketKey(c: VoterCandidate): string {
    // Bucket by normalized name within this race. Within a single race
    // scope, name collisions are rare — and the LEGACY data has multiple
    // unmerged `people` rows for the same human, so two rows for the same
    // person can have DIFFERENT person_ids (we found one candidate
    // duped this way: same race, two non-legacy rows, different person_ids,
    // names differing only by capitalization). Keying on person_id first
    // would let those duplicates through. Name-first catches them.
    return `name:${normName(c.name)}`;
  }

  function populationScore(c: VoterCandidate): number {
    let n = 0;
    if (c.photo_url) n++;
    if (c.bio) n++;
    if (c.website_url) n++;
    return n;
  }

  function pickBest(a: VoterCandidate, b: VoterCandidate): VoterCandidate {
    // 1. is_legacy=false beats is_legacy=true
    if (a.is_legacy !== b.is_legacy) return a.is_legacy ? b : a;
    // 2. Has person_id beats no person_id
    const aHasPid = !!a.person_id;
    const bHasPid = !!b.person_id;
    if (aHasPid !== bHasPid) return aHasPid ? a : b;
    // 3. More populated fields wins
    const aPop = populationScore(a);
    const bPop = populationScore(b);
    if (aPop !== bPop) return aPop > bPop ? a : b;
    // 4. self_attested=true wins
    if (a.self_attested !== b.self_attested) return a.self_attested ? a : b;
    // 5. Stable alphabetical id tiebreak
    return a.id < b.id ? a : b;
  }

  const buckets = new Map<string, VoterCandidate>();
  for (const c of cands) {
    const key = bucketKey(c);
    const existing = buckets.get(key);
    buckets.set(key, existing ? pickBest(existing, c) : c);
  }
  return [...buckets.values()];
}

/**
 * Dedup multiple v_voter_races rows that represent the SAME underlying
 * office-of-the-same-election. The voter view UNIONs legacy + new-graph,
 * and the legacy-to-new bridge can leave several rows pointing at the
 * conceptually-identical race (e.g. 4 cards for UT-2 House).
 *
 * Dedup key: prefer office_id+election_date when available (new-graph rows
 * always have office_id). For legacy-only rows that share neither office_id
 * nor a bridge, fall back to a normalized name+district+election_date key.
 *
 * Within each bucket, pick the BEST row by:
 *   1. is_legacy=false beats is_legacy=true (new-graph wins)
 *   2. More candidates (after published+!withdrew filter) beats fewer
 *   3. Earlier election_date beats later (more imminent)
 *   4. Stable: alphabetical id as last-resort tiebreak
 */
function dedupRaces(
  vraces: VoterRace[],
  vcandsByRace: Map<string, VoterCandidate[]>,
): VoterRace[] {
  /**
   * Normalize a district string so legacy "House District 10" matches
   * new-graph "House of Representatives Seat 10" matches "Seat 10" — all
   * collapse to "10" once the prose is stripped. Senate vs House is
   * distinguished by the level+name fingerprint, not the district token.
   */
  function normDistrict(d: string | null, name: string): string {
    if (!d) {
      // Some legacy rows have null district; pull a number out of the name.
      // "Governor of Utah" → "" (no number, that's correct — only one).
      const m = name.match(/\b(\d+)\b/);
      return m ? m[1] : "";
    }
    const m = d.match(/\b(\d+)\b/);
    if (m) return m[1];
    return d.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  /**
   * Bucket fingerprint that tries to identify "the same office's same
   * election" across legacy + new-graph rows. Keys on:
   *   - level (federal/state/county/...)
   *   - chamber-or-office class extracted from the name ("house"/"senate"/
   *     "governor"/"school board"/"representative"/...)
   *   - normalized district number
   *   - election_date (so a primary and a general for the same seat stay
   *     separate, which is correct)
   *
   * If a row has office_id we include it ONLY when no other row in the
   * candidate set shares the synthesized key — otherwise office_id would
   * always be its own bucket and dedup wouldn't fire across the legacy/new
   * boundary.
   */
  function dedupKey(r: VoterRace): string {
    const lower = r.name.toLowerCase();
    let chamber = "other";
    if (/\bsenat/i.test(r.name)) chamber = "senate";
    else if (/\bhouse|representative/i.test(r.name)) chamber = "house";
    else if (/\bgovernor/i.test(lower)) chamber = "governor";
    else if (/\bschool board|sboe/i.test(lower)) chamber = "schoolboard";
    else if (/\bcommission/i.test(lower)) chamber = "commission";
    else if (/\battorney general/i.test(lower)) chamber = "attorneygeneral";
    else if (/\btreasurer/i.test(lower)) chamber = "treasurer";
    else if (/\bauditor/i.test(lower)) chamber = "auditor";
    else if (/\bjudge|justice/i.test(lower)) chamber = "judicial";
    else if (/\bmayor/i.test(lower)) chamber = "mayor";
    else if (/\bcouncil/i.test(lower)) chamber = "council";
    return [
      "key",
      r.level,
      chamber,
      normDistrict(r.district, r.name),
      r.election_date,
    ].join(":");
  }

  function activeCandCount(rid: string): number {
    return (vcandsByRace.get(rid) ?? []).filter(
      (c) => c.published && !c.withdrew,
    ).length;
  }

  /** Best row within a set of rows for the SAME underlying race. */
  function pickBestRace(group: VoterRace[]): VoterRace {
    return [...group].sort((a, b) => {
      if (a.is_legacy !== b.is_legacy) return a.is_legacy ? 1 : -1;
      const ca = activeCandCount(a.id);
      const cb = activeCandCount(b.id);
      if (ca !== cb) return cb - ca;
      if (a.election_date !== b.election_date) {
        return a.election_date < b.election_date ? -1 : 1;
      }
      return a.id < b.id ? -1 : 1;
    })[0];
  }

  const buckets = new Map<string, VoterRace[]>();
  for (const r of vraces) {
    const k = dedupKey(r);
    const arr = buckets.get(k) ?? [];
    arr.push(r);
    buckets.set(k, arr);
  }

  const out: VoterRace[] = [];
  for (const [, group] of buckets) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    // The synthesized chamber key is coarse: distinct statewide offices with
    // no district number (Secretary of State, Superintendent, Mine Inspector)
    // all land in the same "other" bucket for a given date. Those are
    // genuinely different races, not duplicates. When every row in a bucket
    // is new-graph, dedup only WITHIN each office_id (same office, multiple
    // view rows) and keep distinct offices separate. The cross-bucket
    // collapse below is only for the legacy/new bridge case.
    if (group.every((r) => !r.is_legacy && r.office_id)) {
      const byOffice = new Map<string, VoterRace[]>();
      for (const r of group) {
        const arr = byOffice.get(r.office_id as string) ?? [];
        arr.push(r);
        byOffice.set(r.office_id as string, arr);
      }
      for (const [, officeGroup] of byOffice) {
        out.push(pickBestRace(officeGroup));
      }
      continue;
    }
    const sorted = [...group].sort((a, b) => {
      // Prefer non-legacy
      if (a.is_legacy !== b.is_legacy) return a.is_legacy ? 1 : -1;
      // More candidates wins
      const ca = activeCandCount(a.id);
      const cb = activeCandCount(b.id);
      if (ca !== cb) return cb - ca;
      // Sooner election wins
      if (a.election_date !== b.election_date) {
        return a.election_date < b.election_date ? -1 : 1;
      }
      // Stable
      return a.id < b.id ? -1 : 1;
    });
    out.push(sorted[0]);
  }

  // Nearest-upcoming collapse (AZ July-21 blocker fix). The resolver / voter
  // view can surface BOTH an upcoming primary (e.g. 2026-07-21) AND the later
  // general (2026-11-03) for the SAME office. `dedupKey` keys on election_date,
  // so those land in separate buckets and both survive — the voter sees a
  // candidate-bearing primary card AND an empty "No candidates" general card
  // for every office. Product rule: when an office has an upcoming primary and
  // a later general, show ONLY the nearest upcoming election (the primary);
  // when only a general exists, show it. `renderBallotFromIds` already filtered
  // to election_date >= today, so "earliest date" == "nearest upcoming".
  //
  // We fingerprint "the same seat" by office_id when present (new-graph rows
  // always carry it) and fall back to the same level|chamber|district key used
  // for cross-legacy dedup. This runs on BOTH the district and precinct paths
  // because both converge here, keeping their behavior consistent.
  return collapseToNearestUpcoming(out);
}

/**
 * Collapse multiple upcoming elections for the SAME seat down to the nearest
 * one. Groups by office_id (new-graph) or a level|chamber|district fingerprint
 * (legacy), then keeps the earliest election_date in each group — which, given
 * the upstream `election_date >= today` filter, is the nearest upcoming
 * contest (the primary when a primary + general both exist). Distinct offices
 * that share no fingerprint are untouched.
 */
function collapseToNearestUpcoming(races: VoterRace[]): VoterRace[] {
  function seatKey(r: VoterRace): string {
    if (!r.is_legacy && r.office_id) return `office:${r.office_id}`;
    const lower = r.name.toLowerCase();
    let chamber = "other";
    if (/\bsenat/i.test(r.name)) chamber = "senate";
    else if (/\bhouse|representative/i.test(r.name)) chamber = "house";
    else if (/\bgovernor/i.test(lower)) chamber = "governor";
    else if (/\bschool board|sboe/i.test(lower)) chamber = "schoolboard";
    else if (/\bcommission/i.test(lower)) chamber = "commission";
    else if (/\battorney general/i.test(lower)) chamber = "attorneygeneral";
    else if (/\btreasurer/i.test(lower)) chamber = "treasurer";
    else if (/\bauditor/i.test(lower)) chamber = "auditor";
    else if (/\bjudge|justice/i.test(lower)) chamber = "judicial";
    else if (/\bmayor/i.test(lower)) chamber = "mayor";
    else if (/\bcouncil/i.test(lower)) chamber = "council";
    const districtMatch = (r.district ?? r.name).match(/\b(\d+)\b/);
    const district = districtMatch ? districtMatch[1] : "";
    return `seat:${r.level}:${chamber}:${district}`;
  }

  const bySeat = new Map<string, VoterRace>();
  for (const r of races) {
    const key = seatKey(r);
    const cur = bySeat.get(key);
    if (!cur) {
      bySeat.set(key, r);
      continue;
    }
    // Keep the nearer (earlier) upcoming election. Tie-break stable by id so
    // the choice is deterministic across renders.
    if (
      r.election_date < cur.election_date ||
      (r.election_date === cur.election_date && r.id < cur.id)
    ) {
      bySeat.set(key, r);
    }
  }
  return [...bySeat.values()];
}

/**
 * Internal precinct-deterministic loader. Pure function of `precinctId` —
 * no session, address, or user state in here. Wrapped in `unstable_cache`
 * below so election-week burst converts to cache hits.
 *
 * Returns the same shape as the public `loadBallot()`, but with `quality`
 * serialized as plain entries (Maps don't survive Next.js cache encoding).
 */
async function loadBallotUncached(
  precinctId: string,
): Promise<{
  races: BallotRace[];
  qualityEntries: Array<[string, RaceDataQuality]>;
  bridgeStats: { legacy: number; newGraph: number };
} | null> {
  // Use the service client inside the cache scope: cookies()-based clients
  // can't be constructed inside `unstable_cache` (Next 16 throws). All data
  // read here is public-read RLS (precincts, races, v_voter_*, positions,
  // candidate_sources) so dropping the session-token header is safe.
  const supabase = await createServiceClient();

  // Get race_ids AND election_ids from the user's precinct. race_ids holds
  // LEGACY race UUIDs; election_ids (populated for ~3.3K precincts) holds
  // office-graph election UUIDs directly — the bridge that lets municipal /
  // school / special / judicial office-graph races surface per-precinct
  // (Phase 3 criterion #2). We union both id sets below.
  const { data: precinct } = await supabase
    .from("precincts")
    .select("race_ids, election_ids")
    .eq("id", precinctId)
    .single();

  const legacyRaceIds: string[] =
    precinct?.race_ids && Array.isArray(precinct.race_ids)
      ? (precinct.race_ids as string[])
      : [];
  const directElectionIds: string[] =
    precinct?.election_ids && Array.isArray(precinct.election_ids)
      ? (precinct.election_ids as string[])
      : [];

  if (legacyRaceIds.length === 0 && directElectionIds.length === 0) {
    return null;
  }

  // The precinct.race_ids[] holds LEGACY race UUIDs only. To reach the
  // office-graph world we ALSO walk via races.election_id → elections.id
  // and surface those new-world races alongside the legacy rows.
  const { data: bridgeRows } = legacyRaceIds.length
    ? await supabase
        .from("races")
        .select("id, election_id")
        .in("id", legacyRaceIds)
    : { data: [] as Array<{ id: string; election_id: string | null }> };

  const electionIds: string[] = (bridgeRows ?? [])
    .map((r) => (r as { election_id: string | null }).election_id)
    .filter((x): x is string => typeof x === "string");

  // Union: legacy race UUIDs + bridged election UUIDs (legacy->graph) +
  // precinct.election_ids (direct office-graph links). Dedup defensively.
  const allIds = [
    ...new Set([...legacyRaceIds, ...electionIds, ...directElectionIds]),
  ];

  return renderBallotFromIds(supabase, allIds);
}

/**
 * Render the ballot from an explicit set of v_voter_races ids (which are
 * legacy race UUIDs for legacy rows and election UUIDs for office-graph rows).
 * Shared by BOTH the precinct path (which derives ids from the precinct) and
 * the district path (which derives election ids from point-in-polygon against
 * political_districts). Everything from the upcoming-election filter down is
 * identical, so it lives here once.
 */
async function renderBallotFromIds(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  allIds: string[],
): Promise<{
  races: BallotRace[];
  qualityEntries: Array<[string, RaceDataQuality]>;
  bridgeStats: { legacy: number; newGraph: number };
} | null> {
  if (allIds.length === 0) return null;

  // ISSUE A: filter to upcoming elections only. Past elections are noise on
  // the ballot view. Use a date string at midnight UTC so the comparison is
  // inclusive of today (election day itself stays visible).
  const todayIso = new Date().toISOString().slice(0, 10);

  const { data: vraceData, error } = await supabase
    .from("v_voter_races")
    .select(
      "id, name, level, district, election_date, election_type, state_fips, office_id, election_id, legacy_race_id, is_legacy",
    )
    .in("id", allIds)
    .gte("election_date", todayIso)
    .order("election_date", { ascending: true });

  if (error || !vraceData) return null;

  const vracesAll = vraceData as VoterRace[];

  if (vracesAll.length === 0) {
    return {
      races: [],
      qualityEntries: [],
      bridgeStats: { legacy: 0, newGraph: 0 },
    };
  }

  // Pull candidates for all those races in one round-trip from the view.
  // Pull self_attested flag (added 20260502000004) along with the rest.
  const { data: vcandData } = await supabase
    .from("v_voter_candidates")
    .select(
      "id, race_id, name, office_name, office_level, state_fips, district_identifier, party, party_abbreviation, party_color, incumbent, is_legacy, legacy_candidate_id, bioguide_id, person_id, photo_url, bio, website_url, published, withdrew, self_attested, party_primary_date",
    )
    .in(
      "race_id",
      vracesAll.map((r) => r.id),
    )
    .eq("published", true);

  const vcands = (vcandData ?? []) as VoterCandidate[];
  const vcandsByRace = new Map<string, VoterCandidate[]>();
  for (const c of vcands) {
    const arr = vcandsByRace.get(c.race_id) ?? [];
    arr.push(c);
    vcandsByRace.set(c.race_id, arr);
  }

  // ISSUE B: dedup races representing the same office. After dedup, the
  // surviving race id is the one we'll render — but we still need its
  // candidates. Candidate maps already keyed by race_id, so no rekeying.
  const vraces = dedupRaces(vracesAll, vcandsByRace);

  // Compute data quality for surviving races. `positions` is keyed off the
  // legacy candidate id (the `candidates` table primary key), even for
  // new-graph candidacies — those have a `legacy_candidate_id` bridge that
  // points at the same row. So we resolve the position-lookup id per
  // candidate as `legacy_candidate_id ?? id` and use that everywhere the
  // positions table is queried. This is what makes the "well-documented"
  // count actually fire for new-graph rows.
  function positionId(c: VoterCandidate): string {
    return c.legacy_candidate_id ?? c.id;
  }

  // race_id → position-lookup ids (for tier computation)
  const lookupIdsByRace = new Map<string, string[]>();
  // race_id → display ids (the v_voter_candidates.id values that appear on
  // the rendered card — needed so we can map back from a positions hit to
  // the BallotCandidate.id to set wellDocumented=true)
  const displayToLookup = new Map<string, string>();
  for (const r of vraces) {
    const candidates = (vcandsByRace.get(r.id) ?? []).filter(
      (c) => c.published && !c.withdrew,
    );
    lookupIdsByRace.set(
      r.id,
      candidates.map((c) => positionId(c)),
    );
    for (const c of candidates) {
      displayToLookup.set(c.id, positionId(c));
    }
  }
  const quality = await computeRaceDataQualityBulk(supabase, lookupIdsByRace);

  // Per-candidate well-documented set. Reuses the same triple-check (≥10
  // high/medium-confidence positions AND ≥5 sources AND ≥2 source types)
  // as the per-race tier so the badge and the tier never disagree.
  // Counts come back keyed by the LOOKUP id (= legacy candidate id when
  // present); we translate to display ids for the BallotCandidate badge.
  const allLookupIds = [...lookupIdsByRace.values()].flat();
  const counts = await computeCandidateQualityCountsBulk(
    supabase,
    allLookupIds,
  );
  const wellDocumentedLookupIds = new Set<string>();
  for (const lookupId of allLookupIds) {
    const rec = counts.get(lookupId);
    if (rec && isWellDocumented(rec)) wellDocumentedLookupIds.add(lookupId);
  }
  const wellDocumentedIds = new Set<string>();
  for (const [displayId, lookupId] of displayToLookup) {
    if (wellDocumentedLookupIds.has(lookupId)) wellDocumentedIds.add(displayId);
  }

  const today = new Date();
  const racesShaped = voterRowsToBallotShape(
    vraces,
    vcandsByRace,
    wellDocumentedIds,
    today,
  );

  const bridgeStats = {
    legacy: vraces.filter((r) => r.is_legacy).length,
    newGraph: vraces.filter((r) => !r.is_legacy).length,
  };

  // Map → entries so the cache layer (which uses structured cloning on its
  // serialization path) returns the data intact across cache hits. The
  // public loadBallot() rehydrates back into a Map for the renderer.
  return { races: racesShaped, qualityEntries: [...quality.entries()], bridgeStats };
}

/**
 * Public ballot loader. Thin wrapper around the cached precinct-deterministic
 * loader — rehydrates the qualityEntries → Map shape for the renderer.
 *
 * Cache key: ['ballot-load-v1', precinctId]
 * TTL: 600s (10 min) — voter-facing content tolerates ~10min staleness;
 *      election-week burst absorbs cleanly.
 * Tags: ['ballot', `precinct:${precinctId}`] — invalidate by tag from server
 *       actions after a precinct-affecting write.
 */
export async function loadBallot(
  precinctId: string,
): Promise<{
  races: BallotRace[];
  quality: Map<string, RaceDataQuality>;
  bridgeStats: { legacy: number; newGraph: number };
} | null> {
  const cached = unstable_cache(
    async (pid: string) => loadBallotUncached(pid),
    ['ballot-load-v1', precinctId],
    {
      revalidate: 600,
      tags: ['ballot', `precinct:${precinctId}`],
    },
  );
  const result = await cached(precinctId);
  if (!result) return null;
  return {
    races: result.races,
    quality: new Map(result.qualityEntries),
    bridgeStats: result.bridgeStats,
  };
}

/**
 * District-based ballot loader for addresses OUTSIDE Utah's loaded precincts.
 * Geocodes the address (persistent cache), resolves the containing districts
 * by point-in-polygon against `political_districts`, maps them + the state's
 * statewide offices to their upcoming elections, then renders through the SAME
 * `renderBallotFromIds` path the precinct flow uses.
 *
 * Cache key is the address hash so the election-week burst on a shared address
 * collapses to cache hits (mirrors the precinct-keyed cache). Returns null
 * coverage (empty races) exactly like the precinct loader so the page's
 * no-coverage state fires honestly.
 */
export async function loadBallotForAddress(
  address: string,
): Promise<{
  races: BallotRace[];
  quality: Map<string, RaceDataQuality>;
  bridgeStats: { legacy: number; newGraph: number };
  districts: { district_type: string; district_number: string }[];
} | null> {
  const cached = unstable_cache(
    async (addr: string) => {
      const supabase = await createServiceClient();
      // Geocode (persistent cache in geocode_cache). Territory addresses come
      // back as a structured error object; we only proceed for real coords.
      const coords = await geocodeAddress(addr);
      if (!coords || "error" in coords) return null;

      const { electionIds, districts } = await resolveDistrictBallotElectionIds(
        coords.lat,
        coords.lng,
        supabase,
      );
      if (electionIds.length === 0) {
        // Point resolved but no coverage (no loaded districts, or no upcoming
        // elections for the matched offices). Surface districts for debug/copy.
        return {
          races: [] as BallotRace[],
          qualityEntries: [] as Array<[string, RaceDataQuality]>,
          bridgeStats: { legacy: 0, newGraph: 0 },
          districts: districts.map((d) => ({
            district_type: d.district_type,
            district_number: d.district_number,
          })),
        };
      }

      const rendered = await renderBallotFromIds(supabase, electionIds);
      return {
        races: rendered?.races ?? [],
        qualityEntries: rendered?.qualityEntries ?? [],
        bridgeStats: rendered?.bridgeStats ?? { legacy: 0, newGraph: 0 },
        districts: districts.map((d) => ({
          district_type: d.district_type,
          district_number: d.district_number,
        })),
      };
    },
    // Cache key carries BALLOT_CACHE_VERSION (colocated with the resolver) so a
    // resolver-logic change forces a key bump. It went v1 -> v2 when the
    // "nearest upcoming election" collapse landed: a v1 key could otherwise
    // serve a stale pre-collapse double-race payload for up to the 600s TTL.
    [`ballot-load-address-${BALLOT_CACHE_VERSION}`, address],
    { revalidate: 600, tags: ["ballot", `address:${address}`] },
  );
  const result = await cached(address);
  if (!result) return null;
  return {
    races: result.races,
    quality: new Map(result.qualityEntries),
    bridgeStats: result.bridgeStats,
    districts: result.districts,
  };
}

/**
 * Election-id ballot loader. Renders straight from a stored set of upcoming
 * election ids (the office-graph election UUIDs the district resolver produced
 * at lookup time and persisted on the user), through the SAME
 * `renderBallotFromIds` path the precinct + address flows use. This is what lets
 * a non-Utah session render its ballot WITHOUT re-geocoding a stored plaintext
 * address: the geography was resolved once at lookup and cached as ids.
 *
 * Cache key is a stable hash of the sorted id set (BALLOT_CACHE_VERSION-tagged
 * so a resolver change forces a miss). Returns null when the id set is empty.
 */
export async function loadBallotForElectionIds(
  electionIds: string[],
): Promise<{
  races: BallotRace[];
  quality: Map<string, RaceDataQuality>;
  bridgeStats: { legacy: number; newGraph: number };
} | null> {
  const ids = [...new Set(electionIds)].filter((x) => typeof x === "string" && x);
  if (ids.length === 0) return null;
  // Stable key: sorted ids joined. Small sets, so a plain join is fine; the
  // BALLOT_CACHE_VERSION prefix mirrors loadBallotForAddress so a resolver-logic
  // change invalidates both.
  const keyPart = [...ids].sort().join(",");
  const cached = unstable_cache(
    async (idsCsv: string) => {
      const supabase = await createServiceClient();
      return renderBallotFromIds(supabase, idsCsv.split(","));
    },
    [`ballot-load-elections-${BALLOT_CACHE_VERSION}`, keyPart],
    { revalidate: 600, tags: ["ballot"] },
  );
  const result = await cached(keyPart);
  if (!result) return null;
  return {
    races: result.races,
    quality: new Map(result.qualityEntries),
    bridgeStats: result.bridgeStats,
  };
}

/**
 * Session-convenience wrapper. Mirrors the precinct-vs-geography decision that
 * `/ballot`'s page component makes: the precinct path (Utah early-validation
 * coverage) stays authoritative where a `precinct_id` exists because it carries
 * precinct-level local races the district path can't resolve; otherwise the
 * state-generic path renders from the resolved election ids stored at lookup
 * time. Returns null when neither a precinct nor stored geography is available.
 *
 * PRIVACY: this no longer re-geocodes a stored plaintext address in the normal
 * path. The server persists only resolved geography (precinct_id, or
 * resolved_election_ids), never the raw address. The `address_text` fallback
 * below is a PRE-MIGRATION compatibility path ONLY: it fires for old rows that
 * still carry an address but have no resolved_election_ids yet (i.e. rows
 * written before the null-out migration ran). New lookups never take it.
 *
 * This is the single entry point the live guide provider uses so the guide and
 * `/ballot` resolve identically for the same session.
 */
export async function loadBallotForSession(
  user: Pick<
    User,
    "precinct_id" | "address_text" | "resolved_election_ids"
  > | null,
  addressOverride?: string,
): Promise<{
  races: BallotRace[];
  quality: Map<string, RaceDataQuality>;
  bridgeStats: { legacy: number; newGraph: number };
} | null> {
  if (user?.precinct_id) {
    return loadBallot(user.precinct_id);
  }

  // Preferred non-precinct path: render from the election ids resolved once at
  // lookup time. No re-geocode, no stored address needed.
  const storedIds = user?.resolved_election_ids;
  if (Array.isArray(storedIds) && storedIds.length > 0) {
    return loadBallotForElectionIds(storedIds);
  }

  // PRE-MIGRATION fallback ONLY (see header): an old row that still has a
  // plaintext address but no resolved ids. Re-geocode it so nothing breaks
  // before the operator applies the null-out migration. An explicit addressOverride
  // (e.g. the /ballot ?address= query) also takes this path.
  const address = addressOverride ?? user?.address_text ?? "";
  if (!address) return null;
  const loaded = await loadBallotForAddress(address);
  if (!loaded) return null;
  return {
    races: loaded.races,
    quality: loaded.quality,
    bridgeStats: loaded.bridgeStats,
  };
}

/**
 * Resolve the raw `v_voter_races` id set for a session, the SAME way the ballot
 * renders — the precinct path (legacy race UUIDs + bridged election UUIDs +
 * precinct.election_ids) or the state-generic path (the election ids resolved
 * once at lookup time and stored on the user). This is the counterpart to
 * `loadBallotForSession`: the on-device bundle path (`/api/positions-bundle`)
 * needs the id set to fetch candidates/positions, not the fully-shaped
 * BallotRace[].
 *
 * Returns the union id set so a district-path (non-precinct) session — every
 * non-Utah voter — can be scored exactly like a precinct voter. Returns [] when
 * neither a precinct nor stored geography resolves any coverage.
 *
 * PRIVACY: the non-precinct path reads the pre-resolved `resolved_election_ids`
 * off the user, so it never re-geocodes a stored plaintext address. The
 * `address_text` re-geocode below is a PRE-MIGRATION fallback ONLY, for old rows
 * that still carry an address but no resolved ids (written before the null-out
 * migration). New lookups store the ids and never take that path.
 *
 * Uses the service client: every table read here (precincts, races, v_voter_*)
 * is public-read, and this runs from route handlers where the session-token
 * header is not needed for these public reads. It never reads or writes
 * user-scoped rows.
 */
export async function resolveSessionRaceIds(
  user: Pick<
    User,
    "precinct_id" | "address_text" | "resolved_election_ids"
  > | null,
): Promise<string[]> {
  const supabase = await createServiceClient();

  // Precinct path (Utah early-validation coverage): union legacy race UUIDs,
  // the elections those legacy races bridge to, and any direct office-graph
  // election links on the precinct. Mirrors loadBallotUncached exactly.
  if (user?.precinct_id) {
    const { data: precinct } = await supabase
      .from("precincts")
      .select("race_ids, election_ids")
      .eq("id", user.precinct_id)
      .single();

    const legacyRaceIds: string[] =
      precinct?.race_ids && Array.isArray(precinct.race_ids)
        ? (precinct.race_ids as string[])
        : [];
    const directElectionIds: string[] =
      precinct?.election_ids && Array.isArray(precinct.election_ids)
        ? (precinct.election_ids as string[])
        : [];

    if (legacyRaceIds.length === 0 && directElectionIds.length === 0) {
      return [];
    }

    const { data: bridgeRows } = legacyRaceIds.length
      ? await supabase.from("races").select("id, election_id").in("id", legacyRaceIds)
      : { data: [] as Array<{ id: string; election_id: string | null }> };

    const electionIds: string[] = (bridgeRows ?? [])
      .map((r) => (r as { election_id: string | null }).election_id)
      .filter((x): x is string => typeof x === "string");

    return [...new Set([...legacyRaceIds, ...electionIds, ...directElectionIds])];
  }

  // Preferred non-precinct path: the district resolver already ran at lookup
  // time and its election ids are stored on the user. No re-geocode, no stored
  // address needed.
  const storedIds = user?.resolved_election_ids;
  if (Array.isArray(storedIds) && storedIds.length > 0) {
    return [...new Set(storedIds.filter((x) => typeof x === "string" && x))];
  }

  // PRE-MIGRATION fallback ONLY (see header): an old row that still carries a
  // plaintext address but has no resolved ids yet. Re-geocode + re-resolve so
  // scoring keeps working until the operator applies the null-out migration.
  const address = user?.address_text ?? "";
  if (!address) return [];

  const coords = await geocodeAddress(address);
  if (!coords || "error" in coords) return [];

  const { electionIds } = await resolveDistrictBallotElectionIds(
    coords.lat,
    coords.lng,
    supabase,
  );
  return [...new Set(electionIds)];
}
