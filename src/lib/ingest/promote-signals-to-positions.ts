/**
 * promote-signals-to-positions.ts -- the MISSING LINK in the local
 * position-extraction pipeline.
 *
 * Upstream, extract-signals.ts + RealPositionClassifier (Ollama, local) read one
 * raw_evidence unit at a time and write zero-or-more per-signal records into
 * evidence_signals.signal (sub_dimension_key, direction, intensity_band,
 * position_kind, signal_confidence, quote, source_url, ...). Those rows are
 * EVIDENCE, not voter-facing positions: the matcher (algorithm.ts /
 * selectPositionsForView) never reads evidence_signals. It reads the positions
 * table, keyed on candidate_id, one score per (candidate, sub_dimension), with a
 * non-empty source citation.
 *
 * THIS module is the promotion stage. For a set of persons it:
 *   1. loads their evidence_signals,
 *   2. groups by signal->>'sub_dimension_key',
 *   3. maps each slug to sub_dimensions.id (active rows only; unknown slugs are
 *      warned and skipped, never fabricated),
 *   4. aggregates the contributing signals into ONE 0..1 score per (person,
 *      sub_dimension) by a confidence-weighted mean of the signed directions,
 *   5. derives a confidence enum from the aggregate,
 *   6. builds source_citations from the contributing rows' source_url
 *      ({url,title,date}; never an empty-url citation, because
 *      selectPositionsForView drops rows whose every citation has an empty url),
 *   7. resolves candidate_id from person_id via people.legacy_candidate_ids (the
 *      same legacy pin the matcher reads positions by),
 *   8. writes view_type='inferred' positions, append-only with a
 *      delete-then-insert idempotency guard scoped to THIS promoter's own rows.
 *
 * PURITY + TESTABILITY
 * ----------------------------------------------------------------------------
 * The arithmetic (slug->id mapping, aggregation/scoring, citation building) is a
 * set of PURE exported functions (buildSlugToIdMap, aggregateSignals,
 * buildCitations, deriveConfidenceEnum). The offline unit test
 * (src/lib/ingest/__tests__/promote-signals-to-positions.test.ts) exercises them
 * with fixtures, no DB and no Ollama. The DB orchestration (promoteSignals) takes
 * an injected pg Client and gates every write behind opts.apply, so --dry-run is
 * honest and the live run goes through the host bridge.
 *
 * Single TypeScript runtime, no Python. One pg Client. No metered API: this stage
 * does NO model calls at all, it only aggregates already-extracted signals.
 * No em-dashes / en-dashes; acronyms spelled out on first use.
 */

import type { Client } from 'pg';
import { applyWriteGuards, type PositionConfidence } from './position-write-guards';

// ===========================================================================
// The signal JSONB shape we consume (a subset of RawSignal, doc 07 section 1.6)
// ===========================================================================

/**
 * The fields of evidence_signals.signal (JSONB) this stage reads. Mirrors the
 * RawSignal shape the RealPositionClassifier writes (see extract-signals.ts).
 * Everything is optional / nullable because a taxonomy-free stub signal leaves
 * the taxonomy fields null; those rows simply do not contribute a score.
 */
export interface StoredSignal {
  sub_dimension_key?: string | null;
  /** 0..1 on the spectrum_low -> spectrum_high axis, OR null (abstains/no placement). */
  direction?: number | null;
  intensity_band?: string | null;
  /** Coarse data-quality enum. */
  confidence?: 'high' | 'medium' | 'low' | string | null;
  /** Numeric 0..1 data-quality confidence. Preferred over the enum when present. */
  signal_confidence?: number | null;
  position_kind?: 'graded' | 'balanced' | 'abstains_governing' | null;
  quote?: string | null;
  source_url?: string | null;
  recency?: string | null;
}

/** One evidence_signals row as loaded for a person (signal already parsed). */
export interface EvidenceSignalRow {
  id: string;
  person_id: string | null;
  source_url: string | null;
  /** raw_evidence.fetched_at carried through for citation dates. */
  fetched_at: string | null;
  /** raw_evidence.final_url / source title, best-effort, for the citation title. */
  source_title: string | null;
  signal: StoredSignal;
}

/** The minimal active sub_dimension shape we need: slug -> id. */
export interface ActiveSubDimensionLite {
  id: string;
  name: string; // the slug used as the axis key
  active?: boolean | null;
}

// ===========================================================================
// PURE: slug -> id mapping
// ===========================================================================

/**
 * buildSlugToIdMap(subDims): name (slug) -> id, for ACTIVE rows only. The
 * RealPositionClassifier binds RawSignal.sub_dimension_key to sub_dimensions.name
 * (the slug), so the promotion maps that slug back to the id the positions table
 * stores. Inactive rows are excluded so a retired sub_dimension never receives a
 * promoted position. When two active rows share a slug (should not happen), the
 * FIRST wins and a warning is emitted by the caller; here we keep first-write.
 */
export function buildSlugToIdMap(subDims: ActiveSubDimensionLite[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const sd of subDims) {
    if (sd.active === false) continue;
    if (!sd.name) continue;
    if (!out.has(sd.name)) out.set(sd.name, sd.id);
  }
  return out;
}

// ===========================================================================
// PURE: confidence enum from a numeric 0..1
// ===========================================================================

/**
 * Map a numeric 0..1 confidence onto the positions.confidence enum the existing
 * writers use ('high' | 'medium' | 'low'). Same cutoffs the classifier uses for
 * RawSignal.confidence (confidenceEnum in position-classifier.ts) so a promoted
 * row's confidence label is consistent with the signal layer.
 */
export function deriveConfidenceEnum(n: number): 'high' | 'medium' | 'low' {
  if (n >= 0.75) return 'high';
  if (n >= 0.5) return 'medium';
  return 'low';
}

/** Numeric 0..1 confidence for one signal: prefer signal_confidence, else the enum. */
export function signalNumericConfidence(s: StoredSignal): number {
  if (typeof s.signal_confidence === 'number' && !Number.isNaN(s.signal_confidence)) {
    return clamp01(s.signal_confidence);
  }
  switch (s.confidence) {
    case 'high':
      return 0.85;
    case 'medium':
      return 0.6;
    case 'low':
      return 0.4;
    default:
      return 0.5;
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ===========================================================================
// PURE: aggregation / scoring
// ===========================================================================

/**
 * The aggregated reading for one (person, sub_dimension): a single 0..1 score, a
 * confidence enum, the count of contributing signals, and the effective numeric
 * confidence used (for the nuance note + audit).
 */
export interface AggregatedPosition {
  /** 0..1 on the axis. null when no signal placed the person (all abstains/blank). */
  score: number | null;
  confidence: 'high' | 'medium' | 'low';
  /** Numeric 0..1 confidence the enum was derived from. */
  numericConfidence: number;
  /** How many signals actually contributed a graded direction to the mean. */
  contributingCount: number;
  /** How many signals were considered (incl. abstains that contributed no direction). */
  consideredCount: number;
  /** A short machine-stable rationale tag for the nuance note. */
  rationale: string;
}

/**
 * AGGREGATION RULE (documented; this is the one place the score is decided).
 *
 * Given all evidence signals that addressed one sub_dimension for one person:
 *
 *   score = sum_i( w_i * direction_i ) / sum_i( w_i )
 *
 * where the sum is over signals that carry a GRADED placement (a numeric
 * direction in 0..1: position_kind 'graded' or 'balanced'; balanced contributes
 * direction = 0.5 per doc 07 C1), and the per-signal weight w_i is that signal's
 * numeric data-quality confidence (signalNumericConfidence: signal_confidence
 * when present, else the enum mapped 0.85/0.6/0.4). This is a CONFIDENCE-WEIGHTED
 * MEAN of the signed positions on the spectrum_low -> spectrum_high axis, so a
 * high-confidence primary-source reading moves the score more than a low-
 * confidence aggregate, and several corroborating readings converge.
 *
 * WHY this rule:
 *   - It is the L1-compatible aggregate the matcher expects: the matcher does
 *     weighted-L1 over a single 0..1 score per (candidate, sub_dimension), so the
 *     promotion must collapse N signals to exactly one 0..1 number on the SAME
 *     axis the classifier placed them on. A confidence-weighted mean is the
 *     minimum-variance linear estimator when each reading's confidence stands in
 *     for inverse-variance, which is exactly the founder's "trust the better
 *     source more" intent without inventing a heavier model.
 *   - It never fabricates: 'abstains_governing' signals carry direction = null
 *     (the hard rule) and are EXCLUDED from the mean; they only raise
 *     consideredCount. A (person, sub_dimension) whose every signal abstains
 *     yields score = null and is NOT written (silence is not a position).
 *   - The aggregate confidence is the MAX per-signal numeric confidence among the
 *     contributing signals, NOT the mean: corroboration should not dilute a
 *     strong primary reading down toward a weak one. (Cross-source corroboration
 *     count is a separate gate handled upstream by gateSignal; here we keep the
 *     best evidence's confidence and record the count in the rationale.) The
 *     enum is then deriveConfidenceEnum(maxConfidence).
 *
 * Returns score = null (and the caller SKIPS the write) when no signal placed the
 * person on this axis.
 */
export function aggregateSignals(signals: StoredSignal[]): AggregatedPosition {
  let weightedSum = 0;
  let weightTotal = 0;
  let contributing = 0;
  let maxConf = 0;
  const considered = signals.length;

  for (const s of signals) {
    // A graded placement is a numeric direction in 0..1. 'abstains_governing'
    // carries direction null and contributes NOTHING to the mean (no fabrication).
    const dir = s.direction;
    if (typeof dir !== 'number' || Number.isNaN(dir)) continue;
    if (s.position_kind === 'abstains_governing') continue;
    const w = signalNumericConfidence(s);
    if (w <= 0) continue;
    weightedSum += w * clamp01(dir);
    weightTotal += w;
    contributing += 1;
    if (w > maxConf) maxConf = w;
  }

  if (contributing === 0 || weightTotal <= 0) {
    return {
      score: null,
      confidence: 'low',
      numericConfidence: 0,
      contributingCount: 0,
      consideredCount: considered,
      rationale: 'no_graded_signal',
    };
  }

  const score = clamp01(weightedSum / weightTotal);
  // Aggregate confidence = best contributing evidence's confidence (see WHY above).
  const numericConfidence = clamp01(maxConf);
  const confidence = deriveConfidenceEnum(numericConfidence);
  const rationale =
    contributing === 1
      ? 'single_graded_signal'
      : `confidence_weighted_mean_of_${contributing}_signals`;

  return {
    score,
    confidence,
    numericConfidence,
    contributingCount: contributing,
    consideredCount: considered,
    rationale,
  };
}

// ===========================================================================
// PURE: citation building
// ===========================================================================

export interface SourceCitation {
  url: string;
  title: string;
  date: string;
}

/**
 * buildCitations(rows): one {url,title,date} per DISTINCT contributing source
 * url. Mirrors the existing writers' citation shape (classify-candidate.ts /
 * batch-classify.ts). Rows with an empty / missing url are DROPPED, never emitted
 * as an empty-url citation, because selectPositionsForView (council #51) discards
 * any position whose every citation has an empty url. Deduped by url so a person
 * with five readings off one page yields one citation, not five.
 *
 * date precedence: the signal's recency (the source's as-of date) when present,
 * else the row's fetched_at, else '' (an empty date is allowed; only an empty URL
 * is fatal). title precedence: the row's source_title when present, else the
 * registrable host of the url, else 'source'.
 */
export function buildCitations(rows: EvidenceSignalRow[]): SourceCitation[] {
  const byUrl = new Map<string, SourceCitation>();
  for (const r of rows) {
    const url = (r.signal.source_url ?? r.source_url ?? '').trim();
    if (!url) continue; // never emit an empty-url citation
    if (byUrl.has(url)) continue;
    const date = (r.signal.recency ?? r.fetched_at ?? '') || '';
    const title = (r.source_title ?? '').trim() || hostOf(url) || 'source';
    byUrl.set(url, { url, title, date });
  }
  return [...byUrl.values()];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ===========================================================================
// PURE: build the full set of position upserts for ONE person
// ===========================================================================

/** The exact row shape we will upsert into positions (matches existing writers). */
export interface PlannedPosition {
  /**
   * Legacy pin. NULL for person-native candidacies (no legacy candidate_id);
   * positions.candidate_id is nullable as of migration 20260615010000. When
   * non-null, the legacy candidate_id-keyed read path still finds the row.
   */
  candidate_id: string | null;
  person_id: string;
  sub_dimension_id: string;
  view_type: 'inferred';
  score: number;
  confidence: 'high' | 'medium' | 'low';
  source_citations: SourceCitation[];
  nuance_notes: string;
  source_tier: 'ml_inferred_from_corpus';
  /** The slug, carried for logging only (NOT a positions column). */
  _slug: string;
}

export interface PlanOneResult {
  planned: PlannedPosition[];
  /** sub_dimension slugs seen in signals that are not active / unknown. */
  unknownSlugs: string[];
  /** (slug) pairs that produced no graded score (all abstains/blank) and were skipped. */
  noScoreSlugs: string[];
}

/**
 * planPositionsForPerson(personId, candidateId, rows, slugToId): the pure planner
 * for one person. Groups the person's evidence_signals by sub_dimension slug, maps
 * the slug to an active sub_dimension id, aggregates each group to one score, and
 * builds the (candidate, sub_dimension) position rows. NO DB access: the caller
 * supplies the rows, the candidate_id, and the slug->id map. This is what the
 * unit test drives end-to-end.
 */
export function planPositionsForPerson(
  personId: string,
  candidateId: string | null,
  rows: EvidenceSignalRow[],
  slugToId: Map<string, string>,
): PlanOneResult {
  // Group rows by the slug their signal addresses. A row whose signal has no
  // sub_dimension_key (taxonomy-free stub) is ignored: it places nothing.
  const bySlug = new Map<string, EvidenceSignalRow[]>();
  for (const r of rows) {
    const slug = r.signal.sub_dimension_key;
    if (!slug) continue;
    const arr = bySlug.get(slug) ?? [];
    arr.push(r);
    bySlug.set(slug, arr);
  }

  const planned: PlannedPosition[] = [];
  const unknownSlugs: string[] = [];
  const noScoreSlugs: string[] = [];

  for (const [slug, slugRows] of bySlug) {
    const subDimId = slugToId.get(slug);
    if (!subDimId) {
      unknownSlugs.push(slug);
      continue; // never fabricate a mapping for an unknown/inactive slug
    }

    const agg = aggregateSignals(slugRows.map((r) => r.signal));
    if (agg.score === null) {
      noScoreSlugs.push(slug);
      continue; // no graded placement: silence is not a position
    }

    const citations = buildCitations(slugRows);
    if (citations.length === 0) {
      // Never-impute: a position with no URL-bearing citation is dropped, since
      // the view filter discards it anyway. Record it as a no-score skip.
      noScoreSlugs.push(slug);
      continue;
    }

    const nuance = buildNuanceNote(agg, citations.length);

    // WRITE GUARDS (2026-07-01 audit): before emitting a scored row, run the
    // absence-language guard (never publish a scored medium/high row whose notes
    // state absence) and the extreme-value corroboration guard (a score at an
    // extreme of the axis needs >= 2 DISTINCT corroborating quotes to keep
    // medium/high; otherwise clamp to low). The absence guard almost never fires
    // on this path (buildNuanceNote writes honest "Inferred from N statements"
    // boilerplate, not absence prose), but the extreme-value guard is load-bearing
    // here: promote-signals never called gateSignal's corroboration stage, so a
    // single 0.9+ quote could publish high. The distinct-quote count comes from
    // the contributing signals' verbatim quotes.
    const contributingQuotes = slugRows.map((r) => r.signal.quote ?? null);
    // agg.confidence is only ever 'high' | 'medium' | 'low', and the guards only
    // ever LOWER a medium/high to 'low' (never to 'no_data'), so the guarded
    // result is always one of the three positions-writer confidences.
    const guardedConfidence = applyWriteGuards({
      score: agg.score,
      confidence: agg.confidence as PositionConfidence,
      notes: nuance,
      quotes: contributingQuotes,
    }) as 'high' | 'medium' | 'low';

    planned.push({
      candidate_id: candidateId,
      person_id: personId,
      sub_dimension_id: subDimId,
      view_type: 'inferred',
      score: agg.score,
      confidence: guardedConfidence,
      source_citations: citations,
      nuance_notes: nuance,
      source_tier: 'ml_inferred_from_corpus',
      _slug: slug,
    });
  }

  return { planned, unknownSlugs, noScoreSlugs };
}

/** A short, voter-readable note + machine-stable rationale, used as nuance_notes/ai_summary seed. */
export function buildNuanceNote(agg: AggregatedPosition, citationCount: number): string {
  const sources = citationCount === 1 ? '1 source' : `${citationCount} sources`;
  const signals =
    agg.contributingCount === 1 ? '1 statement' : `${agg.contributingCount} statements`;
  return (
    `Inferred from ${signals} across ${sources} ` +
    `(${agg.rationale}; confidence ${agg.confidence}). ` +
    `Aggregated locally from gathered evidence; not a direct candidate response.`
  );
}

// ===========================================================================
// DB ORCHESTRATION (impure; injected pg Client; gated behind opts.apply)
// ===========================================================================

export interface PromoteOptions {
  /** apply !== true => DRY-RUN: plan, write NOTHING. Default false (dry-run). */
  apply?: boolean;
  /**
   * Max persons to promote this pass. The CLI bounds this; default unbounded here
   * (the runner passes a concrete person list, so the bound is on the selection).
   */
  limitPersons?: number;
  /** Verbose per-person logging. Default true. */
  verbose?: boolean;
}

export interface PromoteSummary {
  mode: 'apply' | 'dry-run';
  personsConsidered: number;
  personsWithCandidate: number;
  personsWithoutCandidate: number;
  positionsPlanned: number;
  positionsWritten: number;
  unknownSlugs: Set<string>;
  noScoreSkips: number;
  errors: number;
}

/**
 * Load the active sub_dimensions (slug -> id). Active-only by design (a retired
 * sub_dimension must not receive a promoted position).
 */
export async function loadActiveSubDimensionsLite(
  client: Client,
): Promise<ActiveSubDimensionLite[]> {
  const { rows } = await client.query(
    `select id, name, active from sub_dimensions where active = true order by name`,
  );
  return rows as ActiveSubDimensionLite[];
}

/**
 * Resolve person_id -> candidate_id (the legacy pin the matcher reads positions
 * by) via people.legacy_candidate_ids[]. A person can carry several legacy
 * candidate ids; we take the FIRST (the canonical legacy candidate). Persons with
 * no legacy candidate id resolve to undefined and are skipped by the caller
 * (their positions could not be read by the candidate_id-keyed matcher anyway).
 *
 * This walks the SAME bridge backfill-legacy-to-newgraph.ts uses, just in the
 * person -> candidate direction.
 */
export async function resolvePersonToCandidate(
  client: Client,
  personIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (personIds.length === 0) return out;
  const { rows } = await client.query(
    `select id, legacy_candidate_ids from people where id = any($1::uuid[])`,
    [personIds],
  );
  for (const r of rows as { id: string; legacy_candidate_ids: string[] | null }[]) {
    const legacy = r.legacy_candidate_ids ?? [];
    if (legacy.length > 0 && legacy[0]) out.set(r.id, legacy[0]);
  }
  return out;
}

/**
 * Load a person's evidence_signals joined to their raw_evidence for the citation
 * date/title. Only rows whose signal carries a sub_dimension_key are returned (a
 * taxonomy-free stub signal places nothing). The signal JSONB is returned parsed.
 */
export async function loadPersonSignals(
  client: Client,
  personId: string,
): Promise<EvidenceSignalRow[]> {
  const { rows } = await client.query(
    `select
        es.id                                   as id,
        es.person_id                            as person_id,
        coalesce(es.source_url, re.source_url)  as source_url,
        re.fetched_at::text                     as fetched_at,
        coalesce(re.final_url, re.source_url)   as source_title,
        es.signal                               as signal
       from evidence_signals es
       left join raw_evidence re on re.id = es.raw_evidence_id
      where es.person_id = $1
        and (es.signal->>'sub_dimension_key') is not null`,
    [personId],
  );
  return (rows as Array<Omit<EvidenceSignalRow, 'signal'> & { signal: StoredSignal }>).map(
    (r) => ({
      id: r.id,
      person_id: r.person_id,
      source_url: r.source_url,
      fetched_at: r.fetched_at,
      source_title: r.source_title,
      // pg returns jsonb already parsed; defend against a string just in case.
      signal: typeof r.signal === 'string' ? (JSON.parse(r.signal) as StoredSignal) : r.signal,
    }),
  );
}

/**
 * Idempotent write for one person's planned positions. Append-only model with a
 * delete-then-insert guard scoped to THIS promoter's own rows only:
 *   - we DELETE prior positions for the same (identity, sub_dimension_id) that
 *     are view_type='inferred' AND source_tier='ml_inferred_from_corpus' (the tag
 *     this promoter stamps), so a re-run does not accumulate duplicate promoted
 *     rows for the same axis. The identity is the legacy candidate_id for rows
 *     that have one, and the person_id for person-native rows (candidate_id
 *     NULL) -- scoping a person-only delete by candidate_id is impossible (it is
 *     NULL), so we scope by person_id instead;
 *   - we NEVER touch a 'stated' row, nor an 'inferred' row from another producer
 *     (different source_tier), so curated / candidate-direct positions are safe.
 * Then we INSERT the fresh row. The whole person is one transaction.
 */
async function writePersonPositions(
  client: Client,
  planned: PlannedPosition[],
): Promise<number> {
  if (planned.length === 0) return 0;
  let written = 0;
  await client.query('begin');
  try {
    for (const p of planned) {
      if (p.candidate_id) {
        // Legacy row: scope the idempotent delete by candidate_id (unchanged).
        await client.query(
          `delete from positions
            where candidate_id = $1
              and sub_dimension_id = $2
              and view_type = 'inferred'
              and source_tier = 'ml_inferred_from_corpus'`,
          [p.candidate_id, p.sub_dimension_id],
        );
      } else {
        // Person-native row: candidate_id is NULL, so scope by person_id.
        await client.query(
          `delete from positions
            where person_id = $1
              and candidate_id is null
              and sub_dimension_id = $2
              and view_type = 'inferred'
              and source_tier = 'ml_inferred_from_corpus'`,
          [p.person_id, p.sub_dimension_id],
        );
      }
      await client.query(
        `insert into positions
           (candidate_id, person_id, sub_dimension_id, view_type, score,
            confidence, source_citations, nuance_notes, ai_summary, source_tier)
         values ($1, $2, $3, 'inferred', $4, $5, $6::jsonb, $7, $8, 'ml_inferred_from_corpus')`,
        [
          p.candidate_id,
          p.person_id,
          p.sub_dimension_id,
          p.score,
          p.confidence,
          JSON.stringify(p.source_citations),
          p.nuance_notes,
          p.nuance_notes, // seed ai_summary from the same note (no extra model call)
        ],
      );
      written += 1;
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  }
  return written;
}

/**
 * promoteSignals(client, personIds, opts): the orchestrator. For each person,
 * resolve the candidate_id, load + aggregate their signals into planned position
 * rows, and (apply only) write them idempotently. DRY-RUN logs the plan and
 * writes nothing. Resilient: one person's failure is counted and does not abort
 * the pass.
 */
export async function promoteSignals(
  client: Client,
  personIds: string[],
  opts: PromoteOptions = {},
): Promise<PromoteSummary> {
  const apply = opts.apply === true;
  const verbose = opts.verbose ?? true;
  const persons = opts.limitPersons ? personIds.slice(0, opts.limitPersons) : personIds;

  const summary: PromoteSummary = {
    mode: apply ? 'apply' : 'dry-run',
    personsConsidered: persons.length,
    personsWithCandidate: 0,
    personsWithoutCandidate: 0,
    positionsPlanned: 0,
    positionsWritten: 0,
    unknownSlugs: new Set<string>(),
    noScoreSkips: 0,
    errors: 0,
  };

  const subDims = await loadActiveSubDimensionsLite(client);
  const slugToId = buildSlugToIdMap(subDims);
  const personToCandidate = await resolvePersonToCandidate(client, persons);

  for (const personId of persons) {
    try {
      // Person-native write path (June 2026): a person with NO legacy
      // candidate_id is NO LONGER skipped. The read path (match/route.ts and
      // candidate/[id]/page.tsx) now reads positions by person_id, and
      // positions.candidate_id is nullable (migration 20260615010000). So we
      // write the position with person_id set and candidate_id left null for
      // person-only candidacies. Legacy persons (those bridged to a candidate)
      // still get candidate_id set, preserving the legacy read path.
      const candidateId = personToCandidate.get(personId) ?? null;
      if (candidateId) {
        summary.personsWithCandidate += 1;
      } else {
        summary.personsWithoutCandidate += 1;
        if (verbose) {
          console.log(
            `[person-only] person=${personId.slice(0, 8)} has no legacy_candidate_id; ` +
              `writing positions keyed by person_id (candidate_id NULL).`,
          );
        }
      }

      const rows = await loadPersonSignals(client, personId);
      const { planned, unknownSlugs, noScoreSlugs } = planPositionsForPerson(
        personId,
        candidateId,
        rows,
        slugToId,
      );
      for (const u of unknownSlugs) summary.unknownSlugs.add(u);
      summary.noScoreSkips += noScoreSlugs.length;
      summary.positionsPlanned += planned.length;

      if (verbose) {
        console.log(
          `${apply ? '[APPLY]' : '[DRY-RUN]'} person=${personId.slice(0, 8)} ` +
            `cand=${candidateId ? candidateId.slice(0, 8) : 'NULL'} signals=${rows.length} ` +
            `=> ${planned.length} position(s)` +
            (unknownSlugs.length ? ` unknown_slugs=${unknownSlugs.join(',')}` : '') +
            (noScoreSlugs.length ? ` no_score=${noScoreSlugs.join(',')}` : ''),
        );
        for (const p of planned) {
          console.log(
            `        ${p._slug} score=${p.score.toFixed(3)} conf=${p.confidence} ` +
              `cites=${p.source_citations.length}`,
          );
        }
      }

      if (apply && planned.length > 0) {
        const w = await writePersonPositions(client, planned);
        summary.positionsWritten += w;
      }
    } catch (e) {
      summary.errors += 1;
      console.error(
        `[ERROR] person=${personId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return summary;
}
