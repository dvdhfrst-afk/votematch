/**
 * legislative-record.ts -- the incumbent OFFICIAL-RECORD harvester (Build 4 of
 * the source-centric harvest engine; see 12-positioning-engine/13-harvest-buildout-plan.md).
 *
 * PATTERN (Build 4): bulk record -> many officeholders. This is a SourceParser
 * that plugs into the generic source-harvest-runner (Phase 0). For a source whose
 * SCOPE names some set of incumbents (a state legislature, a Congressional
 * delegation, or a single person), it pulls each incumbent's legislative VOTES +
 * SPONSORSHIPS and emits one ParsedUnit per item.
 *
 * REUSE -- this parser does NOT rebuild any federal/state API client. It calls the
 * EXISTING Build-2 enrichment wrappers:
 *   - fetchCongress(bioguideId, ctx)   -> congress/types.ts (member_bio + sponsorship)
 *   - fetchOpenStates(openstatesId, ctx) -> openstates state_role
 * Both wrappers are bound by STRONG ID, return normalized CandidateRecordRow[],
 * and skip gracefully (return []) when their API key is unset. We re-key the
 * legislative items inside those rows into the harvest runner's ParsedUnit shape.
 *
 * STRONG-ID RESOLUTION (the most reliable path, no name guessing): every unit
 * carries strongId = { kind, external_id } -- 'bioguide_id' for federal, an
 * 'openstates_id' for state. The runner resolves strongId via person_xref FIRST
 * (deterministic bind at 1.0), so candidateMention is intentionally NULL. We never
 * fall back to a roster name match for these units; if the strong id is unknown to
 * person_xref the runner holds the unit unattributed (correct -- we do not guess).
 *
 * SIGNAL VIEW (doc 09 signal gate): votes and sponsorships are an INFERRED-view
 * signal. They feed axes through a bill->axis map (bill-axis-map.seed.json here,
 * the real bill_axis_map table once the multivariable schema lands). This parser
 * attaches a COARSE axis HINT in extra.axis_hint when a bill matches the seed map;
 * it writes NO graded coordinate. An unmapped bill simply carries no hint and is
 * left for the later classifier. (Local-government minutes -- the government's OWN
 * published agendas/minutes, never the CivicPlus/Granicus vendor copy -- are a
 * documented TODO for a later iteration; see LOCAL_MINUTES_TODO below.)
 *
 * Single TypeScript runtime, no Python. No metered per-token API. No new npm dep.
 * Native JSON read for the seed; the enrich wrappers use native fetch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { QueryClient } from '../../identity-resolve';
import { fetchCongress, fetchOpenStates } from '@/lib/enrich';
import type { CandidateRecordRow, EnrichContext } from '@/lib/enrich';
import type {
  HarvestSource,
  ParsedUnit,
  ParserDeps,
  SourceParser,
} from '../source-harvest-runner';

/**
 * LOCAL_MINUTES_TODO (Build 4, later iteration -- NOT built here):
 * For local incumbents (city council, county commission, school board) there is
 * no federal/state vote API. The signal comes from the government's OWN published
 * agendas + minutes. POLICY (app/CLAUDE.md data-source policy): take the
 * GOVERNMENT copy of the minutes, never the CivicPlus / Granicus / Legistar vendor
 * platform -- those are vendor-controlled aggregators we may compete with and that
 * change ToS. A later iteration registers a 'legislative_record' source whose url
 * points at the .gov agenda/minutes PDF/HTML, extracts roll-call votes and
 * statements where feasible (lower priority, harder, no clean API), resolves each
 * named member ROSTER-constrained (race-roster.ts), and emits inferred-view units
 * with locus = { meeting_date, agenda_item }. Deferred deliberately to keep this
 * build to the strong-id federal/state path that the enrich wrappers already cover.
 */
export const LOCAL_MINUTES_TODO =
  'Local-government minutes harvest (government-published agendas/minutes, NOT ' +
  'CivicPlus/Granicus vendor copies) is a documented TODO for a later iteration.';

export const SOURCE_TYPE = 'legislative_record' as const;

// ---------------------------------------------------------------------------
// Strong-id selection for the source's scope.
// ---------------------------------------------------------------------------

/** One incumbent in scope, with the strong id we will harvest by. */
export interface ScopedIncumbent {
  person_id: string;
  canonical_name: string | null;
  state_fips: string | null;
  /** Exactly one of these is set per harvest call (we prefer bioguide). */
  bioguide_id?: string | null;
  openstates_id?: string | null;
}

/**
 * Resolve the set of incumbents this source covers, each with a strong id.
 *
 * Two scoping modes (deps win over the source row so tests / the CLI can inject):
 *   1. deps.incumbents: an explicit ScopedIncumbent[] (the CLI passes this for
 *      --person and --all-incumbents; the offline test injects fixtures here).
 *   2. source.meta.person_ids: a person_id[] on the harvest_sources row -- we look
 *      up each person's bioguide_id / openstates_id in person_xref.
 *   3. otherwise: pull people in the source's scope (fips_state) that carry a
 *      bioguide_id OR openstates_id xref. Bounded by deps.limit.
 *
 * person_xref is the SAME strong-id table the enrich dispatcher reads, so a
 * person harvestable here is exactly a person enrich could bind.
 */
export async function resolveScopedIncumbents(
  source: HarvestSource,
  deps: ParserDeps,
): Promise<ScopedIncumbent[]> {
  const injected = (deps as { incumbents?: ScopedIncumbent[] }).incumbents;
  if (Array.isArray(injected)) return injected;

  const client = deps.client as QueryClient;
  const limit = Number((deps as { limit?: number }).limit ?? 0) || 0;

  // From an explicit person_ids list on the source row.
  const metaPersonIds = (source.meta as { person_ids?: string[] } | null | undefined)?.person_ids;
  if (Array.isArray(metaPersonIds) && metaPersonIds.length > 0) {
    return loadIncumbentsByPersonIds(client, metaPersonIds);
  }

  // Else: people in scope (fips_state) carrying a strong id usable here.
  const where: string[] = [`x.kind IN ('bioguide_id','openstates_id')`];
  const params: unknown[] = [];
  if (source.fips_state) {
    params.push(source.fips_state);
    where.push(`p.state_fips_primary = $${params.length}`);
  }
  let sql = `
    SELECT p.id AS person_id, p.canonical_name, p.state_fips_primary AS state_fips,
           x.kind, x.external_id
      FROM people p
      JOIN person_xref x ON x.person_id = p.id
     WHERE ${where.join(' AND ')}
     ORDER BY p.canonical_name`;
  if (limit > 0) {
    params.push(limit);
    sql += `\n     LIMIT $${params.length}`;
  }
  const res = await client.query<{
    person_id: string;
    canonical_name: string | null;
    state_fips: string | null;
    kind: string;
    external_id: string;
  }>(sql, params);
  return foldXrefRows(res.rows);
}

/** Load specific person_ids and their harvest-relevant strong ids. */
async function loadIncumbentsByPersonIds(
  client: QueryClient,
  personIds: string[],
): Promise<ScopedIncumbent[]> {
  const res = await client.query<{
    person_id: string;
    canonical_name: string | null;
    state_fips: string | null;
    kind: string;
    external_id: string;
  }>(
    `SELECT p.id AS person_id, p.canonical_name, p.state_fips_primary AS state_fips,
            x.kind, x.external_id
       FROM people p
       JOIN person_xref x ON x.person_id = p.id
      WHERE p.id = ANY($1)
        AND x.kind IN ('bioguide_id','openstates_id')`,
    [personIds],
  );
  return foldXrefRows(res.rows);
}

/** Fold (person, kind, external_id) rows into one ScopedIncumbent per person. */
function foldXrefRows(
  rows: Array<{
    person_id: string;
    canonical_name: string | null;
    state_fips: string | null;
    kind: string;
    external_id: string;
  }>,
): ScopedIncumbent[] {
  const byPerson = new Map<string, ScopedIncumbent>();
  for (const r of rows) {
    let inc = byPerson.get(r.person_id);
    if (!inc) {
      inc = {
        person_id: r.person_id,
        canonical_name: r.canonical_name,
        state_fips: r.state_fips,
      };
      byPerson.set(r.person_id, inc);
    }
    if (r.kind === 'bioguide_id') inc.bioguide_id = r.external_id;
    if (r.kind === 'openstates_id') inc.openstates_id = r.external_id;
  }
  return [...byPerson.values()];
}

// ---------------------------------------------------------------------------
// bill->axis seed map (STUB bridge; held until the multivariable schema lands).
// ---------------------------------------------------------------------------

export interface AxisHint {
  axis: string;
  /** Direction a 'yea' / a sponsorship implies on the axis, in [0,1] (coarse). */
  direction: number;
  /** How the bill matched the seed: which key tier fired. */
  matched_by: 'bill_ref' | 'policy_area' | 'title_keyword';
  /** The seed note (provenance for why this hint applies). */
  note?: string;
  /** Always the seed version -- this is a HINT, not a licensed coordinate. */
  map_version: string;
  /** Mechanical gate reminder for downstream: this is inferred-view, ungated. */
  signal_view: 'inferred';
  hint_only: true;
}

interface SeedShape {
  version: string;
  axis_hints: {
    by_bill_ref: Record<string, { axis: string; direction: number; note?: string }>;
    by_policy_area: Record<string, { axis: string; direction: number; note?: string }>;
    by_title_keyword: Record<string, { axis: string; direction: number; note?: string }>;
  };
}

let _seedCache: SeedShape | null = null;

/** Default on-disk location of the seed (relative to app/). */
export function defaultSeedPath(): string {
  return join(process.cwd(), 'data', 'positioning', 'bill-axis-map.seed.json');
}

/**
 * Load the bill->axis seed map. Cached. A caller (test) can inject a parsed seed
 * via deps.billAxisSeed to avoid the disk read; otherwise we read defaultSeedPath.
 * Returns null if neither is available (the parser then attaches no hints).
 */
export function loadBillAxisSeed(deps?: ParserDeps): SeedShape | null {
  const injected = (deps as { billAxisSeed?: SeedShape } | undefined)?.billAxisSeed;
  if (injected && injected.axis_hints) return injected;
  if (_seedCache) return _seedCache;
  try {
    const raw = readFileSync(defaultSeedPath(), 'utf8');
    const parsed = JSON.parse(raw) as SeedShape;
    if (parsed && parsed.axis_hints) {
      _seedCache = parsed;
      return parsed;
    }
  } catch {
    // Missing/unreadable seed -> no hints (graceful: the build still produces
    // attributed units, just without the axis hint).
  }
  return null;
}

/** Reset the in-process seed cache (test hygiene). */
export function _resetSeedCache(): void {
  _seedCache = null;
}

/**
 * Compute an axis hint for one bill. Tries the three seed tiers most-specific
 * first: exact bill_ref, then policy_area (case-insensitive exact), then a
 * title-keyword substring. Returns null when no tier matches (an unmapped bill
 * yields no coordinate, per doc 09).
 */
export function axisHintForBill(
  bill: { bill_ref?: string | null; policy_area?: string | null; title?: string | null },
  seed: SeedShape | null,
): AxisHint | null {
  if (!seed) return null;
  const h = seed.axis_hints;

  // Tier 1: exact bill_ref.
  if (bill.bill_ref) {
    const key = bill.bill_ref.trim().toLowerCase();
    const hit = h.by_bill_ref[key];
    if (hit) {
      return {
        axis: hit.axis,
        direction: hit.direction,
        matched_by: 'bill_ref',
        note: hit.note,
        map_version: seed.version,
        signal_view: 'inferred',
        hint_only: true,
      };
    }
  }

  // Tier 2: policy area (case-insensitive exact).
  if (bill.policy_area) {
    const pa = bill.policy_area.trim().toLowerCase();
    for (const [k, v] of Object.entries(h.by_policy_area)) {
      if (k.toLowerCase() === pa) {
        return {
          axis: v.axis,
          direction: v.direction,
          matched_by: 'policy_area',
          note: v.note,
          map_version: seed.version,
          signal_view: 'inferred',
          hint_only: true,
        };
      }
    }
  }

  // Tier 3: title keyword substring.
  if (bill.title) {
    const title = bill.title.toLowerCase();
    for (const [kw, v] of Object.entries(h.by_title_keyword)) {
      if (title.includes(kw.toLowerCase())) {
        return {
          axis: v.axis,
          direction: v.direction,
          matched_by: 'title_keyword',
          note: v.note,
          map_version: seed.version,
          signal_view: 'inferred',
          hint_only: true,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Re-key enrichment rows -> ParsedUnits.
// ---------------------------------------------------------------------------

/**
 * A normalized bill/vote item, the common shape we derive ParsedUnits from. The
 * enrich congress wrapper exposes sponsorship items in payload.recent_sponsored /
 * payload.recent_cosponsored; a vote item (from federal_vote_positions, when the
 * caller injects it) follows the same shape with an outcome + position.
 */
interface RecordItem {
  /** A canonical bill reference like 'hr-2-118' (type-number-congress), lowercased. */
  bill_ref: string | null;
  bill_id: string | null;
  title: string | null;
  policy_area: string | null;
  date: string | null;
  /** 'sponsorship' (introduced) | 'cosponsorship' | 'vote'. */
  kind: 'sponsorship' | 'cosponsorship' | 'vote';
  /** For votes: 'Yea' | 'Nay' | 'Present' | 'Not Voting'. Null for sponsorships. */
  position?: string | null;
  /** For votes: the roll-call outcome ('Passed' | 'Failed' | ...). */
  outcome?: string | null;
  chamber: string | null;
}

/** Build a canonical bill_ref from a congress legislation item, lowercased. */
function billRefFromCongress(item: {
  type?: string | null;
  number?: string | null;
  congress?: number | null;
}): string | null {
  if (!item.type || !item.number) return null;
  const c = item.congress ?? '';
  return `${item.type}-${item.number}${c ? `-${c}` : ''}`.toLowerCase();
}

/**
 * Extract RecordItems from the Build-2 congress enrichment rows. We read the
 * sponsorship row's recent_sponsored + recent_cosponsored arrays (the per-bill
 * detail the wrapper already normalized) and the member_bio's chamber for locus.
 */
function congressRowsToItems(rows: CandidateRecordRow[]): RecordItem[] {
  const items: RecordItem[] = [];
  const bio = rows.find((r) => r.record_type === 'member_bio');
  const chamber = (bio?.payload?.chamber as string | null | undefined) ?? null;

  const spon = rows.find((r) => r.record_type === 'sponsorship');
  if (!spon) return items;

  const pushList = (
    list: unknown,
    kind: 'sponsorship' | 'cosponsorship',
  ): void => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      const b = raw as {
        type?: string | null;
        number?: string | null;
        congress?: number | null;
        title?: string | null;
        policy_area?: string | null;
        introduced_date?: string | null;
      };
      items.push({
        bill_ref: billRefFromCongress(b),
        bill_id: billRefFromCongress(b),
        title: b.title ?? null,
        policy_area: b.policy_area ?? null,
        date: b.introduced_date ?? null,
        kind,
        position: null,
        outcome: null,
        chamber,
      });
    }
  };

  pushList(spon.payload?.recent_sponsored, 'sponsorship');
  pushList(spon.payload?.recent_cosponsored, 'cosponsorship');
  return items;
}

/**
 * Optional injected VOTE items (deps.votesByStrongId[external_id]) -- the federal
 * roll-call vote ingest (scripts/ingest-federal-votes.ts) populates
 * federal_vote_positions; a caller that wants those harvested into ParsedUnits can
 * pass them here keyed by bioguide/openstates id. Each item is a RecordItem with
 * kind 'vote'. We keep this an injection point (not a DB read) so the parser stays
 * I/O-light and the offline test can exercise the vote path with fixtures.
 */
function injectedVoteItems(
  deps: ParserDeps,
  strongIdExternal: string,
): RecordItem[] {
  const byId = (deps as { votesByStrongId?: Record<string, RecordItem[]> }).votesByStrongId;
  const list = byId?.[strongIdExternal];
  return Array.isArray(list) ? list : [];
}

/** Map one RecordItem to a ParsedUnit carrying the strong id + axis hint. */
function itemToUnit(
  item: RecordItem,
  strongId: { kind: string; external_id: string },
  seed: SeedShape | null,
): ParsedUnit {
  const sourceFamily = item.kind === 'vote' ? 'vote_record' : 'sponsorship';
  const verb =
    item.kind === 'vote'
      ? `Voted ${item.position ?? '?'}`
      : item.kind === 'cosponsorship'
        ? 'Cosponsored'
        : 'Sponsored';

  const content = [
    `${verb} ${item.bill_ref ? item.bill_ref.toUpperCase() : '(bill)'}`,
    item.title ? `: ${item.title}` : '',
    item.policy_area ? ` [policy area: ${item.policy_area}]` : '',
    item.outcome ? ` (outcome: ${item.outcome})` : '',
    item.date ? ` (${item.date})` : '',
  ].join('');

  const hint = axisHintForBill(item, seed);

  const extra: Record<string, unknown> = {
    bill_id: item.bill_id,
    bill_ref: item.bill_ref,
    record_kind: item.kind,
    position: item.position ?? null,
    outcome: item.outcome ?? null,
    // The bill->axis hint when the seed matched, else an explicit unmapped marker
    // so the downstream classifier knows this item was SEEN and left for it.
    ...(hint
      ? { axis_hint: hint }
      : { axis_hint: null, axis_hint_status: 'unmapped_held_for_classifier' }),
  };

  return {
    candidateMention: null, // strong-id keyed: no name guessing
    strongId,
    locus: {
      chamber: item.chamber,
      bill_ref: item.bill_ref,
      record_kind: item.kind,
      date: item.date,
    },
    content,
    source_family: sourceFamily,
    signal_view: 'inferred', // votes/sponsorships are an inferred-view signal (doc 09)
    extra,
  };
}

// ---------------------------------------------------------------------------
// The SourceParser.
// ---------------------------------------------------------------------------

/**
 * legislativeRecordParser -- source_type 'legislative_record'. For each in-scope
 * incumbent (resolved by strong id), reuse the Build-2 enrich wrappers to pull the
 * member's sponsorships (+ optional injected votes) and emit one inferred-view
 * ParsedUnit per item, each carrying strongId, locus, source_family, and the
 * bill->axis hint from the seed when a bill matches.
 *
 * Skips gracefully: if neither CONGRESS_API_KEY nor OPENSTATES_API_KEY is set the
 * wrappers return [] and this parser yields no units (no error). The strong-id
 * resolution itself happens in the RUNNER (via person_xref), not here -- this
 * parser only stamps the strongId onto each unit.
 */
export const legislativeRecordParser: SourceParser = {
  source_type: SOURCE_TYPE,

  async fetchAndParse(source: HarvestSource, deps: ParserDeps): Promise<ParsedUnit[]> {
    const seed = loadBillAxisSeed(deps);
    const incumbents = await resolveScopedIncumbents(source, deps);
    const units: ParsedUnit[] = [];

    for (const inc of incumbents) {
      const ctx: EnrichContext = {
        person_id: inc.person_id,
        canonical_name: inc.canonical_name,
        state_fips: inc.state_fips,
      };

      // FEDERAL: bioguide_id -> reuse fetchCongress (member_bio + sponsorship).
      if (inc.bioguide_id) {
        const strongId = { kind: 'bioguide_id', external_id: inc.bioguide_id };
        let rows: CandidateRecordRow[] = [];
        try {
          rows = await fetchCongress(inc.bioguide_id, ctx);
        } catch {
          rows = [];
        }
        const items = [
          ...congressRowsToItems(rows),
          ...injectedVoteItems(deps, inc.bioguide_id),
        ];
        for (const item of items) units.push(itemToUnit(item, strongId, seed));
      }

      // STATE: openstates_id -> reuse fetchOpenStates for the role fact; the
      // state vote/sponsorship corpus is not yet an API we wrap (OpenStates bulk
      // requires login -- see app/CLAUDE.md), so state vote items only flow in via
      // injection (deps.votesByStrongId), keeping the strong-id path uniform.
      if (inc.openstates_id) {
        const strongId = { kind: 'openstates_id', external_id: inc.openstates_id };
        try {
          // Called for parity / future-proofing; the current OpenStates wrapper
          // returns a state_role fact (no per-bill items), so it contributes no
          // RecordItems today. We still invoke it so a later wrapper that adds
          // state sponsorships flows through with zero parser changes.
          await fetchOpenStates(inc.openstates_id, ctx);
        } catch {
          // ignore -- graceful skip
        }
        const items = injectedVoteItems(deps, inc.openstates_id);
        for (const item of items) units.push(itemToUnit(item, strongId, seed));
      }
    }

    return units;
  },
};

export default legislativeRecordParser;
