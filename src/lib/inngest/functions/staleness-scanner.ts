import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { reportSlaBreach } from '@/lib/monitoring/sentry-report';

/**
 * Freshness SLA staleness scanner. Runs every 6 hours at minute 15
 * (cron pattern "15 [slash-star-slash]6 * * *"); also event-triggerable
 * for on-demand runs via `monitoring/staleness.check`.
 *
 * What it does, in order:
 *   1. Reads v_freshness_sla_status to find all sources in 'breach' or
 *      'warning' state.
 *   2. Groups by (state_fips, source_type). If any state has > 5 breaches,
 *      fires a Sentry SLA-breach event. Severity is 'critical' if that
 *      state has an election within 7 days, else 'warning'.
 *   3. Marks district_ingestion_status.status = 'partial' for any matching
 *      (state_fips, district_type) pair where the data source is currently
 *      'success' but has breached — stale data is effectively partial.
 *   4. Returns a structured summary for the Inngest run page.
 *
 * Per council pattern (ingestion-burst-alerter):
 *   - retries: 0 — observability must not spam re-attempts.
 *   - concurrency: 1 — single-flight; parallel scanners are pointless and
 *     would race on the district_ingestion_status update.
 */

const BREACH_THRESHOLD_PER_STATE = 5;
const IMMINENT_ELECTION_DAYS = 7;

/**
 * Council #30: when computing "today" for election proximity, default to the
 * latest US time zone (Pacific/Pago_Pago, UTC-11) so we never under-count an
 * election as "past" before its calendar date has rolled over for any voter.
 * Anchorage / Honolulu would also be defensible, but Pago_Pago covers
 * American Samoa (FIPS 60) which we ingest. The per-state lookup overrides
 * this when jurisdictions.iana_tz is populated.
 */
const FALLBACK_TZ = 'Pacific/Pago_Pago';

/**
 * Compute "today" (yyyy-mm-dd) in the given IANA tz. Falls back to FALLBACK_TZ
 * when tz is null/unknown, which is the latest US TZ — so an election today
 * Pacific time is still classified as "today" up until ~11pm UTC, which is
 * what we want for the imminent-election severity ladder.
 */
function todayInTz(tz: string | null | undefined): string {
  const zone = tz && tz.length > 0 ? tz : FALLBACK_TZ;
  try {
    // sv-SE locale → ISO yyyy-mm-dd
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    // Bad TZ string — fall back to UTC date.
    return new Date().toISOString().slice(0, 10);
  }
}

function daysBetweenIso(fromIso: string, toIso: string): number {
  // Both inputs are calendar dates (yyyy-mm-dd) — interpret as UTC midnight,
  // which is sufficient for day-count math (no DST cliff at midnight UTC).
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.max(0, Math.ceil((b - a) / 86_400_000));
}

type SlaRow = {
  data_source_id: string;
  name: string;
  state_fips: string | null;
  source_type: string;
  last_run_at: string | null;
  sla_hours: number | null;
  actual_staleness_hours: number | null;
  sla_status: 'ok' | 'warning' | 'breach' | 'never_run';
};

type ElectionRow = {
  state_fips: string | null;
  election_date: string;
};

export interface StalenessScanResult {
  scanned_at: string;
  total_sources: number;
  status_counts: {
    ok: number;
    warning: number;
    breach: number;
    never_run: number;
  };
  state_groups: Array<{
    state_fips: string | null;
    source_type: string;
    breach_count: number;
    warning_count: number;
    severity: 'warning' | 'critical' | 'none';
    fired_sentry: boolean;
  }>;
  district_status_updates: number;
  reason?: string;
}

async function runStalenessScan(): Promise<StalenessScanResult> {
  const scannedAt = new Date().toISOString();
  const supabase = await createServiceClient();

  // 1. Pull the whole SLA view. This is bounded — one row per data_sources
  //    row, of which there are currently ~450. No pagination needed.
  const { data: rowsRaw, error: rowsError } = await supabase
    .from('v_freshness_sla_status')
    .select(
      'data_source_id, name, state_fips, source_type, last_run_at, sla_hours, actual_staleness_hours, sla_status',
    );
  if (rowsError) {
    return {
      scanned_at: scannedAt,
      total_sources: 0,
      status_counts: { ok: 0, warning: 0, breach: 0, never_run: 0 },
      state_groups: [],
      district_status_updates: 0,
      reason: `v_freshness_sla_status query failed: ${rowsError.message}`,
    };
  }
  const rows = (rowsRaw ?? []) as SlaRow[];

  const statusCounts = { ok: 0, warning: 0, breach: 0, never_run: 0 };
  for (const r of rows) {
    statusCounts[r.sla_status] = (statusCounts[r.sla_status] ?? 0) + 1;
  }

  // 2. Pull upcoming elections to classify breach severity. elections table
  //    has office_id → offices → jurisdictions.fips_state; we join there.
  //
  // Council #30: server UTC vs election_date (calendar date) miscounts by
  // ~1 day at the edges (8pm Pacific the day before HI primary = next day
  // in UTC, so the scanner thinks the election is "tomorrow" when it's
  // actually "today" for HI voters — flip side too: a Pacific-evening run
  // before a midwestern morning election rounds the wrong way).
  //
  // Fix: compute "today" per state using jurisdictions.iana_tz, defaulting
  // to FALLBACK_TZ (latest US TZ — Pacific/Pago_Pago) so we always err on
  // the side of "this election is still imminent" rather than letting it
  // silently slip out of the alerting window.
  let tzByFips = new Map<string, string>();
  try {
    const { data: tzRows } = await supabase
      .from('jurisdictions')
      .select('fips_state, iana_tz')
      .not('fips_state', 'is', null)
      .not('iana_tz', 'is', null);
    for (const row of (tzRows ?? []) as Array<{
      fips_state: string | null;
      iana_tz: string | null;
    }>) {
      if (row.fips_state && row.iana_tz) {
        tzByFips.set(row.fips_state, row.iana_tz);
      }
    }
  } catch {
    tzByFips = new Map();
  }

  // Use FALLBACK_TZ for the "search window" — it's the latest TZ, so any
  // election within `today + IMMINENT_ELECTION_DAYS` for *any* state is
  // included. We narrow per-state when computing daysOut below.
  const fallbackTodayIso = todayInTz(FALLBACK_TZ);
  const inDaysIso = new Date(
    new Date(`${fallbackTodayIso}T00:00:00Z`).getTime()
      + IMMINENT_ELECTION_DAYS * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  let imminentByState = new Map<string, number>();
  try {
    // Supabase rest supports nested select via embedded FK resolution but the
    // offices→jurisdictions FK chain is awkward. Fall back to an RPC? We
    // don't have one; build via two-step query.
    const { data: electionRows } = await supabase
      .from('elections')
      .select('election_date, offices!inner(jurisdictions!inner(fips_state))')
      .gte('election_date', fallbackTodayIso)
      .lte('election_date', inDaysIso);
    // Normalize the nested shape. The embed resolves as an object with
    // `offices: { jurisdictions: { fips_state } }`.
    for (const e of (electionRows ?? []) as Array<{
      election_date: string;
      offices?: { jurisdictions?: { fips_state: string | null } } | null;
    }>) {
      const st = e.offices?.jurisdictions?.fips_state ?? null;
      if (!st) continue;
      // Per-state "today" — use the state's IANA tz when we have it.
      const stateTodayIso = todayInTz(tzByFips.get(st) ?? null);
      const daysOut = daysBetweenIso(stateTodayIso, e.election_date);
      const prev = imminentByState.get(st);
      if (prev === undefined || daysOut < prev) imminentByState.set(st, daysOut);
    }
  } catch {
    // Non-fatal: if the election query fails we downgrade everything to
    // 'warning' severity. We prefer a noisy false positive over silently
    // missing a critical pre-election breach.
    imminentByState = new Map();
  }

  // 3. Group breached / warned sources by (state_fips, source_type).
  type GroupKey = string;
  const groupKey = (state: string | null, type: string): GroupKey =>
    `${state ?? 'null'}::${type}`;
  const groups = new Map<
    GroupKey,
    {
      state_fips: string | null;
      source_type: string;
      breach_count: number;
      warning_count: number;
      breached_sources: SlaRow[];
    }
  >();
  for (const r of rows) {
    if (r.sla_status !== 'breach' && r.sla_status !== 'warning') continue;
    const k = groupKey(r.state_fips, r.source_type);
    let g = groups.get(k);
    if (!g) {
      g = {
        state_fips: r.state_fips,
        source_type: r.source_type,
        breach_count: 0,
        warning_count: 0,
        breached_sources: [],
      };
      groups.set(k, g);
    }
    if (r.sla_status === 'breach') {
      g.breach_count += 1;
      g.breached_sources.push(r);
    } else {
      g.warning_count += 1;
    }
  }

  // 4. For each group, decide whether to fire Sentry. Threshold: > 5
  //    breaches in a single state (regardless of source_type). So we
  //    aggregate per state first.
  const stateBreachTotals = new Map<string | null, number>();
  for (const g of groups.values()) {
    stateBreachTotals.set(
      g.state_fips,
      (stateBreachTotals.get(g.state_fips) ?? 0) + g.breach_count,
    );
  }

  const stateGroupsOut: StalenessScanResult['state_groups'] = [];
  for (const g of groups.values()) {
    const stateTotal = stateBreachTotals.get(g.state_fips) ?? 0;
    const shouldFire = stateTotal > BREACH_THRESHOLD_PER_STATE;
    let severity: 'warning' | 'critical' | 'none' = 'none';
    let fired = false;
    if (shouldFire && g.breach_count > 0) {
      const daysOut = g.state_fips ? imminentByState.get(g.state_fips) : undefined;
      severity =
        daysOut !== undefined && daysOut <= IMMINENT_ELECTION_DAYS
          ? 'critical'
          : 'warning';
      try {
        await reportSlaBreach({
          state_fips: g.state_fips,
          source_type: g.source_type,
          breach_count: g.breach_count,
          warning_count: g.warning_count,
          severity,
          days_to_next_election: daysOut ?? null,
          breached_sources: g.breached_sources.slice(0, 25).map((s) => ({
            data_source_id: s.data_source_id,
            name: s.name,
            source_type: s.source_type,
            sla_hours: s.sla_hours,
            actual_staleness_hours: s.actual_staleness_hours,
          })),
        });
        fired = true;
      } catch {
        fired = false;
      }
    }
    stateGroupsOut.push({
      state_fips: g.state_fips,
      source_type: g.source_type,
      breach_count: g.breach_count,
      warning_count: g.warning_count,
      severity,
      fired_sentry: fired,
    });
  }

  // 5. Update district_ingestion_status for any matching (state, type).
  //    We intentionally only touch rows currently marked 'success' — the
  //    migration from not_started → success is managed by the adapter
  //    runner and we don't want to overwrite in-progress or failed.
  //    Set status = 'partial' with last_error describing the breach.
  //
  //    Note: district_type in district_ingestion_status is a fixed
  //    vocabulary ('us_congressional' | 'state_house' | 'state_senate')
  //    that doesn't directly map to source_type. We map conservatively:
  //    any breached source in a state flips all success rows for that
  //    state to partial. That's the right behavior — if we can't refresh
  //    the SoS candidate filings, the district coverage for that state
  //    is de facto partial.
  //
  //    Council META-ASSUMPTION (2026-04-25): the SLA view's "last successful
  //    run" now includes 'unchanged' and 'unproductive' (see migration
  //    20260425000009), but we still defensively re-check the most-recent
  //    run per breached data source before flipping districts to partial.
  //    A source whose most-recent run is 'unchanged' or 'unproductive' is
  //    healthy — flipping district status to 'partial' on its account would
  //    be a false positive. We only flip to partial when the freshest run
  //    is genuinely 'failed' / 'partial' / 'rejected_*' OR when the source
  //    has no run at all in the SLA window (i.e. the SLA view's 'breach'
  //    classification is itself stale-vs-real).
  let districtUpdates = 0;
  const breachedSourcesByState = new Map<string, SlaRow[]>();
  for (const g of groups.values()) {
    if (g.breach_count === 0 || !g.state_fips) continue;
    const list = breachedSourcesByState.get(g.state_fips) ?? [];
    list.push(...g.breached_sources);
    breachedSourcesByState.set(g.state_fips, list);
  }

  // Treat these statuses as "ran successfully" for the purposes of NOT
  // flipping district_ingestion_status to 'partial'. unchanged and
  // unproductive are healthy outcomes (content_hash short-circuit / source
  // legitimately empty), not breach signals.
  const HEALTHY_RUN_STATUSES = ['success', 'unchanged', 'unproductive'] as const;

  // For each candidate breached state, verify by querying the freshest
  // ingestion_runs row per data_source. If every breached source's freshest
  // run is healthy, the breach is a stale view artifact — skip the flip.
  const verifiedBreachedStates = new Set<string>();
  for (const [fips, sources] of breachedSourcesByState.entries()) {
    let stateHasRealBreach = false;
    for (const src of sources) {
      try {
        const { data: latest } = await supabase
          .from('ingestion_runs')
          .select('status, finished_at')
          .eq('data_source_id', src.data_source_id)
          .not('finished_at', 'is', null)
          .order('finished_at', { ascending: false })
          .limit(1);
        const row = (latest ?? [])[0] as
          | { status: string; finished_at: string | null }
          | undefined;
        if (!row) {
          // No run at all → genuinely never_run / breach.
          stateHasRealBreach = true;
          break;
        }
        const isHealthy = (HEALTHY_RUN_STATUSES as readonly string[]).includes(
          row.status,
        );
        if (isHealthy) {
          // Freshest run is healthy. Check whether it falls inside the SLA
          // window — if it does, this source is fine; if not, the source is
          // really stale and the breach is real.
          if (src.sla_hours == null || row.finished_at == null) {
            // No SLA / no timestamp → not actionable; do not flip.
            continue;
          }
          const ageHours =
            (Date.now() - new Date(row.finished_at).getTime()) / 3_600_000;
          if (ageHours > src.sla_hours) {
            stateHasRealBreach = true;
            break;
          }
          // else: healthy AND within window → not a breach.
        } else {
          // Freshest run is failed / partial / rejected — real breach.
          stateHasRealBreach = true;
          break;
        }
      } catch {
        // On query error, fall back to flipping conservatively (the prior
        // behavior), so observability still fires when the DB is shaky.
        stateHasRealBreach = true;
        break;
      }
    }
    if (stateHasRealBreach) verifiedBreachedStates.add(fips);
  }

  if (verifiedBreachedStates.size > 0) {
    for (const fips of verifiedBreachedStates) {
      const { error: updErr, count } = await supabase
        .from('district_ingestion_status')
        .update(
          {
            status: 'partial',
            last_error: `freshness_sla: ${stateBreachTotals.get(fips) ?? 0} breached sources at ${scannedAt}`,
          },
          { count: 'exact' },
        )
        .eq('state_fips', fips)
        .eq('status', 'success');
      if (!updErr && typeof count === 'number') districtUpdates += count;
    }
  }

  return {
    scanned_at: scannedAt,
    total_sources: rows.length,
    status_counts: statusCounts,
    state_groups: stateGroupsOut,
    district_status_updates: districtUpdates,
  };
}

export const stalenessScanner = inngest.createFunction(
  {
    id: 'staleness-scanner',
    retries: 0,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: '15 */6 * * *' },
      { event: 'monitoring/staleness.check' },
    ],
  },
  async ({ step }: { step: any }) => {
    return await step.run('scan', () => runStalenessScan());
  },
);

// Exported for direct invocation (manual runs + tests).
export { runStalenessScan };
