import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { classifyPosition, generatePositionSummary } from '@/lib/claude';
import type { Candidate, SubDimension, SourceCitation } from '@/types/database';

/**
 * Inngest function: classify a candidate's positions from raw source data.
 * Triggered by "candidate/classify" event.
 *
 * Steps:
 * 1. Fetch all raw source data for the candidate
 * 2. Classify positions on each sub-dimension via Claude
 * 3. Upsert positions into the positions table
 * 4. Generate AI summaries for each position
 * 5. Store summaries in the positions table
 */
export const classifyCandidate = inngest.createFunction(
  {
    id: 'classify-candidate',
    retries: 2,
    // LLM cost risk: cap tight so per-candidate retries don't fan out into a
    // token burn (council 2026-04-23).
    concurrency: [{ limit: 2 }],
    triggers: [{ event: 'candidate/classify' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { candidate_id } = event.data as { candidate_id: string };

    // Step 1: Fetch candidate info and all raw source data
    const { candidate, sources, subDimensions } = await step.run(
      'fetch-sources',
      async () => {
        const supabase = await createServiceClient();

        const { data: candidateData, error: cErr } = await supabase
          .from('candidates')
          .select('*')
          .eq('id', candidate_id)
          .single();

        if (cErr || !candidateData) {
          throw new Error(
            `Candidate ${candidate_id} not found: ${cErr?.message}`
          );
        }

        const { data: sourceData, error: sErr } = await supabase
          .from('candidate_sources')
          .select('*')
          .eq('candidate_id', candidate_id);

        if (sErr) {
          throw new Error(`Failed to fetch sources: ${sErr.message}`);
        }

        const { data: dims, error: dErr } = await supabase
          .from('sub_dimensions')
          .select('*')
          .order('display_order');

        if (dErr) {
          throw new Error(`Failed to fetch sub-dimensions: ${dErr.message}`);
        }

        return {
          candidate: candidateData as Candidate,
          sources: sourceData as {
            id: string;
            source_type: string;
            raw_data: string;
            url: string | null;
            title: string | null;
            fetched_at: string;
          }[],
          subDimensions: dims as SubDimension[],
        };
      }
    );

    // Step 2: Classify positions on each sub-dimension
    const classifications = await step.run('classify-positions', async () => {
      // Combine all source data into a single text block
      const combinedData = sources
        .map((s: any) => {
          const header = `[Source: ${s.source_type}${s.title ? ` - ${s.title}` : ''}${s.url ? ` (${s.url})` : ''}]`;
          return `${header}\n${s.raw_data}`;
        })
        .join('\n\n---\n\n');

      if (!combinedData.trim()) {
        throw new Error(
          `No source data available for candidate ${candidate_id}`
        );
      }

      const results: {
        sub_dimension_id: string;
        score: number;
        confidence: 'high' | 'medium' | 'low';
        nuance: string;
        source_citations: SourceCitation[];
      }[] = [];

      for (const dim of subDimensions) {
        const classification = await classifyPosition(combinedData, dim);

        // The single-view classifier prompt (classifyUserPrompt) never returns
        // null / 'no_data' — those are stated-view-only shapes introduced by
        // council decision 007 §3. Narrow defensively here so this function
        // keeps its single-view contract.
        if (classification.score === null || classification.confidence === 'no_data') {
          continue;
        }

        // Build source citations from available sources
        const citations: SourceCitation[] = sources
          .filter((s: any) => s.url)
          .map((s: any) => ({
            url: s.url!,
            title: s.title || s.source_type,
            date: s.fetched_at,
          }));

        results.push({
          sub_dimension_id: dim.id,
          score: classification.score,
          confidence: classification.confidence,
          nuance: classification.nuance,
          source_citations: citations,
        });
      }

      return results;
    });

    // Step 3: Upsert positions into the positions table
    const positionIds = await step.run('store-positions', async () => {
      const supabase = await createServiceClient();

      const upsertedIds: string[] = [];

      for (const classification of classifications) {
        // blueprint-v6 §7: never impute. Skip positions that don't have at
        // least one source citation — absence is the correct UI state.
        if (
          !classification.source_citations ||
          classification.source_citations.length === 0
        ) {
          continue;
        }

        const { data, error } = await supabase
          .from('positions')
          .upsert(
            {
              candidate_id,
              sub_dimension_id: classification.sub_dimension_id,
              score: classification.score,
              confidence: classification.confidence,
              source_citations: classification.source_citations,
              nuance_notes: classification.nuance,
            },
            {
              onConflict: 'candidate_id,sub_dimension_id',
            }
          )
          .select('id')
          .single();

        if (error) {
          throw new Error(
            `Failed to upsert position for sub_dimension ${classification.sub_dimension_id}: ${error.message}`
          );
        }

        upsertedIds.push(data.id);
      }

      return upsertedIds;
    });

    // Step 4: Generate AI summaries for each position
    const summaries = await step.run('generate-summaries', async () => {
      const results: { position_id: string; summary: string }[] = [];

      for (let i = 0; i < classifications.length; i++) {
        const classification = classifications[i];
        const dim = subDimensions.find(
          (d: SubDimension) => d.id === classification.sub_dimension_id
        );

        if (!dim) continue;

        const summary = await generatePositionSummary(
          candidate.name,
          dim.name,
          classification.score,
          dim.spectrum_low,
          dim.spectrum_high
        );

        results.push({
          position_id: positionIds[i],
          summary,
        });
      }

      return results;
    });

    // Step 5: Store AI summaries in positions table
    await step.run('update-summaries', async () => {
      const supabase = await createServiceClient();

      for (const { position_id, summary } of summaries) {
        const { error } = await supabase
          .from('positions')
          .update({ ai_summary: summary })
          .eq('id', position_id);

        if (error) {
          throw new Error(
            `Failed to update summary for position ${position_id}: ${error.message}`
          );
        }
      }
    });

    return {
      candidate_id,
      positions_classified: classifications.length,
      summaries_generated: summaries.length,
    };
  }
);
