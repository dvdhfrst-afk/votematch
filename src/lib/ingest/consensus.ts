/**
 * consensus.ts -- N-pass MAJORITY CONSENSUS for the extraction gate (Build 6).
 *
 * The anti-hallucination premise (framework 09 Part 2.2 S3, and the multi-model
 * posture in 09 Part 5.6): the same source text is classified by several
 * heterogeneous passes (minicpm-v vision, phi4:14b, and the canonical Claude
 * account pass). A value that ONLY ONE pass produced is treated as a probable
 * single-model artifact and DROPPED; a value that two or more passes agree on is
 * KEPT. This is consensus stage 1 of the ordered gate (the gate's stage 1 in
 * extract-signals.ts is "consensus already applied upstream" -- this is that
 * upstream).
 *
 * The function is PURE: passes in, fused signals + per-field agreement rates
 * out. No I/O, no mutation of inputs, deterministic. That keeps it trivially
 * testable and re-runnable, the same discipline as the classifier interface.
 *
 * Field-level, not signal-level, on purpose. Two models can agree on the
 * proposition and direction band of a signal while one of them additionally
 * hallucinates a quote or a contact; field-level voting keeps the agreed fields
 * and drops only the lone-pass ones, rather than discarding the whole signal.
 * The fused signal therefore carries only fields that cleared the vote, plus an
 * `_agreement` map recording each field's support fraction for the audit trail.
 *
 * Single TypeScript runtime, no Python. No new dependency. No em-dashes /
 * en-dashes; acronyms spelled out on first use.
 */

import type { RawSignal } from './extract-signals';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A fused signal: the subset of RawSignal fields that cleared the majority vote
 * (appeared in >= 2 passes), plus bookkeeping. Taxonomy-keyed fields stay
 * nullable exactly as in RawSignal so a taxonomy-free stub remains a valid
 * producer.
 */
export interface FusedSignal extends Partial<RawSignal> {
  /**
   * Per-field agreement fraction in [0, 1] = (passes that produced this field's
   * winning value) / (total passes). Only fields that cleared the vote appear.
   * This is the consensus's contribution to signal_confidence downstream.
   */
  _agreement: Record<string, number>;
  /** How many passes produced a signal that matched this fused group's key. */
  _support: number;
  /** Total passes considered (denominator for _agreement). */
  _passes: number;
}

export interface ConsensusResult {
  /** Fused signals that survived (group support >= 2 passes). */
  fused: FusedSignal[];
  /**
   * Mean agreement rate per field across all surviving fused signals, for a
   * quick whole-run quality read. Empty when nothing survived.
   */
  field_agreement: Record<string, number>;
  /** Total distinct signal-groups seen across passes (before the drop). */
  groups_seen: number;
  /** Groups dropped because only one pass produced them. */
  groups_dropped_single_pass: number;
  /** Number of passes that were non-empty (contributed at least one signal). */
  passes: number;
}

// ---------------------------------------------------------------------------
// Grouping: which signals across passes are "the same signal"
// ---------------------------------------------------------------------------

/**
 * The fields a value-level vote runs over. `quote` is intentionally EXCLUDED
 * from the vote (two models rarely emit byte-identical quotes, and the gate's
 * stage 2 verifies the quote against the source text directly), but the WINNING
 * signal's quote is carried through from a supporting pass. `note` is bookkeeping
 * and not voted on.
 */
const VOTED_FIELDS: Array<keyof RawSignal> = [
  'proposition_key',
  'sub_dimension_key',
  'direction',
  'intensity_band',
  'position_kind',
  'is_action',
  'confidence',
  'authenticity_tier',
  'source_url',
  'source_domain',
  'actor',
];

/**
 * The grouping key decides which signals across passes are "the same signal" and
 * therefore voted together. We group on the stable IDENTITY of a signal: its
 * taxonomy address (proposition + sub_dimension) and its source_url. Signals
 * with the same identity are the same claim read by different models; their
 * fields are then voted field-by-field. When taxonomy fields are null (stub),
 * the source_url alone is the identity, which is the right behavior: the stub
 * emits one provenance signal per source, so same-source stub signals from
 * different passes correctly group and vote.
 */
function groupKey(s: RawSignal): string {
  const prop = s.proposition_key ?? '';
  const sub = s.sub_dimension_key ?? '';
  const url = s.source_url ?? '';
  return `${prop}\u0000${sub}\u0000${url}`;
}

/**
 * Stable stringification of a field VALUE for vote tallying. Distinguishes
 * null/undefined (a field a pass did not produce) from a real value, and
 * canonicalizes numbers and booleans so '0.30' and 0.3 tally together.
 */
function valueKey(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return null;
    // Round to 3 decimals so float noise across models does not split the vote.
    return `n:${v.toFixed(3)}`;
  }
  if (typeof v === 'boolean') return `b:${v ? 1 : 0}`;
  return `s:${String(v)}`;
}

// ---------------------------------------------------------------------------
// runConsensus
// ---------------------------------------------------------------------------

export interface ConsensusOptions {
  /**
   * Minimum number of passes a SIGNAL-GROUP must appear in to survive. Default
   * 2 (a value in only one pass is dropped). With a single pass total, the
   * effective floor is min(minGroupSupport, passes); see the single-pass note
   * below.
   */
  minGroupSupport?: number;
  /**
   * Minimum passes a FIELD VALUE must win in to be kept on the fused signal.
   * Default 2. A field whose winning value has only one supporter is dropped
   * from the fused signal (the group can still survive on its other fields).
   */
  minFieldSupport?: number;
}

/**
 * runConsensus(passes, opts): fuse N classifier passes into majority-agreed
 * signals.
 *
 *   passes: an array of passes; each pass is an array of RawSignals (one model's
 *   full output for the source). Supports heterogeneous models (minicpm-v +
 *   phi4 + Claude) since it only reads the RawSignal shape, not the producer.
 *
 * Algorithm:
 *   1. Group every signal across all passes by groupKey (taxonomy address +
 *      source). Track which PASS each grouped signal came from (a value seen
 *      three times in ONE pass still counts as one pass of support -- support is
 *      per-pass, not per-occurrence, so a single chatty model cannot manufacture
 *      consensus with itself).
 *   2. DROP any group supported by fewer than minGroupSupport distinct passes.
 *   3. For each surviving group, vote each VOTED_FIELD: tally the per-pass
 *      winning value, keep the plurality value only if its support >=
 *      minFieldSupport, and record agreement = winners / passes.
 *   4. Carry the verbatim quote and note from a supporting pass that had the
 *      winning value set (or any supporter), so the fused signal still points at
 *      a real passage for the gate's stage-2 substring check.
 *
 * Returns fused signals + agreement metrics. Pure and deterministic.
 *
 * Single-pass note: if exactly one pass is supplied, NOTHING can corroborate, so
 * every group is dropped under the default floor. That is correct for the gate
 * (a single model's reading is never auto-consensus). Callers that intentionally
 * run one pass and want it through must lower the floor explicitly.
 */
export function runConsensus(
  passes: RawSignal[][],
  opts: ConsensusOptions = {},
): ConsensusResult {
  const minGroupSupport = Math.max(1, opts.minGroupSupport ?? 2);
  const minFieldSupport = Math.max(1, opts.minFieldSupport ?? 2);

  const nonEmptyPasses = passes.filter((p) => Array.isArray(p) && p.length > 0);
  const totalPasses = passes.length;

  // (1) group across passes, tracking per-pass membership.
  interface Group {
    key: string;
    // passIndex -> the signals that pass contributed to this group.
    byPass: Map<number, RawSignal[]>;
  }
  const groups = new Map<string, Group>();

  passes.forEach((pass, passIndex) => {
    if (!Array.isArray(pass)) return;
    for (const sig of pass) {
      if (!sig || typeof sig !== 'object') continue;
      const key = groupKey(sig);
      let g = groups.get(key);
      if (!g) {
        g = { key, byPass: new Map() };
        groups.set(key, g);
      }
      const arr = g.byPass.get(passIndex) ?? [];
      arr.push(sig);
      g.byPass.set(passIndex, arr);
    }
  });

  const groupsSeen = groups.size;
  let dropped = 0;
  const fused: FusedSignal[] = [];

  for (const g of groups.values()) {
    const supportingPasses = g.byPass.size; // distinct passes -- self-repeat ignored
    if (supportingPasses < minGroupSupport) {
      dropped++;
      continue;
    }

    // (3) field-level vote across the supporting passes.
    const fusedSig: FusedSignal = { _agreement: {}, _support: supportingPasses, _passes: totalPasses };

    for (const field of VOTED_FIELDS) {
      // Per pass, pick that pass's value for the field (first signal that set it,
      // so one pass = one vote even if it emitted multiple grouped signals).
      const tally = new Map<string, { count: number; sample: unknown }>();
      for (const [, sigs] of g.byPass) {
        let vk: string | null = null;
        let sample: unknown = null;
        for (const s of sigs) {
          const candidate = (s as unknown as Record<string, unknown>)[field as string];
          const k = valueKey(candidate);
          if (k !== null) {
            vk = k;
            sample = candidate;
            break;
          }
        }
        if (vk === null) continue; // this pass did not set the field
        const cur = tally.get(vk) ?? { count: 0, sample };
        cur.count += 1;
        tally.set(vk, cur);
      }

      // Plurality winner.
      let bestKey: string | null = null;
      let bestCount = 0;
      let bestSample: unknown = null;
      for (const [k, v] of tally) {
        if (v.count > bestCount) {
          bestCount = v.count;
          bestKey = k;
          bestSample = v.sample;
        }
      }

      if (bestKey !== null && bestCount >= minFieldSupport) {
        (fusedSig as unknown as Record<string, unknown>)[field as string] = bestSample;
        fusedSig._agreement[field as string] = totalPasses > 0 ? bestCount / totalPasses : 0;
      }
      // else: field dropped (only one pass set it, or split with no plurality
      // reaching the floor). The group can still survive on its other fields.
    }

    // (4) carry quote + note from a supporting signal (prefer one whose direction
    // matches the fused direction, else any). The quote is NOT voted; the gate
    // verifies it against source text. We just need a real passage to verify.
    let carriedQuote: string | null | undefined;
    let carriedNote: string | undefined;
    for (const [, sigs] of g.byPass) {
      for (const s of sigs) {
        if (carriedQuote == null && s.quote != null && String(s.quote).length > 0) {
          carriedQuote = s.quote;
        }
        if (carriedNote == null && s.note != null) {
          carriedNote = s.note;
        }
      }
    }
    if (carriedQuote !== undefined) fusedSig.quote = carriedQuote;
    if (carriedNote !== undefined) fusedSig.note = carriedNote;

    fused.push(fusedSig);
  }

  // Whole-run mean agreement per field.
  const fieldSums: Record<string, { sum: number; n: number }> = {};
  for (const f of fused) {
    for (const [field, rate] of Object.entries(f._agreement)) {
      const e = fieldSums[field] ?? { sum: 0, n: 0 };
      e.sum += rate;
      e.n += 1;
      fieldSums[field] = e;
    }
  }
  const field_agreement: Record<string, number> = {};
  for (const [field, { sum, n }] of Object.entries(fieldSums)) {
    field_agreement[field] = n > 0 ? sum / n : 0;
  }

  return {
    fused,
    field_agreement,
    groups_seen: groupsSeen,
    groups_dropped_single_pass: dropped,
    passes: nonEmptyPasses.length,
  };
}
