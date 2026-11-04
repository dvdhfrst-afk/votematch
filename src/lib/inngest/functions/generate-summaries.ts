import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { generatePositionSummary } from '@/lib/claude';
import type { Position, SubDimension, Candidate } from '@/types/database';

/**
 * Inngest function: batch generate position summaries for match explanations.
 * Triggered by "pipeline/generate-summaries" event.
 *
 * Steps:
 * 1. Fetch all positions that lack an ai_summary
 * 2. Call Claude for each position to generate a summary
 * 3. Update positions with the generated summaries
 */
export const generateSummaries = inngest.createFunction(
  {
    id: 'generate-summaries',
    retries: 2,
    // LLM cost risk: cap at 2 parallel runs (council 2026-04-23).
    concurrency: [{ limit: 2 }],
    triggers: [{ event: 'pipeline/generate-summaries' }],
  },
  async ({ step }: { step: any }) => {
    // Step 1: Fetch all positions without ai_summary
    const positionsToSummarize = await step.run(
      'get-positions',
      async () => {
        const supabase = await createServiceClient();

        const { data: positions, error: pErr } = await supabase
          .from('positions')
          .select('*')
          .is('ai_summary', null);

        if (pErr) {
          throw new Error(`Failed to fetch positions: ${pErr.message}`);
        }

        if (!positions || positions.length === 0) {
          return [];
        }

        // Get all candidate IDs and sub_dimension IDs we need
        const candidateIds = [
          ...new Set(positions.map((p: Position) => p.candidate_id)),
        ];
        const subDimIds = [
          ...new Set(positions.map((p: Position) => p.sub_dimension_id)),
        ];

        // Fetch candidate names
        const { data: candidates, error: cErr } = await supabase
          .from('candidates')
          .select('id, name')
          .in('id', candidateIds);

        if (cErr) {
          throw new Error(`Failed to fetch candidates: ${cErr.message}`);
        }

        // Fetch sub-dimension details
        const { data: subDims, error: dErr } = await supabase
          .from('sub_dimensions')
          .select('*')
          .in('id', subDimIds);

        if (dErr) {
          throw new Error(`Failed to fetch sub-dimensions: ${dErr.message}`);
        }

        const candidateMap = new Map(
          (candidates as Pick<Candidate, 'id' | 'name'>[]).map((c) => [
            c.id,
            c.name,
          ])
        );
        const dimMap = new Map(
          (subDims as SubDimension[]).map((d) => [d.id, d])
        );

        return (positions as Position[]).map((p) => ({
          position_id: p.id,
          candidate_name: candidateMap.get(p.candidate_id) || 'Unknown',
          sub_dimension: dimMap.get(p.sub_dimension_id) || null,
          score: p.score,
        }));
      }
    );

    if (positionsToSummarize.length === 0) {
      return {
        summaries_generated: 0,
        message: 'All positions already have summaries',
      };
    }

    // Step 2: Generate summaries via Claude
    const summaries = await step.run('generate-batch', async () => {
      const results: { position_id: string; summary: string }[] = [];

      for (const pos of positionsToSummarize) {
        if (!pos.sub_dimension) continue;

        const summary = await generatePositionSummary(
          pos.candidate_name,
          pos.sub_dimension.name,
          pos.score,
          pos.sub_dimension.spectrum_low,
          pos.sub_dimension.spectrum_high
        );

        results.push({
          position_id: pos.position_id,
          summary,
        });
      }

      return results;
    });

    // Step 3: Store summaries
    await step.run('store-summaries', async () => {
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
      summaries_generated: summaries.length,
      position_ids: summaries.map((s: { position_id: string; summary: string }) => s.position_id),
    };
  }
);
