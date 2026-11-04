import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { iterOpenProposedRules, isRegulationsApiConfigured } from '@/lib/federal/regulations';

/**
 * Daily Regulations.gov ingestion. Federal public-comment windows.
 *
 * Topic-tagging: we assign broad buckets (environment, health, etc.) via
 * keyword heuristics on the title. A future improvement is to classify with
 * Claude Batch, but the title-heuristic floor gives the digest something to
 * work with in v1.
 */

const TOPIC_KEYWORDS: Record<string, string[]> = {
  environment: ['environment', 'climate', 'emission', 'pollut', 'waste', 'wildlife', 'EPA'],
  health: ['health', 'medicaid', 'medicare', 'drug', 'FDA', 'hospital', 'physician'],
  education: ['education', 'student', 'school', 'college', 'university', 'title IX'],
  taxes: ['tax', 'IRS', 'revenue'],
  labor: ['labor', 'employment', 'OSHA', 'wage', 'workplace', 'union'],
  transportation: ['transport', 'aviation', 'FAA', 'highway', 'rail', 'vehicle', 'DOT'],
  civil_rights: ['civil rights', 'discrimination', 'voting rights', 'ADA'],
  public_safety: ['firearm', 'gun', 'crime', 'police', 'border', 'immigration', 'ICE'],
  housing: ['housing', 'HUD', 'mortgage', 'rent', 'fair housing'],
  agriculture: ['agriculture', 'USDA', 'farm', 'crop', 'livestock'],
  energy: ['energy', 'oil', 'gas', 'nuclear', 'solar', 'wind', 'DOE'],
};

function tagByTitle(title: string): string[] {
  const lower = title.toLowerCase();
  const tags: string[] = [];
  for (const [tag, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k.toLowerCase()))) tags.push(tag);
  }
  return tags;
}

export const ingestRegulations = inngest.createFunction(
  {
    id: 'ingest-regulations-daily',
    retries: 2,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: '30 8 * * *' }, // 08:30 UTC daily — staggered after Congress.gov
      { event: 'retention/ingest.regulations' },
    ],
  },
  async ({ step }: { step: any }) => {
    if (!isRegulationsApiConfigured()) {
      return {
        skipped: true,
        reason: 'REGULATIONS_API_KEY not set — sign up at https://api.data.gov/signup/',
      };
    }
    return await step.run('ingest-open-proposed-rules', async () => {
      const supabase = await createServiceClient();
      let upserted = 0;

      // Only pull rules posted in the last 7 days — older open rules were
      // already captured on a previous run.
      const sinceDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      for await (const doc of iterOpenProposedRules({ sinceDate, maxPages: 10 })) {
        const { error } = await supabase.from('federal_comment_windows').upsert(
          {
            document_id: doc.id,
            agency_id: doc.attributes.agencyId ?? null,
            agency_name: doc.attributes.agencyId ?? null,
            title: doc.attributes.title,
            docket_id: doc.attributes.docketId ?? null,
            comment_start_date: doc.attributes.commentStartDate?.slice(0, 10) ?? null,
            comment_end_date: doc.attributes.commentEndDate?.slice(0, 10) ?? null,
            topic_tags: tagByTitle(doc.attributes.title),
            summary: null,
            url: `https://www.regulations.gov/document/${doc.id}`,
          },
          { onConflict: 'document_id' },
        );
        if (!error) upserted += 1;
      }

      return { upserted };
    });
  },
);
