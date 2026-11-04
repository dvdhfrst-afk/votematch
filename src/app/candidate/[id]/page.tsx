import Link from "next/link";
import { redirect } from "next/navigation";
import type { CandidateWithPositions, Position, SubDimension, Domain } from "@/types/database";
import TwoViewPositionsGrid from "@/components/candidate/TwoViewPositionsGrid";
import PositionCard from "@/components/candidate/PositionCard";
import BackButton from "@/components/ui/BackButton";
import DeepLinkConvertCTA from "@/components/ui/DeepLinkConvertCTA";
import DataQualityBadge, { type DataQualityTier as CatalogTier } from "@/components/DataQualityBadge";
import { createClient } from "@/lib/supabase/server";
import { isGuideProviderReady } from "@/lib/guide/provider";
import { getSubDimensionsCached } from "@/lib/supabase/cached";
import { shouldShowGatheringState } from "@/lib/candidate/display-gate";
import { formatCandidateName } from "@/lib/text/candidate-name";
import { sanitizeDisplayName } from "@/lib/text/sanitize-display";

// 5-minute ISR. Voter-facing content (voting record + CF strip) tolerates
// 5min staleness — ingest output lands daily, not by-the-second. Trades the
// per-render `noStore()` (which disabled all caching) for a much cheaper
// burst profile during election week. Council 2026-05-02: this is the
// single biggest perf win on the candidate page.
export const revalidate = 300;

// Two-view feature flag (council decision 007 §7). When off (default),
// render the legacy single-view PositionCard — voters see the inferred row
// (current behavior, v_latest_positions picks the latest). When on, render
// the TwoViewPositionCard stated+inferred comparison.
const TWO_VIEW_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_TWO_VIEW === 'true';

interface SourceCoverage {
  total_sources: number;
  tier_1_sources: number;
  voting_records: number;
  questionnaire_responses: number;
  shared_race_coverage: number;
  high_conf_positions: number;
  med_conf_positions: number;
}

interface TierInfo {
  tier: 'A' | 'B' | 'C';
  source_count: number;
  source_type_count: number;
  high_conf_position_count: number;
}

/** A federal roll-call vote position attributed to this candidate. */
interface RecentVote {
  position: string;
  roll_call: number | null;
  chamber: string | null;
  vote_date: string | null;
  description: string | null;
  result: string | null;
}

/** Aggregated state-level campaign-finance summary for the strip. */
interface CfSummary {
  total_raised: number;
  donor_count: number;
  top_donors: Array<{ name: string; amount: number }>;
}

/**
 * Office-level freshness signal. Pulled from `offices` (and the
 * `v_offices_coverage` view in spirit — we read the underlying columns
 * so a missing view doesn't break the page). Only available for
 * new-graph candidacies that resolve to an office_id.
 */
interface OfficeFreshness {
  last_verified_at: string | null;
  last_candidate_check_at: string | null;
  sourcing_tier:
    | 'fec_federal'
    | 'sos_state'
    | 'sos_county'
    | 'filing_direct'
    | 'unsourced'
    | null;
  /**
   * Catalog provenance tier per notes/verified-definition.md.
   *   - 'authoritative': size_authoritative=TRUE OR research_extracted.authoritative=true
   *   - 'compiled':      inferred from compiled sources (e.g. state-law application)
   *   - 'default':       stub catalog entry, structural facts not yet checked
   * Distinct from `sourcing_tier` (which is about WHERE candidate filings come from)
   * and from `tier.tier` A/B/C (which is about candidate position coverage).
   */
  catalog_tier: CatalogTier;
}

async function loadCandidate(
  id: string
): Promise<{
  candidate: CandidateWithPositions;
  subDimensions: SubDimension[];
  /** Latest position per (sub_dim, view_type) — stated + inferred when both exist */
  positionsByView: Map<string, { stated: Position | null; inferred: Position | null }>;
  coverage: SourceCoverage;
  tier: TierInfo;
  /** Linked person (via people.legacy_candidate_ids) — null when no bridge exists yet. */
  personId: string | null;
  /** Most-recent federal roll-call positions (only set if person has bioguide_id). */
  recentVotes: RecentVote[];
  /** Aggregated state CF summary — null when nothing matched (or table not reachable). */
  cfSummary: CfSummary | null;
  /** Office freshness signal (new-graph only); null when not available. */
  officeFreshness: OfficeFreshness | null;
} | null> {
  const supabase = await createClient();

  // Try the unified view first (handles BOTH legacy candidate IDs and new
  // candidacy IDs from migration 20260425000008). When is_legacy=false the
  // row is a new-graph candidacy — we hand off to the office-graph rendering
  // (federal voting record + CF strip via /person/[id] paths).
  // When is_legacy=true, fall through to the legacy schema for positions.
  type VoterCandRow = {
    id: string;
    name: string;
    party: string | null;
    office_name: string | null;
    office_level: string;
    state_fips: string | null;
    district_identifier: string | null;
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
    race_id: string;
  };
  const { data: voterRow } = await supabase
    .from("v_voter_candidates")
    .select(
      "id, name, party, office_name, office_level, state_fips, district_identifier, incumbent, is_legacy, legacy_candidate_id, bioguide_id, person_id, photo_url, bio, website_url, published, withdrew, race_id",
    )
    .eq("id", id)
    .maybeSingle();
  const voterCand = voterRow as VoterCandRow | null;

  // For NEW candidacies (is_legacy=false): we have the row but the legacy
  // `candidates`+`positions` join doesn't apply. Render via the legacy
  // shape with empty positions and let the existing /person/[id] surfaces
  // (already wired further down in this loader) handle voting record + CF.
  // We construct a minimal candidate record so the existing UI doesn't
  // need to know the source.
  type CandLoaded = CandidateWithPositions;
  let candidate: CandLoaded | null = null;

  if (voterCand && !voterCand.is_legacy && voterCand.published) {
    // Build a synthetic legacy-shaped candidate from the new-graph row.
    const synthetic = {
      id: voterCand.id,
      name: voterCand.name,
      party: voterCand.party,
      race_id: voterCand.race_id,
      bio: voterCand.bio,
      photo_url: voterCand.photo_url,
      website_url: voterCand.website_url,
      questionnaire_status: "not_invited" as const,
      published: voterCand.published,
      created_at: "",
      updated_at: "",
      positions: [] as Position[],
      race: {
        id: voterCand.race_id,
        name: voterCand.office_name ?? "",
        level: (
          voterCand.office_level === "federal" ||
          voterCand.office_level === "state" ||
          voterCand.office_level === "county"
            ? voterCand.office_level
            : "county"
        ) as "federal" | "state" | "county",
        district: voterCand.district_identifier,
        election_date: "",
        type: "general" as const,
      },
    };
    candidate = synthetic as unknown as CandLoaded;
  } else {
    // Legacy path: fetch candidate with race info from the original tables.
    // This preserves all existing functionality (positions, sources, tier).
    const { data: legacyCandidate, error: cError } = await supabase
      .from("candidates")
      .select("*, race:races(*)")
      .eq("id", id)
      .eq("published", true)
      .single();
    if (cError || !legacyCandidate) return null;
    candidate = legacyCandidate as unknown as CandLoaded;
  }

  if (!candidate) return null;

  // For new-graph candidacies, the legacy `candidate_sources` keying off
  // candidate_id returns zero rows. But positions and candidate_tier_view are
  // now person-aware: positions carries a person_id column (backfilled for
  // legacy rows, set on person-native rows), and candidate_tier_view exposes a
  // person_id (migration 20260615020000). So we read positions and the tier by
  // person_id for new-graph candidacies instead of short-circuiting to empty.
  const isNewGraph = !!(voterCand && !voterCand.is_legacy);
  // The person_id of a new-graph candidacy comes straight from the voter view
  // (candidacies.person_id -> people). Legacy rows read positions by their own
  // candidate id, exactly as before.
  const newGraphPersonId =
    isNewGraph && voterCand ? voterCand.person_id : null;
  // Legacy pin for a new-graph candidacy: candidacies.legacy_candidate_id,
  // exposed by v_voter_candidates. For person-native AZ candidacies this equals
  // the people.id, and it is exactly the value research-write.ts stamped into
  // positions.candidate_id. See the read note below.
  const newGraphLegacyId =
    isNewGraph && voterCand ? voterCand.legacy_candidate_id : null;

  // Fetch positions (both views). Order by sub_dim, view, created_at desc
  // so we can grab the latest per (sub_dim, view) pair.
  //
  // Person-native read path (June 2026): a new-graph candidacy owns its
  // positions by person_id. BUT a real-data bug (fixed 2026-07 in
  // scripts/research-write.ts) left person_id NULL on positions the research
  // writer produced: it stamped ONLY candidate_id = candidacies.legacy_candidate_id.
  // For person-native candidacies that legacy id equals the people.id, so the
  // rows exist and are correct, they were just keyed by candidate_id instead of
  // person_id. A person_id-ONLY read missed them entirely and rendered
  // well-cited candidates (e.g. one Tier A candidate) as an empty page.
  //
  // Fix: read new-graph positions by EITHER identity, person_id OR the legacy
  // pin (candidate_id = legacy_candidate_id). This surfaces the existing
  // NULL-person rows immediately without waiting on the person_id backfill, and
  // is a no-op once the backfill runs and person_id is populated (the same row
  // matches both predicates; de-dup by sub_dim/view below keeps one). We reuse
  // the SAME select('*') + ordering + downstream selectPositionsForView/
  // view-filtering the legacy path uses, so all trust filters (council #51
  // empty-url drop, #62 source-tier, confidence='low' hide) apply identically
  // regardless of which identity keyed the fetch.
  const orKeys: string[] = [];
  if (newGraphPersonId) orKeys.push(`person_id.eq.${newGraphPersonId}`);
  if (newGraphLegacyId) orKeys.push(`candidate_id.eq.${newGraphLegacyId}`);
  const { data: positions, error: pError } =
    isNewGraph && orKeys.length > 0
      ? await supabase
          .from("positions")
          .select("*")
          .or(orKeys.join(","))
          .order("sub_dimension_id")
          .order("view_type")
          .order("created_at", { ascending: false })
      : isNewGraph
        ? // New-graph row with neither a person_id nor a legacy pin: nothing to
          // read by.
          { data: [] as Position[], error: null }
        : await supabase
            .from("positions")
            .select("*")
            .eq("candidate_id", id)
            .order("sub_dimension_id")
            .order("view_type")
            .order("created_at", { ascending: false });

  if (pError) return null;

  // Partition: latest per (sub_dim, view_type)
  const positionsByView = new Map<string, { stated: Position | null; inferred: Position | null }>();
  const seenPair = new Set<string>();
  for (const pos of (positions ?? []) as Position[]) {
    const key = pos.sub_dimension_id;
    const pairKey = `${key}:${pos.view_type}`;
    if (seenPair.has(pairKey)) continue;
    seenPair.add(pairKey);
    const entry = positionsByView.get(key) ?? { stated: null, inferred: null };
    if (pos.view_type === 'stated' && entry.stated === null) entry.stated = pos;
    if (pos.view_type === 'inferred' && entry.inferred === null) entry.inferred = pos;
    positionsByView.set(key, entry);
  }

  // Flat list of latest positions that cleared the display bar. A position with
  // `confidence = 'low'` is effectively "we don't have enough data to say" —
  // the nuance notes on low-confidence rows typically read "source data does
  // not provide specific information on the candidate's position." Rendering
  // these with a numeric score would be misleading, so we treat them as
  // missing for display purposes. Still stored in DB for audit + corrections.
  const latestPositions: Position[] = [];
  for (const pair of positionsByView.values()) {
    const best = [pair.inferred, pair.stated].find(
      (p): p is Position => p !== null && p.confidence !== 'low',
    );
    if (best) latestPositions.push(best);
  }

  // Fetch sub-dimensions for display. Cached at module level via
  // unstable_cache (1hr TTL, ['sub-dimensions'] tag) — 19 rows that change
  // maybe once per quarter, no point re-querying every render.
  const subDimensions = await getSubDimensionsCached();
  if (subDimensions.length === 0) return null;

  // Compute source-coverage stats for the candidate header badge. Separate
  // queries (small, fast) so the core page flow doesn't depend on a single
  // complex join.
  // candidate_sources is person-aware too (person_id added 20260603130000).
  // Read by person_id for new-graph rows so the coverage badge reflects the
  // candidate's real sourcing instead of an empty legacy join. Legacy rows
  // read by candidate_id exactly as before.
  const { data: sourceRows } =
    isNewGraph && newGraphPersonId
      ? await supabase
          .from("candidate_sources")
          .select("source_type, authenticity_tier, shared_race_coverage")
          .eq("person_id", newGraphPersonId)
      : isNewGraph
        ? { data: [] }
        : await supabase
            .from("candidate_sources")
            .select("source_type, authenticity_tier, shared_race_coverage")
            .eq("candidate_id", id);

  const coverage: SourceCoverage = {
    total_sources: sourceRows?.length ?? 0,
    tier_1_sources: 0,
    voting_records: 0,
    questionnaire_responses: 0,
    shared_race_coverage: 0,
    high_conf_positions: 0,
    med_conf_positions: 0,
  };
  for (const row of (sourceRows ?? []) as Array<{
    source_type: string;
    authenticity_tier: number;
    shared_race_coverage: boolean;
  }>) {
    if (row.authenticity_tier === 1) coverage.tier_1_sources += 1;
    if (row.source_type === "voting_record") coverage.voting_records += 1;
    if (row.source_type === "questionnaire") coverage.questionnaire_responses += 1;
    if (row.shared_race_coverage) coverage.shared_race_coverage += 1;
  }
  for (const pos of latestPositions) {
    if (pos.confidence === "high") coverage.high_conf_positions += 1;
    else if (pos.confidence === "medium") coverage.med_conf_positions += 1;
  }

  // Pull the authoritative tier from candidate_tier_view. The view applies
  // shared_race_coverage exclusion and the same thresholds used across the
  // rest of the product, so UI can't drift from audit/methodology numbers.
  // candidate_tier_view is person-aware (migration 20260615020000): each row
  // exposes candidate_id AND/OR person_id, and the source counts UNION the
  // legacy candidate_id-keyed and new-graph person_id-keyed sources. So a
  // new-graph candidate is evaluated on its REAL sources by person_id instead
  // of defaulting to Tier C on a legacy-id miss. Thresholds are unchanged
  // (A=>=20/>=3, B=>=10/>=2, else C); only the identity keying is fixed.
  const { data: tierRow } =
    isNewGraph && newGraphPersonId
      ? await supabase
          .from("candidate_tier_view")
          .select(
            "tier, source_count, source_type_count, high_conf_position_count",
          )
          .eq("person_id", newGraphPersonId)
          .maybeSingle()
      : isNewGraph
        ? { data: null }
        : await supabase
            .from("candidate_tier_view")
            .select(
              "tier, source_count, source_type_count, high_conf_position_count",
            )
            .eq("candidate_id", id)
            .maybeSingle();

  const tier: TierInfo = tierRow
    ? {
        tier: tierRow.tier as 'A' | 'B' | 'C',
        source_count: tierRow.source_count as number,
        source_type_count: tierRow.source_type_count as number,
        high_conf_position_count: tierRow.high_conf_position_count as number,
      }
    : {
        tier: 'C',
        source_count: 0,
        source_type_count: 0,
        high_conf_position_count: 0,
      };

  // ------------------------------------------------------------------
  // Voter-facing surfaces for already-ingested data
  // ------------------------------------------------------------------
  // Council finding (2026-04-25): 4.16M federal_vote_positions rows and
  // 3.8M state_cf_events rows had ZERO voter-facing surface. The two
  // blocks below pull just enough to render a "Voting record" section
  // and a CF strip on the candidate page. Both queries are best-effort
  // — they must NEVER fail the page load.

  // 1. Linked person. Two paths:
  //    (a) New-graph candidacy: the voter view already exposes person_id +
  //        bioguide_id (joined via candidacies.person_id → people).
  //    (b) Legacy candidate: reverse-lookup people.legacy_candidate_ids[].
  //        Populated for ~352 UT migrations; null elsewhere.
  let personId: string | null = null;
  let bioguideId: string | null = null;
  if (isNewGraph && voterCand) {
    personId = voterCand.person_id;
    bioguideId = voterCand.bioguide_id;
  } else {
    try {
      const { data: personRow } = await supabase
        .from("people")
        .select("id, meta")
        .contains("legacy_candidate_ids", [id])
        .maybeSingle();
      if (personRow) {
        personId = personRow.id as string;
        const meta = personRow.meta as { bioguide_id?: string } | null;
        bioguideId = meta?.bioguide_id ?? null;
      }
    } catch {
      // Schema older than office-centric graph — skip silently.
    }
  }

  // 2. Federal voting record (only if we have a bioguide_id).
  //    Mirrors the /person/[id] query exactly — same join, same ordering.
  let recentVotes: RecentVote[] = [];
  if (bioguideId) {
    try {
      const { data } = await supabase
        .from("federal_vote_positions")
        .select(
          "position, vote:federal_votes(roll_call, chamber, vote_date, description, result)",
        )
        .eq("bioguide_id", bioguideId)
        .order("vote_id", { ascending: false })
        .limit(10);
      recentVotes = (data ?? []).map((vp) => {
        // The PostgREST `vote:federal_votes(...)` shape can be rendered as
        // either an object or a 1-element array depending on the generated
        // types — normalize through `unknown` to avoid fighting the typegen.
        const raw = vp as unknown as {
          position?: string;
          vote?:
            | { roll_call?: number; chamber?: string; vote_date?: string; description?: string; result?: string }
            | Array<{ roll_call?: number; chamber?: string; vote_date?: string; description?: string; result?: string }>
            | null;
        };
        const v = Array.isArray(raw.vote) ? raw.vote[0] : raw.vote;
        return {
          position: raw.position ?? "",
          roll_call: v?.roll_call ?? null,
          chamber: v?.chamber ?? null,
          vote_date: v?.vote_date ?? null,
          description: v?.description ?? null,
          result: v?.result ?? null,
        };
      });
    } catch {
      // federal_vote_positions may not be available yet — silently skip.
    }
  }

  // 3. State CF summary. Public-read RLS already filters verified=true +
  //    confidence ≥ 0.75 effectively (see migration 20260418000002). Try
  //    the resolved_person_id path first, then fall back to a fuzzy name
  //    match. The whole block must degrade gracefully — missing column
  //    or table errors should NOT break the page.
  let cfSummary: CfSummary | null = null;
  try {
    type CfRow = {
      event_type: string | null;
      amount: number | null;
      counterparty: string | null;
    };
    let cfRows: CfRow[] = [];

    if (personId) {
      const { data } = await supabase
        .from("state_cf_events")
        .select("event_type, amount, counterparty")
        .eq("resolved_person_id", personId);
      cfRows = (data ?? []) as CfRow[];
    }

    // Name-fuzzy fallback when the resolver hasn't linked the row yet.
    // We do not have race.state in the legacy schema, so we can only
    // narrow on candidate_name. False positives are acceptable for a
    // summary strip — exact name collisions across states are rare and
    // resolved_person_id will overwrite this path once ingestion catches up.
    if (cfRows.length === 0 && candidate.name) {
      const { data } = await supabase
        .from("state_cf_events")
        .select("event_type, amount, counterparty")
        .ilike("candidate_name", candidate.name);
      cfRows = (data ?? []) as CfRow[];
    }

    if (cfRows.length > 0) {
      // Money-in events: contributions + in_kind. Loans, expenditures,
      // independent expenditures, and filing rows are excluded from the
      // "raised" tally so the number reads like an FEC receipts total.
      const incomeTypes = new Set(["contribution", "in_kind"]);
      let totalRaised = 0;
      const donorTotals = new Map<string, number>();
      for (const r of cfRows) {
        if (!r.event_type || !incomeTypes.has(r.event_type)) continue;
        const amt = typeof r.amount === "number" ? r.amount : Number(r.amount ?? 0);
        if (!Number.isFinite(amt) || amt <= 0) continue;
        totalRaised += amt;
        const cp = (r.counterparty ?? "").trim() || "(undisclosed)";
        donorTotals.set(cp, (donorTotals.get(cp) ?? 0) + amt);
      }
      const topDonors = [...donorTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, amount]) => ({ name, amount }));

      if (totalRaised > 0 || donorTotals.size > 0) {
        cfSummary = {
          total_raised: totalRaised,
          donor_count: donorTotals.size,
          top_donors: topDonors,
        };
      }
    }
  } catch {
    // state_cf_events not yet provisioned, missing column, or RLS
    // blocked — leave cfSummary null and hide the strip.
    cfSummary = null;
  }

  // 4. Office-level freshness. Only meaningful for new-graph candidacies
  //    where the race resolves to an office. We chase elections.office_id
  //    → offices.{last_verified_at, last_candidate_check_at, sourcing_tier}.
  //    Best-effort: a missing column or RLS denial leaves freshness null
  //    and the surface degrades to "verification pending".
  let officeFreshness: OfficeFreshness | null = null;
  if (isNewGraph && voterCand) {
    try {
      const { data: electionRow } = await supabase
        .from("elections")
        .select("office_id")
        .eq("id", voterCand.race_id)
        .maybeSingle();
      const officeId = (electionRow as { office_id?: string | null } | null)?.office_id ?? null;
      if (officeId) {
        const { data: officeRow } = await supabase
          .from("offices")
          .select("last_verified_at, last_candidate_check_at, sourcing_tier, meta")
          .eq("id", officeId)
          .maybeSingle();
        if (officeRow) {
          const r = officeRow as {
            last_verified_at: string | null;
            last_candidate_check_at: string | null;
            sourcing_tier: string | null;
            meta: Record<string, unknown> | null;
          };
          // Derive catalog tier per the predicate in
          // notes/verified-definition.md.  Source of truth (priority order):
          //   1. offices.meta.data_quality_tier (admin-set value)
          //   2. offices.meta.research_extracted.authoritative (research agent)
          //   3. fall back to 'compiled' when the office row exists but the
          //      structural facts haven't been research-verified
          //   4. 'default' when the office row is a stub (no meta at all)
          const explicit =
            (r.meta?.["data_quality_tier"] as CatalogTier) ?? null;
          const researchExtracted = r.meta?.["research_extracted"] as
            | { authoritative?: boolean }
            | undefined;
          const authoritativeByResearch =
            researchExtracted?.authoritative === true;
          const catalogTier: CatalogTier =
            explicit ??
            (authoritativeByResearch
              ? 'authoritative'
              : r.meta && Object.keys(r.meta).length > 0
                ? 'compiled'
                : 'default');
          officeFreshness = {
            last_verified_at: r.last_verified_at,
            last_candidate_check_at: r.last_candidate_check_at,
            sourcing_tier: (r.sourcing_tier as OfficeFreshness["sourcing_tier"]) ?? null,
            catalog_tier: catalogTier,
          };
        }
      }
    } catch {
      // Schema older than freshness migration — leave null.
      officeFreshness = null;
    }
  }

  // Display normalization applied once here so every downstream surface
  // (header, JSON-LD, copy, initials, mailto) sees the clean form. Raw FEC /
  // voter-file candidate names get formatted ("SAMPLETON, EDGAR J MR" ->
  // "Edgar J Sampleton"); race/office names get em/en dashes stripped. DB data
  // is untouched — this is a render transform only.
  const displayCandidate = {
    ...candidate,
    name: formatCandidateName(candidate.name),
    positions: latestPositions,
  } as CandidateWithPositions;
  if (displayCandidate.race) {
    displayCandidate.race = {
      ...displayCandidate.race,
      name: sanitizeDisplayName(displayCandidate.race.name),
    };
  }

  return {
    candidate: displayCandidate,
    subDimensions: subDimensions as SubDimension[],
    positionsByView,
    coverage,
    tier,
    personId,
    recentVotes,
    cfSummary,
    officeFreshness,
  };
}

export default async function CandidatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ race?: string }>;
}) {
  const { id } = await params;

  // A1 canonical swap (REDESIGN-MAP): /guide is the canonical voter path once
  // the live provider is wired. The legacy candidate id IS the guide candidate
  // id — both key on v_voter_candidates.id — so the mapping is identity. Forward
  // the race context when present (the guide route re-resolves it otherwise).
  // This page stays intact below the gate as the mock/disabled fallback.
  if (isGuideProviderReady()) {
    const { race } = await searchParams;
    redirect(
      race
        ? `/guide/candidate/${id}?race=${encodeURIComponent(race)}`
        : `/guide/candidate/${id}`,
    );
  }

  const data = await loadCandidate(id);

  if (!data) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-[var(--color-primary)] mb-4">
            Candidate not found
          </h1>
          <Link href="/" className="civic-btn-primary">
            Go Home
          </Link>
        </div>
      </main>
    );
  }

  const {
    candidate,
    subDimensions,
    positionsByView,
    coverage,
    tier,
    personId,
    recentVotes,
    cfSummary,
    officeFreshness,
  } = data;
  const subDimMap = Object.fromEntries(subDimensions.map((sd) => [sd.id, sd]));

  // Trust model + Tier-C floor (see src/lib/candidate/display-gate.ts for the
  // full rationale + thresholds). Two carve-outs to the source-coverage floor:
  //   1. a candidate's OWN affirmed words (view_type='stated',
  //      confidence='candidate_direct') always render — the floor governs thin
  //      inferred guesses, not attestation; and
  //   2. any high/medium-confidence position renders — high/medium is the trust
  //      signal the entailment gate + write guards already earned upstream, so
  //      suppressing a well-cited entailment-passed inferred position behind a
  //      coverage source_count floor tuned for a different pipeline was wrong
  //      (it rendered Tier-A/entailment-passed AZ candidates as an empty page).
  // We show the "still gathering sources" stub ONLY when the candidate is below
  // the floor (Tier C) AND has no renderable position at all. The per-position
  // confidence badges, inferred labeling, two-view distinction, and the
  // "source coverage is thin" warning all still fire below regardless.
  //
  // NOTE: candidate.positions is `latestPositions`, which already dropped
  // confidence='low' rows, so the gate operates on positions that cleared the
  // per-view low-confidence hide.
  const showGatheringState = shouldShowGatheringState(
    tier.tier,
    candidate.positions,
  );

  const initials = candidate.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // Group positions by domain
  const positionsByDomain = candidate.positions.reduce(
    (acc, pos) => {
      const sd = subDimMap[pos.sub_dimension_id];
      if (!sd) return acc;
      const domain = sd.domain;
      if (!acc[domain]) acc[domain] = [];
      acc[domain].push(pos);
      return acc;
    },
    {} as Record<Domain, typeof candidate.positions>
  );

  // Council #58 (2026-05-11, distribution): Person JSON-LD on candidate
  // detail pages so Google can surface candidates as rich-result entities
  // when voters search "[Candidate Name] [office]". Pairs with council #50's
  // Event JSON-LD on the homepage. No DB query needed — uses already-loaded
  // candidate + race data.
  const personJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: candidate.name,
    ...(candidate.party ? { affiliation: { '@type': 'Organization', name: candidate.party } } : {}),
    ...(candidate.race?.name ? { jobTitle: `Candidate for ${candidate.race.name}` } : {}),
    ...(candidate.website_url ? { url: candidate.website_url } : {}),
  };

  return (
    <main className="min-h-screen bg-[var(--color-bg-alt)]">
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd) }}
      />
      {/* Header */}
      <header className="bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="civic-container py-4 flex items-center gap-4">
          <Link
            href="/"
            className="text-xl font-bold text-[var(--color-primary)]"
          >
            Havesay
          </Link>
        </div>
      </header>

      <div className="civic-container py-8">
        <div className="max-w-3xl mx-auto">
          <DeepLinkConvertCTA />
          {/* Back link */}
          <BackButton />

          {/* Candidate header */}
          <div className="civic-card mt-4">
            <div className="flex items-start gap-5">
              {/* Photo */}
              <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-[var(--color-bg-muted)] flex items-center justify-center text-[var(--color-primary)] font-bold text-2xl shrink-0">
                {candidate.photo_url ? (
                  <img
                    src={candidate.photo_url}
                    alt={candidate.name}
                    className="w-full h-full rounded-full object-cover"
                  />
                ) : (
                  initials
                )}
              </div>

              <div className="flex-1">
                <div className="flex items-start gap-2 flex-wrap">
                  <h1 className="text-2xl sm:text-3xl font-extrabold text-[var(--color-text)]">
                    {candidate.name}
                  </h1>
                  <CoverageTierBadge tier={tier.tier} />
                  {/* Catalog provenance badge — verified / compiled / template.
                      Orthogonal to CoverageTierBadge (which is about position
                      coverage A/B/C). See notes/verified-definition.md. */}
                  {officeFreshness?.catalog_tier && (
                    <DataQualityBadge
                      tier={officeFreshness.catalog_tier}
                      lastVerified={officeFreshness.last_verified_at}
                      size="sm"
                    />
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  <span className="text-sm font-medium text-[var(--color-text-secondary)]">
                    {candidate.party ?? "Party not yet filed"}
                  </span>
                  <span className="text-sm text-[var(--color-text-muted)]">
                    {candidate.race.name}
                  </span>
                </div>

                {/* Freshness line — voter-facing receipt that the office's
                    candidate list was checked recently. NULL renders as
                    "verification pending" so absence reads as integrity, not
                    a bug. Only rendered when we have any freshness signal at
                    all (i.e. a new-graph candidacy with an office_id). */}
                {officeFreshness && (
                  <FreshnessLine freshness={officeFreshness} />
                )}

                {/* Filing-direct / unsourced disclosure: these tiers map to
                    offices we haven't yet automated. Tell voters why before
                    they assume the data is missing. */}
                {officeFreshness &&
                  (officeFreshness.sourcing_tier === "filing_direct" ||
                    officeFreshness.sourcing_tier === "unsourced") && (
                    <p className="mt-1 text-xs text-[var(--color-text-muted)] italic">
                      Filings for this office come from the{" "}
                      {candidate.race.level === "county"
                        ? "county"
                        : "municipal"}{" "}
                      clerk and are not yet automated.
                    </p>
                  )}

                {candidate.website_url && (
                  <a
                    href={candidate.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-2 text-sm text-[var(--color-primary)] hover:underline"
                  >
                    Campaign website
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}

                {candidate.questionnaire_status === "responded" && (
                  <span className="inline-flex items-center gap-1.5 mt-2 text-xs font-medium text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full">
                    <svg
                      className="w-3.5 h-3.5"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Responded to questionnaire
                  </span>
                )}
              </div>
            </div>

            {/* Bio — empty-state copy convention: when the candidate hasn't
                given us a statement, say so plainly. The phrasing mirrors
                the per-position "has not stated a public position" note,
                so absence reads as integrity, not a missing field. */}
            <div className="mt-5 pt-5 border-t border-[var(--color-border)]">
              <h2 className="text-sm font-bold text-[var(--color-text-muted)] uppercase tracking-wide mb-2">
                About
              </h2>
              {candidate.bio ? (
                <p className="text-[var(--color-text-secondary)] leading-relaxed">
                  {candidate.bio}
                </p>
              ) : (
                <p className="text-[var(--color-text-muted)] italic leading-relaxed">
                  Candidate has not yet provided a statement.
                </p>
              )}
            </div>
          </div>

          {/* Campaign-finance summary strip — derived from state_cf_events
              (verified rows only, public-read RLS). Hidden entirely when no
              rows match this candidate. Council finding 2026-04-25: 3.8M
              CF rows had zero voter-facing surface before this strip. */}
          {cfSummary && (
            <CampaignFinanceStrip
              candidateId={candidate.id}
              summary={cfSummary}
            />
          )}

          {/* Positions — blueprint-v6 §7 disclosure: list every active
              sub_dimension. If the candidate has a cited position, show it.
              If not, show "has not stated a public position" rather than
              leaving the dimension invisible (never-impute rule). */}
          {/* Source coverage summary — helps users calibrate trust */}
          <div className="mt-8 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-sm">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
              Source coverage
            </h3>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[var(--color-text-secondary)]">
              <span>
                <strong className="text-[var(--color-text)]">{coverage.total_sources}</strong>{" "}
                total {coverage.total_sources === 1 ? "source" : "sources"}
              </span>
              {coverage.tier_1_sources > 0 && (
                <span>
                  <strong className="text-[var(--color-text)]">{coverage.tier_1_sources}</strong>{" "}
                  primary-source tier-1
                </span>
              )}
              {coverage.voting_records > 0 && (
                <span>
                  <strong className="text-[var(--color-text)]">{coverage.voting_records}</strong>{" "}
                  voting record{coverage.voting_records === 1 ? "" : "s"}
                </span>
              )}
              {coverage.questionnaire_responses > 0 && (
                <span className="text-emerald-700">
                  <strong>✓</strong> Questionnaire response on file
                </span>
              )}
              {coverage.shared_race_coverage > 0 && (
                <span className="text-amber-700">
                  ⚠ {coverage.shared_race_coverage} flagged as shared race coverage
                </span>
              )}
              <span className="ml-auto">
                <strong className="text-[var(--color-text)]">
                  {coverage.high_conf_positions + coverage.med_conf_positions}
                </strong>{" "}
                of {subDimensions.length} dimensions classified
              </span>
            </div>
            {coverage.total_sources > 0 && coverage.high_conf_positions + coverage.med_conf_positions === 0 && (
              <p className="mt-2 text-xs text-amber-800">
                We have source material for this candidate but haven&apos;t yet produced
                confident position classifications. Check back as classification completes.
              </p>
            )}
            {coverage.total_sources < 3 && (
              <p className="mt-2 text-xs text-amber-800">
                Source coverage is thin. We show fewer positions when we aren&apos;t
                confident in the source material. See <a href="/methodology" className="underline">methodology</a>.
              </p>
            )}
          </div>

          {/* Federal voting record — only rendered when the candidate has a
              bioguide_id and at least one matched roll-call position. The
              "see all votes" link drops users into the unified person profile
              which already surfaces per-topic tally + inferred dimensions. */}
          {recentVotes.length > 0 && (
            <VotingRecordSection
              candidateName={candidate.name}
              personId={personId}
              votes={recentVotes}
            />
          )}

          {showGatheringState ? (
            // Tier C floor (council decision 002): source count or type
            // diversity is below Tier B. We refuse to render position cards
            // rather than publish thin guesses. The source-coverage block
            // above still shows why. EXCEPTIONS (see display-gate.ts): when the
            // candidate has self-stated (candidate_direct) positions OR any
            // high/medium-confidence position (entailment-passed, write-guarded
            // upstream), we fall through to the positions section below so their
            // own affirmed words / well-cited positions are shown — the floor
            // only governs candidates with NO renderable position at all.
            <div className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-6">
              <h2 className="text-xl font-bold text-[var(--color-text)]">
                We are still gathering verified sources for {candidate.name}
              </h2>
              <p className="mt-3 text-sm text-[var(--color-text-secondary)] leading-relaxed">
                We have not yet found enough public sources to describe this
                candidate&apos;s positions responsibly, so we are not listing
                them here. havesay would rather say we do not know yet than fill
                the gap with a guess. See{" "}
                <Link href="/methodology" className="underline">methodology</Link>{" "}
                for how we set this bar.
              </p>
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                So far we have {tier.source_count} public source
                {tier.source_count === 1 ? "" : "s"} across{" "}
                {tier.source_type_count} source type
                {tier.source_type_count === 1 ? "" : "s"} for this candidate. We
                start showing classified positions once that reaches at least 10
                sources and 2 source types.
              </p>
              <div className="mt-5">
                {/* TODO: replace this mailto fallback with a public
                    /candidate/invite/[id] route once the questionnaire
                    invitation flow (magic-link issuance for arbitrary
                    candidates) ships. Until then the fastest, verifiable
                    path is a human-readable email to the Havesay
                    outreach address. */}
                <a
                  href={`mailto:hello@example.org?subject=${encodeURIComponent(
                    `Invite ${candidate.name} to the Havesay questionnaire`,
                  )}&body=${encodeURIComponent(
                    `Please send a candidate questionnaire invitation to ${candidate.name} (${candidate.race.name}).\n\nCandidate ID: ${candidate.id}\n\nContext: this candidate is Tier C (${tier.source_count} sources, ${tier.source_type_count} types). Their public profile is stubbed on ballotbridge.org until we have enough sourcing to classify positions responsibly.\n`,
                  )}`}
                  className="civic-btn-primary inline-flex min-h-[44px] items-center"
                >
                  Invite {candidate.name.split(" ")[0]} to complete the candidate questionnaire
                </a>
              </div>
              <p className="mt-4 text-xs text-[var(--color-text-muted)]">
                If you&apos;re this candidate or a member of the campaign,{" "}
                <a
                  href="mailto:hello@example.org?subject=Candidate questionnaire request"
                  className="underline"
                >
                  email us
                </a>{" "}
                and we&apos;ll send you a direct magic link to complete the
                questionnaire.
              </p>
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Know of a campaign site, voter guide answer, or interview we
                missed?{" "}
                <Link
                  href={`/corrections/new?candidate_id=${candidate.id}`}
                  className="underline"
                >
                  Tell us about a source
                </Link>{" "}
                and we&apos;ll review it.
              </p>
            </div>
          ) : (
            <>
              <div className="mt-6 flex items-baseline justify-between">
                <h2 className="text-xl font-bold text-[var(--color-text)]">
                  Positions
                </h2>
                <span className="text-sm text-[var(--color-text-muted)]">
                  {candidate.positions.length} of {subDimensions.length} stated
                </span>
              </div>

              {candidate.positions.length === 0 && (
                <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5 text-sm text-[var(--color-text-secondary)]">
                  <p className="font-medium text-[var(--color-text)]">
                    No cited positions on file yet.
                  </p>
                  <p className="mt-1">
                    Havesay only displays positions backed by a public
                    source. We&apos;re still gathering information for this
                    candidate — nothing will appear here until we have citations.
                  </p>
                  {/* Council #63 (2026-05-11, voter): tell voters what we
                      tried so they can distinguish "system hasn't looked" from
                      "system looked at N sources and none had quotable policy
                      content." Closes the empty-page trust gap surfaced after
                      councils #58/#62 hardened discoverability + match scoring. */}
                  {coverage.total_sources > 0 && (
                    <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                      We checked <strong>{coverage.total_sources}</strong>{' '}
                      source{coverage.total_sources === 1 ? '' : 's'} for this
                      candidate but didn&apos;t find quoted policy positions on
                      our tracked issues. Know of a campaign site, voter guide
                      response, or interview we missed?{' '}
                      <Link href="/corrections" className="underline">
                        Tell us
                      </Link>.
                    </p>
                  )}
                </div>
              )}

              {(() => {
                // Partition sub-dimensions into ones with a visible position
                // and ones that would only render a "has not stated" placeholder.
                // The UX council flagged a wall of placeholder cards as a
                // "this candidate is empty" abandonment cue, so empties get
                // collapsed behind a disclosure. The count stays visible in the
                // "X of Y stated" header above and in the summary below.
                type WithPos = {
                  sd: SubDimension;
                  statedVisible: Position | null;
                  inferredVisible: Position | null;
                };
                const withPositions: WithPos[] = [];
                const placeholders: SubDimension[] = [];
                for (const sd of subDimensions) {
                  const views = positionsByView.get(sd.id);
                  // Only show a view if its confidence is medium or high. Low-
                  // confidence positions (generic "no data found" scores) get
                  // hidden and fall through to the placeholder bucket.
                  const statedVisible =
                    views?.stated && views.stated.confidence !== "low"
                      ? views.stated
                      : null;
                  const inferredVisible =
                    views?.inferred && views.inferred.confidence !== "low"
                      ? views.inferred
                      : null;
                  if (statedVisible || inferredVisible) {
                    withPositions.push({ sd, statedVisible, inferredVisible });
                  } else {
                    placeholders.push(sd);
                  }
                }

                const firstName = candidate.name.split(" ")[0];

                return (
                  <>
                    {/* Council #60 (2026-05-16, voter): a candidate WITH
                        positions that are all low-confidence (e.g. an
                        identity_unverified_platform_found result — campaign
                        site read, identity not registry-confirmed) would
                        otherwise render with zero visible cards, looking
                        identical to a never-researched candidate. The
                        positions.length===0 block above does NOT fire (there
                        ARE positions), so without this the voter sees a bare
                        header + a collapsed placeholder list. Give that case
                        its own honest card-level state. */}
                    {withPositions.length === 0 && candidate.positions.length > 0 && (
                      <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5 text-sm text-[var(--color-text-secondary)]">
                        <p className="font-medium text-[var(--color-text)]">
                          Researched, but only low-confidence positions found.
                        </p>
                        <p className="mt-1">
                          We found {candidate.positions.length} position
                          {candidate.positions.length === 1 ? "" : "s"} for{" "}
                          {firstName}, but all are low-confidence, drawn from
                          campaign-site content we could not fully verify
                          against an official registry. They are listed below
                          as directional only, not firm positions. This is
                          different from a candidate we have not yet researched.
                        </p>
                        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                          Know of an official source or a fuller statement from{" "}
                          {firstName}?{" "}
                          <Link href="/corrections" className="underline">
                            Tell us
                          </Link>
                          .
                        </p>
                      </div>
                    )}
                    {TWO_VIEW_ENABLED ? (
                      // Client wrapper owns the ViewToggle + filtered grid.
                      // Council decision 007 §5.2 — toggle is rendered above
                      // the positions grid and only when the flag is on.
                      <TwoViewPositionsGrid items={withPositions} />
                    ) : (
                      <div className="grid grid-cols-1 gap-4 mt-3">
                        {withPositions.map(({ sd, statedVisible, inferredVisible }) => {
                          // Flag off: legacy single-view PositionCard with the
                          // best available row (prefer inferred per §7 table,
                          // fall back to stated).
                          const best = inferredVisible ?? statedVisible;
                          if (!best) return null;
                          return (
                            <PositionCard
                              key={sd.id}
                              position={best}
                              subDimension={sd}
                              candidateId={candidate.id}
                            />
                          );
                        })}
                      </div>
                    )}

                    {placeholders.length > 0 && (
                      <details className="group mt-6 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                        <summary className="cursor-pointer list-none select-none text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] transition-colors">
                          <span className="inline-block mr-2 transition-transform group-open:rotate-90 text-[var(--color-text-muted)]">
                            ▸
                          </span>
                          {placeholders.length}{" "}
                          {placeholders.length === 1 ? "topic" : "topics"} with
                          no public data on {firstName}
                          <span className="ml-2 text-xs text-[var(--color-text-muted)] font-normal">
                            (click to show)
                          </span>
                        </summary>
                        <p className="mt-3 text-xs text-[var(--color-text-muted)] italic">
                          These are sub-dimensions where we don&apos;t have a
                          cited position from {firstName}&apos;s campaign
                          materials and don&apos;t have enough public record to
                          infer one. We&apos;d rather say so than fill the gap
                          with a guess.
                        </p>
                        <div className="grid grid-cols-1 gap-3 mt-4">
                          {placeholders.map((sd) => (
                            <div
                              key={sd.id}
                              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-alt)] p-3 text-sm text-[var(--color-text-muted)]"
                            >
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="font-semibold capitalize text-[var(--color-text-secondary)]">
                                  {sd.name.replace(/_/g, " ")}
                                </span>
                                <span className="text-[10px] uppercase tracking-wide font-medium text-[var(--color-text-muted)]">
                                  {sd.domain.replace(/_/g, " ")}
                                </span>
                              </div>
                              <p className="italic">
                                No stated position and not enough public record
                                to infer one.
                              </p>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </>
                );
              })()}
            </>
          )}

          {/* Report issue */}
          <div className="mt-10 text-center">
            <Link
              href={`/corrections/new?candidate_id=${candidate.id}`}
              className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition-colors underline"
            >
              Report an issue with this candidate&apos;s information
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * Format a Postgres timestamp string as "Apr 27" (en-US, en-dash safe).
 * Returns null if the input is null or unparseable so callers can fall
 * through to the "verification pending" copy.
 */
function formatVerifiedDate(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Voter-facing freshness receipt rendered under the candidate's name.
 * Reads "Last verified Apr 27" when we have a timestamp; reads
 * "Verification pending" when last_verified_at is NULL — never "unknown"
 * or "missing" (those frame absence as a defect; this frames it as
 * a process state).
 */
function FreshnessLine({ freshness }: { freshness: OfficeFreshness }) {
  const verified = formatVerifiedDate(freshness.last_verified_at);
  return (
    <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
      {verified ? `Last verified ${verified}` : "Verification pending"}
    </p>
  );
}

/**
 * A/B/C coverage tier pill rendered next to the candidate name. Clicking
 * takes the reader to the methodology page's coverage-tiers section so the
 * labels are defensible — we publish the thresholds.
 *
 * Council decision 007 §5.3. Tier derivation lives in candidate_tier_view
 * (see migration 20260420000001_candidate_tier_view.sql) so UI cannot drift
 * from the thresholds used in audit scripts or the methodology page.
 */
function CoverageTierBadge({ tier }: { tier: 'A' | 'B' | 'C' }) {
  const styles: Record<
    'A' | 'B' | 'C',
    { pill: string; label: string; title: string }
  > = {
    A: {
      pill: "bg-emerald-100 text-emerald-900 border-emerald-200",
      label: "Tier A \u2022 Comprehensive coverage",
      title:
        "At least 20 public sources across at least 3 source types. Full two-view classification.",
    },
    B: {
      pill: "bg-sky-100 text-sky-900 border-sky-200",
      label: "Tier B \u2022 Good coverage",
      title:
        "At least 10 public sources across at least 2 source types (Phase A launch threshold).",
    },
    C: {
      pill: "bg-slate-100 text-slate-700 border-slate-200",
      label: "Tier C \u2022 Limited coverage, see methodology",
      title:
        "Below the Phase A source floor. We publish the profile stub but don't classify positions until coverage improves.",
    },
  };

  const s = styles[tier];

  return (
    <Link
      href="/methodology#coverage-tiers"
      title={s.title}
      className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${s.pill} hover:opacity-90 transition-opacity whitespace-nowrap`}
    >
      {s.label}
    </Link>
  );
}

/**
 * Color the position badge by Yea / Nay / other. Mirrors the per-vote
 * coloring used on /person/[id] so the UX feels continuous when voters
 * follow the "see all votes" link from the candidate page into the
 * unified person profile.
 */
function votePositionBadgeColor(pos: string): string {
  const n = pos.toLowerCase();
  if (n.includes('yea') || n.includes('aye')) return 'bg-green-100 text-green-800 border-green-200';
  if (n.includes('nay') || n === 'no') return 'bg-red-100 text-red-800 border-red-200';
  if (n.includes('present')) return 'bg-yellow-100 text-yellow-800 border-yellow-200';
  return 'bg-gray-100 text-gray-800 border-gray-200';
}

/**
 * Recent federal voting record. Renders only when the candidate has a
 * matched person row WITH a bioguide_id (i.e. they are or were a federal
 * incumbent — House/Senate). The "see all votes" CTA points to the
 * unified /person/[id] profile which already shows full per-topic tally
 * + inferred-policy positions.
 */
function VotingRecordSection({
  candidateName,
  personId,
  votes,
}: {
  candidateName: string;
  personId: string | null;
  votes: RecentVote[];
}) {
  return (
    <section className="mt-8 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-sm font-bold text-[var(--color-text)]">
          Recent voting record
        </h3>
        {personId && (
          <Link
            href={`/person/${personId}`}
            className="text-xs text-[var(--color-primary)] hover:underline whitespace-nowrap"
          >
            See all votes →
          </Link>
        )}
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">
        {candidateName}&apos;s {votes.length} most-recent federal roll-call
        {votes.length === 1 ? " vote" : " votes"}, sourced from
        Congress.gov and senate.gov.
      </p>
      <div className="space-y-2">
        {votes.map((v, i) => (
          <div
            key={i}
            className="p-3 border border-[var(--color-border)] rounded flex justify-between items-start gap-4 bg-[var(--color-bg-alt)]"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[var(--color-text)] truncate">
                {v.description || (v.roll_call !== null ? `Roll call ${v.roll_call}` : "Untitled vote")}
              </div>
              <div className="text-xs text-[var(--color-text-muted)] mt-1">
                {v.chamber ? v.chamber.toUpperCase() : ""}
                {v.vote_date ? ` · ${v.vote_date.slice(0, 10)}` : ""}
                {v.roll_call !== null ? ` · Roll #${v.roll_call}` : ""}
                {v.result ? ` · ${v.result}` : ""}
              </div>
            </div>
            <span
              className={`px-3 py-1 text-xs rounded-full border whitespace-nowrap ${votePositionBadgeColor(
                v.position,
              )}`}
            >
              {v.position}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Compact campaign-finance summary strip. Pulled from state_cf_events
 * (verified=true via RLS). Renders just enough to give voters a sense of
 * money flow before the future /candidate/[id]/finance deep-dive page
 * exists. Top donors are rendered as a single tooltip-friendly line; the
 * link takes voters to the (planned) finance detail page.
 */
function CampaignFinanceStrip({
  candidateId,
  summary,
}: {
  candidateId: string;
  summary: CfSummary;
}) {
  const usd = (n: number) =>
    n.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  const top = summary.top_donors[0];
  return (
    <section className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-[var(--color-text-secondary)]">
        <span className="text-xs uppercase tracking-wide font-semibold text-[var(--color-text-muted)]">
          Campaign finance
        </span>
        <span>
          <strong className="text-[var(--color-text)]">{usd(summary.total_raised)}</strong>{" "}
          raised
        </span>
        <span>
          <strong className="text-[var(--color-text)]">{summary.donor_count.toLocaleString("en-US")}</strong>{" "}
          {summary.donor_count === 1 ? "donor" : "donors"}
        </span>
        {top && (
          <span
            className="truncate max-w-[24ch]"
            title={summary.top_donors
              .map((d) => `${d.name} — ${usd(d.amount)}`)
              .join("\n")}
          >
            Top donor:{" "}
            <strong className="text-[var(--color-text)]">{top.name}</strong>
          </span>
        )}
        <Link
          href={`/candidate/${candidateId}/finance`}
          className="ml-auto text-xs text-[var(--color-primary)] hover:underline whitespace-nowrap"
        >
          See finance details →
        </Link>
      </div>
    </section>
  );
}
