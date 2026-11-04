// ---------------------------------------------------------------------------
// Server-side data helpers for the G1 labeling app.
// Reads/locates the golden queue + per-annotator label files on disk.
// (NOT a "use server" module; these are plain helpers for Server Components.
//  Mutations live in actions.ts.)
//
// The golden set is file-backed (data/golden/*.jsonl), not a DB table: it is a
// small, versioned, human-owned artifact that feeds the entailment-gate
// calibration, and keeping it in git alongside the sampler is the point.
//
// v2 performance note: the queue is ~700 rows with wide context strings (~1 MB
// on disk). v1 shipped the WHOLE parsed queue into the client component's props
// on every page load. v2 ships only a light index (ordered pair_ids) and serves
// pair bodies in small windows via a server action. The parsed queue and the
// full-text sidecar are cached in module memory keyed by file mtime so repeated
// window/full-context reads do not re-parse the file.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BandN } from "./bands";
import type { PartyId7, PartyIdQ1, PartyIdQ2Lean, PartyIdQ2Strength } from "./party-id";

export const GOLDEN_DIR = join(process.cwd(), "data", "golden");
export const QUEUE_FILE = join(GOLDEN_DIR, "queue-2026-07.jsonl");
export const FULLTEXT_FILE = join(GOLDEN_DIR, "queue-2026-07.fulltext.json");
export const ANNOTATORS_FILE = join(GOLDEN_DIR, "annotators.jsonl");
export const PROPOSAL_ANNOTATOR = "agent-proposal";

export interface QueuePair {
  pair_id: string;
  source_table: "evidence_signal" | "position";
  source_row_id: string;
  is_seed: boolean;
  person_id: string | null;
  candidate_name: string | null;
  office: string | null;
  level: string | null;
  state_fips: string | null;
  is_utah: boolean;
  dimension: string | null;
  sub_dimension: string;
  stance: "low" | "high" | "mixed";
  stance_text: string;
  spectrum_low: string | null;
  spectrum_high: string | null;
  score: number | null;
  view_type: "stated" | "inferred";
  confidence: string | null;
  position_kind: string | null;
  claim: string;
  quote: string;
  context: string;
  context_recovered: boolean;
  url: string;
  // v2 additions (widen + media). Optional so older queue files still parse.
  context_source_id?: string | null;
  context_chars?: number;
  has_full_context?: boolean;
  source_url_original?: string | null;
  is_video?: boolean;
  video_platform?: string | null;
  video_id?: string | null;
  timestamp_seconds?: number | null;
  timestamp_resolved?: boolean;
  media_note?: string | null;
}

export interface LabelRecord {
  pair_id: string;
  /** null for a "cannot verify from source" skip; 1..4 otherwise. */
  band: BandN | null;
  band_label: string | null;
  /** present (non-empty) only on skip rows. */
  skip_reason?: string;
  rationale: string;
  annotator: string;
  timestamp: string;
}

/** One optional annotator bias-check profile (groundwork for the hosted version). */
export interface AnnotatorProfile {
  annotator: string;
  /**
   * @deprecated 2026-07: replaced by the ANES party-identification battery
   * below (party_id_q1 / party_id_q2_strength / party_id_q2_lean /
   * party_id_7). This was a rudimentary, unresearched self-report slider,
   * 1 (very liberal) .. 5 (very conservative). New saves never write this
   * field; it is kept ONLY so a pre-existing row on disk still parses and no
   * historical data is silently dropped. See party-id.ts.
   */
  political_lean?: number | null;
  /** ANES party-ID battery, Q1 raw answer (party self-identification). */
  party_id_q1?: PartyIdQ1 | null;
  /** ANES party-ID battery, Q2a raw answer (strength; only asked if Q1 is Democrat/Republican). */
  party_id_q2_strength?: PartyIdQ2Strength | null;
  /** ANES party-ID battery, Q2b raw answer (lean; only asked if Q1 is Independent/something else/no preference). */
  party_id_q2_lean?: PartyIdQ2Lean | null;
  /** Derived standard ANES 7-point party-identification code (see party-id.ts). */
  party_id_7?: PartyId7 | null;
  age_band?: string | null;
  state?: string | null;
  timestamp: string;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Normalize an annotator name into a filesystem-safe slug (guards traversal). */
export function slugAnnotator(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function labelsFile(annotatorSlug: string): string {
  return join(GOLDEN_DIR, `labels-${annotatorSlug}.jsonl`);
}

// ---------------------------------------------------------------------------
// Queue: mtime-cached parse + light index + windowed access
// ---------------------------------------------------------------------------
let _queueCache: { mtimeMs: number; rows: QueuePair[]; byId: Map<string, QueuePair> } | null = null;

function loadQueue(): { rows: QueuePair[]; byId: Map<string, QueuePair> } {
  if (!existsSync(QUEUE_FILE)) return { rows: [], byId: new Map() };
  const mtimeMs = statSync(QUEUE_FILE).mtimeMs;
  if (_queueCache && _queueCache.mtimeMs === mtimeMs) {
    return { rows: _queueCache.rows, byId: _queueCache.byId };
  }
  const rows = readJsonl<QueuePair>(QUEUE_FILE);
  const byId = new Map<string, QueuePair>(rows.map((r) => [r.pair_id, r]));
  _queueCache = { mtimeMs, rows, byId };
  return { rows, byId };
}

/** The full parsed queue (server-only; used by the agreement view). */
export function readQueue(): QueuePair[] {
  return loadQueue().rows;
}

/** Light index for the labeling page: ordered pair_ids + total (no bodies). */
export function readQueueIndex(): { pairIds: string[]; total: number } {
  const { rows } = loadQueue();
  return { pairIds: rows.map((r) => r.pair_id), total: rows.length };
}

/** Resolve a small window of pair bodies by id (order follows the input ids). */
export function pairsByIds(ids: string[]): QueuePair[] {
  const { byId } = loadQueue();
  const out: QueuePair[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (p) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full-document sidecar (lazy expand-to-full-document); mtime-cached
// ---------------------------------------------------------------------------
let _fullTextCache: { mtimeMs: number; map: Record<string, string> } | null = null;

function loadFullText(): Record<string, string> {
  if (!existsSync(FULLTEXT_FILE)) return {};
  const mtimeMs = statSync(FULLTEXT_FILE).mtimeMs;
  if (_fullTextCache && _fullTextCache.mtimeMs === mtimeMs) return _fullTextCache.map;
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(readFileSync(FULLTEXT_FILE, "utf8")) as Record<string, string>;
  } catch {
    map = {};
  }
  _fullTextCache = { mtimeMs, map };
  return map;
}

/**
 * Full document text for a pair with the quote wrapped in «guillemets» (so the
 * client's ContextView highlights it). Returns null when no source document was
 * stored for the pair (limited-context rows).
 */
export function fullContextForPair(pairId: string): string | null {
  const { byId } = loadQueue();
  const pair = byId.get(pairId);
  if (!pair || !pair.context_source_id) return null;
  const raw = loadFullText()[pair.context_source_id];
  if (!raw) return null;
  return markQuoteInText(raw, pair.quote);
}

/** Insert «» around the first occurrence of the quote (best-effort, marker-safe). */
function markQuoteInText(text: string, quote: string): string {
  const src = text.replace(/[«»]/g, "");
  const q = (quote || "").replace(/[«»]/g, "").trim();
  if (!q) return src;
  const probe = q.slice(0, 60).toLowerCase();
  const idx = src.toLowerCase().indexOf(probe);
  if (idx < 0) return src;
  const end = idx + q.length;
  return src.slice(0, idx) + "«" + src.slice(idx, end) + "»" + src.slice(end);
}

// ---------------------------------------------------------------------------
// Proposals + labels
// ---------------------------------------------------------------------------
/** Latest proposal per pair_id (last line wins). */
export function readProposals(): Map<string, LabelRecord> {
  const rows = readJsonl<LabelRecord>(labelsFile(PROPOSAL_ANNOTATOR));
  const m = new Map<string, LabelRecord>();
  for (const r of rows) if (r.pair_id) m.set(r.pair_id, r);
  return m;
}

/** Proposals limited to a set of pair_ids (for windowed client fetches). */
export function proposalsForIds(ids: string[]): Map<string, LabelRecord> {
  const all = readProposals();
  const m = new Map<string, LabelRecord>();
  for (const id of ids) {
    const p = all.get(id);
    if (p) m.set(id, p);
  }
  return m;
}

/** Discover every annotator that has a labels file on disk. */
export function listAnnotators(): string[] {
  if (!existsSync(GOLDEN_DIR)) return [];
  return readdirSync(GOLDEN_DIR)
    .map((f) => /^labels-(.+)\.jsonl$/.exec(f)?.[1])
    .filter((x): x is string => !!x)
    .sort();
}

export function readLabels(annotatorSlug: string): LabelRecord[] {
  return readJsonl<LabelRecord>(labelsFile(annotatorSlug));
}

/** Latest label per pair for one annotator (last line wins, re-labels override). */
export function latestLabelsByPair(annotatorSlug: string): Map<string, LabelRecord> {
  const m = new Map<string, LabelRecord>();
  for (const r of readLabels(annotatorSlug)) if (r.pair_id) m.set(r.pair_id, r);
  return m;
}

// ---------------------------------------------------------------------------
// Annotator profiles (optional, one-time; keyed by annotator slug, last wins)
// ---------------------------------------------------------------------------
export function readAnnotatorProfiles(): Map<string, AnnotatorProfile> {
  const rows = readJsonl<AnnotatorProfile>(ANNOTATORS_FILE);
  const m = new Map<string, AnnotatorProfile>();
  for (const r of rows) if (r.annotator) m.set(slugAnnotator(r.annotator), r);
  return m;
}

export function annotatorProfile(annotatorSlug: string): AnnotatorProfile | null {
  return readAnnotatorProfiles().get(annotatorSlug) ?? null;
}
