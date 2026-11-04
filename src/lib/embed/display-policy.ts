/**
 * display-policy.ts - what the embeddable widget is allowed to SHOW, wired to
 * the entailment gate's mode.
 *
 * THE RULE (V2-VISION pillar 2, "two-view positioning, gated AND auditable")
 * ----------------------------------------------------------------------------
 * Stated (the candidate's own words) outranks inferred (AI-collected). Inferred
 * data displays ONLY above the clearly-supported bar. The entailment gate
 * (lib/ingest/entailment-gate.ts) decides that bar at CLASSIFICATION time by
 * clamping any inferred reading that does not entail its cited quote down to
 * 'low' confidence. This module is the DISPLAY-side companion: given the gate's
 * current MODE, it decides which already-stored positions the widget surfaces.
 *
 * WHY IT IS KEYED TO gateMode()
 * ----------------------------------------------------------------------------
 * While ENTAILMENT_GATE=shadow the gate is measuring, not enforcing: an inferred
 * row that fails entailment still carries whatever confidence it had, so
 * confidence alone is NOT yet a trustworthy display signal for inferred content.
 * So under shadow the widget shows ONLY the two provenance tiers that do not
 * depend on the entailment check being enforced:
 *   - candidate-stated (the candidate's own words), and
 *   - officeholder voting record (an official roll-call fact).
 * Everything inferred/media is withheld and the candidate shows an abstain-honest
 * card ("has not stated a public position; we are still gathering").
 *
 * When ENTAILMENT_GATE flips to enforce, the gate itself has clamped every
 * non-entailed inferred row to 'low', so a SURVIVING high/medium inferred row is
 * exactly the "voter_visible" band. At that point the display rule drops the
 * tier restriction and admits any RENDERABLE position (self-stated OR high/medium
 * confidence). Flipping the gate therefore AUTOMATICALLY widens the widget from
 * "stated + record only" to "stated + record + entailment-passed inferred",
 * with no code change here. That is the whole point: one env flip, two behaviors.
 *
 * This module never RAISES trust; it only decides visibility. It reuses the
 * candidate page's renderable floor (lib/candidate/display-gate) so the widget
 * and the full candidate page agree on the minimum bar.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { gateMode, type GateMode } from '@/lib/ingest/entailment-gate';
import { isRenderablePosition, type GatePosition } from '@/lib/candidate/display-gate';

/**
 * The provenance tiers that are trustworthy to display WITHOUT the entailment
 * gate being enforced: the candidate's own current words and the official
 * voting record. These are facts of record, not AI readings, so shadow mode
 * shows them. Keyed off positions.source_tier (see lib/provenance TIER_META).
 */
export const SHADOW_VISIBLE_SOURCE_TIERS: ReadonlySet<string> = new Set([
  'candidate_stated_current',
  'voting_record_authoritative',
]);

/** The minimal position shape the display policy reads (a subset of positions columns). */
export interface DisplayPosition extends GatePosition {
  /** positions.source_tier (nullable). Drives the shadow-mode tier restriction. */
  source_tier?: string | null;
}

/**
 * True when a position is the candidate's own current words. A position counts
 * as stated when EITHER its provenance tier says so OR its view_type is 'stated'
 * (robust to whichever field the pipeline populated for a given row).
 */
export function isStatedTier(p: DisplayPosition): boolean {
  return p.source_tier === 'candidate_stated_current' || p.view_type === 'stated';
}

/** True when a position is drawn from the official roll-call voting record. */
export function isOfficeholderRecordTier(p: DisplayPosition): boolean {
  return p.source_tier === 'voting_record_authoritative';
}

/**
 * The single decision: is this position VISIBLE in the widget under the given
 * gate mode?
 *
 *   - Every mode first requires the RENDERABLE floor (self-stated OR high/medium
 *     confidence) so a low-confidence guess is never shown.
 *   - shadow: additionally restrict to stated + officeholder-record tiers.
 *   - enforce / off: no tier restriction beyond renderable (under enforce the
 *     entailment gate has already clamped non-entailed inferred rows out).
 *
 * mode defaults to the live gateMode() so callers can just pass a position.
 */
export function isEmbedVisiblePosition(
  p: DisplayPosition,
  mode: GateMode = gateMode(),
): boolean {
  if (!isRenderablePosition(p)) return false;
  if (mode === 'shadow') {
    return isStatedTier(p) || isOfficeholderRecordTier(p);
  }
  // enforce | off: renderable is the bar; entailment-passed inferred is admitted.
  return true;
}

/**
 * A plain-language, voter-facing description of what the widget is showing under
 * the current gate mode. Rendered in the methodology strip and the abstain
 * cards so the display rule is auditable, never hidden.
 */
export function embedGateExplainer(mode: GateMode = gateMode()): {
  mode: GateMode;
  /** One-line summary of the display band. */
  summary: string;
  /** The longer honest explanation for the trust/methodology strip. */
  detail: string;
} {
  if (mode === 'shadow') {
    return {
      mode,
      summary: 'Showing the candidate’s own words and official voting records only.',
      detail:
        'Our AI-collected (inferred) readings are still being verified against their cited sources, so we are not showing them yet. Where a candidate has not stated a position in their own words and has no relevant voting record, we say so plainly rather than guess.',
    };
  }
  if (mode === 'enforce') {
    return {
      mode,
      summary:
        'Showing stated positions, voting records, and AI-inferred readings that passed our source-entailment check.',
      detail:
        'Inferred readings are shown only when our entailment check confirms the cited quote actually supports the reading. Every inferred claim stays labeled as AI-collected and carries its source receipt.',
    };
  }
  return {
    mode,
    summary: 'Showing all renderable positions (gate off).',
    detail:
      'The entailment gate is off in this environment; positions are shown at the renderable floor. This mode is for development only.',
  };
}
