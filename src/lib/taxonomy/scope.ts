/**
 * Scope-applicability resolution for the sub-dimension taxonomy.
 *
 * Each sub_dimension has a `scope_applicability` JSON map describing how it should
 * be treated at each race scope (federal / state / county / municipal / judicial /
 * school_board / special_district). Three modes:
 *
 *   matching       — counts toward the voter-candidate match score
 *   informational  — shown on the candidate profile for context, excluded from match
 *   not_applicable — hidden entirely for candidates at this scope
 *
 * Absence of a scope key in the map is treated as `not_applicable` (strict default).
 * This makes opt-in matching: a dim only counts for a scope if explicitly marked.
 *
 * Counter-argument considered: "why strict default instead of permissive?"
 * Because silently scoring a candidate on an issue they have no authority over is
 * worse than silently hiding an applicable dim. Missed matches are catchable at
 * review; spurious matches erode voter trust. Strict opt-in favors the safer failure mode.
 */
import type {
  RaceLevel,
  RaceScope,
  ScopeApplicability,
  ScopeApplicabilityMode,
  SubDimension,
} from '@/types/database';

/**
 * Races in the DB currently use a constrained RaceLevel. Scopes are a superset.
 * In practice, this lets us upgrade race types over time (add 'judicial', 'municipal',
 * 'school_board') without breaking existing scope filtering.
 */
export function raceLevelToScope(level: RaceLevel): RaceScope {
  // RaceLevel and RaceScope share most values but two are aliased — DB
  // convention is offices.level='school'/'special' while scope_applicability
  // keys are 'school_board'/'special_district'. Translate explicitly.
  if (level === 'school') return 'school_board';
  if (level === 'special') return 'special_district';
  return level as RaceScope;
}

export function applicabilityAt(
  sd: Pick<SubDimension, 'scope_applicability'>,
  scope: RaceScope,
): ScopeApplicabilityMode {
  const map = sd.scope_applicability;
  if (!map) return 'not_applicable';
  return map[scope] ?? 'not_applicable';
}

/** True if this dim should count toward the match score at the given scope. */
export function isMatching(
  sd: Pick<SubDimension, 'scope_applicability'>,
  scope: RaceScope,
): boolean {
  return applicabilityAt(sd, scope) === 'matching';
}

/** True if this dim should be displayed on the candidate profile at the given scope. */
export function isVisible(
  sd: Pick<SubDimension, 'scope_applicability'>,
  scope: RaceScope,
): boolean {
  const mode = applicabilityAt(sd, scope);
  return mode === 'matching' || mode === 'informational';
}

/** Filter a dim list down to just the dims that count at this scope for matching. */
export function filterMatchingDims<T extends Pick<SubDimension, 'scope_applicability'>>(
  dims: T[],
  scope: RaceScope,
): T[] {
  return dims.filter((sd) => isMatching(sd, scope));
}

/** Filter a dim list down to dims that should be visible (matching OR informational). */
export function filterVisibleDims<T extends Pick<SubDimension, 'scope_applicability'>>(
  dims: T[],
  scope: RaceScope,
): T[] {
  return dims.filter((sd) => isVisible(sd, scope));
}

/**
 * For a candidate profile UI: partition a dim list into three buckets for rendering.
 * The UI convention is to show matching first, informational under a collapsible
 * "more context" section, and not_applicable hidden entirely.
 */
export function partitionByApplicability<T extends Pick<SubDimension, 'scope_applicability'>>(
  dims: T[],
  scope: RaceScope,
): { matching: T[]; informational: T[]; hidden: T[] } {
  const out = { matching: [] as T[], informational: [] as T[], hidden: [] as T[] };
  for (const sd of dims) {
    const mode = applicabilityAt(sd, scope);
    if (mode === 'matching') out.matching.push(sd);
    else if (mode === 'informational') out.informational.push(sd);
    else out.hidden.push(sd);
  }
  return out;
}

/**
 * True if this sub-dim applies in the given region (ISO 3166 country or sub-national code).
 * Empty or absent applicable_regions = universal (applies everywhere).
 *
 * Matches by prefix — a dim scoped to ["US"] applies for region "US-UT".
 * Matches exactly — a dim scoped to ["US-UT"] does NOT apply for region "US-CA".
 */
export function appliesInRegion(
  sd: Pick<SubDimension, 'applicable_regions'>,
  regionCode: string,
): boolean {
  const regions = sd.applicable_regions;
  if (!regions || regions.length === 0) return true; // universal
  for (const r of regions) {
    if (r === regionCode) return true;
    if (regionCode.startsWith(r + '-')) return true; // "US" covers "US-UT"
  }
  return false;
}
