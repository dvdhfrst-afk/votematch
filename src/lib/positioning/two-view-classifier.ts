/**
 * Two-view position classifier.
 *
 * Orchestrates stated-view and inferred-view classification for a given
 * (candidate, sub_dimension) pair. Reads sources from candidate_sources,
 * filters/weights by authenticity_tier, delegates the actual per-view
 * classification to either phi4:14b (local dev) or Claude Opus 4.7 (production)
 * via a pluggable backend.
 *
 * Stated view rules (per 12-positioning-engine/00-requirements.md):
 *   - Uses authenticity_tier=1 sources only (candidate's own words)
 *   - Returns { score: null, confidence: 'no_data' } if the candidate has no
 *     tier-1 content on this sub-dim — correct behavior; "no stated position"
 *     is itself information
 *
 * Inferred view rules:
 *   - Uses all sources across all tiers
 *   - Weight hierarchy in the prompt: primary (1.0) > reported-with-quote
 *     (0.75) > paraphrased (0.5) > voting_record (0.9 — high weight because
 *     actions > words, but classed as "not-stated" since a vote is an action)
 *   - Always returns a score if any sources exist
 *
 * Both views share the existing `classifyPosition` helper from either backend
 * — the orchestration is about WHICH sources get shown to the model, not HOW
 * the model processes them.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CandidateSource,
  PositionViewType,
  SubDimension,
} from '@/types/database';
import { classifyPosition as classifyOllama } from '@/lib/ollama';
import { classifyPosition as classifyClaude } from '@/lib/claude';
import { retrieveExemplars } from '@/lib/rag-retrieval';

/**
 * Classifier backend selector (council decision 007 §3 pre-flight resolution).
 *
 *  - 'ollama'  → local phi4:14b (dev; free; overnight-bakeoff baseline)
 *  - 'claude'  → Claude Opus 4.7 via @/lib/claude (production; Batch API path)
 *
 * Controlled by the CLASSIFIER_BACKEND env var. Default is 'ollama' so local
 * development + CI stay free. Production batches go through Claude Batch API
 * in batch-classify.ts directly; this selector is for the single-shot path
 * used by backfill scripts and tests.
 */
type ClassifierBackend = 'ollama' | 'claude' | 'phi3-then-phi4';

function backendFor(explicit?: ClassifierBackend): ClassifierBackend {
  if (explicit) return explicit;
  const env = process.env.CLASSIFIER_BACKEND?.toLowerCase();
  if (env === 'claude') return 'claude';
  if (env === 'ollama') return 'ollama';
  // Phase-E (2026-05-08): phi3-then-phi4 is now the default. phi3:3.8b
  // first-pass + phi4:14b escalation on low-confidence outputs is ~2x faster
  // than phi4-only with comparable quality on the 70-80% of classifications
  // that come back high/medium from phi3. Override via CLASSIFIER_BACKEND=ollama
  // to revert to phi4-only.
  return 'phi3-then-phi4';
}

async function invokeClassifier(
  backend: ClassifierBackend,
  text: string,
  subDim: SubDimension,
  opts: { exemplars?: unknown; model?: string; skipEscalation?: boolean },
): Promise<{ score: number | null; confidence: 'high' | 'medium' | 'low' | 'no_data'; nuance: string }> {
  if (backend === 'claude') {
    // Claude's classifyPosition uses the single-view user prompt. Two-view
    // batch fan-out is in batch-classify.ts which picks the stated/inferred
    // user-prompt builders directly via `view_type` on the batch request.
    const r = await classifyClaude(text, subDim);
    return r;
  }
  if (backend === 'phi3-then-phi4') {
    // Phase-E: cheap first pass with phi3:3.8b, escalate to phi4:14b only
    // when the small model isn't confident. Both models stay loaded in VRAM
    // (Ollama's keep_alive='5m'). On a 16GB card: phi3 ~2.2GB + phi4 ~9GB ≈
    // 11GB combined. Saves ~50-70% of total inference time on average.
    const r1 = await classifyOllama(text, subDim, {
      exemplars: opts.exemplars as never,
      model: opts.model ?? 'phi3:3.8b',
      think: false,
    });
    if (r1.confidence === 'high' || r1.confidence === 'medium') return r1;
    // Council #41+1 (2026-05-09, time perspective followup to throughput
    // wakeup): when caller signals the source corpus contains no issue
    // content (e.g. only synthetic-filing sources), skip phi4 escalation —
    // phi4 can't extract issue positions from a filing record any better
    // than phi3 already did. Per-candidate wall drops ~9× for filing-only
    // candidates, which is most of the 8k pending queue.
    if (opts.skipEscalation) return r1;
    // Low confidence (or no_data) — phi4 may see something phi3 missed.
    return classifyOllama(text, subDim, {
      exemplars: opts.exemplars as never,
      model: 'phi4:14b',
      think: false,
    });
  }
  return classifyOllama(text, subDim, {
    exemplars: opts.exemplars as never,
    model: opts.model,
    think: false,
  });
}

export interface ViewClassificationResult {
  view_type: PositionViewType;
  score: number | null;
  confidence: 'high' | 'medium' | 'low' | 'no_data';
  nuance: string;
  source_count: number;
  tier_breakdown: { tier1: number; tier2: number; tier3: number };
  /** Source citations to attach to the position row (required for DB insert). */
  citations: { url: string; title: string; date: string }[];
}

function citationsFromSources(
  sources: CandidateSource[],
  maxCount: number = 10,
): { url: string; title: string; date: string }[] {
  return sources.slice(0, maxCount).map((s) => ({
    url: s.url ?? '',
    title: s.title ?? `${s.source_type} source`,
    date: s.published_at
      ? s.published_at.slice(0, 10)
      : s.fetched_at.slice(0, 10),
  }));
}

export interface TwoViewClassificationOptions {
  /** If true, use RAG exemplars on both views. Default true. */
  useRAG?: boolean;
  /**
   * If true, skip the stated view even if tier-1 sources exist. Useful when
   * you just want to re-generate inferred scores. Default false.
   */
  skipStated?: boolean;
  /**
   * If true, skip the inferred view. Default false.
   */
  skipInferred?: boolean;
  /** Model to use; defaults to OLLAMA_CLASSIFY_MODEL env setting. */
  model?: string;
  /**
   * Which classifier backend to use for this single-shot call:
   *   - 'ollama'  = local phi4:14b (dev)
   *   - 'claude'  = Claude Opus 4.7 via @/lib/claude (production path)
   *   - 'phi3-then-phi4' = phi3:3.8b first, escalate to phi4 on low-conf (phase-E default)
   * Defaults to CLASSIFIER_BACKEND env var, or 'phi3-then-phi4' when unset.
   * Bulk production flow uses batch-classify.ts directly, not this helper.
   */
  backend?: 'ollama' | 'claude' | 'phi3-then-phi4';
}

function aggregateSourcesForStated(sources: CandidateSource[]): string {
  // Stated view: tier-1 only. These are the candidate's own words — website,
  // questionnaire, op-eds, speeches. Preserve chronological order since
  // stated positions evolve.
  const tier1 = sources
    .filter((s) => s.authenticity_tier === 1)
    .sort((a, b) => {
      const aDate = a.published_at ?? a.fetched_at;
      const bDate = b.published_at ?? b.fetched_at;
      return new Date(bDate).getTime() - new Date(aDate).getTime();
    });
  return tier1
    .map((s) => {
      const origin = s.published_at
        ? `[${s.source_type}, ${s.published_at.slice(0, 10)}]`
        : `[${s.source_type}]`;
      return `${origin} ${s.title ?? ''}\n${s.raw_data}\n—`;
    })
    .join('\n\n');
}

function aggregateSourcesForInferred(sources: CandidateSource[]): string {
  // Inferred view: all sources, labeled with tier so the model can weight.
  // Sort: tier 1 first (most authoritative direct statements), then tier 2
  // (reported with quotes), then tier 3 (paraphrased/secondary). Within a
  // tier, most recent first.
  const sorted = [...sources].sort((a, b) => {
    if (a.authenticity_tier !== b.authenticity_tier) {
      return a.authenticity_tier - b.authenticity_tier;
    }
    const aDate = a.published_at ?? a.fetched_at;
    const bDate = b.published_at ?? b.fetched_at;
    return new Date(bDate).getTime() - new Date(aDate).getTime();
  });
  return sorted
    .map((s) => {
      const tierLabel =
        s.authenticity_tier === 1
          ? 'PRIMARY (candidate\'s own words)'
          : s.authenticity_tier === 2
            ? 'REPORTED (direct quote in journalism)'
            : 'SECONDARY (paraphrase or third-party)';
      const ideology = s.outlet_ideology ? ` [${s.outlet_ideology}]` : '';
      return `[${s.source_type} — ${tierLabel}${ideology}] ${s.title ?? ''}\n${s.raw_data}\n—`;
    })
    .join('\n\n');
}

/**
 * Classify one (candidate, sub_dim) pair under both views.
 *
 * Returns two ViewClassificationResult rows (one per view) unless
 * opts.skipStated/skipInferred is set. The caller is responsible for
 * writing them to the positions table with view_type set correctly.
 */
export async function classifyBothViews(
  candidateId: string,
  subDim: SubDimension,
  sources: CandidateSource[],
  opts: TwoViewClassificationOptions = {},
): Promise<ViewClassificationResult[]> {
  const results: ViewClassificationResult[] = [];

  const tier1Count = sources.filter((s) => s.authenticity_tier === 1).length;
  const tier2Count = sources.filter((s) => s.authenticity_tier === 2).length;
  const tier3Count = sources.filter((s) => s.authenticity_tier === 3).length;
  const breakdown = { tier1: tier1Count, tier2: tier2Count, tier3: tier3Count };
  // Throughput optimization: when sources are filing-only (no issue content),
  // phi3's no_data is final — skip phi4 escalation (~9× speedup per dim).
  const filingOnly = sources.length > 0 && sources.every((s) => s.source_type === 'filing');

  // ---- STATED VIEW ----
  if (!opts.skipStated) {
    const tier1Sources = sources.filter((s) => s.authenticity_tier === 1);
    if (tier1Count === 0) {
      // Still need ≥1 citation for DB constraint — use any source as
      // "no primary source exists" pointer. If NO sources at all, fall
      // back to a single synthetic citation pointing at the candidate profile.
      const fallback = sources.length > 0
        ? citationsFromSources(sources.slice(0, 1))
        : [{ url: '', title: 'No primary sources available', date: new Date().toISOString().slice(0, 10) }];
      results.push({
        view_type: 'stated',
        score: null,
        confidence: 'no_data',
        nuance: 'No primary-source material found. The candidate has not stated a position on this issue in their official materials.',
        source_count: 0,
        tier_breakdown: breakdown,
        citations: fallback,
      });
    } else {
      const text = aggregateSourcesForStated(sources);
      const exemplars = opts.useRAG !== false ? retrieveExemplars(candidateId, subDim.name, 2) : undefined;
      try {
        const r = await invokeClassifier(backendFor(opts.backend), text, subDim, {
          exemplars,
          model: opts.model,
          skipEscalation: filingOnly,
        });
        results.push({
          view_type: 'stated',
          score: r.score,
          confidence: r.confidence,
          nuance: r.nuance,
          source_count: tier1Count,
          tier_breakdown: breakdown,
          citations: citationsFromSources(tier1Sources, 8),
        });
      } catch (err) {
        results.push({
          view_type: 'stated',
          score: null,
          confidence: 'no_data',
          nuance: `Classification failed: ${err instanceof Error ? err.message : String(err)}`,
          source_count: tier1Count,
          tier_breakdown: breakdown,
          citations: citationsFromSources(tier1Sources, 8),
        });
      }
    }
  }

  // ---- INFERRED VIEW ----
  if (!opts.skipInferred) {
    if (sources.length === 0) {
      results.push({
        view_type: 'inferred',
        score: null,
        confidence: 'no_data',
        nuance: 'No sources available for inference.',
        source_count: 0,
        tier_breakdown: breakdown,
        citations: [{ url: '', title: 'No sources available', date: new Date().toISOString().slice(0, 10) }],
      });
    } else {
      const text = aggregateSourcesForInferred(sources);
      const exemplars = opts.useRAG !== false ? retrieveExemplars(candidateId, subDim.name, 3) : undefined;
      try {
        const r = await invokeClassifier(backendFor(opts.backend), text, subDim, {
          exemplars,
          model: opts.model,
          skipEscalation: filingOnly,
        });
        results.push({
          view_type: 'inferred',
          score: r.score,
          confidence: r.confidence,
          nuance: r.nuance,
          source_count: sources.length,
          tier_breakdown: breakdown,
          citations: citationsFromSources(sources, 10),
        });
      } catch (err) {
        results.push({
          view_type: 'inferred',
          score: null,
          confidence: 'no_data',
          nuance: `Classification failed: ${err instanceof Error ? err.message : String(err)}`,
          source_count: sources.length,
          tier_breakdown: breakdown,
          citations: citationsFromSources(sources, 10),
        });
      }
    }
  }

  return results;
}

/**
 * Loads a candidate's sources + writes both-view positions to the DB for every
 * active sub-dimension. Used by the re-classification script and the batch
 * orchestrator.
 */
export async function classifyCandidateBothViews(
  s: SupabaseClient,
  candidateId: string,
  opts: TwoViewClassificationOptions & { subDims?: SubDimension[] } = {},
): Promise<{ classified: number; errors: number }> {
  // Fetch sources
  const { data: sourcesRaw, error: srcErr } = await s
    .from('candidate_sources')
    .select('*')
    .eq('candidate_id', candidateId);
  if (srcErr) throw new Error(`fetch sources: ${srcErr.message}`);
  const sources = (sourcesRaw ?? []) as CandidateSource[];

  // Fetch sub-dimensions (active only)
  let subDims = opts.subDims;
  if (!subDims) {
    const { data: sdRaw, error: sdErr } = await s
      .from('sub_dimensions')
      .select('id, name, domain, spectrum_low, spectrum_high, display_order')
      .order('display_order');
    if (sdErr) throw new Error(`fetch sub_dims: ${sdErr.message}`);
    subDims = (sdRaw ?? []) as SubDimension[];
  }

  // Council #34 (2026-05-09): respect office relevance dims to skip
  // classification work on dimensions an office has no authority over.
  // Saves ~63% GPU/candidate (avg ~7 of 19 dims are relevant). Override
  // with RESPECT_RELEVANT_DIMS=0 to disable.
  if (process.env.RESPECT_RELEVANT_DIMS !== '0') {
    try {
      const { data: peopleRows } = await s
        .from('people')
        .select('id')
        .contains('legacy_candidate_ids', [candidateId])
        .limit(1);
      if (peopleRows && peopleRows.length > 0) {
        const personId = (peopleRows[0] as { id: string }).id;
        const { data: cands } = await s
          .from('candidacies')
          .select('election:elections(office:offices(relevant_dimensions, office_type:office_types(relevant_dimensions)))')
          .eq('person_id', personId)
          .limit(1);
        const c = cands?.[0] as { election?: { office?: { relevant_dimensions?: string[] | null; office_type?: { relevant_dimensions?: string[] | null } } } };
        const officeRel = c?.election?.office?.relevant_dimensions;
        const typeRel = c?.election?.office?.office_type?.relevant_dimensions;
        const relevantDims = (officeRel && officeRel.length > 0) ? officeRel : typeRel;
        if (relevantDims && relevantDims.length > 0) {
          const allowed = new Set(relevantDims);
          const filtered = subDims.filter((sd) => allowed.has(sd.name));
          // Defensive: only apply filter if it produces a non-empty set,
          // so a missing/empty relevance row doesn't silently drop all dims.
          if (filtered.length > 0) subDims = filtered;
        }
      }
    } catch {
      // Best-effort — never fail classification on lookup error.
    }
  }

  let classified = 0;
  let errors = 0;
  const errorDetails: string[] = [];
  for (const sd of subDims) {
    try {
      const results = await classifyBothViews(candidateId, sd, sources, opts);
      for (const r of results) {
        const row = {
          candidate_id: candidateId,
          sub_dimension_id: sd.id,
          view_type: r.view_type,
          // no_data placeholder: neutral score, confidence='low', nuance
          // explains why. Having a row (rather than nothing) lets the UI
          // render "no stated position" deterministically.
          score: r.score === null ? 0.5 : r.score,
          confidence:
            r.confidence === 'no_data' || r.score === null
              ? ('low' as const)
              : r.confidence,
          nuance_notes: r.nuance,
          ai_summary: null,
          source_citations: r.citations,
        };
        const { error: insErr } = await s.from('positions').insert(row);
        if (insErr) {
          errors++;
          errorDetails.push(`${sd.name}/${r.view_type}: ${insErr.message.slice(0, 120)}`);
        } else {
          classified++;
        }
      }
    } catch (err) {
      errors++;
      errorDetails.push(`${sd.name}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
  }

  if (errors > 0 && errorDetails.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`  ⚠ ${errors} insert errors. First 3:`);
    for (const e of errorDetails.slice(0, 3)) {
      // eslint-disable-next-line no-console
      console.log(`    ${e}`);
    }
  }

  return { classified, errors };
}
