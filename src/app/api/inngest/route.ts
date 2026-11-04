import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { classifyCandidate } from '@/lib/inngest/functions/classify-candidate';
import { scrapeCandidate } from '@/lib/inngest/functions/scrape-candidate';
import { batchClassify } from '@/lib/inngest/functions/batch-classify';
import { generateSummaries } from '@/lib/inngest/functions/generate-summaries';
import { ingestCongress } from '@/lib/inngest/functions/ingest-congress';
import { ingestRegulations } from '@/lib/inngest/functions/ingest-regulations';
import { ingestFec } from '@/lib/inngest/functions/ingest-fec';
import {
  extractStateRulemakingFn,
  extractBallotMeasuresFn,
  extractMunicipalMeetingsFn,
  extractStateCfFn,
  extractOfficeholdersFn,
} from '@/lib/inngest/functions/extract-state-data';
import { sendDigestFn, sendDigestOneFn, sendElectionReminderFn } from '@/lib/inngest/functions/send-digest';
import { ingestionBurstAlerter } from '@/lib/inngest/functions/ingestion-burst-alerter';
import { stalenessScanner } from '@/lib/inngest/functions/staleness-scanner';
import { correctionReverify } from '@/lib/inngest/functions/correction-reverify';
import {
  ingestStateSosWave,
  ingestStateSosShard,
} from '@/lib/inngest/functions/ingest-state-sos-wave';
import {
  ingestStateCfWave,
  ingestStateCfShard,
} from '@/lib/inngest/functions/ingest-state-cf-wave';
import { scrapeEndorsementsWave } from '@/lib/inngest/functions/scrape-endorsements-wave';
import {
  scrapeLegistarWave,
  scrapeLegistarCity,
} from '@/lib/inngest/functions/scrape-legistar-wave';
import { refreshMatviews } from '@/lib/inngest/functions/refresh-matviews';
import {
  ingestBallotMeasuresWave,
  ingestBallotMeasuresShard,
} from '@/lib/inngest/functions/ingest-ballot-measures-wave';
import { heartbeatWatchdog } from '@/lib/inngest/functions/heartbeat-watchdog';
import { costCapsDailySeed } from '@/lib/inngest/functions/cost-caps-daily-seed';
import { attributeInviteCompletion } from '@/lib/inngest/functions/attribute-invite-completion';
// regenerateResearchDashboard is event-only (no cron) — the dashboard is
// wired to live data via /api/dashboards/research-progress, so scheduled
// regen is obsolete. Kept registered so it can be fired on-demand via
// sendEvent('dashboard/regenerate.manual') if anyone wants a one-off
// rendered snapshot.
import { regenerateResearchDashboard } from '@/lib/inngest/functions/regenerate-research-dashboard';
import { updateCandidacyStatuses } from '@/lib/inngest/functions/update-candidacy-statuses';
import { researchBodiesCron } from '@/lib/inngest/functions/research-bodies-cron';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    classifyCandidate,
    scrapeCandidate,
    batchClassify,
    generateSummaries,
    // Retention engine
    ingestCongress,
    ingestRegulations,
    ingestFec,
    extractStateRulemakingFn,
    extractBallotMeasuresFn,
    extractMunicipalMeetingsFn,
    extractStateCfFn,
    extractOfficeholdersFn,
    sendDigestFn,
    sendDigestOneFn,
    sendElectionReminderFn,
    // Monitoring — every 5m, alerts on ingestion_errors bursts (council 2026-04-23).
    ingestionBurstAlerter,
    // Freshness SLA scanner — every 6h. Reads v_freshness_sla_status and
    // fires Sentry when per-state breach counts cross the threshold.
    stalenessScanner,
    // Human-in-the-loop — re-verify voter-submitted corrections within a
    // 2h SLA. Event-triggered from /admin/corrections-review.
    correctionReverify,
    // Continuous-ingestion scheduler (council 2026-04-24). Six wave functions
    // + their per-state/per-city shard workers keep the 2026 primary
    // calendar populated. Each wave fans out to shard events consumed by
    // the paired worker; the adapter runner handles lock + cost + audit.
    ingestStateSosWave,
    ingestStateSosShard,
    ingestStateCfWave,
    ingestStateCfShard,
    scrapeEndorsementsWave,
    scrapeLegistarWave,
    scrapeLegistarCity,
    refreshMatviews,
    ingestBallotMeasuresWave,
    ingestBallotMeasuresShard,
    // Heartbeat watchdog — every 5m. Reads worker_heartbeats and flags any
    // worker whose last heartbeat is older than 2× expected tick (council
    // 2026-04-25 SRE finding #3). Closes the silent-regression gap when a
    // long-running loop crashes.
    heartbeatWatchdog,
    // Cost-caps daily seeder — 00:05 UTC daily. Pre-seeds today's
    // cost_caps row for every known service so cost_cap_check_and_consume
    // doesn't auto-insert a $0 row that silently refuses every reservation
    // (Council Fix C, 2026-04-25). Companion migration
    // 20260425000014_cost_caps_today_seed.sql ensures TODAY's rows exist
    // immediately on deploy.
    costCapsDailySeed,
    // Voter invites + participation rank — attribution loop. Triggered by
    // `match/quick-match.completed` from submitQuickMatchAction. Stamps
    // users.first_match_completed_at and closes any open invite_acceptances
    // row for the user. Migration: 20260502000002_voter_invites.sql.
    attributeInviteCompletion,
    // Results → candidacy.status pipeline — hourly cron. Reads
    // election_results and flips candidacies.status (won_primary,
    // lost_primary, advanced_to_runoff, etc.). Idempotent.
    // Service: src/lib/elections/update-statuses-from-results.ts
    updateCandidacyStatuses,
    // Dashboard snapshot generator (event-only — no cron). Fire via
    // sendEvent('dashboard/regenerate.manual') for an on-demand HTML
    // snapshot in 00-inbox/.../snapshots/.
    regenerateResearchDashboard,
    // Governing-body research cron (daily 13:00 UTC). Picks BODY_RESEARCH_
    // DAILY_BUDGET un-verified bodies, dispatches the appropriate
    // per-level agent template, writes results back to governing_bodies
    // + office_tenures. Default budget = 10/day; ramp up as template
    // confidence grows. Fire manually via sendEvent('research-bodies.manual',
    // { data: { limit: N, dryRun: true } }) to test or burst.
    researchBodiesCron,
  ],
});
