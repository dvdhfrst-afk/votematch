import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import {
  extractStateRulemaking,
  extractBallotMeasures,
  extractMunicipalMeetings,
  extractStateCampaignFinance,
  extractOfficeholders,
  fetchForExtraction,
  resolveValidationStatus,
  type ContentRiskClass,
  type ExtractionDefenses,
} from '@/lib/extractors';

/**
 * State-level AI extraction pipelines. Generic pattern:
 *   1. Fetch source URL
 *   2. Hash + dedupe against extraction_audit (skip if same hash seen recently)
 *   3. Call Claude extractor
 *   4. For each extracted item: record audit, then upsert the data row with
 *      `verified = (validation_status === 'auto_passed')`
 *
 * Source URLs are configured in `extraction_sources` table (seeded per-state);
 * for now we accept them as event payload so the pipeline is testable without
 * a config table. Add config table in a follow-up migration.
 *
 * ## Per-extractor risk classification (2026-04-23)
 *
 * Each pipeline declares a `ContentRiskClass` so `shouldAutoPublish` uses the
 * right threshold. Rationale matrix:
 *
 *   - state_rulemaking   → low_stakes         (calendar entries; factual dates)
 *   - ballot_measures    → attributed_position (attributes signatures/status to a sponsor)
 *   - municipal_meetings → low_stakes         (calendar entries)
 *   - state_cf           → attributed_position (attributes money to named candidates)
 *   - officeholders      → attributed_position (attributes an office to a named person)
 *
 * No extractor here auto-publishes ethics_or_character content — that risk
 * class is reserved for future "candidate bio" extractors that may touch
 * criminal/ethics content. The ethics keyword defense in the extractor layer
 * catches cases where bio content slips into another extractor's input.
 */

type DefensesCarrier<T> = T & { _defenses: ExtractionDefenses };

function computeStatusForItem(opts: {
  confidence: number;
  riskClass: ContentRiskClass;
  defenses: ExtractionDefenses;
}): { status: 'auto_passed' | 'flagged'; verified: boolean; notes: string | null } {
  const { status, reasons } = resolveValidationStatus({
    confidence: opts.confidence,
    riskClass: opts.riskClass,
    nonceMatched: opts.defenses.nonceMatched,
    groundingOk: opts.defenses.groundingOk,
    ethicsKeywordHit: opts.defenses.ethicsKeywordHit,
  });
  const notes = reasons.length > 0 ? reasons.join(',') : null;
  return { status, verified: status === 'auto_passed', notes };
}

async function insertAuditRow(opts: {
  extractor_name: string;
  source_url: string;
  source_hash: string;
  confidence_score: number;
  raw_response: string;
  validation_status: 'auto_passed' | 'flagged';
  validator_notes: string | null;
}): Promise<string> {
  const supabase = await createServiceClient();
  const { data, error } = await supabase
    .from('extraction_audit')
    .insert({
      extractor_name: opts.extractor_name,
      source_url: opts.source_url,
      source_fetched_at: new Date().toISOString(),
      source_hash: opts.source_hash,
      // Model + prompt_version are populated by `recordAudit` normally; for the
      // inngest path we inline to avoid a second call and still get consistent
      // columns. Values read from env.
      model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-7',
      prompt_version: '2026-04-23-v2-injection-defense',
      confidence_score: opts.confidence_score,
      raw_response: opts.raw_response.slice(0, 50_000),
      validation_status: opts.validation_status,
      validator_notes: opts.validator_notes,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`extraction_audit insert failed: ${error?.message}`);
  }
  return data.id as string;
}

// ---------------------------------------------------------------------------
// State rulemaking
// ---------------------------------------------------------------------------

export const extractStateRulemakingFn = inngest.createFunction(
  {
    id: 'extract-state-rulemaking',
    retries: 2,
    concurrency: [{ limit: 4 }],
    triggers: [{ event: 'retention/extract.state_rulemaking' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { state, url } = event.data as { state: string; url: string };

    const fetched = await step.run('fetch', () => fetchForExtraction(url));
    const extracted: DefensesCarrier<Awaited<ReturnType<typeof extractStateRulemaking>>> =
      await step.run('extract', () => extractStateRulemaking(url, state));

    return await step.run('persist', async () => {
      const supabase = await createServiceClient();
      const riskClass: ContentRiskClass = 'low_stakes';
      let written = 0;
      let flagged = 0;

      for (const item of extracted.items) {
        const { status, verified, notes } = computeStatusForItem({
          confidence: item.confidence,
          riskClass,
          defenses: extracted._defenses,
        });

        const auditId = await insertAuditRow({
          extractor_name: 'state_rulemaking',
          source_url: url,
          source_hash: fetched.hash,
          confidence_score: item.confidence,
          raw_response: JSON.stringify(item),
          validation_status: status,
          validator_notes: notes,
        });

        const { error } = await supabase.from('state_rulemaking_events').upsert(
          {
            state,
            agency: item.agency,
            title: item.title,
            summary: item.summary,
            topic_tags: item.topic_tags,
            comment_start_date: item.comment_start_date,
            comment_end_date: item.comment_end_date,
            source_url: url,
            confidence_score: item.confidence,
            extraction_audit_id: auditId,
            verified,
          },
          { onConflict: 'state,source_url' },
        );
        if (error) {
          flagged += 1;
        } else if (verified) {
          written += 1;
        } else {
          flagged += 1;
        }
      }
      return { state, url, written, flagged, total: extracted.items.length };
    });
  },
);

// ---------------------------------------------------------------------------
// Ballot measures
// ---------------------------------------------------------------------------

export const extractBallotMeasuresFn = inngest.createFunction(
  {
    id: 'extract-ballot-measures',
    retries: 2,
    concurrency: [{ limit: 4 }],
    triggers: [{ event: 'retention/extract.ballot_measures' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { state, url } = event.data as { state: string; url: string };

    const fetched = await step.run('fetch', () => fetchForExtraction(url));
    const extracted: DefensesCarrier<Awaited<ReturnType<typeof extractBallotMeasures>>> =
      await step.run('extract', () => extractBallotMeasures(url, state));

    return await step.run('persist', async () => {
      const supabase = await createServiceClient();
      const riskClass: ContentRiskClass = 'attributed_position';
      let written = 0;
      let flagged = 0;

      for (const item of extracted.items) {
        const { status, verified, notes } = computeStatusForItem({
          confidence: item.confidence,
          riskClass,
          defenses: extracted._defenses,
        });

        const auditId = await insertAuditRow({
          extractor_name: 'ballot_measures',
          source_url: url,
          source_hash: fetched.hash,
          confidence_score: item.confidence,
          raw_response: JSON.stringify(item),
          validation_status: status,
          validator_notes: notes,
        });

        const { error } = await supabase.from('ballot_measures').upsert(
          {
            state,
            jurisdiction: item.jurisdiction,
            title: item.title,
            summary: item.summary,
            topic_tags: item.topic_tags,
            status: item.status,
            filing_date: item.filing_date,
            qualified_date: item.qualified_date,
            election_date: item.election_date,
            signature_requirement: item.signature_requirement,
            signatures_collected: item.signatures_collected,
            source_url: url,
            sponsor_name: item.sponsor_name,
            confidence_score: item.confidence,
            extraction_audit_id: auditId,
            verified,
          },
          { onConflict: 'state,source_url' },
        );
        if (error) {
          flagged += 1;
        } else if (verified) {
          written += 1;
        } else {
          flagged += 1;
        }
      }
      return { state, url, written, flagged, total: extracted.items.length };
    });
  },
);

// ---------------------------------------------------------------------------
// Municipal meetings
// ---------------------------------------------------------------------------

export const extractMunicipalMeetingsFn = inngest.createFunction(
  {
    id: 'extract-municipal-meetings',
    retries: 2,
    concurrency: [{ limit: 4 }],
    triggers: [{ event: 'retention/extract.municipal_meetings' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { state, jurisdiction, url } = event.data as {
      state: string;
      jurisdiction: string;
      url: string;
    };

    const fetched = await step.run('fetch', () => fetchForExtraction(url));
    const extracted: DefensesCarrier<Awaited<ReturnType<typeof extractMunicipalMeetings>>> =
      await step.run('extract', () => extractMunicipalMeetings(url, jurisdiction));

    return await step.run('persist', async () => {
      const supabase = await createServiceClient();
      const riskClass: ContentRiskClass = 'low_stakes';
      let written = 0;
      let flagged = 0;

      for (const item of extracted.items) {
        const { status, verified, notes } = computeStatusForItem({
          confidence: item.confidence,
          riskClass,
          defenses: extracted._defenses,
        });

        const auditId = await insertAuditRow({
          extractor_name: `municipal_${extracted.platform}`,
          source_url: url,
          source_hash: fetched.hash,
          confidence_score: item.confidence,
          raw_response: JSON.stringify(item),
          validation_status: status,
          validator_notes: notes,
        });

        const { error } = await supabase.from('municipal_meetings').upsert(
          {
            state,
            jurisdiction,
            jurisdiction_type: item.jurisdiction_type,
            title: item.title,
            meeting_datetime: item.meeting_datetime,
            agenda_url: item.agenda_url,
            topic_tags: item.topic_tags,
            source_url: url,
            platform: extracted.platform,
            confidence_score: item.confidence,
            extraction_audit_id: auditId,
            verified,
          },
          { onConflict: 'source_url,meeting_datetime' },
        );
        if (error) {
          flagged += 1;
        } else if (verified) {
          written += 1;
        } else {
          flagged += 1;
        }
      }
      return { state, jurisdiction, written, flagged, total: extracted.items.length };
    });
  },
);

// ---------------------------------------------------------------------------
// State campaign finance
// ---------------------------------------------------------------------------

export const extractStateCfFn = inngest.createFunction(
  {
    id: 'extract-state-cf',
    retries: 2,
    concurrency: [{ limit: 4 }],
    triggers: [{ event: 'retention/extract.state_cf' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { state, url } = event.data as { state: string; url: string };

    const fetched = await step.run('fetch', () => fetchForExtraction(url));
    const extracted: DefensesCarrier<Awaited<ReturnType<typeof extractStateCampaignFinance>>> =
      await step.run('extract', () => extractStateCampaignFinance(url, state));

    return await step.run('persist', async () => {
      const supabase = await createServiceClient();
      const riskClass: ContentRiskClass = 'attributed_position';
      let written = 0;

      for (const ev of extracted.events) {
        const { status, verified, notes } = computeStatusForItem({
          confidence: ev.confidence,
          riskClass,
          defenses: extracted._defenses,
        });

        const auditId = await insertAuditRow({
          extractor_name: 'state_cf',
          source_url: url,
          source_hash: fetched.hash,
          confidence_score: ev.confidence,
          raw_response: JSON.stringify(ev),
          validation_status: status,
          validator_notes: notes,
        });

        const { error } = await supabase.from('state_cf_events').insert({
          state,
          candidate_name: ev.candidate_name,
          candidate_office: ev.candidate_office,
          committee_name: ev.committee_name,
          event_type: ev.event_type,
          amount: ev.amount,
          event_date: ev.event_date,
          counterparty: ev.counterparty,
          filing_url: url,
          confidence_score: ev.confidence,
          extraction_audit_id: auditId,
          verified,
        });
        if (!error && verified) written += 1;
      }
      return { state, written, total: extracted.events.length };
    });
  },
);

// ---------------------------------------------------------------------------
// Officeholders (5th B2B stream)
// ---------------------------------------------------------------------------

export const extractOfficeholdersFn = inngest.createFunction(
  {
    id: 'extract-officeholders',
    retries: 2,
    concurrency: [{ limit: 4 }],
    triggers: [{ event: 'retention/extract.officeholders' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { state, url, level, jurisdiction, ocd_division_id } = event.data as {
      state: string;
      url: string;
      level?: string;
      jurisdiction?: string;
      ocd_division_id?: string;
    };

    const fetched = await step.run('fetch', () => fetchForExtraction(url));
    const extracted: DefensesCarrier<Awaited<ReturnType<typeof extractOfficeholders>>> =
      await step.run('extract', () => extractOfficeholders(url, state, level));

    return await step.run('persist', async () => {
      const supabase = await createServiceClient();
      const riskClass: ContentRiskClass = 'attributed_position';
      let written = 0;

      for (const item of extracted.items) {
        const { status, verified, notes } = computeStatusForItem({
          confidence: item.confidence,
          riskClass,
          defenses: extracted._defenses,
        });

        const auditId = await insertAuditRow({
          extractor_name: 'officeholders',
          source_url: url,
          source_hash: fetched.hash,
          confidence_score: item.confidence,
          raw_response: JSON.stringify(item),
          validation_status: status,
          validator_notes: notes,
        });

        const { error } = await supabase.from('officeholders').insert({
          ocd_division_id: ocd_division_id ?? null,
          full_name: item.full_name,
          office_name: item.office_name,
          level: item.level,
          state,
          jurisdiction: jurisdiction ?? item.jurisdiction ?? null,
          party: item.party,
          term_start: item.term_start,
          term_end: item.term_end,
          email: item.email,
          phone: item.phone,
          website_url: item.website_url,
          source_url: url,
          confidence_score: item.confidence,
          extraction_audit_id: auditId,
          verified,
        });
        if (!error && verified) written += 1;
      }
      return { state, written, total: extracted.items.length };
    });
  },
);
