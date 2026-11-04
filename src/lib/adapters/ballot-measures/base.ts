/**
 * Factory + shared row type for per-state ballot-measure adapters.
 *
 * Every initiative-heavy state (14 catalogued in `./<abbr>/measures.ts`)
 * plugs into this factory with just a `stateFips`, `sourceUrl`, and an
 * optional state-specific parser hint. The factory:
 *
 *   1. Calls `extractBallotMeasures()` from `src/lib/extractors/index.ts`
 *      against the given URL. That extractor handles fetch, prompt-injection
 *      defenses (nonce echo, grounding check, ethics keyword scan,
 *      content-type whitelist), and JSON-schema-validated output.
 *   2. For each extracted measure, resolves a validation_status via the
 *      shared `resolveValidationStatus()` using
 *      `riskClass='attributed_position'` — ballot-measure text attributes
 *      legally-consequential claims (signature totals, sponsor identity) to
 *      named actors, so the bar is 0.85 confidence + all defenses green.
 *   3. Writes one audit row per measure and upserts `ballot_measures`.
 *      Rows where validation_status is 'flagged' land with `verified=false`
 *      (the public-read RLS policy blocks unverified rows).
 *
 * Test hooks (see `__tests__/base.test.ts`):
 *   - `extractImpl` lets tests inject a fake extractor returning synthetic
 *     measures without a live Claude call.
 *   - `recordAuditImpl` lets tests pre-canned audit IDs.
 *
 * See also:
 *   - `src/lib/extractors/index.ts`            (extractor + defense envelope)
 *   - `src/lib/adapters/run.ts`                (lifecycle + advisory lock)
 *   - `src/lib/inngest/functions/extract-state-data.ts`
 *       (existing call site — same write semantics, different trigger)
 */

import { createHash } from 'node:crypto';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../types';
import { createTokenBucket } from '../rate-limit';
import {
  extractBallotMeasures,
  recordAudit,
  resolveValidationStatus,
  type BallotMeasureExtraction,
  type ContentRiskClass,
  type ExtractionDefenses,
} from '@/lib/extractors';
import { LlmRouterCapExceededError, isTransientCapError } from '@/lib/llm-router';

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

/**
 * One measure returned by `adapter.run()` — still unwritten, carries its
 * confidence + defense status so the insert step can assign verified flag
 * and audit id without re-running the extractor.
 */
export type BallotMeasureRow = {
  state_fips: string;
  /** Full state-assigned measure text (title). */
  title: string;
  summary: string | null;
  status:
    | 'proposed'
    | 'circulating'
    | 'qualified'
    | 'on_ballot'
    | 'passed'
    | 'failed'
    | 'withdrawn';
  filing_date: string | null;
  qualified_date: string | null;
  election_date: string | null;
  signature_requirement: number | null;
  signatures_collected: number | null;
  sponsor_name: string | null;
  topic_tags: string[];
  jurisdiction: string | null;
  source_url: string;
  /** Raw confidence from the extractor (0..1). */
  confidence: number;
  /** 'auto_passed' when everything green + confidence >= threshold; else 'flagged'. */
  validation_status: 'auto_passed' | 'flagged';
  /** Comma-joined list of defense-failure reasons, or null when all green. */
  validator_notes: string | null;
  /** Raw JSON payload for the audit row (pre-stringified). */
  raw_response: string;
};

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export type CreateBallotMeasuresAdapterOptions = {
  /** Two-character state FIPS (e.g. '06' for California). */
  stateFips: string;
  /** Human-readable state postal code for logging + extractor prompt. */
  stateAbbr: string;
  /** SoS / leg-council page or PDF URL. */
  sourceUrl: string;
  /** Optional free-form hint forwarded to per-state parser (currently logged only). */
  parseHint?: string;
  /** Elections this run targets (YYYY-MM-DD or just YYYY). Stashed in data_source meta. */
  electionDate?: string;
  /**
   * Test hook: replace the live `extractBallotMeasures` with a stub. The
   * stub must honor the same signature: `(url, state) => Promise<...>`.
   */
  extractImpl?: typeof extractBallotMeasures;
  /**
   * Test hook: replace `recordAudit` with a stub returning a canned id.
   */
  recordAuditImpl?: typeof recordAudit;
  /**
   * Test hook: replace the `fetch`-for-hash step. When extractImpl is
   * injected we never call the real fetcher, but we still want a stable
   * content hash for the data_sources row. Defaults to hashing the URL
   * string + election year.
   */
  contentHash?: string;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a SourceAdapter that runs one state's ballot-measure extraction.
 *
 * @example
 *   const co = createBallotMeasuresAdapter({
 *     stateFips: '08',
 *     stateAbbr: 'CO',
 *     sourceUrl: 'https://content.leg.colorado.gov/publications/blue-book-2024/',
 *     electionDate: '2026-11-03',
 *   });
 *   await runAdapter(co);
 */
export function createBallotMeasuresAdapter(
  options: CreateBallotMeasuresAdapterOptions,
): SourceAdapter<BallotMeasureRow> {
  const extractImpl = options.extractImpl ?? extractBallotMeasures;
  const recordAuditImpl = options.recordAuditImpl ?? recordAudit;
  const riskClass: ContentRiskClass = 'attributed_position';

  // Polite-scraper profile — ballot-measure PDFs are large; fetch infrequently.
  const bucket = createTokenBucket({ rps: 0.25, burst: 1 });

  const adapter: SourceAdapter<BallotMeasureRow> = {
    name: `ballot-measures-${options.stateAbbr.toLowerCase()}`,
    stateFips: options.stateFips,
    tokenBucket: { rps: 0.25, burst: 1 },
    // Routing: extractBallotMeasures() goes through the LLM router with
    // riskClass='attributed_position', which means ollama (phi4:14b, free)
    // takes the first pass and Claude only fires as a verifier when ollama
    // fails schema/nonce/grounding checks. The runner-level cost reservation
    // therefore points at the ollama service ($0/call); the router itself
    // calls cost_cap_check_and_consume('claude_api', est) when the Claude
    // fallback path actually runs. Previously this was ('claude_api', $0.50)
    // which double-reserved against Claude's daily cap and rejected every run
    // once the cap zeroed out at midnight (the cost_caps row does not auto-
    // roll, so a missing row defaults to $0/day cap).
    costService: 'interpretation-llm-ollama',
    estimatedCostUsd: 0,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<BallotMeasureRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: extracting`, {
        url: options.sourceUrl,
        state: options.stateAbbr,
        parseHint: options.parseHint ?? null,
      });

      let extracted: BallotMeasureExtraction & { _defenses: ExtractionDefenses };
      try {
        extracted = await extractImpl(options.sourceUrl, options.stateAbbr);
      } catch (err) {
        // Graceful degradation when the LLM is unavailable (e.g. the operator's $0
        // Claude budget + ollama failed/parse-failed). Don't throw — return a
        // zero-row outcome with parserSignal='parse_failed' so runAdapter
        // classifies the run as 'unproductive' instead of 'failed'. This
        // keeps the source row at interpretation_status=0 for the next
        // cycle and avoids alert spam from a cap that's pinned at $0 by
        // policy. See feedback_no_claude_api_use_plan.md.
        if (err instanceof LlmRouterCapExceededError || isTransientCapError(err)) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(`${adapter.name}: LLM unavailable (cap), marking unproductive`, {
            error: msg,
            kind: err instanceof LlmRouterCapExceededError ? err.kind : 'transient',
          });
          const synthHash = createHash('sha256')
            .update(
              JSON.stringify({
                url: options.sourceUrl,
                electionDate: options.electionDate ?? null,
                cap_unavailable: true,
                kind: err instanceof LlmRouterCapExceededError ? err.kind : 'transient',
              }),
            )
            .digest('hex');
          return {
            rows: [],
            // Zero is legitimate when the LLM was never reached — the next
            // cycle will retry. Don't trigger the partial-floor alarm.
            expectedMinRows: 0,
            // Tells runAdapter to classify as 'unproductive' (not 'failed'
            // and not 'success'+0). Surfaces in error_summary as
            // "parser_signal=parse_failed returned 0 rows".
            parserSignal: 'parse_failed',
            source: {
              sourceType: 'state_ballot_measures',
              name: `${options.stateAbbr} statewide ballot measures (LLM unavailable)`,
              url: options.sourceUrl,
              contentHash: synthHash,
              license: 'state_open_records',
              stateFips: options.stateFips,
              meta: {
                state_abbr: options.stateAbbr,
                election_date: options.electionDate ?? null,
                parse_hint: options.parseHint ?? null,
                llm_unavailable: true,
                llm_unavailable_kind:
                  err instanceof LlmRouterCapExceededError ? err.kind : 'transient',
                llm_unavailable_reason: msg.slice(0, 500),
              },
            },
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.error(`${adapter.name}: extractor threw`, { error: msg });
        throw err;
      }

      ctx.logger.info(`${adapter.name}: extracted`, {
        items: extracted.items.length,
        found: extracted.found,
        defenses: extracted._defenses,
      });

      const rows: BallotMeasureRow[] = extracted.items.map((item) => {
        const { status, reasons } = resolveValidationStatus({
          confidence: item.confidence,
          riskClass,
          nonceMatched: extracted._defenses.nonceMatched,
          groundingOk: extracted._defenses.groundingOk,
          ethicsKeywordHit: extracted._defenses.ethicsKeywordHit,
        });
        return {
          state_fips: options.stateFips,
          title: item.title,
          summary: item.summary,
          status: item.status,
          filing_date: item.filing_date,
          qualified_date: item.qualified_date,
          election_date: item.election_date,
          signature_requirement: item.signature_requirement,
          signatures_collected: item.signatures_collected,
          sponsor_name: item.sponsor_name,
          topic_tags: item.topic_tags,
          jurisdiction: item.jurisdiction,
          source_url: options.sourceUrl,
          confidence: item.confidence,
          validation_status: status,
          validator_notes: reasons.length > 0 ? reasons.join(',') : null,
          raw_response: JSON.stringify(item),
        };
      });

      // A deterministic fingerprint for the data_sources row — swap in a real
      // body hash once the extractor surfaces it on the return envelope.
      const contentHash =
        options.contentHash ??
        createHash('sha256')
          .update(
            JSON.stringify({
              url: options.sourceUrl,
              electionDate: options.electionDate ?? null,
              itemCount: extracted.items.length,
              defenses: extracted._defenses,
              titles: extracted.items.map((i) => i.title),
            }),
          )
          .digest('hex');

      // Count rows that will actually publish (validation_status='auto_passed')
      // vs rows that will land flagged-for-review (verified=false). The runner's
      // floor check uses rowsInserted+rowsUpdated, NOT rowsSkipped — so when
      // every extracted item is flagged (low ollama confidence under the 0.85
      // attributed_position threshold, or an ethics-keyword false-positive
      // tripping on boilerplate nav like "Felony Convictions and Voting Rights"),
      // the run looks 'partial' even though we successfully processed the
      // source. Set expectedMinRows based on auto-publishable rows so the floor
      // matches what the runner actually counts; emit parserSignal='table_empty'
      // when the extractor found candidate items but none are auto-publishable
      // — this is a legitimate "page processed, nothing publishable" signal,
      // not a parser failure. The flagged rows still upsert to ballot_measures
      // with verified=false for the /corrections review queue.
      const autoPassedCount = rows.filter(
        (r) => r.validation_status === 'auto_passed',
      ).length;
      const flaggedCount = rows.length - autoPassedCount;
      const parserSignal: 'ok' | 'table_empty' =
        extracted.found && autoPassedCount === 0 && flaggedCount > 0
          ? 'table_empty'
          : 'ok';

      return {
        rows,
        // Floor reflects auto-publishable rows. Off-cycle states (no items
        // returned) AND review-queue states (items returned but all flagged)
        // both legitimately produce 0 inserts; the runner shouldn't fire a
        // 'partial' alert for either case.
        expectedMinRows: autoPassedCount > 0 ? 1 : 0,
        parserSignal,
        source: {
          sourceType: 'state_ballot_measures',
          name: `${options.stateAbbr} statewide ballot measures`,
          url: options.sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: options.stateFips,
          meta: {
            state_abbr: options.stateAbbr,
            election_date: options.electionDate ?? null,
            parse_hint: options.parseHint ?? null,
            item_count: extracted.items.length,
            auto_passed_count: autoPassedCount,
            flagged_count: flaggedCount,
            nonce_matched: extracted._defenses.nonceMatched,
            grounding_ok: extracted._defenses.groundingOk,
            ethics_keyword_hit: extracted._defenses.ethicsKeywordHit,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.title || row.title.trim().length === 0) {
        return 'missing title';
      }
      if (row.confidence < 0 || row.confidence > 1) {
        return `confidence out of [0,1]: ${row.confidence}`;
      }
      if (
        row.signature_requirement !== null &&
        row.signature_requirement < 0
      ) {
        return `negative signature_requirement: ${row.signature_requirement}`;
      }
      if (
        row.signatures_collected !== null &&
        row.signatures_collected < 0
      ) {
        return `negative signatures_collected: ${row.signatures_collected}`;
      }
      return null;
    },

    async insert(
      rows: BallotMeasureRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      const stats: InsertStats = {
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        errors: [],
      };
      if (rows.length === 0) return stats;

      for (const row of rows) {
        let auditId: string | null = null;
        try {
          auditId = await recordAuditImpl({
            extractor_name: 'ballot_measures',
            source_url: row.source_url,
            // The extractor no longer surfaces the body hash on the return
            // envelope; the data_sources.content_hash captures provenance at
            // the adapter layer. Use the per-row stable hash so duplicate
            // extractions of the same title dedupe in the audit table.
            source_hash: createHash('sha256')
              .update(row.raw_response)
              .digest('hex'),
            confidence_score: row.confidence,
            raw_response: row.raw_response,
            validation_status: row.validation_status,
            validator_notes: row.validator_notes ?? undefined,
          });
        } catch (err) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: `audit insert failed: ${err instanceof Error ? err.message : String(err)}`,
            rawInput: row,
          });
          continue;
        }

        const { error } = await ctx.supabase.from('ballot_measures').upsert(
          {
            state: options.stateAbbr,
            jurisdiction: row.jurisdiction,
            title: row.title,
            summary: row.summary,
            topic_tags: row.topic_tags,
            status: row.status,
            filing_date: row.filing_date,
            qualified_date: row.qualified_date,
            election_date: row.election_date,
            signature_requirement: row.signature_requirement,
            signatures_collected: row.signatures_collected,
            source_url: row.source_url,
            sponsor_name: row.sponsor_name,
            confidence_score: row.confidence,
            extraction_audit_id: auditId,
            verified: row.validation_status === 'auto_passed',
          },
          { onConflict: 'state,source_url' },
        );

        if (error) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: `ballot_measures upsert failed: ${error.message}`,
            rawInput: row,
          });
          continue;
        }

        if (row.validation_status === 'flagged') {
          // Still written (for the review queue) but not counted as a
          // publishable row. Surfaces skip in the runner's status counts.
          stats.rowsSkipped += 1;
          ctx.logger.info(`${adapter.name}: row flagged`, {
            title: row.title,
            reasons: row.validator_notes,
          });
        } else {
          stats.rowsInserted += 1;
        }
      }

      // Touch refs so eslint/tsc is happy in test builds that don't
      // reference dataSourceId here (it's captured via the upsert row
      // meta in the extract-state-data inngest path).
      void refs;

      return stats;
    },
  };

  return adapter;
}
