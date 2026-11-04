import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import {
  submitClassificationBatch,
  getClassificationBatch,
  iterateClassificationBatchResults,
  type BatchClassificationRequest,
} from '@/lib/claude';
import type { Candidate, SubDimension, SourceCitation } from '@/types/database';

/**
 * Inngest function: classify every candidate with source data against every
 * active sub_dimension, in a single Claude Batch.
 *
 * Triggered by `pipeline/batch-classify`.
 *
 * Cost controls (added per 15-council/00-initial-review-2026-04-20.md Lens 1
 * risk #4 — batch is a cartesian product w/ no ceiling; accidental re-trigger
 * would cost real money):
 *   - Concurrency sentinel via `pipeline_runs` table — a new run aborts if
 *     another batch-classify is already `running`.
 *   - Pre-flight cost guard — if planned_requests > MAX_BATCH_REQUESTS
 *     (default 2000), reject without submitting and audit the attempt.
 *   - retries: 3 (was 1) — this is a 24h-polling function, and a flake on
 *     the submit/poll side shouldn't blow up the whole run.
 *
 * Steps:
 *   1. Check concurrency sentinel + insert `running` row.
 *   2. Build the request list (candidate × sub_dimension).
 *   3. Pre-flight cost guard.
 *   4. Submit one Claude Batch (50% cost savings, shared cached prefix).
 *   5. Poll every 2 minutes (up to 24h) until the batch ends.
 *   6. Stream results and upsert them as `positions` rows.
 *   7. Mark sentinel `completed` / `failed`.
 *
 * The custom_id format is `<candidate_id>:<sub_dimension_id>`, so each
 * result routes back to the right DB row without a side map.
 *
 * Fan-out via per-candidate `candidate/classify` events is still available
 * (see classify-candidate.ts) for single-candidate backfills or tests.
 */
export const batchClassify = inngest.createFunction(
  {
    id: 'batch-classify',
    // Tightened from 3 -> 2 per council 2026-04-23: retry storms on this
    // 24h-polling function can compound into a real Claude-spend incident.
    // One batch at a time, two retries max.
    retries: 2,
    concurrency: [{ limit: 1 }],
    triggers: [{ event: 'pipeline/batch-classify' }],
  },
  async ({ step, runId }: { step: any; runId: string }) => {
    const MAX_BATCH_REQUESTS = Number(process.env.MAX_BATCH_REQUESTS ?? 2000);
    const FUNCTION_NAME = 'batch-classify';

    // Step 0a: concurrency sentinel — abort if another run is already in flight.
    // We use `runId` as the idempotency key so an Inngest step retry doesn't
    // double-insert (unique index on inngest_run_id).
    await step.run('check-concurrent', async () => {
      const supabase = await createServiceClient();
      const { data: inFlight, error } = await supabase
        .from('pipeline_runs')
        .select('id, started_at, inngest_run_id')
        .eq('function_name', FUNCTION_NAME)
        .eq('status', 'running')
        .neq('inngest_run_id', runId)
        .limit(1);
      if (error) throw new Error(`pipeline_runs lookup: ${error.message}`);

      if (inFlight && inFlight.length > 0) {
        await supabase.from('pipeline_runs').upsert(
          {
            function_name: FUNCTION_NAME,
            status: 'rejected_concurrent',
            inngest_run_id: runId,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            metadata: { blocked_by: inFlight[0] },
          },
          { onConflict: 'inngest_run_id' },
        );
        throw new Error(
          `batch-classify aborted: another run is already in flight (started ${inFlight[0].started_at}). ` +
            `Wait for it to complete, or manually mark stale rows as 'failed' in pipeline_runs.`,
        );
      }
      return { ok: true };
    });

    // Step 0b: insert the sentinel `running` row. Idempotent on inngest_run_id.
    await step.run('mark-running', async () => {
      const supabase = await createServiceClient();
      const { error } = await supabase.from('pipeline_runs').upsert(
        {
          function_name: FUNCTION_NAME,
          status: 'running',
          inngest_run_id: runId,
          started_at: new Date().toISOString(),
        },
        { onConflict: 'inngest_run_id' },
      );
      if (error) throw new Error(`pipeline_runs insert: ${error.message}`);
      return { ok: true };
    });

    try {
      // Step 1: Build the full request list
      //
      // Two-view fan-out (council decision 007 §3, gated by ENABLE_TWO_VIEW
      // per §7): when the flag is ON we emit TWO requests per
      // (candidate, sub_dim) — a stated request and an inferred request —
      // with custom_id format `${candidateId}:${dim.id}:${viewType}`.
      // Skip-stated-when-no-primary optimization: if a candidate has zero
      // tier-1 sources, we skip the stated-view batch request entirely and
      // write a `confidence='no_data'` placeholder row directly (plan §3
      // line 116).
      const twoViewEnabled = process.env.ENABLE_TWO_VIEW === 'true';
      const { requests, subDimensionsById, placeholders } = await step.run(
        'build-requests',
        async () => {
          const supabase = await createServiceClient();

          // Candidates + per-row authenticity_tier so we can split stated/inferred
          const { data: sourceRows, error: srcErr } = await supabase
            .from('candidate_sources')
            .select(
              'candidate_id, source_type, raw_data, url, title, fetched_at, authenticity_tier',
            );

          if (srcErr) throw new Error(`candidate_sources fetch: ${srcErr.message}`);
          if (!sourceRows || sourceRows.length === 0) {
            return {
              requests: [] as BatchClassificationRequest[],
              subDimensionsById: {} as Record<string, SubDimension>,
              placeholders: [] as {
                candidate_id: string;
                sub_dimension_id: string;
              }[],
            };
          }

          type SourceRow = {
            candidate_id: string;
            source_type: string;
            raw_data: string;
            url: string | null;
            title: string | null;
            fetched_at: string;
            authenticity_tier: number;
          };

          // Group: (1) all-tier aggregated text (inferred + legacy),
          //        (2) tier-1-only aggregated text (stated),
          //        (3) tier-1 count per candidate (skip-stated guard).
          const sourcesByCandidate = new Map<string, string>();
          const tier1ByCandidate = new Map<string, string>();
          const tier1CountByCandidate = new Map<string, number>();
          for (const s of sourceRows as SourceRow[]) {
            const tierLabel =
              s.authenticity_tier === 1
                ? 'PRIMARY'
                : s.authenticity_tier === 2
                  ? 'REPORTED'
                  : s.source_type === 'voting_record'
                    ? 'VOTE'
                    : 'SECONDARY';
            const header = `[${tierLabel} — ${s.source_type}${s.title ? ` - ${s.title}` : ''}${s.url ? ` (${s.url})` : ''}]`;
            const existing = sourcesByCandidate.get(s.candidate_id) ?? '';
            sourcesByCandidate.set(
              s.candidate_id,
              existing
                ? `${existing}\n\n---\n\n${header}\n${s.raw_data}`
                : `${header}\n${s.raw_data}`,
            );

            if (s.authenticity_tier === 1) {
              const t1Existing = tier1ByCandidate.get(s.candidate_id) ?? '';
              const t1Header = `[${s.source_type}${s.title ? ` - ${s.title}` : ''}${s.url ? ` (${s.url})` : ''}]`;
              tier1ByCandidate.set(
                s.candidate_id,
                t1Existing
                  ? `${t1Existing}\n\n---\n\n${t1Header}\n${s.raw_data}`
                  : `${t1Header}\n${s.raw_data}`,
              );
              tier1CountByCandidate.set(
                s.candidate_id,
                (tier1CountByCandidate.get(s.candidate_id) ?? 0) + 1,
              );
            }
          }

          // Active sub_dimensions
          const { data: dims, error: dErr } = await supabase
            .from('sub_dimensions')
            .select('*')
            .eq('active', true)
            .order('display_order');

          if (dErr) throw new Error(`sub_dimensions fetch: ${dErr.message}`);

          const subDimsById: Record<string, SubDimension> = {};
          for (const d of dims as SubDimension[]) subDimsById[d.id] = d;

          const requests: BatchClassificationRequest[] = [];
          const placeholders: { candidate_id: string; sub_dimension_id: string }[] = [];

          for (const [candidateId, candidateData] of sourcesByCandidate) {
            const tier1Count = tier1CountByCandidate.get(candidateId) ?? 0;
            const tier1Text = tier1ByCandidate.get(candidateId) ?? '';

            for (const dim of dims as SubDimension[]) {
              if (twoViewEnabled) {
                // Inferred request: always emit — uses the full tier-labeled
                // source blob so the classifier can weight per plan §3.
                requests.push({
                  custom_id: `${candidateId}:${dim.id}:inferred`,
                  candidate_data: candidateData,
                  sub_dimension: dim,
                  view_type: 'inferred',
                });

                // Stated request: skip when tier-1 count is zero — write a
                // no_data placeholder directly instead of spending tokens on
                // a guaranteed-null answer (plan §3 skip optimization).
                if (tier1Count === 0) {
                  placeholders.push({
                    candidate_id: candidateId,
                    sub_dimension_id: dim.id,
                  });
                } else {
                  requests.push({
                    custom_id: `${candidateId}:${dim.id}:stated`,
                    candidate_data: tier1Text,
                    sub_dimension: dim,
                    view_type: 'stated',
                  });
                }
              } else {
                // Flag off: preserve pre-007 single-view behavior. Writes
                // view_type='inferred' (the DB default) in the distribute step.
                requests.push({
                  custom_id: `${candidateId}:${dim.id}`,
                  candidate_data: candidateData,
                  sub_dimension: dim,
                });
              }
            }
          }

          return {
            requests,
            subDimensionsById: subDimsById,
            placeholders,
          };
        },
      );

      if (requests.length === 0) {
        await step.run('mark-completed-empty', async () => {
          const supabase = await createServiceClient();
          await supabase
            .from('pipeline_runs')
            .update({
              status: 'completed',
              request_count: 0,
              finished_at: new Date().toISOString(),
              metadata: { note: 'no candidates with sources' },
            })
            .eq('inngest_run_id', runId);
        });
        return {
          submitted: 0,
          message: 'No candidates with sources to classify.',
        };
      }

      // Step 1.5: pre-flight cost guard. Reject before submit if the planned
      // request count exceeds the ceiling. Default 2000 is sized for Phase A
      // (50-110 candidates × 19 sub_dims ≈ 950-2090) with a small safety
      // margin; Phase B (240 candidates × 19 × potentially 2 views ≈ 9,120)
      // will need an explicit bump via env, which is the point — a human has
      // to acknowledge the spend.
      const plannedRequests = requests.length;
      const modelName = process.env.CLAUDE_MODEL ?? 'claude-opus-4-7';
      console.log(
        `[batch-classify] planned requests: ${plannedRequests} ` +
          `(ceiling: ${MAX_BATCH_REQUESTS}, model: ${modelName})`,
      );

      if (plannedRequests > MAX_BATCH_REQUESTS) {
        await step.run('cost-guard-reject', async () => {
          const supabase = await createServiceClient();
          const { error } = await supabase
            .from('pipeline_runs')
            .update({
              status: 'rejected_cost_guard',
              request_count: plannedRequests,
              finished_at: new Date().toISOString(),
              metadata: {
                ceiling: MAX_BATCH_REQUESTS,
                model: modelName,
                reason:
                  'planned request count exceeded MAX_BATCH_REQUESTS — bump the env var intentionally to proceed',
              },
            })
            .eq('inngest_run_id', runId);
          if (error) throw new Error(`cost-guard audit write: ${error.message}`);
        });
        return {
          submitted: 0,
          rejected: 'cost_guard',
          planned_requests: plannedRequests,
          ceiling: MAX_BATCH_REQUESTS,
          message:
            `Planned ${plannedRequests} requests exceeds MAX_BATCH_REQUESTS=${MAX_BATCH_REQUESTS}. ` +
            `Set a higher ceiling and re-trigger if this is expected.`,
        };
      }

      // Step 2: Submit to Claude Batch API
      const batchId = await step.run('submit-batch', async () =>
        submitClassificationBatch(requests),
      );

      // Step 3: Poll. Each poll is its own step (≤60s); Inngest's step.sleep
      // handles the waits. Up to ~24h max (the Batch API's own limit).
      const MAX_POLLS = 720; // 720 × 2m = 24h
      let finalStatus: Awaited<ReturnType<typeof getClassificationBatch>> | null = null;
      for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
        await step.sleep(`wait-${attempt}`, '2m');
        const status = await step.run(`poll-${attempt}`, async () =>
          getClassificationBatch(batchId),
        );
        if (status.processing_status === 'ended') {
          finalStatus = status;
          break;
        }
      }

      if (!finalStatus) {
        throw new Error(`Batch ${batchId} did not end within 24h`);
      }

      // Step 4: Retrieve results and write positions
      //
      // Per council decision 007 §1 (resolution: append-only, see 20260418000003
      // lines 14-18), we INSERT — no `onConflict` clause. v_latest_positions
      // handles latest-read by (candidate_id, sub_dimension_id, view_type,
      // created_at DESC).
      //
      // custom_id parsing:
      //   - legacy 2-part `${candidateId}:${dim.id}`  -> view_type='inferred'
      //   - two-view 3-part `${candidateId}:${dim.id}:${viewType}` -> view_type=parsed
      const summary = await step.run('distribute-results', async () => {
        const supabase = await createServiceClient();

        let succeeded = 0;
        let errored = 0;
        let skippedNoCitation = 0;
        let placeholdersWritten = 0;

        // Gather citations once, split by tier. Stated-view rows get tier-1
        // citations only; inferred-view rows get all URL-bearing citations.
        const { data: allSources } = await supabase
          .from('candidate_sources')
          .select(
            'candidate_id, source_type, url, title, fetched_at, authenticity_tier',
          );
        const citationsAllByCandidate = new Map<string, SourceCitation[]>();
        const citationsTier1ByCandidate = new Map<string, SourceCitation[]>();
        for (const s of (allSources ?? []) as {
          candidate_id: string;
          source_type: string;
          url: string | null;
          title: string | null;
          fetched_at: string;
          authenticity_tier: number;
        }[]) {
          if (!s.url) continue;
          const citation = {
            url: s.url,
            title: s.title || s.source_type,
            date: s.fetched_at,
          };
          const all = citationsAllByCandidate.get(s.candidate_id) ?? [];
          all.push(citation);
          citationsAllByCandidate.set(s.candidate_id, all);
          if (s.authenticity_tier === 1) {
            const t1 = citationsTier1ByCandidate.get(s.candidate_id) ?? [];
            t1.push(citation);
            citationsTier1ByCandidate.set(s.candidate_id, t1);
          }
        }

        // Write skip-stated placeholders first (plan §3 line 116). These are
        // candidate/sub_dim pairs with zero tier-1 sources under the two-view
        // flag. We attach the candidate's all-tier citations so the DB-side
        // require_citations check passes; the UI-side filter on confidence
        // will keep them from rendering as a score.
        for (const p of placeholders) {
          const citations = citationsAllByCandidate.get(p.candidate_id) ?? [];
          if (citations.length === 0) {
            skippedNoCitation++;
            continue;
          }
          const { error: phErr } = await supabase.from('positions').insert({
            candidate_id: p.candidate_id,
            sub_dimension_id: p.sub_dimension_id,
            view_type: 'stated',
            score: 0.5,
            confidence: 'low',
            nuance_notes:
              'No primary-source material found. The candidate has not stated a position on this issue in their official materials.',
            source_citations: citations,
          });
          if (phErr) {
            errored++;
          } else {
            placeholdersWritten++;
          }
        }

        for await (const result of iterateClassificationBatchResults(batchId)) {
          const parts = result.custom_id.split(':');
          // Legacy 2-part (flag off) or new 3-part (flag on with view_type)
          const candidateId = parts[0];
          const subDimensionId = parts[1];
          const parsedViewType = parts[2];
          if (!candidateId || !subDimensionId) {
            console.error('bad custom_id:', result.custom_id);
            errored++;
            continue;
          }
          const viewType: 'stated' | 'inferred' =
            parsedViewType === 'stated'
              ? 'stated'
              : parsedViewType === 'inferred'
                ? 'inferred'
                : 'inferred'; // default when 2-part legacy id

          if (result.status !== 'succeeded') {
            console.error(
              `classification ${result.custom_id} ${result.status}:`,
              result.error,
            );
            errored++;
            continue;
          }

          // blueprint-v6 §7: never impute. A position without a source citation
          // is not stored — absence is the correct UI state ("Candidate has not
          // stated a public position"), not a confabulated score.
          //
          // Stated rows cite tier-1 only; inferred rows cite all URL-bearing
          // sources.
          const citations =
            viewType === 'stated'
              ? (citationsTier1ByCandidate.get(candidateId) ??
                citationsAllByCandidate.get(candidateId) ??
                [])
              : (citationsAllByCandidate.get(candidateId) ?? []);
          if (citations.length === 0) {
            console.warn(
              `skipping position ${result.custom_id}: no source citations available`,
            );
            skippedNoCitation++;
            continue;
          }

          // Stated-view classifier may return score=null / confidence='no_data'
          // (plan §3). Normalize to the DB's {0..1, low|medium|high} shape;
          // the nuance carries the explanation.
          const rawScore = result.classification.score;
          const rawConfidence = result.classification.confidence;
          const dbScore = rawScore === null ? 0.5 : rawScore;
          const dbConfidence =
            rawConfidence === 'no_data' || rawScore === null
              ? ('low' as const)
              : rawConfidence;

          const { error } = await supabase.from('positions').insert({
            candidate_id: candidateId,
            sub_dimension_id: subDimensionId,
            view_type: viewType,
            score: dbScore,
            confidence: dbConfidence,
            nuance_notes: result.classification.nuance,
            source_citations: citations,
          });

          if (error) {
            console.error('position insert failed:', error.message);
            errored++;
            continue;
          }
          succeeded++;
        }

        return {
          succeeded,
          errored,
          skipped_no_citation: skippedNoCitation,
          placeholders_written: placeholdersWritten,
        };
      });

      // Fire-and-forget: summaries can now be generated for new positions.
      await step.sendEvent('kickoff-summaries', {
        name: 'pipeline/generate-summaries',
        data: {},
      });

      // Step 5: mark the sentinel completed.
      await step.run('mark-completed', async () => {
        const supabase = await createServiceClient();
        await supabase
          .from('pipeline_runs')
          .update({
            status: 'completed',
            request_count: plannedRequests,
            finished_at: new Date().toISOString(),
            metadata: {
              batch_id: batchId,
              model: modelName,
              succeeded: summary.succeeded,
              errored: summary.errored,
              skipped_no_citation: summary.skipped_no_citation,
              placeholders_written: summary.placeholders_written,
              two_view: twoViewEnabled,
            },
          })
          .eq('inngest_run_id', runId);
      });

      return {
        batch_id: batchId,
        two_view: twoViewEnabled,
        requests_submitted: requests.length,
        stated_placeholders_written: summary.placeholders_written,
        classifications_stored: summary.succeeded,
        classifications_failed: summary.errored,
        classifications_skipped_no_citation: summary.skipped_no_citation,
        sub_dimensions_in_scope: Object.keys(subDimensionsById).length,
      };
    } catch (err) {
      // Mark the sentinel failed so the next trigger isn't blocked by a stale
      // `running` row. Inngest's retry policy (retries: 3) will still re-enter
      // this function if applicable — the concurrency sentinel uses runId so
      // the retry re-acquires the same row.
      await step.run('mark-failed', async () => {
        const supabase = await createServiceClient();
        await supabase
          .from('pipeline_runs')
          .update({
            status: 'failed',
            finished_at: new Date().toISOString(),
            metadata: { error: err instanceof Error ? err.message : String(err) },
          })
          .eq('inngest_run_id', runId);
      });
      throw err;
    }
  },
);
