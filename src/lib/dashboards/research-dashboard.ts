/**
 * Research-progress dashboard — shared module
 *
 * Used by:
 *   • scripts/generate-research-dashboard.ts (CLI, writes static HTML)
 *   • src/app/admin/candidate-review/page.tsx (server-rendered admin page)
 *   • src/lib/inngest/functions/regenerate-research-dashboard.ts (cron regen)
 *
 * Outcome derivation (no `research_outcome` column exists on candidacies):
 *   verified = >=8 positions AND >=1 tier-1 source
 *   partial  = >=1 position or >=1 tier-1 source
 *   no-data  = has extraction_audit history but 0 positions/sources
 *   pending  = no extraction_audit history yet
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type ResearchOutcome = "verified" | "partial" | "no-data" | "pending";

export interface DashboardRow {
  id: string;
  name: string;
  office: string;
  level: string; // federal/state/county/municipal/school/special/judicial
  tier: string;  // A/B/C or '' (from offices.sourcing_tier)
  stateAbbr: string;
  district: string;
  party: string;
  election_date: string;
  tdays: number;
  outcome: ResearchOutcome;
  positions: number;
  sources: number;
  tier1: number;
  /** Number of sub_dimensions actually relevant to this candidate's office
   *  (offices.relevant_dimensions ?? office_types.relevant_dimensions). 0
   *  means the office has no per-office relevance set — those candidates
   *  effectively get researched against an empty dim set (data-quality gap). */
  dimsRelevant: number;
  last_reviewed: string | null;
}

export interface PipelineHealth {
  /** Candidacies for passed elections whose status is still active/pending_verification
   *  AND whose person has no future candidacy in the same cycle. Excludes
   *  primary winners running in the general (and independent re-runs). */
  stuck: number;
  /** New candidacies in the last N days (rolling) */
  inflow7d: number;
  inflow14d: number;
  inflow30d: number;
  /** ingestion_runs activity in the last 24h */
  adapterRuns24h: number;
  adapterSuccess24h: number;
  adapterFailed24h: number;
  /** Number of distinct adapters that ran in the last 24h */
  distinctAdapters24h: number;
  /** office_types with relevant_dimensions=[] (no per-office dim relevance set).
   *  Candidates whose office_type is empty get researched against zero dims. */
  officeTypesEmpty: number;
  officeTypesTotal: number;
}

/**
 * One row per RACE (office × election) — the natural unit of voter-facing
 * "let's research this contest as a unit" work. A single office can appear
 * twice in a cycle if it has both a primary and a general election; those are
 * different races with different candidate sets.
 */
export type OfficeOutcome = "fully_researched" | "partial" | "no_data" | "pending";
export type LevelGroup = "federal" | "state" | "local";

export interface OfficeRow {
  electionId: string;
  officeId: string;
  office: string;                  // canonical_name (+ seat_designation)
  level: string;                   // federal/state/county/municipal/school/special/judicial
  levelGroup: LevelGroup;
  stateAbbr: string;
  district: string;
  electionDate: string;
  electionType: string;
  tdays: number;
  candidates: number;              // count of active candidacies in this race (stuck excluded)
  cVerified: number;               // candidates individually verified
  cPartial: number;
  cNoData: number;
  cPending: number;
  sumPositions: number;            // sum across candidates
  sumTier1: number;                // sum tier-1 source count across candidates
  dimsRelevant: number;            // office's relevant-dim count (same for every candidate in the race)
  avgPctComplete: number;          // mean of (positions / dimsRelevant) per candidate, capped 1.0
  outcome: OfficeOutcome;
  lastReviewed: string | null;
  // Office-knowledge state — populated from office-review data sources
  // (governing_bodies.size_authoritative OR offices.meta.research_extracted.
  // authoritative). True when the office has been formally researched and
  // its editorial fields (description / powers / term / vacancy rules) are
  // trustworthy.
  officeKnowledgeVerified: boolean;
  governingBodyId: string | null;
  governingBodyName: string | null;
  governingBodyVerified: boolean;
  // Current incumbent (from office_tenures where is_current=true)
  incumbentName: string | null;
  incumbentParty: string | null;
  incumbentTermEnd: string | null;
  /** Derived: is the current officeholder running for re-election in this race?
   *  True when one of the active candidacies' person_id matches the office's
   *  current officeholder's person_id. */
  incumbentInRace: boolean;
  /** Count of candidates running in this race who are NOT the incumbent. */
  challengerCount: number;
}

export interface LevelStats {
  totalOffices: number;            // offices in this level with ≥1 active 2026 candidacy (the matrix unit)
  fullyResearched: number;         // all candidates ≥80% positions + ≥1 tier-1 source
  partial: number;                 // at least one candidate has any data
  noData: number;                  // candidates exist + had audit attempts but no data extracted
  pending: number;                 // no audit attempts at all
  /** Catalogued universe: offices with this level tag in the offices table.
   *  Many won't have a 2026 election (they're not up this cycle) and many
   *  more won't have a filed candidate (local filings come in very late). */
  cataloguedUniverse: number;
  /** Offices that DO have at least one 2026 election scheduled (regardless
   *  of candidacy status). The gap (cataloguedUniverse − scheduled2026) is
   *  "seats not up this cycle"; the gap (scheduled2026 − totalOffices) is
   *  "election scheduled but no candidate filed yet". */
  scheduled2026: number;
  /** Provenance breakdown of the catalogued universe.
   *  authoritative = traced to a primary source (Census of Governments 2022,
   *    Congress.gov, state SoS filings, etc.)
   *  compiled = extrapolated from per-state legal rules (e.g., "Indiana law
   *    says towns have mayor + council, so we generated seats for every
   *    Indiana town"). The seats are plausibly real but not per-charter
   *    verified.  authoritative + compiled may sum slightly below
   *    cataloguedUniverse if some rows have neither tier set. */
  authoritativeUniverse: number;
  compiledUniverse: number;
  /** For the `local` group only: how many of the catalogued offices are at
   *  TOWNSHIP jurisdictions (NE/MW township government). The dashboard's
   *  "Local · special" label otherwise hides this — but townships are a
   *  distinct civic structure with their own election calendars. */
  townshipUniverse?: number;
  specialDistrictUniverse?: number;
}

export interface SubDimensionRef {
  id: string;
  name: string;
  domain: string;
  scope_applicability: Record<string, string> | null;
}

export interface DashboardData {
  generatedAt: string;             // ISO
  cycleYear: number;
  /** Candidacy-level aggregate (post-stuck-exclusion). Kept for the
   *  candidate-row drill-down + the inngest snapshotter that still serializes
   *  candidacy rows. The voter-facing display now leads with `byLevel`. */
  aggregate: { verified: number; partial: number; noData: number; pending: number; total: number };
  /** State heatmap — counts OFFICES (races), not candidacies, so the heatmap
   *  reads "where's the work?" in the same unit as the office matrix. */
  byState: Map<string, { count: number; verified: number; nextDate: string | null }>;
  /** Per-level (federal/state/local) office-completeness breakdown. This is
   *  the headline metric the operator asked for: "40/101 federal offices populated
   *  with 80% positions, 32/101 partial …" */
  byLevel: { federal: LevelStats; state: LevelStats; local: LevelStats };
  /** One row per race (office × election). Drives the office matrix. */
  offices: OfficeRow[];
  /** Candidacy rows — kept for the drill-down link from an office row to its
   *  per-candidate detail; no longer the headline display. */
  rows: DashboardRow[];
  health: PipelineHealth;
  /** The 19 sub_dimensions (reference; for the "what are we grading on" section) */
  subDimensions: SubDimensionRef[];
}

export interface RenderOptions {
  mode: "standalone" | "embed";
  rowCap?: number;                 // default 250
  staticCssHref?: string;          // standalone: where lib/specs.css lives
  todayMs?: number;                // override for tests
}

// ────────────────────────────────────────────────────────────────────────────
// Tile-grid coordinates for the US heatmap
// ────────────────────────────────────────────────────────────────────────────

const TILE: Record<string, [number, number]> = {
  ME: [1, 11],
  WA: [2, 1], MT: [2, 3], ND: [2, 4], MN: [2, 5], WI: [2, 6], MI: [2, 7],          NY: [2, 9], VT: [2, 10], NH: [2, 11],
  OR: [3, 1], ID: [3, 2], WY: [3, 3], SD: [3, 4], IA: [3, 5], IL: [3, 6], IN: [3, 7], OH: [3, 8], PA: [3, 9], NJ: [3, 10], MA: [3, 11],
  CA: [4, 1], NV: [4, 2], UT: [4, 3], CO: [4, 4], NE: [4, 5], MO: [4, 6], KY: [4, 7], WV: [4, 8], VA: [4, 9], DE: [4, 10], CT: [4, 11],
              AZ: [5, 2], NM: [5, 3], KS: [5, 4], AR: [5, 5], TN: [5, 6], NC: [5, 7], SC: [5, 8], DC: [5, 9],  MD: [5, 10], RI: [5, 11],
  HI: [6, 1],                         OK: [6, 4], LA: [6, 5], MS: [6, 6], AL: [6, 7], GA: [6, 8],
  AK: [7, 1],                         TX: [7, 4],                                     FL: [7, 8],
};

const FIPS_TO_ABBR: Record<string, string> = {
  "01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT","10":"DE","11":"DC",
  "12":"FL","13":"GA","15":"HI","16":"ID","17":"IL","18":"IN","19":"IA","20":"KS","21":"KY",
  "22":"LA","23":"ME","24":"MD","25":"MA","26":"MI","27":"MN","28":"MS","29":"MO","30":"MT",
  "31":"NE","32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND","39":"OH",
  "40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD","47":"TN","48":"TX","49":"UT",
  "50":"VT","51":"VA","53":"WA","54":"WV","55":"WI","56":"WY",
  "60":"AS","66":"GU","69":"MP","72":"PR","78":"VI",
};

// ────────────────────────────────────────────────────────────────────────────
// Fetch
// ────────────────────────────────────────────────────────────────────────────

/**
 * Page through a Supabase select. MUST emit a stable ORDER BY — PostgREST
 * returns rows nondeterministically without one, so pages overlap AND skip
 * silently. The builder must produce a query whose target table has an `id`
 * column (true for everything in our schema). If you need a different sort,
 * specify .order() inside the builder; pagedSelect will detect it via the
 * `orderBy` param and skip the default.
 */
async function pagedSelect<T>(builder: () => any, pageSize = 1000, orderBy = 'id'): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const q = orderBy ? builder().order(orderBy) : builder();
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < pageSize) break;
  }
  return all;
}

export async function fetchDashboardData(
  supabase: SupabaseClient,
  opts: { cycleYear?: number; todayMs?: number } = {},
): Promise<DashboardData> {
  const today = new Date(opts.todayMs ?? Date.now());
  const cycleYear = opts.cycleYear ?? today.getUTCFullYear();
  const yearStart = `${cycleYear}-01-01`;
  const yearEnd = `${cycleYear + 1}-01-01`;

  type Cand = {
    id: string; status: string; party: string | null; person_id: string | null;
    created_at: string;
    election: {
      id: string; election_date: string; election_type: string;
      office: {
        id: string; canonical_name: string; level: string; seat_designation: string | null;
        sourcing_tier: string | null;
        relevant_dimensions: string[] | null;
        governing_body_id: string | null;
        meta: any;
        office_type: { relevant_dimensions: string[] | null } | null;
        jurisdiction: { id: string; name: string; short_name: string | null; fips_state: string | null; type: string } | null;
      } | null;
    } | null;
    person: { id: string; canonical_name: string; legacy_candidate_ids: string[] | null } | null;
  };

  const candidacies = await pagedSelect<Cand>(() =>
    supabase
      .from("candidacies")
      .select(
        `id, status, party, person_id, created_at,
         election:elections!inner(
           id, election_date, election_type,
           office:offices(
             id, canonical_name, level, seat_designation, sourcing_tier,
             relevant_dimensions, governing_body_id, meta,
             office_type:office_types(relevant_dimensions),
             jurisdiction:jurisdictions!offices_jurisdiction_id_fkey(id, name, short_name, fips_state, type)
           )
         ),
         person:people(id, canonical_name, legacy_candidate_ids)`,
      )
      .gte("election.election_date", yearStart)
      .lt("election.election_date", yearEnd),
  );

  // ── Office-review enrichment: load verified governing_bodies + current
  // office_tenures for the offices that appear in our matrix. Doing this in
  // batch (one set of office_ids) is much cheaper than per-row joins.
  const officeIds = new Set<string>();
  const bodyIds = new Set<string>();
  for (const c of candidacies) {
    if (c.election?.office?.id) officeIds.add(c.election.office.id);
    if (c.election?.office?.governing_body_id) bodyIds.add(c.election.office.governing_body_id);
  }

  // Bodies: map from body_id → { name, size_authoritative }
  const bodyById = new Map<string, { name: string; verified: boolean }>();
  if (bodyIds.size > 0) {
    const idsArr = [...bodyIds];
    const BATCH = 200;
    for (let i = 0; i < idsArr.length; i += BATCH) {
      const slice = idsArr.slice(i, i + BATCH);
      const { data } = await supabase
        .from("governing_bodies")
        .select("id, canonical_name, size_authoritative")
        .in("id", slice);
      for (const b of (data as Array<{ id: string; canonical_name: string; size_authoritative: boolean }>) || []) {
        bodyById.set(b.id, { name: b.canonical_name, verified: b.size_authoritative });
      }
    }
  }

  // Current officeholder: office_tenures where ended_on IS NULL
  type Tenure = { office_id: string; person_id: string; party_at_tenure: string | null; meta: any };
  const tenureByOffice = new Map<string, Tenure>();
  const idsArr = [...officeIds];
  for (let i = 0; i < idsArr.length; i += 200) {
    const slice = idsArr.slice(i, i + 200);
    const { data } = await supabase
      .from("office_tenures")
      .select("office_id, person_id, party_at_tenure, meta")
      .in("office_id", slice)
      .is("ended_on", null);
    for (const t of (data as Tenure[]) || []) {
      // Each office should have at most one current tenure
      if (!tenureByOffice.has(t.office_id)) tenureByOffice.set(t.office_id, t);
    }
  }
  // Resolve incumbent person names
  const incumbentPersonIds = [...new Set([...tenureByOffice.values()].map((t) => t.person_id))];
  const personById = new Map<string, string>();
  for (let i = 0; i < incumbentPersonIds.length; i += 200) {
    const slice = incumbentPersonIds.slice(i, i + 200);
    const { data } = await supabase.from("people").select("id, canonical_name").in("id", slice);
    for (const p of (data as Array<{ id: string; canonical_name: string }>) || []) {
      personById.set(p.id, p.canonical_name);
    }
  }

  type Pos = { person_id: string | null; candidate_id: string | null; confidence: string | null; extraction_audit_id: string | null };
  const positions = await pagedSelect<Pos>(() =>
    supabase.from("positions").select("person_id, candidate_id, confidence, extraction_audit_id"),
  );

  type Src = { candidate_id: string; authenticity_tier: number | null; extraction_audit_id: string | null };
  const sources = await pagedSelect<Src>(() =>
    supabase.from("candidate_sources").select("candidate_id, authenticity_tier, extraction_audit_id"),
  );

  // Aggregate by person/candidate
  const posByPerson = new Map<string, number>();
  const posByLegacy = new Map<string, number>();
  const auditIdsFromPositions = new Set<string>();
  for (const p of positions) {
    if (p.person_id) posByPerson.set(p.person_id, (posByPerson.get(p.person_id) || 0) + 1);
    if (p.candidate_id) posByLegacy.set(p.candidate_id, (posByLegacy.get(p.candidate_id) || 0) + 1);
    if (p.extraction_audit_id) auditIdsFromPositions.add(p.extraction_audit_id);
  }

  const srcByLegacy = new Map<string, number>();
  const tier1ByLegacy = new Map<string, number>();
  const auditIdsFromSources = new Set<string>();
  for (const s of sources) {
    srcByLegacy.set(s.candidate_id, (srcByLegacy.get(s.candidate_id) || 0) + 1);
    if (s.authenticity_tier === 1) tier1ByLegacy.set(s.candidate_id, (tier1ByLegacy.get(s.candidate_id) || 0) + 1);
    if (s.extraction_audit_id) auditIdsFromSources.add(s.extraction_audit_id);
  }

  // extraction_audit created_at (batched)
  type Audit = { id: string; created_at: string };
  const auditCreatedAt = new Map<string, string>();
  const allAuditIds = new Set<string>([...auditIdsFromPositions, ...auditIdsFromSources]);
  if (allAuditIds.size) {
    const idsArr = [...allAuditIds];
    const BATCH = 200;
    for (let i = 0; i < idsArr.length; i += BATCH) {
      const slice = idsArr.slice(i, i + BATCH);
      const { data, error } = await supabase
        .from("extraction_audit")
        .select("id, created_at")
        .in("id", slice);
      if (error) throw error;
      for (const r of (data as Audit[]) || []) auditCreatedAt.set(r.id, r.created_at);
    }
  }

  const lastReviewedByLegacy = new Map<string, string>();
  const lastReviewedByPerson = new Map<string, string>();
  for (const p of positions) {
    if (!p.extraction_audit_id) continue;
    const ts = auditCreatedAt.get(p.extraction_audit_id);
    if (!ts) continue;
    if (p.person_id) {
      const cur = lastReviewedByPerson.get(p.person_id);
      if (!cur || ts > cur) lastReviewedByPerson.set(p.person_id, ts);
    }
    if (p.candidate_id) {
      const cur = lastReviewedByLegacy.get(p.candidate_id);
      if (!cur || ts > cur) lastReviewedByLegacy.set(p.candidate_id, ts);
    }
  }
  for (const s of sources) {
    if (!s.extraction_audit_id) continue;
    const ts = auditCreatedAt.get(s.extraction_audit_id);
    if (!ts) continue;
    const cur = lastReviewedByLegacy.get(s.candidate_id);
    if (!cur || ts > cur) lastReviewedByLegacy.set(s.candidate_id, ts);
  }

  // State name/abbr lookup
  const { data: states, error: stateErr } = await supabase
    .from("jurisdictions")
    .select("id, name, short_name, fips_state")
    .eq("type", "state");
  if (stateErr) throw stateErr;
  const stateByFips = new Map<string, { name: string; abbr: string }>();
  for (const s of (states as any[]) || []) {
    // Prefer the canonical USPS abbr (matches our TILE keys); fall back to
    // whatever jurisdictions.short_name happens to be (could be "Texas" or
    // "TX" depending on seed).  Mismatch here breaks click-to-filter.
    const abbr = FIPS_TO_ABBR[s.fips_state] || s.short_name || "—";
    stateByFips.set(s.fips_state, { name: s.name, abbr });
  }
  for (const [fips, abbr] of Object.entries(FIPS_TO_ABBR)) {
    if (!stateByFips.has(fips)) stateByFips.set(fips, { name: abbr, abbr });
  }

  // Derive per-row + aggregates + pipeline health
  const rows: DashboardRow[] = [];
  const aggregate = { verified: 0, partial: 0, noData: 0, pending: 0, total: 0 };
  const byState = new Map<string, { count: number; verified: number; nextDate: string | null }>();

  // ── Office (race) aggregation. Key = office_id; one entry per office across
  // all active candidacies. We display the NEAREST upcoming election date as
  // the row's "next election" so the matrix sorts by urgency.
  type OfficeAccum = OfficeRow & { _pctSum: number };
  const officesMap = new Map<string, OfficeAccum>();
  const LEVEL_GROUP: Record<string, LevelGroup> = {
    federal: "federal",
    state: "state",
    county: "local",
    municipal: "local",
    school: "local",
    special: "local",
    judicial: "local",
  };

  const todayMs = today.getTime();
  const dayBetween = (iso: string) =>
    Math.floor((new Date(iso).getTime() - todayMs) / (1000 * 60 * 60 * 24));
  const todayStr = today.toISOString().slice(0, 10);
  const daysAgoIso = (d: number) =>
    new Date(todayMs - d * 86400e3).toISOString();
  const cutoff7 = daysAgoIso(7);
  const cutoff14 = daysAgoIso(14);
  const cutoff30 = daysAgoIso(30);

  // Build the set of person_ids who have at least one FUTURE candidacy in this
  // cycle. Used by the stuck-calc to exclude primary winners + independent
  // re-runs (their primary candidacy is "passed" but they're still in play).
  const personIdsWithFuture = new Set<string>();
  for (const c of candidacies) {
    const ed = c.election?.election_date;
    if (c.person_id && ed && ed >= todayStr) {
      personIdsWithFuture.add(c.person_id);
    }
  }

  // Pipeline-health counters derived from the same candidacy fetch
  let stuck = 0;
  let inflow7d = 0;
  let inflow14d = 0;
  let inflow30d = 0;

  for (const c of candidacies) {
    const e = c.election;
    if (!e?.office?.jurisdiction) continue;

    // Stuck: passed-election candidacies whose status hasn't been updated,
    // EXCLUDING people who have a future candidacy (those are primary winners
    // who advanced, or independent re-runs — they're not "stuck", just
    // waiting for the results→status pipeline to flip their primary row).
    if (
      e.election_date < todayStr &&
      (c.status === "active" || c.status === "pending_verification") &&
      !(c.person_id && personIdsWithFuture.has(c.person_id))
    ) {
      stuck += 1;
    }

    // Inflow: new candidacies in the last N days (any election in the cycle)
    if (c.created_at >= cutoff7)  inflow7d  += 1;
    if (c.created_at >= cutoff14) inflow14d += 1;
    if (c.created_at >= cutoff30) inflow30d += 1;
    const fips = e.office.jurisdiction.fips_state || "";
    const stateInfo = stateByFips.get(fips) || { name: "—", abbr: FIPS_TO_ABBR[fips] || "—" };

    const posPerson = c.person_id ? posByPerson.get(c.person_id) || 0 : 0;
    const legacyIds = c.person?.legacy_candidate_ids || [];
    const posLegacy = legacyIds.reduce((acc, id) => acc + (posByLegacy.get(id) || 0), 0);
    const positionsCount = posPerson > 0 ? posPerson : posLegacy;
    const sourcesCount = legacyIds.reduce((acc, id) => acc + (srcByLegacy.get(id) || 0), 0);
    const tier1Count = legacyIds.reduce((acc, id) => acc + (tier1ByLegacy.get(id) || 0), 0);

    let lastTs: string | null = c.person_id ? lastReviewedByPerson.get(c.person_id) || null : null;
    for (const id of legacyIds) {
      const t = lastReviewedByLegacy.get(id);
      if (t && (!lastTs || t > lastTs)) lastTs = t;
    }

    let outcome: ResearchOutcome;
    if (positionsCount >= 8 && tier1Count >= 1) outcome = "verified";
    else if (positionsCount >= 1 || tier1Count >= 1) outcome = "partial";
    else if (lastTs) outcome = "no-data";
    else outcome = "pending";

    const tdays = dayBetween(e.election_date);
    if (tdays < 0) continue;

    const office = e.office.canonical_name + (e.office.seat_designation ? ` (${e.office.seat_designation})` : "");

    // Per-office dim relevance: prefer the seat-level override on offices,
    // fall back to the office_type baseline. Empty = data-quality gap.
    const officeDims =
      e.office.relevant_dimensions ?? e.office.office_type?.relevant_dimensions ?? [];
    const dimsRelevant = Array.isArray(officeDims) ? officeDims.length : 0;

    rows.push({
      id: c.id,
      name: c.person?.canonical_name || "—",
      office,
      level: e.office.level || "",
      tier: (e.office.sourcing_tier || "").toUpperCase(),
      stateAbbr: stateInfo.abbr,
      district: e.office.seat_designation || "",
      party: (c.party || "").trim() || "—",
      election_date: e.election_date,
      dimsRelevant,
      tdays,
      outcome,
      positions: positionsCount,
      sources: sourcesCount,
      tier1: tier1Count,
      last_reviewed: lastTs,
    });

    aggregate.total += 1;
    if (outcome === "verified") aggregate.verified += 1;
    else if (outcome === "partial") aggregate.partial += 1;
    else if (outcome === "no-data") aggregate.noData += 1;
    else aggregate.pending += 1;

    // ── Office (race) accumulator
    const officeId = e.office.id;
    const levelGroup: LevelGroup = LEVEL_GROUP[e.office.level || ""] ?? "local";
    let oa = officesMap.get(officeId);
    if (!oa) {
      // Resolve office-knowledge state
      const officeMeta = e.office?.meta;
      const officeResearchVerified = !!(officeMeta?.research_extracted?.authoritative);
      const bodyInfo = e.office?.governing_body_id ? bodyById.get(e.office.governing_body_id) : undefined;
      const tenure = tenureByOffice.get(officeId);
      const incumbentName = tenure ? personById.get(tenure.person_id) ?? null : null;
      oa = {
        electionId: e.id,
        officeId,
        office,
        level: e.office.level || "",
        levelGroup,
        stateAbbr: stateInfo.abbr,
        district: e.office.seat_designation || "",
        electionDate: e.election_date,
        electionType: e.election_type || "general",
        tdays,
        dimsRelevant,
        candidates: 0,
        cVerified: 0,
        cPartial: 0,
        cNoData: 0,
        cPending: 0,
        sumPositions: 0,
        sumTier1: 0,
        avgPctComplete: 0,
        outcome: "pending",
        lastReviewed: null,
        officeKnowledgeVerified: officeResearchVerified || !!bodyInfo?.verified,
        governingBodyId: e.office?.governing_body_id ?? null,
        governingBodyName: bodyInfo?.name ?? null,
        governingBodyVerified: !!bodyInfo?.verified,
        incumbentName,
        incumbentParty: tenure?.party_at_tenure ?? null,
        incumbentTermEnd: tenure?.meta?.agent_term_end ?? null,
        incumbentInRace: false,         // populated as candidacies are processed
        challengerCount: 0,             // populated post-loop
        _pctSum: 0,
      };
      officesMap.set(officeId, oa);
    } else {
      // Primary-agnostic: an office's representative race is the GENERAL (the
      // seat-deciding election) — the office doesn't care how the general's
      // candidates are decided. Prefer a general over a primary regardless of
      // date; among same-type rows, show the soonest.
      const curIsGeneral = oa.electionType === "general";
      const newIsGeneral = (e.election_type || "general") === "general";
      const prefer = (newIsGeneral && !curIsGeneral) ||
        (newIsGeneral === curIsGeneral && e.election_date < oa.electionDate);
      if (prefer) {
        oa.electionDate = e.election_date;
        oa.electionId = e.id;
        oa.electionType = e.election_type || "general";
        oa.tdays = tdays;
      }
    }
    oa.candidates += 1;
    if (outcome === "verified") oa.cVerified += 1;
    else if (outcome === "partial") oa.cPartial += 1;
    else if (outcome === "no-data") oa.cNoData += 1;
    else oa.cPending += 1;
    oa.sumPositions += positionsCount;
    oa.sumTier1 += tier1Count;
    const denom = dimsRelevant > 0 ? dimsRelevant : 19;
    oa._pctSum += Math.min(1, positionsCount / denom);
    if (lastTs && (!oa.lastReviewed || lastTs > oa.lastReviewed)) oa.lastReviewed = lastTs;

    // Incumbent-vs-challenger derivation: does this candidacy's person match
    // the current officeholder for this office (per office_tenures)?
    const officeTenure = tenureByOffice.get(officeId);
    if (officeTenure && c.person_id && officeTenure.person_id === c.person_id) {
      oa.incumbentInRace = true;
    }

    // ── State heatmap — counts OFFICES, not candidacies, so the heatmap unit
    // matches the matrix below. Only increment when this is the first time
    // we've seen this office (i.e. it just got created in officesMap).
    if (oa.candidates === 1) {
      const sa = byState.get(stateInfo.abbr) || { count: 0, verified: 0, nextDate: null };
      sa.count += 1;
      if (tdays >= 0 && (!sa.nextDate || e.election_date < sa.nextDate)) sa.nextDate = e.election_date;
      byState.set(stateInfo.abbr, sa);
    }
  }

  // ── Post-process offices: compute avgPct + outcome + challenger count
  const offices: OfficeRow[] = [];
  for (const oa of officesMap.values()) {
    const { _pctSum, ...row } = oa;
    row.avgPctComplete = oa.candidates > 0 ? _pctSum / oa.candidates : 0;
    row.challengerCount = Math.max(0, oa.candidates - (oa.incumbentInRace ? 1 : 0));
    // Outcome rules (per-office):
    //   fully_researched  → every candidate is individually verified
    //   partial           → at least one candidate has any data
    //   no_data           → audit attempts happened but produced no data
    //   pending           → no audit attempts yet
    if (oa.cVerified === oa.candidates && oa.candidates > 0) {
      row.outcome = "fully_researched";
    } else if (oa.cVerified > 0 || oa.cPartial > 0) {
      row.outcome = "partial";
    } else if (oa.cNoData > 0) {
      row.outcome = "no_data";
    } else {
      row.outcome = "pending";
    }
    offices.push(row);
  }
  offices.sort((a, b) => a.tdays - b.tdays);

  // ── Update byState.verified to count FULLY-RESEARCHED OFFICES (not candidates),
  // matching the new heatmap unit.
  for (const o of offices) {
    if (o.outcome === "fully_researched") {
      const sa = byState.get(o.stateAbbr);
      if (sa) sa.verified += 1;
    }
  }

  // ── Per-level rollup (federal/state/local)
  const blank = (): LevelStats => ({
    totalOffices: 0,
    fullyResearched: 0,
    partial: 0,
    noData: 0,
    pending: 0,
    cataloguedUniverse: 0,
    scheduled2026: 0,
    authoritativeUniverse: 0,
    compiledUniverse: 0,
  });
  const byLevel = { federal: blank(), state: blank(), local: blank() };
  for (const o of offices) {
    const bucket = byLevel[o.levelGroup];
    bucket.totalOffices += 1;
    if (o.outcome === "fully_researched") bucket.fullyResearched += 1;
    else if (o.outcome === "partial") bucket.partial += 1;
    else if (o.outcome === "no_data") bucket.noData += 1;
    else bucket.pending += 1;
  }

  // ── Universe coverage: how many offices are catalogued at each level, and
  // how many have a 2026 election scheduled (regardless of candidacy state).
  // This surfaces the local-ingestion gap that's otherwise hidden behind the
  // 540-vs-2,534 split — municipal alone is 142K catalogued vs ~20 scheduled.
  //
  // Use HEAD count queries per level. A `.select(...).range(0, 999999)` is
  // silently capped at 1000 rows by PostgREST, which was producing
  // cataloguedUniverse=1000 instead of ~445K for local.
  for (const lvl of [
    "federal",
    "state",
    "county",
    "municipal",
    "school",
    "special",
    "judicial",
  ]) {
    const grp = lvl === "federal" ? "federal" : lvl === "state" ? "state" : "local";
    try {
      const { count } = await supabase
        .from("offices")
        .select("id", { count: "exact", head: true })
        .eq("level", lvl);
      byLevel[grp].cataloguedUniverse += count ?? 0;
    } catch { /* degrade */ }
    // Provenance breakdown — meta is JSONB, filter via meta->>data_quality_tier.
    try {
      const { count } = await supabase
        .from("offices")
        .select("id", { count: "exact", head: true })
        .eq("level", lvl)
        .filter("meta->>data_quality_tier", "eq", "authoritative");
      byLevel[grp].authoritativeUniverse += count ?? 0;
    } catch { /* degrade */ }
    try {
      const { count } = await supabase
        .from("offices")
        .select("id", { count: "exact", head: true })
        .eq("level", lvl)
        .filter("meta->>data_quality_tier", "eq", "compiled");
      byLevel[grp].compiledUniverse += count ?? 0;
    } catch { /* degrade */ }
  }

  // ── Township + special-district carve-out within the local group. Surface
  // separately so 116K township seats stop being lumped under "special."
  try {
    byLevel.local.townshipUniverse = 0;
    byLevel.local.specialDistrictUniverse = 0;
    // PostgREST !inner join lets the filter on the embedded resource affect
    // the parent's count.
    const { count: tCount } = await supabase
      .from("offices")
      .select("id, jurisdiction:jurisdictions!offices_jurisdiction_id_fkey!inner(type)", { count: "exact", head: true })
      .eq("jurisdiction.type", "township");
    byLevel.local.townshipUniverse = tCount ?? 0;
    const { count: sdCount } = await supabase
      .from("offices")
      .select("id, jurisdiction:jurisdictions!offices_jurisdiction_id_fkey!inner(type)", { count: "exact", head: true })
      .eq("jurisdiction.type", "special_district");
    byLevel.local.specialDistrictUniverse = sdCount ?? 0;
  } catch { /* degrade */ }
  try {
    // Distinct offices that have a 2026 election scheduled.
    type EOff = { office: { id: string; level: string | null } | null };
    const seen = new Set<string>();
    const counts = { federal: 0, state: 0, local: 0 };
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("elections")
        .select(`office:offices(id, level)`)
        .gte("election_date", yearStart)
        .lt("election_date", yearEnd)
        .order("id")
        .range(from, from + 999);
      if (error) break;
      const rows = ((data ?? []) as unknown as EOff[]);
      for (const e of rows) {
        const o = Array.isArray(e.office) ? e.office[0] : e.office;
        if (!o?.id || seen.has(o.id)) continue;
        seen.add(o.id);
        const lvl = o.level || "";
        const grp = lvl === "federal" ? "federal" : lvl === "state" ? "state" : "local";
        counts[grp] += 1;
      }
      if (rows.length < 1000) break;
      from += 1000;
    }
    byLevel.federal.scheduled2026 = counts.federal;
    byLevel.state.scheduled2026 = counts.state;
    byLevel.local.scheduled2026 = counts.local;
  } catch {
    // Same fallback.
  }

  rows.sort((a, b) => a.tdays - b.tdays);

  // ── Pipeline health: ingestion_runs activity in last 24h
  const since24h = new Date(todayMs - 24 * 3600e3).toISOString();
  type Run = { adapter_name: string; status: string; created_at: string };
  let adapterRuns: Run[] = [];
  try {
    const { data, error } = await supabase
      .from("ingestion_runs")
      .select("adapter_name, status, created_at")
      .gte("created_at", since24h)
      .order("created_at", { ascending: false })
      .range(0, 4999);
    if (error) throw error;
    adapterRuns = (data as Run[]) || [];
  } catch (e) {
    // Table may not exist on older schemas; degrade gracefully to zeros.
    adapterRuns = [];
  }
  const adapterSet = new Set<string>();
  let adapterSuccess = 0, adapterFailed = 0;
  for (const r of adapterRuns) {
    adapterSet.add(r.adapter_name);
    if (r.status === "success" || r.status === "partial") adapterSuccess += 1;
    if (r.status === "failed") adapterFailed += 1;
  }

  // ── office_types coverage (data-quality signal for per-office dim relevance)
  let officeTypesEmpty = 0;
  let officeTypesTotal = 0;
  try {
    const { data: ot, error } = await supabase
      .from("office_types")
      .select("id, relevant_dimensions")
      .order("id")
      .range(0, 999);
    if (error) throw error;
    for (const r of (ot as Array<{ relevant_dimensions: string[] | null }>) || []) {
      officeTypesTotal += 1;
      if (!r.relevant_dimensions || r.relevant_dimensions.length === 0) officeTypesEmpty += 1;
    }
  } catch {
    // Older schemas or local quirks — fall back to zero counts.
  }

  // ── The 19 sub_dimensions reference (for the "what are we grading on" section)
  let subDimensions: SubDimensionRef[] = [];
  try {
    const { data: sd, error } = await supabase
      .from("sub_dimensions")
      .select("id, name, domain, scope_applicability, active")
      .eq("active", true)
      .order("domain")
      .order("name")
      .range(0, 199);
    if (error) throw error;
    subDimensions = (sd as Array<SubDimensionRef & { active: boolean }>)?.map(
      ({ id, name, domain, scope_applicability }) => ({
        id, name, domain, scope_applicability,
      }),
    ) || [];
  } catch {
    subDimensions = [];
  }

  const health: PipelineHealth = {
    stuck,
    inflow7d, inflow14d, inflow30d,
    adapterRuns24h: adapterRuns.length,
    adapterSuccess24h: adapterSuccess,
    adapterFailed24h: adapterFailed,
    distinctAdapters24h: adapterSet.size,
    officeTypesEmpty,
    officeTypesTotal,
  };

  return {
    generatedAt: new Date(todayMs).toISOString(),
    cycleYear,
    aggregate,
    byState,
    byLevel,
    offices,
    rows,
    health,
    subDimensions,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Render
// ────────────────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 100));

function lastReviewedLabel(iso: string | null, todayMs: number): { label: string; cls: string } {
  if (!iso) return { label: "never", cls: "never" };
  const days = Math.floor((todayMs - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return { label: "today", cls: "" };
  if (days === 1) return { label: "1d ago", cls: "" };
  if (days < 14) return { label: `${days}d ago`, cls: "" };
  return { label: `${days}d ago`, cls: "stale" };
}

function tierClass(pctVerified: number, count: number): string {
  if (count === 0) return "tier-empty";
  if (pctVerified >= 70) return "tier-good";
  if (pctVerified >= 40) return "tier-ok";
  return "tier-warn";
}

// CSS — used in both standalone and embed modes. In embed mode we also alias
// the spec-set token names (`--primary`, `--text`, etc.) to the civic tokens
// from app/src/app/globals.css so the same CSS works in either context.
function dashboardStyles(mode: "standalone" | "embed"): string {
  const tokenBridge =
    mode === "embed"
      ? `:root {
  --bg: var(--civic-surface-muted);
  --surface: var(--civic-surface);
  --surface-muted: var(--civic-surface-muted);
  --surface-sunken: var(--civic-surface-sunken);
  --text: var(--civic-text);
  --text-secondary: var(--civic-text-secondary);
  --text-muted: var(--civic-text-muted);
  --border: var(--civic-border);
  --border-strong: var(--civic-border-strong);
  --primary: var(--civic-primary);
  --primary-soft: var(--civic-primary-soft);
  --accent: var(--civic-accent);
  --success-fg: var(--state-success-fg);
  --success-bg: var(--state-success-bg);
  --success-bd: var(--state-success-bd);
  --warn-fg: var(--state-warn-fg);
  --warn-bg: var(--state-warn-bg);
  --warn-bd: var(--state-warn-bd);
  --error-fg: var(--state-error-fg);
  --error-bg: var(--state-error-bg);
  --error-bd: var(--state-error-bd);
  --n-100: #f4f4f2; --n-200: #e7e6e2; --n-300: #d5d3cc; --n-400: #a8a69f;
  --n-500: #78756d; --n-600: #57544d; --n-700: #3e3b36; --n-900: #1a1917;
  --font-display: 'Cabinet Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-sans:    'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono:    'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-serif:   'Source Serif 4', ui-serif, Georgia, serif;
  --r-sm:4px; --r-md:8px; --r-lg:12px;
}
.dashboard-root { font-family: var(--font-sans); color: var(--text); padding: 24px 32px 64px; max-width: 80rem; margin: 0 auto; }
.dashboard-root h1 { font-family: var(--font-display); font-size: 38px; font-weight: 700; letter-spacing: -.025em; margin: 8px 0; color: var(--text); }
.dashboard-root h2 { font-family: var(--font-display); font-size: 22px; font-weight: 600; margin: 1.6em 0 .5em; padding-bottom: .3em; border-bottom: 1px solid var(--border); color: var(--text); }
.dashboard-root .lede { font-family: var(--font-serif); font-size: 18px; line-height: 1.5; color: var(--text); margin: .5em 0 1.2em; max-width: 50rem; }
.dashboard-root .kicker { font-family: var(--font-mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
.dashboard-root .callout { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); padding: 12px 16px; margin: 14px 0; font-size: 14px; }
.dashboard-root .callout.c-note { background: #e1ebf3; border-color: #a8c3d8; color: #2f4e6e; }`
      : "";

  return `${tokenBridge}
  /* Pipeline-health strip — compact "is the system breathing?" row */
  .health-strip { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin:14px 0 10px; }
  @media (max-width:820px){ .health-strip{grid-template-columns:repeat(2,1fr);} }
  .hcell { background:var(--surface); border:1px solid var(--border); border-radius:var(--r-sm); padding:10px 12px; }
  .hcell.hwarn { background:var(--warn-bg); border-color:var(--warn-bd); }
  .hnum { font-family:var(--font-display); font-size:24px; font-weight:700; color:var(--text); line-height:1; letter-spacing:-.025em; }
  .hnum .hsub { font-size:14px; font-weight:500; color:var(--text-muted); }
  .hlbl { font-family:var(--font-mono); font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted); margin-top:6px; font-weight:600; }
  .hcell.hwarn .hnum { color:var(--warn-fg); }

  .stat-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin:18px 0 10px; }
  @media (max-width:820px){ .stat-grid{grid-template-columns:repeat(2,1fr);} }
  .stat { background:var(--surface); border:1px solid var(--border); border-radius:var(--r-md); padding:16px 14px; text-align:left; }
  .stat .num { font-family:var(--font-display); font-size:36px; font-weight:700; color:var(--text); line-height:1; letter-spacing:-.025em; }
  .stat .label { font-family:var(--font-mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted); margin-top:8px; font-weight:600; }
  .stat .pct { font-family:var(--font-mono); font-size:12px; color:var(--text-muted); margin-top:2px; }
  .stat.verified   { border-left:3px solid var(--success-fg); } .stat.verified   .num { color:var(--success-fg); }
  .stat.partial    { border-left:3px solid var(--warn-fg); }   .stat.partial    .num { color:var(--warn-fg); }
  .stat.no-data    { border-left:3px solid var(--error-fg); }  .stat.no-data    .num { color:var(--error-fg); }
  .stat.pending    { border-left:3px solid var(--n-400); }

  .progress { background:var(--n-100); height:10px; border-radius:999px; overflow:hidden; margin:8px 0 22px; display:flex; box-shadow: inset 0 1px 1px rgba(14,13,12,.04); }
  .progress span { display:block; height:100%; }
  .p-verified { background:var(--success-fg); } .p-partial { background:var(--warn-fg); }
  .p-no-data { background:var(--error-fg); } .p-pending { background:var(--n-300); }

  .heatmap { display:grid; grid-template-columns:repeat(11, minmax(0, 1fr)); grid-auto-rows:minmax(56px, auto); gap:4px; margin:14px 0 8px; }
  .state { background:var(--surface-sunken); border:1px solid var(--border); border-radius:var(--r-sm); padding:5px 6px; display:flex; flex-direction:column; justify-content:space-between; font-size:10.5px; line-height:1.1; position:relative; min-width:0; cursor:pointer; transition: transform 100ms, box-shadow 100ms; }
  .state:hover { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(14,13,12,.1); }
  .state.tier-good { background:#e4f2ea; border-color:#a6cfb6; }
  .state.tier-ok { background:#fbf0d9; border-color:#e3c582; }
  .state.tier-warn { background:#f5e1de; border-color:#d19a95; }
  .state.tier-empty { background:var(--n-100); border-color:var(--n-200); cursor: default; }
  .state.tier-empty:hover { transform: none; box-shadow: none; }
  .state.active { outline: 2px solid var(--primary); outline-offset: 1px; }
  .state .abbr { font-family:var(--font-mono); font-weight:700; font-size:12px; color:var(--text); letter-spacing:.02em; }
  .state .count { font-family:var(--font-display); font-size:18px; font-weight:600; color:var(--text); line-height:1; margin:2px 0 0; letter-spacing:-.02em; }
  .state .pct { font-family:var(--font-mono); font-size:9.5px; color:var(--text-muted); letter-spacing:.02em; }
  .state.urgent::after { content:''; position:absolute; top:5px; right:5px; width:7px; height:7px; background:var(--error-fg); border-radius:50%; box-shadow:0 0 0 2px var(--surface); }

  .legend-row { font-family:var(--font-mono); font-size:11px; color:var(--text-muted); display:flex; gap:14px; flex-wrap:wrap; margin:8px 0 14px; letter-spacing:.04em; }
  .legend-row .sw { display:inline-block; width:11px; height:11px; border-radius:2px; margin-right:5px; vertical-align:middle; border:1px solid rgba(14,13,12,.1); }

  .filter-row { display:flex; gap:10px 14px; margin:14px 0; align-items:center; flex-wrap:wrap; padding: 12px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); }
  .filter-row input, .filter-row select { font-family:var(--font-sans); font-size:13px; padding:6px 10px; border:1px solid var(--border); border-radius:var(--r-sm); background:var(--surface); color:var(--text); }
  .filter-row input { min-width:200px; }
  .filter-row label { font-family:var(--font-mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted); font-weight:600; display: inline-flex; gap: 6px; align-items: center; }
  .filter-row .clear-btn { font-family:var(--font-mono); font-size:11px; color:var(--primary); background: none; border: 1px solid var(--border); border-radius: var(--r-sm); padding: 4px 9px; cursor: pointer; }
  .filter-row .clear-btn:hover { background: var(--primary-soft); }
  #counter { margin-left:auto; font-family:var(--font-mono); font-size:11px; color:var(--text-muted); letter-spacing:.04em; }

  table.candidates { font-size:13px; border-collapse: collapse; width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; }
  table.candidates th, table.candidates td { border-bottom: 1px solid var(--border); padding: 8px 11px; text-align: left; vertical-align: top; }
  table.candidates th { background: var(--surface-sunken); color: var(--primary); font-family: var(--font-mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; cursor:pointer; user-select:none; white-space:nowrap; }
  table.candidates tbody tr:nth-child(even) td { background: var(--surface-muted); }
  table.candidates th:hover { background: var(--n-200); }
  table.candidates th[aria-sort="ascending"]::after  { content:' ↑'; color:var(--primary); }
  table.candidates th[aria-sort="descending"]::after { content:' ↓'; color:var(--primary); }
  table.candidates td.tdays { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
  table.candidates td.tdays.urgent { color:var(--error-fg); font-weight:700; }
  table.candidates td.tdays.warn   { color:var(--warn-fg); font-weight:600; }
  table.candidates td.last { font-family:var(--font-mono); font-size:12px; color:var(--text-muted); white-space:nowrap; }
  table.candidates td.last.stale { color:var(--warn-fg); font-weight:600; }
  table.candidates td.last.never { color:var(--n-500); font-style:italic; }

  .bar { background:var(--n-100); width:78px; height:9px; border-radius:999px; overflow:hidden; display:inline-block; vertical-align:middle; border:1px solid var(--border); }
  .bar > span { display:block; height:100%; background:var(--primary); }
  .bar.good > span { background:var(--success-fg); }
  .bar.mid  > span { background:var(--warn-fg); }
  .bar.low  > span { background:var(--error-fg); }
  .bar-text { font-family:var(--font-mono); font-size:11px; color:var(--text-muted); margin-left:6px; vertical-align:middle; }

  .pill-out { font-family:var(--font-mono); font-size:10px; padding:2px 8px; border-radius:999px; letter-spacing:.04em; text-transform:uppercase; font-weight:600; display:inline-block; }
  .out-verified { background:var(--success-bg); color:var(--success-fg); border:1px solid var(--success-bd); }
  .out-partial  { background:var(--warn-bg); color:var(--warn-fg); border:1px solid var(--warn-bd); }
  .out-no-data  { background:var(--error-bg); color:var(--error-fg); border:1px solid var(--error-bd); }
  .out-pending  { background:var(--n-100); color:var(--n-700); border:1px solid var(--n-300); }

  .party { font-family:var(--font-mono); font-size:11px; color:var(--text-muted); }
  .party.d { color:#2f4e6e; }
  .party.r { color:#8b2e2e; }
  .party.np, .party.i { color:var(--n-600); }

  /* Per-level office-completeness strip — the "1 · By level" section */
  .level-strip { display:grid; grid-template-columns: 220px 1fr; gap:14px; padding:14px 16px; margin:12px 0; background:var(--surface); border:1px solid var(--border); border-radius:var(--r-md); align-items:center; }
  @media (max-width:720px){ .level-strip{ grid-template-columns:1fr; gap:8px; } }
  .level-label .level-name { font-family:var(--font-display); font-size:18px; font-weight:600; color:var(--text); letter-spacing:-.01em; }
  .level-label .level-total { font-family:var(--font-display); font-size:28px; font-weight:700; color:var(--text); line-height:1.1; }
  .level-label .level-gap { font-family:var(--font-mono); font-size:11.5px; color:var(--text-muted); margin-top:6px; line-height:1.3; }
  .level-label .level-prov { font-family:var(--font-mono); font-size:11.5px; color:var(--text-muted); margin-top:3px; line-height:1.3; }
  .level-prov .prov-auth { color:var(--success-fg); font-weight:700; }
  .level-prov .prov-comp { color:var(--warn-fg); font-weight:600; }
  .level-prov .prov-pct  { color:var(--text); font-weight:600; }
  .level-label .ltsub { font-family:var(--font-mono); font-size:11px; font-weight:500; color:var(--text-muted); text-transform:uppercase; letter-spacing:.06em; }
  .level-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
  @media (max-width:560px){ .level-stats{ grid-template-columns:repeat(2,1fr); } }
  .lstat { background:var(--surface-sunken); border:1px solid var(--border); border-radius:var(--r-sm); padding:8px 10px; border-left-width:3px; }
  .lstat-full { border-left-color:var(--success-fg); }
  .lstat-part { border-left-color:var(--warn-fg); }
  .lstat-no   { border-left-color:var(--error-fg); }
  .lstat-pnd  { border-left-color:var(--n-400); }
  .lstat .lnum { font-family:var(--font-display); font-size:22px; font-weight:700; color:var(--text); line-height:1; letter-spacing:-.02em; }
  .lstat .llbl { font-family:var(--font-mono); font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted); margin-top:4px; font-weight:600; }
  .lstat .lpct { color:var(--text); font-weight:700; }
  .level-progress { grid-column:2 / -1; background:var(--n-100); height:8px; border-radius:999px; overflow:hidden; display:flex; margin-top:6px; box-shadow:inset 0 1px 1px rgba(14,13,12,.04); }
  .level-progress span { display:block; height:100%; }
  @media (max-width:720px){ .level-progress{ grid-column:1 / -1; } }

  /* Office-matrix tweaks */
  table.candidates td.num { font-family:var(--font-mono); font-variant-numeric:tabular-nums; text-align:right; }
  table.candidates td a { color:var(--primary); text-decoration:none; }
  table.candidates td a:hover { text-decoration:underline; }
  table.candidates td .row-sub { font-family:var(--font-mono); font-size:11px; color:var(--text-muted); margin-top:2px; }

  /* Dimensions reference table */
  table.dims-ref { font-size:12.5px; border-collapse:collapse; width:auto; background:var(--surface); border:1px solid var(--border); border-radius:var(--r-md); overflow:hidden; }
  table.dims-ref th, table.dims-ref td { border-bottom:1px solid var(--border); padding:6px 11px; text-align:left; vertical-align:middle; }
  table.dims-ref th { background:var(--surface-sunken); color:var(--primary); font-family:var(--font-mono); font-size:10px; text-transform:uppercase; letter-spacing:.05em; font-weight:600; }
  table.dims-ref th:nth-child(n+3), table.dims-ref td:nth-child(n+3) { text-align:center; min-width:48px; }
  table.dims-ref tbody tr:nth-child(even) td { background:var(--surface-muted); }
  table.dims-ref td:first-child { font-family:var(--font-mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--text-muted); font-weight:600; }
  table.dims-ref td.dc-match { background:var(--success-bg); color:var(--success-fg); font-weight:700; font-family:var(--font-mono); }
  table.dims-ref td.dc-info { background:var(--warn-bg); color:var(--warn-fg); font-family:var(--font-mono); }
  table.dims-ref td.dc-na { color:var(--n-400); }
`;
}

function dashboardScript(): string {
  // Vanilla JS — runs in the browser after the markup mounts. Handles sort,
  // search, outcome / window / level / state filters, and clickable state
  // cells. Office-row schema (column order: office | state | type | election |
  // tdays | candidates | verified | pct | outcome | last).
  return `
  (function(){
    const tbody = document.getElementById('rows');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const counter = document.getElementById('counter');
    const $ = (id) => document.getElementById(id);
    const search = $('search');
    const outcomeSel = $('outcome');
    const windowSel = $('window');
    const levelSel = $('level');
    const stateSel = $('state');
    const bodySel = $('body');
    const clearBtn = $('clearFilters');
    const cells = Array.from(document.querySelectorAll('.heatmap .state'));
    let sortKey = 'tdays', sortDir = 1;

    function val(row, key){
      const map = {
        tdays:        () => +row.dataset.tdays,
        outcome:      () => row.dataset.outcome,
        candidates:   () => +row.dataset.candidates,
        verified:     () => +row.dataset.verified,
        pct:          () => +row.dataset.pct,
        knowledge:    () => +row.dataset.knowledge,
        last:         () => row.dataset.last || '0000-00-00',
        office:       () => row.cells[0].textContent.trim().toLowerCase(),
        state:        () => row.cells[1].textContent.trim().toLowerCase(),
        electiontype: () => row.cells[2].textContent.trim().toLowerCase(),
        election:     () => row.cells[3].textContent.trim(),
        levelgroup:   () => row.dataset.levelgroup || '',
      };
      return (map[key] || (()=>''))();
    }

    const INITIAL_CAP = 250;

    function render(){
      const q = (search.value || '').toLowerCase().trim();
      const o = outcomeSel.value;
      const w = windowSel.value ? parseInt(windowSel.value, 10) : null;
      const lvl = levelSel.value;
      const st = stateSel.value;
      const body = bodySel.value;
      const hasFilter = !!(q || o || w !== null || lvl || st || body);

      let visible = rows.filter(r => {
        if (o && r.dataset.outcome !== o) return false;
        if (w !== null && +r.dataset.tdays > w) return false;
        if (lvl && (r.dataset.levelgroup || '') !== lvl) return false;
        if (st && (r.dataset.state || '') !== st) return false;
        if (body && (r.dataset.bodyname || '') !== body) return false;
        if (!q) return true;
        return r.textContent.toLowerCase().includes(q);
      });
      visible.sort((a,b) => {
        const av = val(a, sortKey), bv = val(b, sortKey);
        if (av < bv) return -1 * sortDir;
        if (av > bv) return 1 * sortDir;
        return 0;
      });

      if (!hasFilter && visible.length > INITIAL_CAP) {
        visible = visible.slice(0, INITIAL_CAP);
      }
      tbody.innerHTML = '';
      visible.forEach(r => tbody.appendChild(r));

      if (hasFilter) {
        counter.textContent = visible.length + ' shown (filtered from ' + rows.length + ')';
      } else {
        counter.textContent = 'top ' + visible.length + ' of ' + rows.length + ' (filter to see more)';
      }

      // Highlight the active state cell
      cells.forEach(c => c.classList.toggle('active', c.dataset.stateAbbr === st && !!st));
    }

    document.querySelectorAll('table.candidates th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (sortKey === key) { sortDir *= -1; } else { sortKey = key; sortDir = 1; }
        document.querySelectorAll('table.candidates th[data-sort]').forEach(t => t.removeAttribute('aria-sort'));
        th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');
        render();
      });
    });

    [search, outcomeSel, windowSel, levelSel, stateSel, bodySel].forEach(el => {
      el.addEventListener('input', render);
      el.addEventListener('change', render);
    });

    clearBtn.addEventListener('click', () => {
      search.value = ''; outcomeSel.value = ''; windowSel.value = '';
      levelSel.value = ''; stateSel.value = ''; bodySel.value = '';
      render();
    });

    cells.forEach(c => {
      if (c.classList.contains('tier-empty')) return;
      c.addEventListener('click', () => {
        const abbr = c.dataset.stateAbbr;
        // Toggle: clicking the active state clears it.
        if (stateSel.value === abbr) stateSel.value = '';
        else stateSel.value = abbr;
        render();
        // Scroll the table into view
        document.querySelector('table.candidates').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    render();
  })();
  `;
}

function renderMarkup(data: DashboardData, opts: RenderOptions): string {
  const todayMs = opts.todayMs ?? Date.now();
  // Render ALL office rows into the DOM so any state filter can show them; the
  // client-side JS caps the *visible* set to 250 when no filter is active.
  const rowCap = opts.rowCap ?? data.offices.length;
  const initialDisplayCap = 250;
  const { byState, byLevel, offices, generatedAt, cycleYear, health } = data;
  const totalOffices = offices.length;

  const dayBetween = (iso: string) =>
    Math.floor((new Date(iso).getTime() - todayMs) / (1000 * 60 * 60 * 24));

  // Per-level office stats — replaces the candidate-progress bubbles.
  // The header carries THREE numbers so the local-ingestion gap is visible:
  //   active        — offices with ≥1 candidate filed for 2026 (matrix unit)
  //   scheduled     — offices with a 2026 election in our DB (any candidates or not)
  //   catalogued    — offices in this level's universe (regardless of cycle)
  // For federal/state, active ≈ scheduled because filing is reliable. For
  // local, active << scheduled << catalogued because most cities run their
  // own elections and we haven't ingested those calendars yet.
  const renderLevelStrip = (label: string, st: LevelStats): string => {
    const pFull = pct(st.fullyResearched, st.totalOffices);
    const pPart = pct(st.partial, st.totalOffices);
    const pNo = pct(st.noData, st.totalOffices);
    const pPnd = pct(st.pending, st.totalOffices);
    const haveUniverse = st.cataloguedUniverse > 0;
    const haveProv = st.authoritativeUniverse + st.compiledUniverse > 0;
    const pAuth = haveProv ? pct(st.authoritativeUniverse, st.authoritativeUniverse + st.compiledUniverse) : 0;
    const gap = haveUniverse
      ? `<div class="level-gap" title="active = offices with ≥1 active 2026 candidacy · scheduled = offices with any 2026 election in our DB · catalogued = offices in the universe (any cycle)">${fmt(st.scheduled2026)} <span class="ltsub">scheduled</span> · ${fmt(st.cataloguedUniverse)} <span class="ltsub">catalogued</span></div>`
      : "";
    // Provenance split — authoritative (traced to primary source) vs.
    // compiled (extrapolated from state law). The honest gap the operator asked
    // me to surface.
    const prov = haveProv
      ? `<div class="level-prov" title="authoritative = traced to a primary source (Census of Governments 2022, Congress.gov, state SoS filings); compiled = extrapolated from per-state legal rules — the seat is plausibly real but not per-charter verified"><span class="prov-auth">${fmt(st.authoritativeUniverse)}</span> verified <span class="prov-pct">(${pAuth}%)</span> · <span class="prov-comp">${fmt(st.compiledUniverse)}</span> extrapolated</div>`
      : "";
    return `
    <div class="level-strip">
      <div class="level-label">
        <div class="level-name">${esc(label)}</div>
        <div class="level-total">${fmt(st.totalOffices)} <span class="ltsub">active</span></div>
        ${gap}
        ${prov}
      </div>
      <div class="level-stats">
        <div class="lstat lstat-full"><div class="lnum">${fmt(st.fullyResearched)}</div><div class="llbl">fully researched <span class="lpct">(${pFull}%)</span></div></div>
        <div class="lstat lstat-part"><div class="lnum">${fmt(st.partial)}</div><div class="llbl">partial <span class="lpct">(${pPart}%)</span></div></div>
        <div class="lstat lstat-no"><div class="lnum">${fmt(st.noData)}</div><div class="llbl">no data <span class="lpct">(${pNo}%)</span></div></div>
        <div class="lstat lstat-pnd"><div class="lnum">${fmt(st.pending)}</div><div class="llbl">pending <span class="lpct">(${pPnd}%)</span></div></div>
      </div>
      <div class="level-progress" aria-label="${esc(label)} completeness">
        <span class="p-verified" style="width:${pFull}%"></span>
        <span class="p-partial"  style="width:${pPart}%"></span>
        <span class="p-no-data"  style="width:${pNo}%"></span>
        <span class="p-pending"  style="width:${pPnd}%"></span>
      </div>
    </div>`;
  };

  const stateCells = Object.entries(TILE)
    .map(([abbr, [row, col]]) => {
      const sa = byState.get(abbr) || { count: 0, verified: 0, nextDate: null };
      const p = pct(sa.verified, sa.count);
      const urgent = sa.nextDate && dayBetween(sa.nextDate) >= 0 && dayBetween(sa.nextDate) <= 14;
      const cls = `state ${tierClass(p, sa.count)}${urgent ? " urgent" : ""}`;
      const title = sa.count
        ? `${abbr}: ${sa.count} offices, ${p}% fully researched${sa.nextDate ? `, next ${sa.nextDate} (T-${dayBetween(sa.nextDate)})` : ""} — click to filter`
        : `${abbr}: no offices yet`;
      return `<div class="${cls}" data-state-abbr="${abbr}" style="grid-row:${row};grid-column:${col}" title="${esc(title)}"><span class="abbr">${abbr}</span><span class="count">${sa.count ? fmt(sa.count) : "—"}</span><span class="pct">${sa.count ? p + "%" : ""}</span></div>`;
    })
    .join("\n");

  const stateOptions = Object.keys(TILE)
    .filter((abbr) => (byState.get(abbr)?.count || 0) > 0)
    .sort()
    .map((abbr) => `<option value="${abbr}">${abbr}</option>`)
    .join("");

  // Body filter options — distinct governing bodies represented in the matrix.
  // Lets reviewers focus on "all Utah State Senate seats" or "all US House
  // races" with one filter, without grouping the rows.
  const bodySet = new Set<string>();
  for (const o of offices) if (o.governingBodyName) bodySet.add(o.governingBodyName);
  const bodyOptions = [...bodySet]
    .sort()
    .map((b) => `<option value="${esc(b)}">${esc(b)}</option>`)
    .join("");

  // ── Office (race) matrix rows. One per office; rolls up all active
  // candidacies. Sort already applied in fetchDashboardData (by tdays asc).
  const outcomeLabel: Record<OfficeOutcome, string> = {
    fully_researched: "fully researched",
    partial: "partial",
    no_data: "no data",
    pending: "pending",
  };
  const outcomePill: Record<OfficeOutcome, string> = {
    fully_researched: "out-verified",
    partial: "out-partial",
    no_data: "out-no-data",
    pending: "out-pending",
  };
  // Office-knowledge metric: bodies + offices that have verified editorial content
  const officesWithKnowledge = offices.filter((o) => o.officeKnowledgeVerified).length;
  const tableRows = offices
    .slice(0, rowCap)
    .map((o) => {
      const tdaysCls = o.tdays <= 14 ? " urgent" : o.tdays <= 60 ? " warn" : "";
      const completePct = Math.round(o.avgPctComplete * 100);
      const barCls = completePct >= 70 ? "good" : completePct >= 30 ? "mid" : "low";
      const last = lastReviewedLabel(o.lastReviewed, todayMs);
      const dimsTitle =
        o.dimsRelevant > 0
          ? `Office covers ${o.dimsRelevant} sub-dimensions; avg ${completePct}% of those scored per candidate`
          : `No relevant_dimensions set on this office (data-quality gap) — fallback denominator of 19`;
      const verifiedTitle =
        `${o.cVerified} of ${o.candidates} candidates individually verified ` +
        `(≥80% of relevant dims scored + ≥1 tier-1 source)`;
      // Office-knowledge column: green check if verified body or office, dim warning otherwise
      const knowledgePill = o.officeKnowledgeVerified
        ? `<span class="pill-out out-verified" title="Office knowledge verified by research agent">✓ ${esc(o.governingBodyName ? "body" : "office")}</span>`
        : '<span class="pill-out out-pending" title="Office knowledge not yet verified (compiled tier from generic rules)">compiled</span>';
      const incumbentLine = o.incumbentName
        ? `${esc(o.incumbentName)}${o.incumbentParty ? ` (${esc(o.incumbentParty[0])})` : ""}`
        : '<span style="color:var(--text-muted);font-style:italic">—</span>';
      const bodyLine = o.governingBodyName
        ? `<a href="/admin/office-review#body-${esc(o.governingBodyId ?? "")}" title="${esc(o.governingBodyName)}${o.governingBodyVerified ? " — verified body" : " — compiled body"}">${esc(o.governingBodyName.length > 22 ? o.governingBodyName.slice(0, 22) + "…" : o.governingBodyName)}</a>`
        : '<span style="color:var(--text-muted)">—</span>';
      // Candidates column: "5" or "1 inc + 4 chal" when incumbent is in race
      const candidatesCell = o.incumbentInRace
        ? `<span title="Current officeholder is running for re-election"><strong>1</strong> inc + ${fmt(o.challengerCount)} chal</span>`
        : fmt(o.candidates);
      return `      <tr data-tdays="${o.tdays}" data-outcome="${o.outcome}" data-candidates="${o.candidates}" data-verified="${o.cVerified}" data-pct="${completePct}" data-knowledge="${o.officeKnowledgeVerified ? "1" : "0"}" data-incumbent="${o.incumbentInRace ? "1" : "0"}" data-bodyid="${esc(o.governingBodyId ?? "")}" data-bodyname="${esc(o.governingBodyName ?? "")}" data-last="${o.lastReviewed || ""}" data-level="${esc(o.level)}" data-levelgroup="${esc(o.levelGroup)}" data-state="${esc(o.stateAbbr)}" data-electionid="${esc(o.electionId)}" data-officeid="${esc(o.officeId)}"><td><a href="/office/${esc(o.officeId)}" title="Open office detail">${esc(o.office)}</a><div class="row-sub">incumbent: ${incumbentLine} · body: ${bodyLine}</div></td><td>${esc(o.stateAbbr)}${o.district ? " · " + esc(o.district) : ""}</td><td>${esc(o.electionType)}</td><td>${o.electionDate}</td><td class="tdays${tdaysCls}">${o.tdays}</td><td class="num">${candidatesCell}</td><td title="${esc(verifiedTitle)}" class="num">${fmt(o.cVerified)}/${fmt(o.candidates)}</td><td title="${esc(dimsTitle)}"><span class="bar ${barCls}"><span style="width:${completePct}%"></span></span><span class="bar-text">${completePct}%</span></td><td>${knowledgePill}</td><td><span class="pill-out ${outcomePill[o.outcome]}">${outcomeLabel[o.outcome]}</span></td><td class="last ${last.cls}">${last.label}</td></tr>`;
    })
    .join("\n");

  const generatedAtDisplay =
    new Date(generatedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";

  // ── Pipeline-health strip + smart callouts (top of page, above aggregate)
  const healthStrip = `
  <div class="health-strip">
    <div class="hcell ${health.stuck > 0 ? "hwarn" : ""}"><div class="hnum">${fmt(health.stuck)}</div><div class="hlbl">Stuck (excluded)</div></div>
    <div class="hcell ${health.inflow7d === 0 ? "hwarn" : ""}"><div class="hnum">${fmt(health.inflow7d)}</div><div class="hlbl">New · 7d</div></div>
    <div class="hcell"><div class="hnum">${fmt(health.inflow14d)}</div><div class="hlbl">New · 14d</div></div>
    <div class="hcell"><div class="hnum">${fmt(health.inflow30d)}</div><div class="hlbl">New · 30d</div></div>
    <div class="hcell ${health.adapterRuns24h === 0 ? "hwarn" : ""}"><div class="hnum">${fmt(health.adapterSuccess24h)}<span class="hsub">/${fmt(health.adapterRuns24h)}</span></div><div class="hlbl">Adapter runs · 24h (${health.distinctAdapters24h} distinct)</div></div>
  </div>`;

  const stuckCallout =
    health.stuck > 0
      ? `<div class="callout c-warn"><strong>${fmt(health.stuck)} candidacies look "stuck"</strong> — passed-election + status still <code>active</code> + no future candidacy exists for the same person in this cycle. (Primary winners advancing to the general and independent re-runs are excluded here — they have a future candidacy and aren't stuck.) The results→status pipeline will flip these to <code>lost_primary</code> once SoS results certify.</div>`
      : "";

  // Inflow framing — be honest about adapter-dependency. "0 in 7d" is
  // meaningless if the adapter scheduler hasn't run.
  const inflowCallout = (() => {
    if (health.adapterRuns24h === 0) {
      return `<div class="callout c-danger"><strong>Adapter scheduler hasn't run in 24h</strong> (0 <code>ingestion_runs</code>). The inflow signal is unreliable until ingest is back online — fix the scheduler first, then re-check for new candidacies. Inflow numbers below (${fmt(health.inflow7d)} in 7d, ${fmt(health.inflow14d)} in 14d, ${fmt(health.inflow30d)} in 30d) reflect the last bulk load only.</div>`;
    }
    if (health.inflow7d === 0) {
      return `<div class="callout c-warn"><strong>No new candidacies in 7 days,</strong> but adapters DID run (${health.distinctAdapters24h} distinct in last 24h) — most likely filing deadlines have passed and there's just no new data to ingest. If you expected new filings in a specific state, check that adapter's last run in the engine logs.</div>`;
    }
    return "";
  })();

  const officeTypesCallout =
    health.officeTypesTotal > 0 && health.officeTypesEmpty > 0
      ? `<div class="callout c-warn"><strong>${health.officeTypesEmpty} of ${health.officeTypesTotal} office_types have no <code>relevant_dimensions</code> set</strong> — candidates whose office_type is empty get researched against zero dimensions (or fall back to the seat-level override on <code>offices.relevant_dimensions</code>, which is set on only ~1% of seats). Backfilling <code>office_types.relevant_dimensions</code> is the highest-leverage data fix for matching quality.</div>`
      : "";

  // ── Dimensions reference: the 19 sub_dimensions + which office levels each applies to
  const LEVELS = ["fed", "state", "county", "muni", "judicial", "school_board"] as const;
  const dimsByDomain = new Map<string, SubDimensionRef[]>();
  for (const d of data.subDimensions ?? []) {
    const arr = dimsByDomain.get(d.domain) ?? [];
    arr.push(d);
    dimsByDomain.set(d.domain, arr);
  }
  const dimsSection = data.subDimensions && data.subDimensions.length > 0
    ? `<h2>4 · The ${data.subDimensions.length} sub-dimensions (what we grade on)</h2>
  <p style="font-size:13.5px;color:var(--text-muted);margin:.3em 0 .6em">Each cell shows how a dimension applies at that office level: <span style="color:var(--success-fg);font-weight:700">M</span> = match (counted in score), <span style="color:var(--warn-fg);font-weight:700">i</span> = info-only, blank = not applicable. The research-swarm already narrows the per-candidate dim set using <code>offices.relevant_dimensions ?? office_types.relevant_dimensions</code>; the matching algorithm currently uses these scope keys only (gap: doesn't read per-office relevance).</p>
  <table class="dims-ref">
    <thead><tr><th>Domain</th><th>Dimension</th>${LEVELS.map((l) => `<th>${esc(l)}</th>`).join("")}</tr></thead>
    <tbody>
${[...dimsByDomain.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([domain, dims]) =>
  dims.map((d, i) => `      <tr><td>${i === 0 ? esc(domain) : ""}</td><td>${esc(d.name)}</td>${LEVELS.map((l) => {
    const v = d.scope_applicability?.[l] || "";
    if (v === "match") return `<td class="dc-match">M</td>`;
    if (v === "info" || v === "informational") return `<td class="dc-info">i</td>`;
    return `<td class="dc-na"></td>`;
  }).join("")}</tr>`).join("\n"),
).join("\n")}
    </tbody>
  </table>`
    : "";

  return `<div class="dashboard-root">
  <header><div class="kicker">Operational visibility · live data · regenerated ${esc(generatedAtDisplay)}</div><h1>Candidate Research Progress</h1></header>

  <p class="lede">A live progress matrix for the research-swarm: where every ${cycleYear} candidacy stands, where the data gaps are, and what the calendar is squeezing.</p>

  ${healthStrip}
  ${stuckCallout}
  ${inflowCallout}
  ${officeTypesCallout}

  <div class="callout c-note"><strong>Outcome derivation</strong> (office row aggregates per-candidate outcomes):
    A candidate is <code>verified</code> when ≥80% of the office's relevant sub-dimensions are scored AND there's ≥1 tier-1 source.
    An office is <strong>fully researched</strong> when every candidate is individually verified, <strong>partial</strong> when at least one candidate has data, <strong>no data</strong> when audit attempts have happened but produced no positions, <strong>pending</strong> when no audit has been attempted.
    Stuck candidacies (passed primary, no future candidacy) are excluded from every count.
  </div>

  <h2>1 · By level — federal · state · local</h2>
  <p style="font-size:13.5px;color:var(--text-muted);margin:.3em 0 .8em">One row per level. Three numbers per row tell the coverage story: <strong>active</strong> = offices with ≥1 candidate filed for ${cycleYear}; <strong>scheduled</strong> = offices with a ${cycleYear} election in our DB; <strong>catalogued</strong> = offices in this level's universe. The bar shows how many of the active offices are fully researched vs. partial vs. no-data vs. pending.</p>
  ${renderLevelStrip("Federal", byLevel.federal)}
  ${renderLevelStrip("State", byLevel.state)}
  ${renderLevelStrip("Local (county · muni · school · special-district · judicial)", byLevel.local)}
  ${byLevel.local.townshipUniverse && byLevel.local.townshipUniverse > 10_000
    ? `<div class="callout c-note"><strong>Township government under the "Local" label.</strong> ${fmt(byLevel.local.townshipUniverse)} of the ${fmt(byLevel.local.cataloguedUniverse)} local offices catalogued are at <em>township</em> jurisdictions — New England + Midwest township government (CT First Selectmen, MI Township Supervisors, NY/WI/MN/MA town clerks &amp; trustees). For comparison, true special-district seats (water / fire / library / mosquito-abatement boards) are ${fmt(byLevel.local.specialDistrictUniverse ?? 0)}. Townships have their own election calendars (mostly not yet ingested), so they're invisible in the active matrix below regardless of how many seats exist.</div>`
    : ""}
  ${byLevel.local.cataloguedUniverse > 10_000 && byLevel.local.scheduled2026 < byLevel.local.cataloguedUniverse * 0.05
    ? `<div class="callout c-warn"><strong>Local coverage gap surfaced honestly.</strong> The ${fmt(byLevel.local.cataloguedUniverse)} catalogued local offices include both true seats (Census of Governments 2022) and ${fmt(byLevel.local.compiledUniverse)} seats <em>extrapolated from state law</em> — e.g., "Indiana's IC 36-2 says towns have mayor + council, so we generated those seats for every Indiana town" without verifying each city's actual charter. Only ${fmt(byLevel.local.scheduled2026)} local offices have a ${cycleYear} election scheduled, of which ${fmt(byLevel.local.totalOffices)} have a candidate filed. This is a data-engine ingestion problem, not a research-quality problem: most cities + special districts run their own elections (not via state SoS) and we haven't ingested those calendars yet.</div>`
    : ""}

  <h2>2 · State readiness heatmap</h2>
  <p style="font-size:13.5px;color:var(--text-muted);margin:.3em 0 .6em">Counts upcoming-${cycleYear} <strong>offices</strong> per state; verified-pct = fully-researched offices. Click a state to filter the matrix below. Click again to clear.</p>
  <div class="legend-row">
    <span><span class="sw" style="background:#e4f2ea;border-color:#a6cfb6"></span>≥ 70% fully-researched</span>
    <span><span class="sw" style="background:#fbf0d9;border-color:#e3c582"></span>40 – 69%</span>
    <span><span class="sw" style="background:#f5e1de;border-color:#d19a95"></span>&lt; 40%</span>
    <span><span class="sw" style="background:#f4f4f2;border-color:#d5d3cc"></span>no offices yet</span>
    <span><span class="sw" style="background:var(--error-fg);border-radius:50%;width:9px;height:9px;border:0"></span>election &lt; 14d</span>
  </div>
  <div class="heatmap">
${stateCells}
  </div>

  <h2>3 · Per-office (race) matrix</h2>
  <p style="font-size:13px;color:var(--text-muted);margin:.3em 0 .6em">${fmt(totalOffices)} upcoming-${cycleYear} offices in the dataset (one row per office, showing the nearest upcoming election). Top ${initialDisplayCap} (by T-days) shown by default; click a state or set any filter to see the matching set. Click an office name to drill into its candidates.</p>
  <div class="callout c-note" style="margin:8px 0 14px"><strong>Office-knowledge crosslink</strong> (from <a href="/admin/office-review">/admin/office-review</a>): <strong>${fmt(officesWithKnowledge)}</strong> of ${fmt(totalOffices)} offices have verified editorial content (description / powers / vacancy rules / current incumbent). The remainder still rely on compiled-tier defaults from generic state rules. Each row below shows the office's incumbent + governing body inline; click an office name for its full profile.</div>
  <div class="filter-row">
    <label for="search">Search <input id="search" type="search" placeholder="office, state…"></label>
    <label for="state">State <select id="state"><option value="">all</option>${stateOptions}</select></label>
    <label for="outcome">Outcome <select id="outcome"><option value="">all</option><option value="fully_researched">fully researched</option><option value="partial">partial</option><option value="no_data">no data</option><option value="pending">pending</option></select></label>
    <label for="window">When <select id="window"><option value="">all</option><option value="14">next 14d</option><option value="30">next 30d</option><option value="90">next 90d</option><option value="180">next 180d</option></select></label>
    <label for="level">Level <select id="level"><option value="">all</option><option value="federal">federal</option><option value="state">state</option><option value="local">local</option></select></label>
    <label for="body">Body <select id="body"><option value="">all</option>${bodyOptions}</select></label>
    <button id="clearFilters" class="clear-btn" type="button">Clear</button>
    <span id="counter"></span>
  </div>
  <table class="candidates">
    <thead><tr>
      <th data-sort="office">Office · incumbent · body</th>
      <th data-sort="state">ST · Dist</th>
      <th data-sort="electiontype">Type</th>
      <th data-sort="election">Election</th>
      <th data-sort="tdays" aria-sort="ascending">T-days</th>
      <th data-sort="candidates">Candidates</th>
      <th data-sort="verified">Verified</th>
      <th data-sort="pct">Avg % complete</th>
      <th data-sort="knowledge">Office knowledge</th>
      <th data-sort="outcome">Outcome</th>
      <th data-sort="last">Last activity</th>
    </tr></thead>
    <tbody id="rows">
${tableRows}
    </tbody>
  </table>

  ${dimsSection}
</div>
`;
}

export function renderDashboardHTML(data: DashboardData, opts: RenderOptions): string {
  const styles = dashboardStyles(opts.mode);
  const script = dashboardScript();
  const markup = renderMarkup(data, opts);

  if (opts.mode === "embed") {
    return `<style>${styles}</style>${markup}<script>${script}</script>`;
  }

  // Standalone — full HTML doc, links to the spec set's lib/specs.css for the
  // outer civic chrome (fonts, body bg, stripe), then inlines dashboard CSS.
  const cssHref = opts.staticCssHref ?? "lib/specs.css";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Candidate Research Progress — Havesay</title>
<link rel="stylesheet" href="${esc(cssHref)}">
<style>
${styles}
</style>
</head>
<body>
<div class="civic-stripe" aria-hidden="true"></div>
<div class="wrap">
  <div class="crumb"><a href="index.html">← Beta Spec Set</a> &nbsp;/&nbsp; Candidate Research Progress</div>
${markup}
  <div class="foot">Generated ${esc(new Date(data.generatedAt).toISOString().replace("T", " ").slice(0, 16))} UTC from local Supabase by <code>scripts/generate-research-dashboard.ts</code>. · <a href="index.html">Back to Beta Spec Set</a></div>
</div>
<script>${script}</script>
</body>
</html>
`;
}
