/**
 * axis-set.ts - the issue's askable/scoreable axis set, shared by the voter
 * side and the candidate side of multivariable matching (doc 09 Part 4.1).
 *
 * Two responsibilities, both dependency-light (a Supabase client is the only
 * injected dependency, so this lib is importable from the app runtime, from
 * scripts, and from tests):
 *
 *   1. computeAxisUid: the single source of truth for the composite axis key.
 *      It MUST match v_axis_positions.axis_uid (in the multivariable axis
 *      registry migration) and the matcher's issueOf() split-on-first-colon,
 *      byte-for-byte. Format:
 *
 *          `${sub_dimension_id}:${axis_kind}:${axis_id ?? 'primary'}`
 *
 *      sub_dimension_id is a UUID (no colons), so issueOf()'s split on the
 *      FIRST colon recovers the issue from any axis_uid.
 *
 *   2. resolveActiveAxisSet: the issue's ACTIVE axis set, resolved exactly the
 *      way scripts/interpret/score-axes.ts resolveActiveAxes() does it:
 *        - the primary sub_dimension axis (always present),
 *        - the matching-mode backbone axes from issue_backbone_activation,
 *        - the issue's active propositions.
 *      The query is reimplemented here cleanly (NOT imported from score-axes,
 *      which is a script) so both call sites can converge on this lib later.
 *
 * Acronyms, spelled out on first use: UID (unique identifier), DB (database),
 * RLS (row-level security), JSONB (binary JavaScript object notation).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** axis_kind discriminator matching the positions / migration vocabulary. */
export type AxisKind = 'sub_dimension' | 'backbone' | 'proposition';

/**
 * One resolved axis in an issue's active subspace. This is the askable +
 * scoreable shape: enough to render a slider (label, spectrum poles) and to
 * key a position (axis_uid).
 */
export interface ActiveAxis {
  axis_kind: AxisKind;
  /** backbone_axes.id or propositions.id; null for the primary sub_dimension axis. */
  axis_id: string | null;
  /** The issue context (sub_dimensions.id) carried on every axis. */
  sub_dimension_id: string;
  /** The composite key the matcher vectors on. computeAxisUid of the three above. */
  axis_uid: string;
  /** Human label for UI / logging. */
  label: string;
  /** Slider pole at score 0.0. */
  spectrum_low: string;
  /** Slider pole at score 1.0. */
  spectrum_high: string;
}

/**
 * The composite axis key. Single source of truth shared by:
 *   - the matcher (algorithm.ts keyOf / issueOf),
 *   - the candidate-side view v_axis_positions.axis_uid,
 *   - the voter-side vector builder (voter-axis.ts).
 *
 * Format: `${subDimensionId}:${axisKind}:${axisId ?? 'primary'}`.
 * issueOf() in algorithm.ts recovers subDimensionId by splitting on the FIRST
 * colon, which is unambiguous because a UUID contains no colon.
 */
export function computeAxisUid(
  subDimensionId: string,
  axisKind: AxisKind,
  axisId: string | null,
): string {
  return `${subDimensionId}:${axisKind}:${axisId ?? 'primary'}`;
}

// ---------------------------------------------------------------------------
// Embedded-relation row shapes (PostgREST embeds one-to-one / one-to-many as
// either an object or an array depending on the cardinality it can infer, so
// we normalize defensively, exactly as score-axes.ts does).
// ---------------------------------------------------------------------------

interface SubDimRow {
  id: string;
  name: string;
  domain: string;
  spectrum_low: string;
  spectrum_high: string;
}

interface BackboneRow {
  id: string;
  code: string;
  display_label: string;
  pole_low: string;
  pole_high: string;
}

interface PropositionRow {
  id: string;
  display_label: string;
  spectrum_low: string;
  spectrum_high: string;
}

function pickOne<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * Resolve the active axis set for ONE issue: primary + matching-mode backbone +
 * active propositions. Same resolution as score-axes.ts resolveActiveAxes(),
 * shaped for askability (UI sliders) and matching (axis_uid keys).
 *
 * Returns [] on any DB error or when the issue is not found, so callers treat
 * the issue as "no askable axes" rather than crashing. The primary axis is the
 * first element on success.
 */
export async function resolveActiveAxisSet(
  sb: SupabaseClient,
  subDimensionId: string,
): Promise<ActiveAxis[]> {
  // Primary sub_dimension axis (always present when the issue exists).
  const { data: sd, error: sdErr } = await sb
    .from('sub_dimensions')
    .select('id, name, domain, spectrum_low, spectrum_high')
    .eq('id', subDimensionId)
    .maybeSingle();
  if (sdErr || !sd) return [];
  const issue = sd as SubDimRow;

  const axes: ActiveAxis[] = [
    {
      axis_kind: 'sub_dimension',
      axis_id: null,
      sub_dimension_id: issue.id,
      axis_uid: computeAxisUid(issue.id, 'sub_dimension', null),
      label: `${issue.name} (primary)`,
      spectrum_low: issue.spectrum_low,
      spectrum_high: issue.spectrum_high,
    },
  ];

  // Matching-mode backbone axes via issue_backbone_activation (mode='matching').
  const { data: act } = await sb
    .from('issue_backbone_activation')
    .select(
      'mode, backbone_axes(id, code, display_label, pole_low, pole_high)',
    )
    .eq('sub_dimension_id', issue.id)
    .eq('mode', 'matching');
  const actRows = (act ?? []) as unknown as Array<{
    backbone_axes: BackboneRow | BackboneRow[] | null;
  }>;
  for (const row of actRows) {
    const b = pickOne<BackboneRow>(row.backbone_axes);
    if (!b) continue;
    axes.push({
      axis_kind: 'backbone',
      axis_id: b.id,
      sub_dimension_id: issue.id,
      axis_uid: computeAxisUid(issue.id, 'backbone', b.id),
      label: `${issue.name} / ${b.code} ${b.display_label}`,
      spectrum_low: b.pole_low,
      spectrum_high: b.pole_high,
    });
  }

  // Active propositions for the issue.
  const { data: props } = await sb
    .from('propositions')
    .select('id, display_label, spectrum_low, spectrum_high')
    .eq('sub_dimension_id', issue.id)
    .eq('active', true);
  for (const p of (props ?? []) as PropositionRow[]) {
    axes.push({
      axis_kind: 'proposition',
      axis_id: p.id,
      sub_dimension_id: issue.id,
      axis_uid: computeAxisUid(issue.id, 'proposition', p.id),
      label: `${issue.name} / ${p.display_label}`,
      spectrum_low: p.spectrum_low,
      spectrum_high: p.spectrum_high,
    });
  }

  return axes;
}
