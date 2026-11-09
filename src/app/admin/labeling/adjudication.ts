// ---------------------------------------------------------------------------
// Server-side data helpers for the G1 golden-set ADJUDICATION mode.
// (NOT a "use server" module; these are plain helpers for Server Components and
//  the adjudication server actions. Mutations still go through the existing
//  submitLabel in actions.ts.)
//
// Adjudication mode serves the pairs the operator flagged for a second human read:
// every disputed pair (the two agent annotators disagreed) plus a 10 percent
// audit sample of the consensus pairs (a blind calibration check). The queue is
// produced by an offline script into data/golden/consensus-2026-07.json; this
// module only READS that file, plus the two agent label files and the operator's own
// labels file, and derives the resume + progress state the surface needs.
//
// Design note (blind calibration): we keep the queue in FILE ORDER, which
// interleaves disputed and audit pairs as they were sampled. We deliberately do
// NOT sort disputed-first-then-audit, because that would let the operator infer, once
// he reached the audit block, that every remaining pair was one the agents
// already agreed on, which would bias the audit-agreement rate the whole check
// exists to measure. The per-pair reason is likewise never shown before he
// picks a band. File order is deterministic, which satisfies the ordering rule.
// ---------------------------------------------------------------------------
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { GOLDEN_DIR, latestLabelsByPair, type QueuePair, pairsByIds } from "./data";
import { isBandN, type BandN } from "./bands";

export const CONSENSUS_FILE = join(GOLDEN_DIR, "consensus-2026-07.json");
export const HUMAN_ANNOTATOR = "operator";
export const PROPOSAL_ANNOTATOR = "agent-proposal";
export const SKEPTIC_ANNOTATOR = "agent-skeptic";

export type AdjudicationReason = "disputed" | "audit";

export interface ConsensusPairRecord {
  pair_id: string;
  proposal_band: number | null;
  skeptic_band: number | null;
  agreement: boolean | null;
  tier: "consensus" | "disputed" | "incomparable";
  in_adjudication_queue: boolean;
  adjudication_reason: AdjudicationReason | null;
}

interface ConsensusFile {
  summary?: Record<string, unknown>;
  pairs?: ConsensusPairRecord[];
}

/** One queue entry the client needs: the pair id and why it is in the queue.
 *  `reason` is used client-side ONLY for the live counters and the post-pick
 *  reveal panel; it is never rendered before the operator picks a band. */
export interface AdjQueueItem {
  pair_id: string;
  reason: AdjudicationReason;
}

/** The operator's resolved state for a queue pair (resume + progress seed). */
export interface AdjResolvedSeed {
  pair_id: string;
  /** null for a "cannot verify from source" skip; 1..4 otherwise. */
  band: number | null;
  reason: AdjudicationReason;
  /** Audit pairs only: whether the operator's band exactly matched the consensus band.
   *  null for disputed pairs and for skips (no consensus band to match). */
  matched_consensus: boolean | null;
}

// --- consensus file: mtime-cached parse -------------------------------------
let _consensusCache: {
  mtimeMs: number;
  records: ConsensusPairRecord[];
  byId: Map<string, ConsensusPairRecord>;
} | null = null;

function loadConsensus(): {
  records: ConsensusPairRecord[];
  byId: Map<string, ConsensusPairRecord>;
} {
  if (!existsSync(CONSENSUS_FILE)) return { records: [], byId: new Map() };
  const mtimeMs = statSync(CONSENSUS_FILE).mtimeMs;
  if (_consensusCache && _consensusCache.mtimeMs === mtimeMs) {
    return { records: _consensusCache.records, byId: _consensusCache.byId };
  }
  let records: ConsensusPairRecord[] = [];
  try {
    const parsed = JSON.parse(readFileSync(CONSENSUS_FILE, "utf8")) as ConsensusFile;
    records = Array.isArray(parsed.pairs) ? parsed.pairs : [];
  } catch {
    records = [];
  }
  const byId = new Map<string, ConsensusPairRecord>(records.map((r) => [r.pair_id, r]));
  _consensusCache = { mtimeMs, records, byId };
  return { records, byId };
}

/** All consensus pair records (unfiltered), in file order. */
export function readConsensusPairs(): ConsensusPairRecord[] {
  return loadConsensus().records;
}

/**
 * The ordered adjudication queue: every pair with in_adjudication_queue === true
 * and a real reason, kept in file order (see the blind-calibration note above).
 */
export function readAdjudicationQueue(): AdjQueueItem[] {
  const out: AdjQueueItem[] = [];
  for (const p of loadConsensus().records) {
    if (!p.in_adjudication_queue) continue;
    if (p.adjudication_reason !== "disputed" && p.adjudication_reason !== "audit") continue;
    out.push({ pair_id: p.pair_id, reason: p.adjudication_reason });
  }
  return out;
}

/**
 * The consensus band for an audit pair (proposal_band, which equals skeptic_band
 * for audit pairs since audit pairs are consensus pairs). Returns null for
 * disputed pairs or when the band is not a valid 1..4 ordinal. Server-only; this
 * is never shipped to the client for an un-adjudicated pair (it would leak the
 * agents' judgment before the operator picks).
 */
export function consensusBandFor(pairId: string): BandN | null {
  const rec = loadConsensus().byId.get(pairId);
  if (!rec || rec.adjudication_reason !== "audit") return null;
  return isBandN(rec.proposal_band) ? rec.proposal_band : null;
}

/** Pair bodies for a set of queue ids (reuses the shared queue loader). */
export function adjudicationPairs(ids: string[]): QueuePair[] {
  return pairsByIds(ids);
}

// --- the operator's progress (resume + audit / disputed counters) ------------------
export interface AdjProgress {
  resolved: AdjResolvedSeed[];
  auditTotal: number;
  disputedTotal: number;
}

/**
 * The operator's current adjudication state: which queue pairs he has already resolved,
 * with per-audit-pair match against the consensus band, plus the queue's audit
 * and disputed totals. Seeds the client so live counters resume correctly.
 */
export function operatorAdjudicationProgress(): AdjProgress {
  const queue = readAdjudicationQueue();
  const reasonById = new Map<string, AdjudicationReason>(queue.map((q) => [q.pair_id, q.reason]));
  let auditTotal = 0;
  let disputedTotal = 0;
  for (const q of queue) {
    if (q.reason === "audit") auditTotal++;
    else disputedTotal++;
  }

  const operatorLabels = latestLabelsByPair(HUMAN_ANNOTATOR);
  const resolved: AdjResolvedSeed[] = [];
  for (const [pairId, rec] of operatorLabels) {
    const reason = reasonById.get(pairId);
    if (!reason) continue; // only queue pairs count toward adjudication progress
    let matched: boolean | null = null;
    if (reason === "audit" && rec.band != null) {
      const consensus = consensusBandFor(pairId);
      matched = consensus != null && rec.band === consensus;
    }
    resolved.push({ pair_id: pairId, band: rec.band, reason, matched_consensus: matched });
  }
  return { resolved, auditTotal, disputedTotal };
}

// --- agent judgments (revealed ONLY after the operator picks) ----------------------
export interface AgentJudgment {
  band: number | null;
  band_label: string | null;
  rationale: string;
}

export interface AgentJudgments {
  proposal: AgentJudgment | null;
  skeptic: AgentJudgment | null;
}

/**
 * The two agent annotators' band + rationale for one pair. Called by the reveal
 * server action AFTER the operator submits his band, so nothing here reaches the client
 * before he has committed a judgment of his own.
 */
export function agentJudgmentsFor(pairId: string): AgentJudgments {
  const prop = latestLabelsByPair(PROPOSAL_ANNOTATOR).get(pairId) ?? null;
  const skep = latestLabelsByPair(SKEPTIC_ANNOTATOR).get(pairId) ?? null;
  return {
    proposal: prop
      ? { band: prop.band, band_label: prop.band_label, rationale: prop.rationale ?? "" }
      : null,
    skeptic: skep
      ? { band: skep.band, band_label: skep.band_label, rationale: skep.rationale ?? "" }
      : null,
  };
}
