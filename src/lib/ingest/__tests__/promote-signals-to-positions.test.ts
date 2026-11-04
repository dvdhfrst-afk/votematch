/**
 * Offline unit tests for promote-signals-to-positions.ts.
 *
 * Covers the THREE pure pieces of logic the promotion stage rests on, with no DB
 * and no Ollama:
 *   1. buildSlugToIdMap        -- slug -> sub_dimension id, active-only.
 *   2. aggregateSignals        -- the confidence-weighted-mean scoring rule.
 *   3. buildCitations          -- {url,title,date} citation building (never empty url).
 *   + planPositionsForPerson   -- the end-to-end pure planner that ties them together.
 *
 * Vitest (the project's runner). No network, no database.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSlugToIdMap,
  aggregateSignals,
  buildCitations,
  deriveConfidenceEnum,
  signalNumericConfidence,
  planPositionsForPerson,
  type ActiveSubDimensionLite,
  type StoredSignal,
  type EvidenceSignalRow,
} from '../promote-signals-to-positions';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUB_DIMS: ActiveSubDimensionLite[] = [
  { id: 'sd-immigration', name: 'immigration', active: true },
  { id: 'sd-school-choice', name: 'school_choice', active: true },
  { id: 'sd-water-rights', name: 'water_rights', active: true },
  // Inactive: must be excluded from the slug map.
  { id: 'sd-retired', name: 'retired_axis', active: false },
];

function sig(partial: Partial<StoredSignal>): StoredSignal {
  return {
    sub_dimension_key: 'immigration',
    direction: 0.5,
    confidence: 'medium',
    position_kind: 'graded',
    quote: 'q',
    source_url: 'https://example.com/a',
    ...partial,
  };
}

function row(partial: Partial<EvidenceSignalRow> & { signal: StoredSignal }): EvidenceSignalRow {
  return {
    id: 'es-1',
    person_id: 'person-1',
    source_url: partial.signal.source_url ?? null,
    fetched_at: '2026-05-01T00:00:00Z',
    source_title: null,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// 1. slug -> id mapping
// ---------------------------------------------------------------------------

describe('buildSlugToIdMap', () => {
  it('maps active sub_dimension slugs to their ids', () => {
    const m = buildSlugToIdMap(SUB_DIMS);
    expect(m.get('immigration')).toBe('sd-immigration');
    expect(m.get('school_choice')).toBe('sd-school-choice');
    expect(m.get('water_rights')).toBe('sd-water-rights');
  });

  it('excludes inactive sub_dimensions', () => {
    const m = buildSlugToIdMap(SUB_DIMS);
    expect(m.has('retired_axis')).toBe(false);
  });

  it('first-write-wins on a duplicate slug', () => {
    const m = buildSlugToIdMap([
      { id: 'first', name: 'dup', active: true },
      { id: 'second', name: 'dup', active: true },
    ]);
    expect(m.get('dup')).toBe('first');
  });
});

// ---------------------------------------------------------------------------
// 2. aggregation / scoring rule
// ---------------------------------------------------------------------------

describe('signalNumericConfidence', () => {
  it('prefers the numeric signal_confidence', () => {
    expect(signalNumericConfidence(sig({ signal_confidence: 0.9 }))).toBeCloseTo(0.9, 6);
  });
  it('falls back to the enum when no numeric value', () => {
    expect(signalNumericConfidence(sig({ signal_confidence: null, confidence: 'high' }))).toBeCloseTo(0.85, 6);
    expect(signalNumericConfidence(sig({ signal_confidence: null, confidence: 'low' }))).toBeCloseTo(0.4, 6);
  });
});

describe('deriveConfidenceEnum', () => {
  it('maps numeric confidence to the positions enum at the documented cutoffs', () => {
    expect(deriveConfidenceEnum(0.9)).toBe('high');
    expect(deriveConfidenceEnum(0.75)).toBe('high');
    expect(deriveConfidenceEnum(0.6)).toBe('medium');
    expect(deriveConfidenceEnum(0.5)).toBe('medium');
    expect(deriveConfidenceEnum(0.49)).toBe('low');
    expect(deriveConfidenceEnum(0.1)).toBe('low');
  });
});

describe('aggregateSignals', () => {
  it('returns a single graded signal score unchanged', () => {
    const out = aggregateSignals([sig({ direction: 0.8, signal_confidence: 0.9 })]);
    expect(out.score).toBeCloseTo(0.8, 6);
    expect(out.confidence).toBe('high');
    expect(out.contributingCount).toBe(1);
    expect(out.rationale).toBe('single_graded_signal');
  });

  it('computes a confidence-weighted mean across multiple graded signals', () => {
    // direction 0.2 @ conf 0.9, direction 0.8 @ conf 0.3.
    // weighted mean = (0.9*0.2 + 0.3*0.8) / (0.9 + 0.3) = (0.18 + 0.24)/1.2 = 0.35
    const out = aggregateSignals([
      sig({ direction: 0.2, signal_confidence: 0.9 }),
      sig({ direction: 0.8, signal_confidence: 0.3 }),
    ]);
    expect(out.score).toBeCloseTo(0.35, 6);
    expect(out.contributingCount).toBe(2);
    // Aggregate confidence = MAX contributing confidence (0.9) -> 'high', not the mean.
    expect(out.confidence).toBe('high');
    expect(out.numericConfidence).toBeCloseTo(0.9, 6);
  });

  it('treats balanced as direction 0.5 and includes it in the mean', () => {
    const out = aggregateSignals([
      sig({ position_kind: 'balanced', direction: 0.5, signal_confidence: 0.6 }),
      sig({ direction: 0.9, signal_confidence: 0.6 }),
    ]);
    // (0.6*0.5 + 0.6*0.9)/1.2 = 0.7
    expect(out.score).toBeCloseTo(0.7, 6);
    expect(out.contributingCount).toBe(2);
  });

  it('EXCLUDES abstains_governing (direction null) from the mean', () => {
    const out = aggregateSignals([
      sig({ position_kind: 'abstains_governing', direction: null, signal_confidence: 0.9 }),
      sig({ direction: 0.6, signal_confidence: 0.5 }),
    ]);
    // Only the graded 0.6 contributes; the abstain raises consideredCount only.
    expect(out.score).toBeCloseTo(0.6, 6);
    expect(out.contributingCount).toBe(1);
    expect(out.consideredCount).toBe(2);
  });

  it('also excludes an abstain even if a stray direction is present (hard rule)', () => {
    const out = aggregateSignals([
      // A malformed abstain with a non-null direction must STILL be excluded.
      sig({ position_kind: 'abstains_governing', direction: 0.5, signal_confidence: 0.9 }),
    ]);
    expect(out.score).toBeNull();
    expect(out.contributingCount).toBe(0);
    expect(out.rationale).toBe('no_graded_signal');
  });

  it('returns null score when no signal places a graded direction (silence is not a position)', () => {
    const out = aggregateSignals([
      sig({ direction: null }),
      sig({ position_kind: 'abstains_governing', direction: null }),
    ]);
    expect(out.score).toBeNull();
    expect(out.contributingCount).toBe(0);
  });

  it('clamps an out-of-range direction into 0..1', () => {
    const out = aggregateSignals([sig({ direction: 1.5, signal_confidence: 0.8 })]);
    expect(out.score).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// 3. citation building
// ---------------------------------------------------------------------------

describe('buildCitations', () => {
  it('builds one {url,title,date} per distinct contributing url', () => {
    const cites = buildCitations([
      row({ signal: sig({ source_url: 'https://a.org/1' }), fetched_at: '2026-01-01T00:00:00Z' }),
      row({ signal: sig({ source_url: 'https://b.org/2' }), fetched_at: '2026-02-02T00:00:00Z' }),
    ]);
    expect(cites).toHaveLength(2);
    expect(cites[0].url).toBe('https://a.org/1');
    expect(cites[0].title).toBe('a.org'); // host fallback when no source_title
    expect(cites[0].date).toBe('2026-01-01T00:00:00Z');
  });

  it('dedupes by url', () => {
    const cites = buildCitations([
      row({ signal: sig({ source_url: 'https://a.org/1' }) }),
      row({ signal: sig({ source_url: 'https://a.org/1' }) }),
    ]);
    expect(cites).toHaveLength(1);
  });

  it('NEVER emits a citation with an empty url', () => {
    const cites = buildCitations([
      row({ signal: sig({ source_url: '' }), source_url: null }),
      row({ signal: sig({ source_url: '   ' }), source_url: null }),
      row({ signal: sig({ source_url: 'https://good.org/x' }) }),
    ]);
    expect(cites).toHaveLength(1);
    expect(cites[0].url).toBe('https://good.org/x');
    expect(cites.every((c) => c.url.trim().length > 0)).toBe(true);
  });

  it('prefers signal.recency over fetched_at for the date', () => {
    const cites = buildCitations([
      row({
        signal: sig({ source_url: 'https://a.org/1', recency: '2025-12-31' }),
        fetched_at: '2026-06-01T00:00:00Z',
      }),
    ]);
    expect(cites[0].date).toBe('2025-12-31');
  });

  it('uses an explicit source_title when present', () => {
    const cites = buildCitations([
      row({ signal: sig({ source_url: 'https://a.org/1' }), source_title: 'Candidate Site' }),
    ]);
    expect(cites[0].title).toBe('Candidate Site');
  });
});

// ---------------------------------------------------------------------------
// End-to-end pure planner
// ---------------------------------------------------------------------------

describe('planPositionsForPerson', () => {
  const slugToId = buildSlugToIdMap(SUB_DIMS);

  it('produces one inferred position per known sub_dimension with a graded score + citation', () => {
    const rows: EvidenceSignalRow[] = [
      row({
        signal: sig({
          sub_dimension_key: 'immigration',
          direction: 0.3,
          signal_confidence: 0.8,
          source_url: 'https://x.org/imm',
        }),
      }),
      row({
        signal: sig({
          sub_dimension_key: 'water_rights',
          direction: 0.7,
          signal_confidence: 0.6,
          source_url: 'https://x.org/water',
        }),
      }),
    ];
    const { planned, unknownSlugs, noScoreSlugs } = planPositionsForPerson(
      'person-1',
      'candidate-1',
      rows,
      slugToId,
    );
    expect(unknownSlugs).toHaveLength(0);
    expect(noScoreSlugs).toHaveLength(0);
    expect(planned).toHaveLength(2);

    const imm = planned.find((p) => p.sub_dimension_id === 'sd-immigration')!;
    expect(imm.candidate_id).toBe('candidate-1');
    expect(imm.person_id).toBe('person-1');
    expect(imm.view_type).toBe('inferred');
    expect(imm.source_tier).toBe('ml_inferred_from_corpus');
    expect(imm.score).toBeCloseTo(0.3, 6);
    expect(imm.confidence).toBe('high');
    expect(imm.source_citations).toHaveLength(1);
    expect(imm.source_citations[0].url).toBe('https://x.org/imm');
    expect(imm.nuance_notes.length).toBeGreaterThan(0);
  });

  it('warns/skips unknown (inactive or unmapped) slugs without fabricating a position', () => {
    const rows: EvidenceSignalRow[] = [
      row({ signal: sig({ sub_dimension_key: 'retired_axis', direction: 0.5 }) }),
      row({ signal: sig({ sub_dimension_key: 'made_up_slug', direction: 0.5 }) }),
    ];
    const { planned, unknownSlugs } = planPositionsForPerson('p', 'c', rows, slugToId);
    expect(planned).toHaveLength(0);
    expect(unknownSlugs.sort()).toEqual(['made_up_slug', 'retired_axis']);
  });

  it('skips a sub_dimension whose every signal abstains (no score)', () => {
    const rows: EvidenceSignalRow[] = [
      row({
        signal: sig({
          sub_dimension_key: 'school_choice',
          position_kind: 'abstains_governing',
          direction: null,
        }),
      }),
    ];
    const { planned, noScoreSlugs } = planPositionsForPerson('p', 'c', rows, slugToId);
    expect(planned).toHaveLength(0);
    expect(noScoreSlugs).toEqual(['school_choice']);
  });

  it('skips a graded sub_dimension whose only signal has no usable citation url', () => {
    const rows: EvidenceSignalRow[] = [
      row({
        signal: sig({ sub_dimension_key: 'immigration', direction: 0.4, source_url: '' }),
        source_url: null,
      }),
    ];
    const { planned, noScoreSlugs } = planPositionsForPerson('p', 'c', rows, slugToId);
    expect(planned).toHaveLength(0);
    expect(noScoreSlugs).toEqual(['immigration']);
  });

  it('ignores taxonomy-free stub signals (no sub_dimension_key)', () => {
    const rows: EvidenceSignalRow[] = [
      row({ signal: sig({ sub_dimension_key: null, direction: null }) }),
    ];
    const { planned, unknownSlugs, noScoreSlugs } = planPositionsForPerson('p', 'c', rows, slugToId);
    expect(planned).toHaveLength(0);
    expect(unknownSlugs).toHaveLength(0);
    expect(noScoreSlugs).toHaveLength(0);
  });

  // Person-native write path (June 2026): a person with NO legacy candidate_id
  // is planned with candidate_id=null and person_id set, instead of being
  // skipped. positions.candidate_id is nullable (migration 20260615010000) and
  // the read path keys these rows by person_id.
  it('plans a person-only position with candidate_id=null and person_id set', () => {
    const rows: EvidenceSignalRow[] = [
      row({
        signal: sig({
          sub_dimension_key: 'immigration',
          direction: 0.7,
          signal_confidence: 0.8,
          source_url: 'https://example.com/p',
        }),
      }),
    ];
    // candidateId = null simulates a new-graph person with no legacy pin.
    const { planned } = planPositionsForPerson('person-only-1', null, rows, slugToId);
    expect(planned).toHaveLength(1);
    expect(planned[0].candidate_id).toBeNull();
    expect(planned[0].person_id).toBe('person-only-1');
    expect(planned[0].sub_dimension_id).toBe('sd-immigration');
    expect(planned[0].view_type).toBe('inferred');
    expect(planned[0].source_tier).toBe('ml_inferred_from_corpus');
    // Still URL-citation-bearing (never-impute rule preserved).
    expect(planned[0].source_citations.length).toBeGreaterThan(0);
  });

  it('still pins candidate_id when a legacy candidate id is supplied (legacy path unchanged)', () => {
    const rows: EvidenceSignalRow[] = [
      row({
        signal: sig({
          sub_dimension_key: 'immigration',
          direction: 0.3,
          signal_confidence: 0.7,
          source_url: 'https://example.com/legacy',
        }),
      }),
    ];
    const { planned } = planPositionsForPerson('person-1', 'candidate-9', rows, slugToId);
    expect(planned).toHaveLength(1);
    expect(planned[0].candidate_id).toBe('candidate-9');
    expect(planned[0].person_id).toBe('person-1');
  });

  // ── EXTREME-VALUE WRITE GUARD (2026-07-01 audit fix #2b) ──────────────────
  // A single extreme signal must NOT promote to a high-confidence position; the
  // guard clamps it to low. Two DISTINCT corroborating extreme quotes keep it.
  it('clamps a single-quote EXTREME score to low confidence', () => {
    const rows: EvidenceSignalRow[] = [
      row({
        signal: sig({
          sub_dimension_key: 'immigration',
          direction: 0.95,
          signal_confidence: 0.9, // would be 'high' without the guard
          quote: 'ban all of it',
          source_url: 'https://x.org/one',
        }),
      }),
    ];
    const { planned } = planPositionsForPerson('p', 'c', rows, slugToId);
    expect(planned).toHaveLength(1);
    expect(planned[0].score).toBeCloseTo(0.95, 6);
    // Score is preserved (we only lower confidence, never the number).
    expect(planned[0].confidence).toBe('low');
  });

  it('KEEPS a high-confidence EXTREME score when >=2 distinct quotes corroborate it', () => {
    const rows: EvidenceSignalRow[] = [
      row({
        signal: sig({
          sub_dimension_key: 'immigration',
          direction: 0.95,
          signal_confidence: 0.9,
          quote: 'abolish the agency entirely',
          source_url: 'https://x.org/one',
        }),
      }),
      row({
        signal: sig({
          sub_dimension_key: 'immigration',
          direction: 0.95,
          signal_confidence: 0.9,
          quote: 'end it on day one',
          source_url: 'https://y.org/two',
        }),
      }),
    ];
    const { planned } = planPositionsForPerson('p', 'c', rows, slugToId);
    expect(planned).toHaveLength(1);
    expect(planned[0].confidence).toBe('high');
  });

  it('does NOT clamp a non-extreme high-confidence score even with a single quote', () => {
    const rows: EvidenceSignalRow[] = [
      row({
        signal: sig({
          sub_dimension_key: 'immigration',
          direction: 0.7, // mid-axis, not extreme
          signal_confidence: 0.9,
          quote: 'I support expanding legal pathways',
          source_url: 'https://x.org/one',
        }),
      }),
    ];
    const { planned } = planPositionsForPerson('p', 'c', rows, slugToId);
    expect(planned).toHaveLength(1);
    expect(planned[0].confidence).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Match read-path identity merge (match/route.ts logic, extracted as a pure
// helper here so it can be unit-tested without the live DB). The route merges
// candidate_id-keyed and person_id-keyed positions into ONE list per voter
// row, deduping by the positions row id so a legacy row backfilled with BOTH
// ids is not double-counted.
// ---------------------------------------------------------------------------

/** Pure mirror of the merge/dedupe in match/route.ts (kept in lockstep). */
function mergePositionsForCandidate(
  candPositions: Array<{ id: string }>,
  personPositions: Array<{ id: string }>,
): Array<{ id: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string }> = [];
  for (const p of [...candPositions, ...personPositions]) {
    if (p.id && seen.has(p.id)) continue;
    if (p.id) seen.add(p.id);
    out.push(p);
  }
  return out;
}

describe('match read-path identity merge', () => {
  it('populates positions from the person_id path when there is no legacy candidate_id', () => {
    const merged = mergePositionsForCandidate([], [{ id: 'pos-a' }, { id: 'pos-b' }]);
    expect(merged.map((p) => p.id).sort()).toEqual(['pos-a', 'pos-b']);
  });

  it('populates positions from the candidate_id path for legacy rows', () => {
    const merged = mergePositionsForCandidate([{ id: 'pos-x' }], []);
    expect(merged.map((p) => p.id)).toEqual(['pos-x']);
  });

  it('dedupes a row reachable from BOTH ids (backfilled legacy row) by row id', () => {
    // pos-1 carries both candidate_id and person_id, so it shows up in both
    // maps. It must appear exactly once after the merge.
    const merged = mergePositionsForCandidate(
      [{ id: 'pos-1' }, { id: 'pos-2' }],
      [{ id: 'pos-1' }, { id: 'pos-3' }],
    );
    expect(merged.map((p) => p.id).sort()).toEqual(['pos-1', 'pos-2', 'pos-3']);
  });
});
