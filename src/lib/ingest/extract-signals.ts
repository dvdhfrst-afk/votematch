/**
 * extract-signals.ts -- the DERIVED-SIGNAL extraction layer for Havesay.
 *
 * One stage downstream of raw-ingest.ts. The ingest pipeline stores immutable,
 * normalized source text in raw_evidence and marks each unique piece of
 * NORMALIZED content in evidence_seen_ledger (keyed on normalized_hash) with a
 * `classified` boolean. THIS layer reads the unclassified content, asks a
 * classifier to emit zero-or-more per-signal records, writes them to
 * evidence_signals, and flips `classified` to true so each piece of content is
 * processed exactly once.
 *
 * TAXONOMY-INDEPENDENCE IS THE WHOLE POINT (founder hard rule).
 * ----------------------------------------------------------------------------
 * The issue taxonomy is being finalized in a SEPARATE workstream. Ingest and
 * signal-extraction must stay DECOUPLED from the taxonomy so the real
 * classifier (phi4 / Claude, bound to the final taxonomy) can be swapped in
 * later WITHOUT touching this plumbing. The mechanism:
 *
 *   - PositionClassifier is a clean INTERFACE. The pipeline depends only on the
 *     interface, never on a concrete classifier. The classifier is injected
 *     into extractSignals() by the caller (constructor / argument injection),
 *     so swapping StubClassifier for a future Phi4Classifier / ClaudeClassifier
 *     is a one-line change at the call site and zero change here.
 *
 *   - RawSignal's taxonomy-keyed fields (proposition_key, sub_dimension_key,
 *     direction, intensity_band) are ALL nullable. A classifier that knows no
 *     taxonomy leaves them null; a future taxonomy-bound classifier fills them
 *     in. Nothing in this file names, imports, or assumes any taxonomy.
 *
 *   - The stored row stamps `taxonomy_version` (null until a taxonomy is bound)
 *     and `classifier_model`, so once the real classifier ships, its output is
 *     distinguishable from the stub's and filterable by taxonomy version.
 *
 * The RawSignal shape mirrors doc 07 ("12-positioning-engine/
 * 07-positioning-data-and-intensity-redesign.md") section 1.6, the per-signal
 * record the classifier emits, with the taxonomy-keyed fields made nullable so
 * a taxonomy-free stub is a first-class producer.
 *
 * Single TypeScript runtime, no Python (architecture rule). One pg Client does
 * all DB work. DRY-RUN is the default at the CLI; this module's extractSignals
 * gates every write behind opts.apply.
 */

import type { Client } from 'pg';

// ---------------------------------------------------------------------------
// The per-signal record (doc 07 section 1.6), taxonomy fields nullable
// ---------------------------------------------------------------------------

/**
 * RawSignal -- the atomic unit a classifier emits, one per (candidate,
 * proposition) the source speaks to. Mirrors doc 07 section 1.6, but every
 * field that names or scores a TAXONOMY concept is nullable so a classifier
 * that is not yet bound to a taxonomy (the stub) is a valid producer:
 *
 *   - proposition_key / sub_dimension_key: the taxonomy address of the signal.
 *     Null until a taxonomy is bound. (Doc 07 calls these *_slug; we use *_key
 *     to keep the column-agnostic, taxonomy-version-agnostic naming the founder
 *     asked for, since the final taxonomy's key scheme is not decided yet.)
 *   - direction: 0..1 calibrated position on the spectrum, OR null when the
 *     signal is not a graded placement (doc 07: null when position_kind is not
 *     'graded', and necessarily null when there is no taxonomy to place it on).
 *   - intensity_band: 'neutral'|'lean'|'support'|'strong' display band derived
 *     from direction; null when direction is null.
 *   - confidence: DATA-QUALITY confidence in THIS reading ('high'|'medium'
 *     |'low'), never a strength reading (doc 07's signal_confidence, bucketed).
 *   - authenticity_tier: 1 primary / 2 reported-with-direct-quote / 3
 *     paraphrased-or-aggregate. Copied from the source.
 *   - source_url: the exact source the signal was read from (provenance).
 *   - quote: the verbatim passage the reading rests on (doc 07's
 *     verbatim_quote). Null for tier-3 / action signals.
 *   - note: free-text classifier bookkeeping (e.g. the stub's "awaiting
 *     taxonomy" marker). Not surfaced to voters.
 *
 * Fields added in Build 6 (the extraction gate; framework 09). These are what
 * the REAL classifier needs and what the gate (gateSignal below) enforces. All
 * are OPTIONAL so the existing StubClassifier and every existing caller keep
 * compiling and behaving exactly as before; the stub fills the ones it can.
 *
 *   - position_kind: the 07 C1 distinction. 'graded' = a placed position on a
 *     spectrum (direction is a real 0..1). 'balanced' = the candidate explicitly
 *     holds a both-sides / qualified view (a real reading, but not a single
 *     pole). 'abstains_governing' = the candidate declines to govern on this
 *     (e.g. "not within this office", "I will not legislate X"); per the hard
 *     rule, an abstains_governing signal's direction is NULL, NEVER 0.5 -- silence
 *     and abstention must never be manufactured into a centrist position.
 *   - is_action: true for an ACTION signal (a roll-call vote, a sponsorship) as
 *     opposed to a STATEMENT. Actions are licensed differently (09 Part 2.3) and
 *     a graded action does not require a verbatim quote the way a tier-1/2
 *     statement does (the bill text / vote record is the grounding).
 *   - source_domain: the registrable domain of source_url, for cheap
 *     same-source detection in corroboration counting.
 *   - actor: WHO is speaking. 'candidate_self' (the candidate's own site /
 *     questionnaire), 'named_outlet:<slug>' (a named news outlet),
 *     'org:<slug>' (an organization), or 'gov_record' (an official record:
 *     vote, filing). Inference distance (09 Part 2.3) keys off this.
 *   - recency: the published / as-of date of the source (ISO 8601 string),
 *     for the recency-decay path (07 M2). Null when unknown.
 *   - signal_confidence: a NUMERIC 0..1 confidence in this reading, ALONGSIDE
 *     the existing `confidence` enum (which stays for backward compatibility).
 *     The gate's confidence routing (stage 5) uses the numeric value against the
 *     project's 0.75 auto-publish threshold; the enum remains the coarse label.
 */
export type PositionKind = 'graded' | 'balanced' | 'abstains_governing';

export type SignalActor = 'candidate_self' | 'gov_record' | string; // string allows 'named_outlet:<slug>' / 'org:<slug>'

export interface RawSignal {
  proposition_key?: string | null;
  sub_dimension_key?: string | null;
  direction?: number | null;
  intensity_band?: string | null;
  confidence: 'high' | 'medium' | 'low';
  authenticity_tier: 1 | 2 | 3;
  source_url: string;
  quote?: string | null;
  note?: string;
  // ---- Build 6 additions (all optional; the gate enforces them) ----
  position_kind?: PositionKind | null;
  is_action?: boolean;
  source_domain?: string | null;
  actor?: SignalActor | null;
  recency?: string | null;
  signal_confidence?: number | null;
}

/**
 * Context handed to a classifier alongside the text. Everything the classifier
 * might need to attribute and tier a signal, without giving it DB access (the
 * classifier stays pure: text + context in, signals out).
 */
export interface ClassifyContext {
  person_id: string | null;
  source_family: string | null;
  source_url: string;
  authenticity_tier: number;
}

// ---------------------------------------------------------------------------
// The classifier INTERFACE -- the taxonomy-independence seam
// ---------------------------------------------------------------------------

/**
 * PositionClassifier -- the swap-in seam. The pipeline depends ONLY on this
 * interface. To bind the real taxonomy later, implement this interface in a new
 * class (Phi4Classifier / ClaudeClassifier) and inject it at the call site;
 * nothing in extract-signals.ts or the CLI changes.
 *
 *   - model: identifies the producing model, stored in
 *     evidence_signals.classifier_model ('stub' now; later 'phi4:14b' /
 *     'claude-...').
 *   - classify(text, ctx): returns zero-or-more RawSignals for the given source
 *     text. MUST be side-effect-free (no DB, no network beyond the model call
 *     in a real implementation, no mutation of inputs) so it is trivially
 *     testable and re-runnable.
 */
export interface PositionClassifier {
  readonly model: string;
  classify(text: string, ctx: ClassifyContext): Promise<RawSignal[]>;
}

// ---------------------------------------------------------------------------
// StubClassifier -- PLACEHOLDER for the taxonomy-bound classifier
// ---------------------------------------------------------------------------

/**
 * StubClassifier -- a deterministic, side-effect-free PLACEHOLDER.
 *
 * !!! THIS IS NOT A REAL CLASSIFIER. !!!
 * It exists ONLY so the pipeline (table, extractor, CLI, ledger bookkeeping)
 * can be built, type-checked, and exercised end-to-end BEFORE the issue
 * taxonomy is finalized. When the taxonomy ships, REPLACE this class with a
 * Phi4Classifier / ClaudeClassifier that implements the same PositionClassifier
 * interface; do not edit the pipeline.
 *
 * The stub NEVER invents taxonomy mappings. By default it returns [] (no
 * signal). It will OPTIONALLY emit a single PROVENANCE-ONLY signal -- with NO
 * taxonomy address and NO direction/intensity -- when the text clearly contains
 * a first-person policy-statement marker. That row records "there is an
 * unclassified candidate statement at this URL, worth re-classifying once the
 * taxonomy exists," nothing more. It is:
 *   - deterministic: same text in => same output out (a regex marker test);
 *   - side-effect-free: reads only its inputs, mutates nothing, no I/O;
 *   - taxonomy-free: proposition_key / sub_dimension_key / direction /
 *     intensity_band are all null; confidence is 'low'.
 */
export class StubClassifier implements PositionClassifier {
  readonly model = 'stub';

  /**
   * When true (the default), the stub may emit ONE provenance-only signal for
   * text that trips the first-person-policy marker. Set false for a pure no-op
   * stub that always returns []. Either way it never invents taxonomy mappings.
   */
  private readonly emitProvenanceMarker: boolean;

  constructor(opts: { emitProvenanceMarker?: boolean } = {}) {
    this.emitProvenanceMarker = opts.emitProvenanceMarker ?? true;
  }

  /**
   * First-person POLICY-statement markers. Deliberately conservative: a
   * first-person pronoun / commitment verb immediately followed by policy /
   * governing language. This is ONLY a "this looks like a candidate stating a
   * position" smell test for queueing, NOT a position reading. It assigns no
   * issue, no direction, no intensity.
   */
  private static readonly POLICY_MARKERS: RegExp[] = [
    // "I will / I'll / I would / I'd / I want to / I plan to / I pledge to ..."
    /\bI(?:'ll| will| would|'d| want to| plan to| pledge to| promise to| intend to| commit to| support| oppose| believe| stand for| fight for| vote (?:for|against))\b/i,
    // "My plan / my priority / my position / my pledge / my promise is to ..."
    /\bmy (?:plan|priority|priorities|position|pledge|promise|platform|agenda|commitment)\b/i,
    // "We must / we will / we need to ..." (campaign first-person-plural)
    /\bwe (?:must|will|need to|should)\b/i,
    // "If elected ... / when elected ... / as your <office> ..."
    /\b(?:if|when) elected\b/i,
    /\bas your (?:mayor|senator|representative|governor|council ?member|commissioner|delegate|assembly ?member)\b/i,
  ];

  /**
   * Extract a short, single-line quote around the FIRST policy marker hit, so
   * the provenance signal points a future classifier at the right passage.
   * Pure string work; returns null if nothing matches. Length-capped.
   */
  private static firstMarkerQuote(text: string): string | null {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return null;
    for (const re of StubClassifier.POLICY_MARKERS) {
      const m = re.exec(t);
      if (m && m.index >= 0) {
        const start = Math.max(0, m.index);
        // Take up to ~220 chars from the marker, trimmed to a sentence-ish end.
        const slice = t.slice(start, start + 220);
        const cut = slice.search(/[.!?](?:\s|$)/);
        const quote = (cut >= 0 ? slice.slice(0, cut + 1) : slice).trim();
        return quote.length ? quote : null;
      }
    }
    return null;
  }

  /**
   * classify(): the stub reading. Deterministic and side-effect-free.
   *   - emitProvenanceMarker disabled, or no marker hit  => return [] (no data).
   *   - marker hit                                        => return EXACTLY one
   *     provenance-only RawSignal: no taxonomy address, null direction, null
   *     intensity_band, confidence 'low', authenticity_tier copied from ctx,
   *     the source_url, the extracted quote, and a note flagging it as awaiting
   *     the taxonomy.
   */
  async classify(text: string, ctx: ClassifyContext): Promise<RawSignal[]> {
    if (!this.emitProvenanceMarker) return [];
    const quote = StubClassifier.firstMarkerQuote(text ?? '');
    if (!quote) return [];

    const tier = (ctx.authenticity_tier === 1 || ctx.authenticity_tier === 2 || ctx.authenticity_tier === 3
      ? ctx.authenticity_tier
      : 3) as 1 | 2 | 3;

    const signal: RawSignal = {
      proposition_key: null,
      sub_dimension_key: null,
      direction: null,
      intensity_band: null,
      confidence: 'low',
      authenticity_tier: tier,
      source_url: ctx.source_url,
      quote,
      note: 'stub: unclassified candidate statement, awaiting taxonomy',
    };
    return [signal];
  }
}

// ---------------------------------------------------------------------------
// authenticityTierFor -- source-family + discovery-path => tier (doc 07)
// ---------------------------------------------------------------------------

/**
 * Map a source's family + discovery path to an authenticity_tier per doc 07:
 *   tier 1 = primary / candidate-self-published (candidate site, candidate
 *            social, our own questionnaire) -- the gold-standard "stated" view.
 *   tier 2 = reported WITH a direct quote (named-outlet news carrying a
 *            verbatim quote).
 *   tier 3 = paraphrased / secondary / aggregate (reporter paraphrase, summary,
 *            roundup) -- and the conservative DEFAULT when we cannot tell.
 *
 * Conservative by design: anything we cannot positively place as tier 1 or 2
 * falls to tier 3. The discovery_path can promote a news hit to tier 2 when it
 * signals a direct quote was captured.
 */
export function authenticityTierFor(
  source_family: string | null | undefined,
  discovery_path: string | null | undefined,
): 1 | 2 | 3 {
  const fam = (source_family ?? '').toLowerCase().trim();
  const path = (discovery_path ?? '').toLowerCase().trim();

  // Tier 1: candidate-self / candidate-site / our questionnaire.
  const tier1Families = new Set([
    'candidate_self',
    'candidate_site',
    'candidate_website',
    'questionnaire',
    'candidate_social',
  ]);
  if (tier1Families.has(fam)) return 1;
  // Some pipelines carry the self-published signal on the discovery path.
  if (
    path === 'authoritative_anchor' ||
    path === 'verified_email_domain' ||
    path === 'candidate_self' ||
    path === 'questionnaire'
  ) {
    return 1;
  }

  // Tier 2: reported WITH a direct quote (news that captured a verbatim quote).
  const tier2Families = new Set(['news', 'named_outlet', 'press', 'media']);
  const quotedPath =
    path.includes('quote') || path === 'reported_with_quote' || path === 'direct_quote';
  if (tier2Families.has(fam) && quotedPath) return 2;

  // Tier 3: paraphrased / secondary / aggregate, and the conservative default.
  return 3;
}

// ---------------------------------------------------------------------------
// extractSignals -- the per-content extraction pass
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /** Max distinct content pieces to process this pass. Default 50 at the CLI. */
  limit?: number;
  /** apply !== true => DRY-RUN: classify + plan, write NOTHING. Default false. */
  apply?: boolean;
}

/** Per-content outcome, for logging + the summary. */
export interface ExtractRowResult {
  normalized_hash: string;
  raw_evidence_id: string;
  person_id: string | null;
  source_url: string | null;
  source_family: string | null;
  authenticity_tier: 1 | 2 | 3;
  signals_emitted: number;
  /** True when the ledger row was (or would be) flipped classified=true. */
  marked_classified: boolean;
  /** Set when this content piece errored; the pass continues regardless. */
  error?: string;
}

export interface ExtractSummary {
  mode: 'apply' | 'dry-run';
  classifier_model: string;
  extractor_version: string;
  processed: number;
  signals_emitted: number;
  marked_classified: number;
  errors: number;
  rows: ExtractRowResult[];
}

/**
 * Pipeline-code version. Bump when the extraction CONTRACT changes (what gets
 * selected, how signals map to rows). Independent of classifier_model.
 */
export const EXTRACTOR_VERSION = 'extract-signals/1';

/**
 * Row shape returned by the unclassified-content query. One row per DISTINCT
 * piece of normalized content (the ledger is keyed on normalized_hash), joined
 * to its FIRST raw_evidence row for the text + context.
 */
interface UnclassifiedRow {
  normalized_hash: string;
  raw_evidence_id: string;
  extracted_text: string | null;
  source_url: string | null;
  source_family: string | null;
  discovery_path: string | null;
  person_id: string | null;
  stored_authenticity_tier: number | null;
}

/**
 * Select unclassified content: each evidence_seen_ledger row with
 * classified=false, joined to its representative raw_evidence row (the
 * first_raw_evidence_id, falling back to any row sharing the normalized_hash).
 * Joining on the ledger guarantees we process each piece of underlying CONTENT
 * exactly once even when many URLs share the same normalized_hash.
 */
/**
 * Source families the POSITIONING classifier is allowed to read. Mirrors
 * raw-ingest.ts (POSITIONING_SOURCE_FAMILIES) and classify-signals.ts. The
 * 'filing' family (declaration-of-candidacy / legal filings) is deliberately
 * ABSENT so those rows are kept for contact data only and never become
 * positioning signals. NULL-family rows are also excluded (opt-in by family).
 */
const POSITIONING_SOURCE_FAMILIES = ['candidate_site', 'social', 'video_transcript'];

async function selectUnclassified(
  client: Client,
  limit: number,
): Promise<UnclassifiedRow[]> {
  const { rows } = await client.query(
    `select
        l.normalized_hash                          as normalized_hash,
        re.id                                      as raw_evidence_id,
        re.extracted_text                          as extracted_text,
        re.source_url                              as source_url,
        re.source_family                           as source_family,
        re.discovery_path                          as discovery_path,
        re.person_id                               as person_id,
        (re.provenance->>'authenticity_tier')::int as stored_authenticity_tier
      from evidence_seen_ledger l
      join raw_evidence re
        on re.id = coalesce(
             l.first_raw_evidence_id,
             (select r2.id from raw_evidence r2
               where r2.normalized_hash = l.normalized_hash
               order by r2.created_at asc
               limit 1)
           )
      where l.classified = false
        and re.source_family = any($2::text[])
      order by l.last_seen_at desc
      limit $1`,
    [limit, POSITIONING_SOURCE_FAMILIES],
  );
  return rows as UnclassifiedRow[];
}

/** Insert one signal row. Only called in apply mode. */
async function insertSignal(
  client: Client,
  args: {
    rawEvidenceId: string;
    personId: string | null;
    classifierModel: string;
    signal: RawSignal;
  },
): Promise<void> {
  await client.query(
    `insert into evidence_signals
       (raw_evidence_id, person_id, extractor_version, classifier_model,
        taxonomy_version, signal, source_url, authenticity_tier)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      args.rawEvidenceId,
      args.personId,
      EXTRACTOR_VERSION,
      args.classifierModel,
      // taxonomy_version stays NULL until a taxonomy-bound classifier sets it.
      null,
      JSON.stringify(args.signal),
      args.signal.source_url,
      args.signal.authenticity_tier,
    ],
  );
}

/** Flip the ledger row to classified=true. Only called in apply mode. */
async function markClassified(client: Client, normalizedHash: string): Promise<void> {
  await client.query(
    'update evidence_seen_ledger set classified = true where normalized_hash = $1',
    [normalizedHash],
  );
}

/**
 * extractSignals(client, classifier, opts): the per-content extraction pass.
 *
 * For each DISTINCT unclassified content piece (evidence_seen_ledger.classified
 * = false), joined to its representative raw_evidence row:
 *   1. derive the authenticity_tier (prefer the stored provenance tier; else
 *      compute it from source_family + discovery_path).
 *   2. call classifier.classify(extracted_text, ctx) -- zero-or-more RawSignals.
 *   3. APPLY mode: insert one evidence_signals row per emitted signal, then flip
 *      the ledger row classified=true (so the content is never re-processed).
 *      DRY-RUN: print the plan, write NOTHING.
 *   4. wrap each content piece in try/catch so one failure never aborts the
 *      pass; a failed piece is NOT marked classified, so a later run retries it.
 *
 * Idempotent: already-classified content is excluded by the query, so re-runs
 * skip it. Side-effect-free classifier + per-row gating keep DRY-RUN honest.
 */
export async function extractSignals(
  client: Client,
  classifier: PositionClassifier,
  opts: ExtractOptions = {},
): Promise<ExtractSummary> {
  const apply = opts.apply === true;
  const limit = Math.max(1, opts.limit ?? 50);

  const rows = await selectUnclassified(client, limit);

  const summary: ExtractSummary = {
    mode: apply ? 'apply' : 'dry-run',
    classifier_model: classifier.model,
    extractor_version: EXTRACTOR_VERSION,
    processed: 0,
    signals_emitted: 0,
    marked_classified: 0,
    errors: 0,
    rows: [],
  };

  for (const row of rows) {
    const tier = (row.stored_authenticity_tier === 1 ||
    row.stored_authenticity_tier === 2 ||
    row.stored_authenticity_tier === 3
      ? row.stored_authenticity_tier
      : authenticityTierFor(row.source_family, row.discovery_path)) as 1 | 2 | 3;

    const rowResult: ExtractRowResult = {
      normalized_hash: row.normalized_hash,
      raw_evidence_id: row.raw_evidence_id,
      person_id: row.person_id ?? null,
      source_url: row.source_url ?? null,
      source_family: row.source_family ?? null,
      authenticity_tier: tier,
      signals_emitted: 0,
      marked_classified: false,
    };

    try {
      const ctx: ClassifyContext = {
        person_id: row.person_id ?? null,
        source_family: row.source_family ?? null,
        source_url: row.source_url ?? '',
        authenticity_tier: tier,
      };

      const signals = await classifier.classify(row.extracted_text ?? '', ctx);
      rowResult.signals_emitted = signals.length;

      if (apply) {
        for (const signal of signals) {
          await insertSignal(client, {
            rawEvidenceId: row.raw_evidence_id,
            personId: row.person_id ?? null,
            classifierModel: classifier.model,
            signal,
          });
        }
        await markClassified(client, row.normalized_hash);
        rowResult.marked_classified = true;
      } else {
        // DRY-RUN: report what WOULD be written; flip nothing.
        rowResult.marked_classified = true; // would-be
        console.log(
          `[DRY-RUN] nhash=${row.normalized_hash.slice(0, 12)} ` +
            `raw=${row.raw_evidence_id.slice(0, 8)} ` +
            `tier=${tier} model=${classifier.model} ` +
            `=> would insert ${signals.length} signal(s), then mark classified=true`,
        );
        if (signals.length > 0) {
          console.log(
            '            signals: ' +
              JSON.stringify(
                signals.map((s) => ({
                  proposition_key: s.proposition_key ?? null,
                  direction: s.direction ?? null,
                  intensity_band: s.intensity_band ?? null,
                  confidence: s.confidence,
                  authenticity_tier: s.authenticity_tier,
                  note: s.note ?? null,
                })),
              ),
          );
        }
      }

      summary.signals_emitted += signals.length;
      if (rowResult.marked_classified) summary.marked_classified++;
    } catch (e) {
      // Resilient: one bad content piece never aborts the pass. It is NOT
      // marked classified, so a later run retries it.
      rowResult.error = e instanceof Error ? e.message : String(e);
      rowResult.marked_classified = false;
      summary.errors++;
      console.error(
        `[ERROR] nhash=${row.normalized_hash.slice(0, 12)} raw=${row.raw_evidence_id.slice(0, 8)}: ${rowResult.error}`,
      );
    }

    summary.processed++;
    summary.rows.push(rowResult);
  }

  return summary;
}

// ===========================================================================
// gateSignal -- the anti-hallucination EXTRACTION GATE (Build 6)
// ===========================================================================

/**
 * The ordered gate stages, per the founder spec / framework 09:
 *
 *   (0) prefer a deterministic / clean-text source over a vision read. A signal
 *       read from clean extracted text outranks the same signal read from an
 *       image by a vision model; when both exist consensus already favored the
 *       agreed value, but the gate also refuses to PUBLISH a vision-only graded
 *       reading at high confidence.
 *   (1) consensus already applied upstream (runConsensus in consensus.ts). The
 *       gate trusts that a graded value reaching it cleared the >= 2-pass vote;
 *       it records the upstream agreement if provided.
 *   (2) verbatim quote + locator REQUIRED for a graded tier-1/2 signal, and the
 *       quote substring is VERIFIED IN CODE to actually exist in sourceText
 *       (rejected if not). This is the single hardest hallucination guard: a
 *       model cannot invent a quote, because the gate checks it against the
 *       source bytes.
 *   (3) cross-source corroboration AFTER dedup. One distinct source publishes
 *       low at best; >= 2 distinct deduped sources may publish high.
 *   (4) deterministic validators on contact-type values (email / phone / URL).
 *       A contact that fails the validator never publishes as verified.
 *   (5) confidence routing -> 'publish' | 'hold' | 'review', reusing the
 *       project's 0.75 auto-publish threshold.
 *
 * Hard rules enforced (founder spec):
 *   - a 'graded' signal from a tier-1/2 source MUST carry a verbatim quote;
 *   - 'abstains_governing' has direction === null (never 0.5);
 *   - 'strong' intensity_band requires a maximalism marker in the quote;
 *   - never publish a value that fails ANY stage.
 *
 * The gate is applied by the PIPELINE, not the classifier (the classifier stays
 * pure and taxonomy-independent). It is a pure function of (signal, sourceText,
 * corroboratingSourcesCount[, opts]) so it is trivially testable offline.
 */

/** The project's auto-publish threshold (0.75); reused here, not redefined. */
export const AUTO_PUBLISH_THRESHOLD = 0.75;

/** A graded signal at or above this corroboration count may publish high. */
export const MIN_CORROBORATION_FOR_HIGH = 2;

export type GateDecision = 'publish' | 'hold' | 'review';

export interface GateResult {
  /** publish (auto), hold (insufficient evidence; keep but do not surface), or review (needs a human). */
  decision: GateDecision;
  /** True only when decision === 'publish'. Convenience for the caller. */
  publish: boolean;
  /** Ordered list of the stages that ran and their pass/fail, for the audit log. */
  stages: Array<{ stage: string; pass: boolean; detail?: string }>;
  /** The first hard-rule / stage failure reason, if any (machine-stable tag). */
  reason: string | null;
  /** The effective numeric confidence the routing used (signal_confidence, clamped). */
  effective_confidence: number;
  /** Echoed corroboration count the gate saw (post-dedup, supplied by caller). */
  corroboration: number;
}

export interface GateContext {
  /**
   * The clean source text the signal was read from. The quote check verifies
   * the signal's quote is a substring of this. For an ACTION signal (a vote /
   * sponsorship) this can be the bill text / official record; for a statement it
   * is the page's extracted_text.
   */
  sourceText: string;
  /**
   * Number of DISTINCT corroborating sources AFTER near-duplicate dedup
   * (clusterNearDuplicates in dedup.ts). The caller computes this; the gate does
   * not re-cluster (separation of concerns + the gate stays pure on its inputs).
   * Defaults to 1 (the signal's own source) when omitted.
   */
  corroboratingSourcesCount?: number;
  /**
   * True when this signal was produced by a VISION model from an image rather
   * than from clean extracted text. Stage 0 down-routes a vision-only graded
   * reading. Default false.
   */
  fromVision?: boolean;
  /**
   * Optional contact-validator results, if the caller already ran the
   * deterministic validators on a contact-type value carried by this signal.
   * When the signal is not a contact, leave undefined. { valid:false } forces a
   * non-publish at stage 4.
   */
  contactValidation?: { valid: boolean; reason?: string };
  /**
   * Optional upstream consensus agreement (0..1) for the graded value, recorded
   * for the audit. The gate does not re-run consensus.
   */
  consensusAgreement?: number;
}

/**
 * Maximalism markers: the rhetorical-absolute vocabulary that licenses a 'strong'
 * intensity band (07's "strong = rhetorical maximalism, applied symmetrically").
 * Deliberately symmetric (no partisan valence) and conservative: a 'strong' band
 * with NONE of these in its quote is downgraded, because the band was asserted
 * without textual support.
 */
const MAXIMALISM_MARKERS: RegExp[] = [
  /\b(?:ban|abolish|eliminate|end|outlaw|prohibit|criminaliz\w*)\b/i,
  /\b(?:guarantee|mandate|require|enforce|compel)\b/i,
  /\b(?:always|never|all|every|none|no\s+exceptions?|under\s+no\s+circumstances)\b/i,
  /\b(?:completely|entirely|absolutely|totally|fully|unconditional\w*)\b/i,
  /\b(?:immediately|at\s+once|without\s+delay)\b/i,
  /\b(?:fight|stop|defeat|crush|reject)\b/i,
  /\b(?:must|will\s+not\s+(?:rest|stop|allow))\b/i,
];

function hasMaximalismMarker(quote: string): boolean {
  return MAXIMALISM_MARKERS.some((re) => re.test(quote));
}

/**
 * Normalize text for the verbatim-quote substring check. The stored
 * extracted_text has had whitespace collapsed (raw-ingest normalizeContent), and
 * a classifier's quote may differ in whitespace, smart quotes, or surrounding
 * spaces. We lowercase, normalize a few unicode punctuation variants to ASCII,
 * and collapse whitespace on BOTH sides so the check is robust to those without
 * being so loose it accepts a non-quote. (It is still a real substring check, not
 * a fuzzy match -- a hallucinated quote with invented words still fails.)
 */
function normForQuoteCheck(s: string): string {
  return s
    .replace(/[‘’‛′]/g, "'") // curly / prime single quotes -> '
    .replace(/[“”″]/g, '"') // curly / prime double quotes -> "
    .replace(/[–—−]/g, '-') // en / em dash / minus -> hyphen
    .replace(/[ \s]+/g, ' ') // any whitespace (incl. nbsp) -> single space
    .trim()
    .toLowerCase();
}

/** True when `quote` actually appears (whitespace/quote-normalized) in `sourceText`. */
export function quoteAppearsInSource(quote: string, sourceText: string): boolean {
  const q = normForQuoteCheck(quote);
  if (!q) return false;
  const src = normForQuoteCheck(sourceText);
  if (!src) return false;
  return src.includes(q);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * gateSignal(signal, ctx): run the ordered gate. Pure; returns a GateResult.
 *
 * Decision logic, after every stage passes:
 *   - effective_confidence = signal.signal_confidence (clamped); when absent,
 *     it is derived from the enum (high=0.85, medium=0.6, low=0.4) so legacy /
 *     stub signals still route.
 *   - publish requires: effective_confidence >= 0.75 AND corroboration >= 2
 *     (for a graded/balanced reading). A single-source graded reading, however
 *     confident the model is, is HELD, not published (one source publishes low
 *     at best -- the founder rule). abstains_governing never publishes a
 *     direction (there is none) but can publish as an informational
 *     "declines to govern" record.
 *   - hold: passed the hard rules but not enough confidence / corroboration.
 *   - review: a soft contradiction the gate cannot auto-resolve (e.g. a 'strong'
 *     band whose quote lacks a maximalism marker is DOWNGRADED to non-strong and
 *     flagged review rather than silently published strong).
 *
 * Any HARD-RULE failure short-circuits to decision='review' (a human should see
 * a malformed signal) or, for clear fabrication (quote not in source), the gate
 * refuses entirely with decision='review' and reason set -- it is never published.
 */
export function gateSignal(
  signal: RawSignal,
  ctx: GateContext,
): GateResult {
  const stages: GateResult['stages'] = [];
  const corroboration = Math.max(0, ctx.corroboratingSourcesCount ?? 1);
  const isGraded = signal.position_kind === 'graded' || (signal.position_kind == null && signal.direction != null);
  const isAction = signal.is_action === true;
  const tier = signal.authenticity_tier;

  const fail = (stage: string, reason: string, detail?: string): GateResult => {
    stages.push({ stage, pass: false, detail: detail ?? reason });
    return {
      decision: 'review',
      publish: false,
      stages,
      reason,
      effective_confidence: deriveConfidence(signal),
      corroboration,
    };
  };

  // ---- HARD RULE A: abstains_governing must have direction === null ----
  if (signal.position_kind === 'abstains_governing') {
    if (signal.direction !== null && signal.direction !== undefined) {
      return fail('hard:abstains_direction', 'abstains_governing_has_direction',
        `abstains_governing must carry direction=null, got ${signal.direction}`);
    }
  }
  stages.push({ stage: 'hard:abstains_direction', pass: true });

  // ---- STAGE 0: prefer deterministic clean text over vision ----
  // A vision-only GRADED reading is not allowed to publish high; it routes to
  // review so a clean-text pass or a human confirms it. (Non-graded vision
  // signals -- e.g. an informational record -- are not blocked here.)
  if (ctx.fromVision && isGraded) {
    stages.push({ stage: '0:source_preference', pass: false, detail: 'vision-only graded reading -> review' });
  } else {
    stages.push({ stage: '0:source_preference', pass: true });
  }
  const visionGradedBlock = ctx.fromVision === true && isGraded;

  // ---- STAGE 1: consensus (applied upstream) ----
  stages.push({
    stage: '1:consensus',
    pass: true,
    detail: ctx.consensusAgreement != null ? `agreement=${ctx.consensusAgreement.toFixed(2)}` : 'applied upstream',
  });

  // ---- STAGE 2: verbatim quote + in-source verification ----
  // A graded tier-1/2 STATEMENT must carry a verbatim quote that exists in the
  // source. An ACTION signal (vote / sponsorship) is grounded by the record, so
  // it is exempt from the statement-quote requirement (the bill text is its
  // grounding); if it DOES carry a quote, the quote is still verified.
  const needsQuote = isGraded && !isAction && (tier === 1 || tier === 2);
  if (needsQuote) {
    if (!signal.quote || signal.quote.trim().length === 0) {
      return fail('2:quote_required', 'graded_tier12_missing_quote',
        `graded tier-${tier} signal requires a verbatim quote`);
    }
    if (!quoteAppearsInSource(signal.quote, ctx.sourceText)) {
      // The single strongest anti-hallucination check: the quote is not in the
      // source bytes, so it was invented. Refuse.
      return fail('2:quote_in_source', 'quote_not_in_source',
        'verbatim quote does not appear in the source text (fabricated)');
    }
    stages.push({ stage: '2:quote_in_source', pass: true });
  } else if (signal.quote && signal.quote.trim().length > 0) {
    // A quote was supplied even though not strictly required (tier-3, action, or
    // non-graded). Still verify it -- a supplied quote that is not in source is a
    // fabrication regardless of whether it was required.
    if (!quoteAppearsInSource(signal.quote, ctx.sourceText)) {
      return fail('2:quote_in_source', 'quote_not_in_source',
        'supplied quote does not appear in the source text (fabricated)');
    }
    stages.push({ stage: '2:quote_in_source', pass: true, detail: 'optional quote verified' });
  } else {
    stages.push({ stage: '2:quote_in_source', pass: true, detail: 'no quote required' });
  }

  // ---- HARD RULE B: 'strong' band requires a maximalism marker in the quote ----
  // If the band claims 'strong' but the quote carries no maximalism marker, the
  // band was asserted without textual support. We DOWNGRADE (do not publish
  // strong) and flag review rather than trust the band.
  let strongDowngraded = false;
  if (signal.intensity_band === 'strong') {
    const q = signal.quote ?? '';
    if (!q || !hasMaximalismMarker(q)) {
      strongDowngraded = true;
      stages.push({
        stage: 'hard:strong_marker',
        pass: false,
        detail: 'strong band lacks a maximalism marker in the quote -> downgrade + review',
      });
    } else {
      stages.push({ stage: 'hard:strong_marker', pass: true });
    }
  } else {
    stages.push({ stage: 'hard:strong_marker', pass: true });
  }

  // ---- STAGE 3: cross-source corroboration (after dedup, caller-supplied) ----
  const corroboratedHigh = corroboration >= MIN_CORROBORATION_FOR_HIGH;
  stages.push({
    stage: '3:corroboration',
    pass: true,
    detail: `${corroboration} distinct deduped source(s); high-publish=${corroboratedHigh}`,
  });

  // ---- STAGE 4: deterministic contact validators ----
  if (ctx.contactValidation) {
    if (!ctx.contactValidation.valid) {
      return fail('4:contact_validation', `contact_invalid:${ctx.contactValidation.reason ?? 'unknown'}`,
        `contact value failed deterministic validation (${ctx.contactValidation.reason ?? 'unknown'})`);
    }
    stages.push({ stage: '4:contact_validation', pass: true });
  } else {
    stages.push({ stage: '4:contact_validation', pass: true, detail: 'not a contact value' });
  }

  // ---- STAGE 5: confidence routing ----
  const effective = deriveConfidence(signal);
  stages.push({
    stage: '5:confidence_routing',
    pass: true,
    detail: `effective_confidence=${effective.toFixed(2)} threshold=${AUTO_PUBLISH_THRESHOLD}`,
  });

  // Decision composition.
  let decision: GateDecision;
  let reason: string | null = null;

  if (visionGradedBlock || strongDowngraded) {
    // Soft contradiction the gate flags for a human; never auto-published.
    decision = 'review';
    reason = strongDowngraded ? 'strong_band_unsupported' : 'vision_only_graded';
  } else if (signal.position_kind === 'abstains_governing') {
    // Abstention: there is no graded value to publish; it is an informational
    // "declines to govern" record. We mark it publish (as informational) so the
    // pipeline can surface "not within this office" with grounding, but it
    // carries no direction by construction.
    decision = 'publish';
    reason = 'abstains_informational';
  } else if (isGraded || signal.position_kind === 'balanced') {
    // A graded / balanced reading needs BOTH confidence and corroboration.
    if (effective >= AUTO_PUBLISH_THRESHOLD && corroboratedHigh) {
      decision = 'publish';
    } else if (effective >= AUTO_PUBLISH_THRESHOLD && !corroboratedHigh) {
      decision = 'hold';
      reason = 'single_source';
    } else {
      decision = 'hold';
      reason = 'below_confidence_threshold';
    }
  } else {
    // No graded reading (e.g. the stub's provenance-only signal). It is not a
    // publishable position; hold it as collected evidence awaiting a real
    // classifier.
    decision = 'hold';
    reason = 'no_graded_reading';
  }

  return {
    decision,
    publish: decision === 'publish',
    stages,
    reason,
    effective_confidence: effective,
    corroboration,
  };
}

/**
 * Derive a numeric 0..1 confidence: prefer signal_confidence; fall back to the
 * coarse enum (high=0.85, medium=0.6, low=0.4) so legacy / stub signals route.
 */
function deriveConfidence(signal: RawSignal): number {
  if (typeof signal.signal_confidence === 'number' && !Number.isNaN(signal.signal_confidence)) {
    return clamp01(signal.signal_confidence);
  }
  switch (signal.confidence) {
    case 'high':
      return 0.85;
    case 'medium':
      return 0.6;
    case 'low':
    default:
      return 0.4;
  }
}
