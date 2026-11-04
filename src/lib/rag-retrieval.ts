/**
 * Retrieval module for augmenting local-LLM classification with exemplars
 * pulled from a frozen, Claude-labeled corpus.
 *
 * Design goal: demonstrate that retrieval-augmented prompting closes the
 * score/direction gap between phi4:14b (and friends) and Claude Opus 4.7
 * without any weight changes.
 *
 * Strategy: for a given (candidate, sub_dimension), retrieve N exemplars from
 * OTHER candidates on the SAME sub_dimension, spread across the 0-1 spectrum.
 *
 * We deliberately exclude the candidate under test to avoid leakage, and we
 * pick exemplars spanning low-score + high-score ends so the model sees both
 * poles of the calibration scale.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { ClassificationExemplar } from './ollama';
import type { SubDimension } from '@/types/database';

/** One candidate in the frozen, Claude-labeled exemplar corpus. */
export interface BaselineCandidate {
  id: string;
  name: string;
  party?: string;
  sources_text: string; // already aggregated
  source_row_count: number;
  positions: Array<{
    sub_dimension_id: string;
    sub_dimension_name: string;
    domain: string;
    score: number;
    confidence: 'high' | 'medium' | 'low';
    ai_summary: string | null;
    nuance_notes: string | null;
  }>;
}

/** The exemplar corpus file format (JSON). */
export interface BaselineDataset {
  built_at: string;
  sub_dimensions: SubDimension[];
  candidates: BaselineCandidate[];
}

let cachedDataset: BaselineDataset | null | undefined;

/**
 * Load the exemplar corpus from the JSON file named by BASELINE_DATASET_PATH.
 * Returns null when the variable is unset or the file is missing, in which
 * case retrieval yields no exemplars and classification runs zero-shot.
 */
function loadDataset(): BaselineDataset | null {
  if (cachedDataset !== undefined) return cachedDataset;
  const path = process.env.BASELINE_DATASET_PATH;
  if (!path || !existsSync(path)) {
    cachedDataset = null;
    return cachedDataset;
  }
  cachedDataset = JSON.parse(readFileSync(path, 'utf8')) as BaselineDataset;
  return cachedDataset;
}

/**
 * Extract a short (≤1500 char) excerpt from the full aggregated source text
 * that is topically relevant to the sub-dimension — uses simple keyword
 * heuristics. A real production RAG would use sentence embeddings; we keep
 * it cheap and local.
 */
function extractRelevantExcerpt(
  fullText: string,
  subDimensionName: string,
  maxChars = 1200,
): string {
  const keywords = keywordsForSubDim(subDimensionName);
  const paragraphs = fullText.split(/\n\s*\n/).filter((p) => p.trim().length > 40);

  // Score each paragraph by keyword density
  const scored = paragraphs.map((p) => {
    const lower = p.toLowerCase();
    const matches = keywords.reduce(
      (sum, kw) => sum + (lower.split(kw).length - 1),
      0,
    );
    return { p, score: matches };
  });

  scored.sort((a, b) => b.score - a.score);

  // Take top-scoring paragraphs until we hit the budget
  let out = '';
  for (const s of scored) {
    if (s.score === 0 && out.length > 200) break; // stop once we're scraping the bottom
    const remaining = maxChars - out.length;
    if (remaining < 100) break;
    out += (out ? '\n\n' : '') + s.p.slice(0, remaining);
  }
  if (!out) out = fullText.slice(0, maxChars);
  return out;
}

function keywordsForSubDim(name: string): string[] {
  const map: Record<string, string[]> = {
    taxes: ['tax', 'taxation', 'revenue', 'irs', 'rate', 'deduction'],
    government_spending: ['spending', 'budget', 'deficit', 'debt', 'fiscal', 'appropriation'],
    business_regulation: ['regulation', 'business', 'commerce', 'industry', 'red tape', 'deregulat'],
    immigration: ['immigration', 'border', 'migrant', 'asylum', 'visa', 'deportation', 'daca'],
    civil_rights: ['civil rights', 'discrimination', 'equality', 'lgbt', 'gay', 'trans', 'race'],
    religious_liberty: ['religio', 'faith', 'church', 'prayer', 'conscience'],
    insurance_coverage: ['insurance', 'medicaid', 'medicare', 'aca', 'obamacare', 'healthcare', 'health care'],
    reproductive_rights: ['abortion', 'reproductive', 'roe', 'pregnancy', 'contraception', 'planned parenthood'],
    school_choice: ['school choice', 'voucher', 'charter', 'private school', 'esa', 'tuition'],
    public_school_funding: ['public school', 'education funding', 'teacher', 'classroom', 'per-pupil'],
    energy_policy: ['energy', 'oil', 'gas', 'coal', 'renewable', 'solar', 'wind', 'nuclear', 'climate'],
    public_lands: ['public land', 'blm', 'national park', 'monument', 'wilderness', 'grazing'],
    water_rights: ['water', 'colorado river', 'drought', 'irrigation', 'lake powell'],
    election_reform: ['election', 'voting', 'ballot', 'voter id', 'mail', 'fraud'],
    government_transparency: ['transparency', 'ethics', 'disclosure', 'open records', 'accountab'],
    gun_policy: ['gun', 'firearm', 'second amendment', '2a', 'nra', 'ccw', 'red flag'],
    criminal_justice: ['crime', 'police', 'prison', 'sentencing', 'bail', 'prosecut'],
    housing: ['housing', 'home', 'rent', 'zoning', 'mortgage', 'affordable'],
    transportation: ['transportation', 'transit', 'road', 'highway', 'rail', 'frontrunner', 'uta'],
  };
  const k = map[name] ?? [name.replace(/_/g, ' ')];
  return k.map((s) => s.toLowerCase());
}

/**
 * Retrieve N exemplars for a given (candidate_id_to_exclude, sub_dimension_name).
 * Picks a mix of low-end and high-end scores so the model sees both poles.
 */
export function retrieveExemplars(
  excludeCandidateId: string,
  subDimensionName: string,
  n = 3,
): ClassificationExemplar[] {
  const ds = loadDataset();
  if (!ds) return [];
  const subDim = ds.sub_dimensions.find((sd) => sd.name === subDimensionName);
  if (!subDim) return [];

  const candidates = ds.candidates.filter((c) => c.id !== excludeCandidateId);

  const pool: ClassificationExemplar[] = [];
  for (const c of candidates) {
    const pos = c.positions.find((p) => p.sub_dimension_name === subDimensionName);
    if (!pos) continue;
    // Only use high-confidence exemplars — we want calibration anchors, not ambiguous cases
    if (pos.confidence !== 'high') continue;
    pool.push({
      candidate_name: c.name,
      sub_dimension_name: subDimensionName,
      spectrum_low: subDim.spectrum_low,
      spectrum_high: subDim.spectrum_high,
      source_excerpt: extractRelevantExcerpt(c.sources_text, subDimensionName),
      score: pos.score,
      confidence: pos.confidence,
      nuance: pos.nuance_notes ?? pos.ai_summary ?? '',
    });
  }

  // Sort by score, pick one low, one high, and one middle if possible
  pool.sort((a, b) => a.score - b.score);
  if (pool.length === 0) return [];
  if (pool.length <= n) return pool;

  const picks: ClassificationExemplar[] = [];
  picks.push(pool[0]); // lowest
  picks.push(pool[pool.length - 1]); // highest
  if (n >= 3) picks.push(pool[Math.floor(pool.length / 2)]); // middle
  // If n > 3, spread remaining picks evenly
  while (picks.length < n && pool.length > picks.length) {
    const next = pool[Math.floor(pool.length * (picks.length / n))];
    if (!picks.includes(next)) picks.push(next);
    else break;
  }
  return picks;
}

/**
 * For static few-shot (not dynamic RAG): pick the same 2 high-confidence
 * exemplars each time — one low, one high — for this sub-dim. Useful as a
 * "no-retrieval" baseline to compare against full RAG.
 */
export function staticFewShot(
  excludeCandidateId: string,
  subDimensionName: string,
): ClassificationExemplar[] {
  return retrieveExemplars(excludeCandidateId, subDimensionName, 2);
}
