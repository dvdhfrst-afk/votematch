import Link from "next/link";
import { unstable_noStore as noStore } from "next/cache";
import { Pool } from "pg";
import { createServiceClient } from "@/lib/supabase/server";
import {
  WORKER_NAMES,
  readPm2Snapshot,
  stalenessSeconds,
  isStale,
  formatAge,
  formatBytes,
  formatUptime,
  pm2NameToHeartbeatName,
  type HeartbeatRow,
  type Pm2Process,
  type Pm2Snapshot,
  type WorkerName,
} from "@/lib/workers";
import { restartWorkerForm } from "./actions";

// ---------------------------------------------------------------------------
// /admin/workers — Worker pipeline monitoring dashboard
// ---------------------------------------------------------------------------
// Single page, server-rendered. Joins PM2 process state (`pm2 jlist`) with
// the worker_heartbeats table for the 7 known workers. Plus four supporting
// panels: interpretation backlog, ingestion velocity (last 6h), recent
// failures, and adapter status (dormant / circuit_broken / quarantined).
//
// No client components, no fetching libraries. Every query goes through the
// service-role Supabase client (the admin layout has already verified the
// caller's role). The page is excluded from the Next cache via
// `unstable_noStore` so each render hits the DB and re-execs PM2.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types (loose — view rows aren't in generated types/database.ts yet)
// ---------------------------------------------------------------------------

type BacklogRow = { kind: string; pending: number };

type VelocityRow = {
  hour: string;
  adapter_name: string;
  productive: number;
  unchanged: number;
  unproductive: number;
  failed_partial: number;
  true_new_rows: number | null;
  touched_rows: number | null;
};

type FailureSummary = {
  adapter_name: string;
  count: number;
  most_recent_error: string | null;
  most_recent_at: string;
};

type AdapterStatusRow = {
  adapter_name: string;
  status: string;
  flap_count: number;
  last_breaker_trip_at: string | null;
  last_productive_at: string | null;
  marked_dormant_at: string | null;
};

type RecentRun = {
  adapter_name: string;
  status: string;
  started_at: string;
  error_summary: string | null;
};

type AgentActivityRow = {
  kind: string;
  total_writes: number;
  unique_targets: number;
  last_hour: number;
  most_recent: string;
  by_model: Record<string, number>;
};

// One-row-per-worker view model: PM2 + heartbeat joined by name.
type WorkerRow = {
  name: WorkerName;
  pm2: Pm2Process | null;
  heartbeat: HeartbeatRow | null;
  staleSeconds: number | null;
  stale: boolean;
};

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

async function load() {
  noStore();
  const supabase = await createServiceClient();
  const nowIso = new Date().toISOString();
  const sixHoursAgoIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const twoHoursAgoIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  // PM2 snapshot is synchronous and cheap; do it inline so the server-render
  // surface doesn't have to wait on a child-process Promise.
  const pm2: Pm2Snapshot = readPm2Snapshot();

  const [
    heartbeatsRes,
    backlogRes,
    velocityRes,
    interpretationsRes,
    failuresRes,
    adapterStatusRes,
  ] = await Promise.all([
    supabase
      .from("worker_heartbeats")
      .select(
        "worker_name, pid, last_heartbeat_at, expected_tick_seconds, cycle_count, last_event",
      ),
    supabase.from("v_interpretation_backlog").select("kind, pending"),
    supabase
      .from("v_ingestion_run_velocity")
      .select(
        "hour, adapter_name, productive, unchanged, unproductive, failed_partial, true_new_rows, touched_rows",
      )
      .gte("hour", sixHoursAgoIso)
      .order("hour", { ascending: true }),
    supabase
      .from("interpretations")
      .select("kind, created_at")
      .gte("created_at", oneHourAgoIso),
    supabase
      .from("ingestion_runs")
      .select("adapter_name, status, started_at, error_summary")
      .in("status", ["failed", "partial", "unproductive"])
      .gte("started_at", twoHoursAgoIso)
      .order("started_at", { ascending: false })
      .limit(500),
    supabase
      .from("adapter_status")
      .select(
        "adapter_name, status, flap_count, last_breaker_trip_at, last_productive_at, marked_dormant_at",
      )
      .in("status", ["dormant", "circuit_broken", "quarantined"])
      .order("status", { ascending: true })
      .limit(200),
  ]);

  const heartbeats = (heartbeatsRes.data ?? []) as HeartbeatRow[];
  const heartbeatByName = new Map<string, HeartbeatRow>();
  for (const h of heartbeats) heartbeatByName.set(h.worker_name, h);

  const pm2ByName = new Map<string, Pm2Process>();
  if (pm2.ok) {
    for (const p of pm2.processes) pm2ByName.set(p.name, p);
  }

  const workerRows: WorkerRow[] = WORKER_NAMES.map((name) => {
    // PM2 keys by `bb-<x>`; heartbeat table stores `<x>` (no prefix).
    const heartbeat = heartbeatByName.get(pm2NameToHeartbeatName(name)) ?? null;
    const pm2Proc = pm2ByName.get(name) ?? null;
    const staleSeconds = heartbeat
      ? stalenessSeconds(heartbeat.last_heartbeat_at)
      : null;
    const stale = heartbeat
      ? isStale(heartbeat.last_heartbeat_at, heartbeat.expected_tick_seconds)
      : false;
    return { name, pm2: pm2Proc, heartbeat, staleSeconds, stale };
  });

  // Backlog: 3 known kinds (cf_resolution, bill_dimension, positions).
  const backlog = (backlogRes.data ?? []) as BacklogRow[];
  const backlogByKind = new Map<string, number>();
  for (const r of backlog) backlogByKind.set(r.kind, Number(r.pending) || 0);

  // Drainage: count interpretations rows in last hour, grouped by kind.
  // The view's `kind` and the interpretations.kind don't match 1:1
  // (positions backlog ↔ position_extraction in interpretations).
  const interpsLastHour = (interpretationsRes.data ?? []) as Array<{
    kind: string;
    created_at: string;
  }>;
  const drainByKind = new Map<string, number>();
  for (const r of interpsLastHour) {
    const mapped =
      r.kind === "position_extraction" ? "positions" : r.kind;
    drainByKind.set(mapped, (drainByKind.get(mapped) ?? 0) + 1);
  }

  // Velocity: bucket per-hour for last 6h. Sum across adapters per bucket.
  const velocityRaw = (velocityRes.data ?? []) as VelocityRow[];
  type Bucket = {
    hour: string;
    productive: number;
    unproductive: number;
    unchanged: number;
    failed: number;
  };
  // Build the 6 hourly slots so rendering is deterministic even if a slot
  // has zero rows.
  const hourMs = 60 * 60 * 1000;
  const baseHour = new Date();
  baseHour.setUTCMinutes(0, 0, 0);
  const slots: Bucket[] = [];
  for (let i = 5; i >= 0; i--) {
    const t = new Date(baseHour.getTime() - i * hourMs);
    slots.push({
      hour: t.toISOString(),
      productive: 0,
      unproductive: 0,
      unchanged: 0,
      failed: 0,
    });
  }
  for (const v of velocityRaw) {
    const bucketIso = new Date(v.hour).toISOString();
    const slot = slots.find(
      (s) => new Date(s.hour).getTime() === new Date(bucketIso).getTime(),
    );
    if (!slot) continue;
    slot.productive += Number(v.productive) || 0;
    slot.unproductive += Number(v.unproductive) || 0;
    slot.unchanged += Number(v.unchanged) || 0;
    slot.failed += Number(v.failed_partial) || 0;
  }

  // Failures: aggregate by adapter_name.
  const failureRows = (failuresRes.data ?? []) as RecentRun[];
  const byAdapter = new Map<string, RecentRun[]>();
  for (const r of failureRows) {
    const arr = byAdapter.get(r.adapter_name) ?? [];
    arr.push(r);
    byAdapter.set(r.adapter_name, arr);
  }
  const failureSummaries: FailureSummary[] = Array.from(byAdapter.entries())
    .map(([adapter, rows]) => {
      const newest = rows[0]; // already sorted desc
      return {
        adapter_name: adapter,
        count: rows.length,
        most_recent_error: newest.error_summary,
        most_recent_at: newest.started_at,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const adapterStatuses = (adapterStatusRes.data ?? []) as AdapterStatusRow[];

  // Recent agent activity (24h) — per-kind interpretation writes broken down
  // by model_id. Uses pg.Pool because supabase-js can't express
  // jsonb_object_agg over a CTE. Pool is created+closed per request; this is
  // a server-rendered admin page (low QPS), so the connection cost is fine.
  // Pattern matches refresh-matviews.ts.
  let agentActivity: AgentActivityRow[] = [];
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      const { rows } = await pool.query<{
        kind: string;
        total_writes: string;
        unique_targets: string;
        last_hour: string;
        most_recent: string;
        by_model: Record<string, number>;
      }>(`
        WITH per_model AS (
          SELECT kind, model_id,
                 count(*) AS writes,
                 count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS last_hour,
                 max(created_at) AS most_recent
          FROM interpretations
          WHERE created_at > now() - interval '24 hours'
          GROUP BY kind, model_id
        ),
        per_kind AS (
          SELECT kind, count(DISTINCT target_id) AS unique_targets
          FROM interpretations
          WHERE created_at > now() - interval '24 hours'
          GROUP BY kind
        )
        SELECT pk.kind,
               sum(pm.writes)::bigint AS total_writes,
               pk.unique_targets::bigint AS unique_targets,
               sum(pm.last_hour)::bigint AS last_hour,
               max(pm.most_recent) AS most_recent,
               jsonb_object_agg(pm.model_id, pm.writes) AS by_model
        FROM per_model pm
        JOIN per_kind pk USING (kind)
        GROUP BY pk.kind, pk.unique_targets
        ORDER BY total_writes DESC
      `);
      agentActivity = rows.map((r) => ({
        kind: r.kind,
        total_writes: Number(r.total_writes) || 0,
        unique_targets: Number(r.unique_targets) || 0,
        last_hour: Number(r.last_hour) || 0,
        most_recent: r.most_recent,
        by_model: r.by_model ?? {},
      }));
    } catch (e) {
      // Don't fail the whole dashboard if this one section breaks.
      console.error("[admin/workers] agent activity query failed:", e);
    } finally {
      await pool.end();
    }
  }

  return {
    pm2,
    workerRows,
    backlogByKind,
    drainByKind,
    velocitySlots: slots,
    failureSummaries,
    adapterStatuses,
    agentActivity,
    nowIso,
  };
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function StatusDot({
  tone,
}: {
  tone: "success" | "warn" | "error" | "neutral";
}) {
  const bg =
    tone === "success"
      ? "var(--state-success-fg)"
      : tone === "warn"
        ? "var(--state-warn-fg)"
        : tone === "error"
          ? "var(--state-error-fg)"
          : "var(--civic-border-strong)";
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 999,
        background: bg,
      }}
    />
  );
}

function pm2StatusTone(s: Pm2Process["status"] | "not-found"): {
  tone: "success" | "warn" | "error" | "neutral";
  label: string;
} {
  switch (s) {
    case "online":
      return { tone: "success", label: "online" };
    case "errored":
      return { tone: "error", label: "errored" };
    case "stopping":
      return { tone: "warn", label: "stopping" };
    case "launching":
      return { tone: "warn", label: "launching" };
    case "stopped":
      return { tone: "error", label: "stopped" };
    case "not-found":
      return { tone: "neutral", label: "not in pm2" };
    default:
      return { tone: "neutral", label: String(s) };
  }
}

function fmtIso(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 19).replace("T", " ") + "Z";
}

function hourLabel(iso: string): string {
  const d = new Date(iso);
  const h = d.getUTCHours().toString().padStart(2, "0");
  return `${h}:00`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function WorkersPage() {
  const {
    pm2,
    workerRows,
    backlogByKind,
    drainByKind,
    velocitySlots,
    failureSummaries,
    adapterStatuses,
    agentActivity,
    nowIso,
  } = await load();

  // Headline numbers for the agent-activity section.
  const totalAgentWrites = agentActivity.reduce(
    (sum, r) => sum + r.total_writes,
    0,
  );
  const claudePlanWrites = agentActivity.reduce(
    (sum, r) => sum + (r.by_model["claude-plan-agent"] ?? 0),
    0,
  );

  const cfPending = backlogByKind.get("cf_resolution") ?? 0;
  const billPending = backlogByKind.get("bill_dimension") ?? 0;
  const posPending = backlogByKind.get("positions") ?? 0;

  const cfDrain = drainByKind.get("cf_resolution") ?? 0;
  const billDrain = drainByKind.get("bill_dimension") ?? 0;
  const posDrain = drainByKind.get("positions") ?? 0;

  // For the velocity bars: scale to the tallest slot so bars fill the row.
  const maxVelTotal = Math.max(
    1,
    ...velocitySlots.map(
      (s) => s.productive + s.unproductive + s.unchanged + s.failed,
    ),
  );

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-10">
      <header className="flex items-baseline justify-between border-b border-[var(--civic-border)] pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--civic-text)] tracking-tight">
            Workers
          </h1>
          <p className="text-sm text-[var(--civic-text-muted)] mt-1">
            Process state (PM2) joined with heartbeats. Reload to refresh.
          </p>
        </div>
        <div className="text-xs civic-mono text-[var(--civic-text-muted)]">
          {nowIso.slice(0, 19).replace("T", " ")}Z
        </div>
      </header>

      {!pm2.ok && (
        <div
          className="civic-card"
          style={{
            background: "var(--state-warn-bg)",
            borderColor: "var(--state-warn-bd)",
          }}
        >
          <div className="text-sm font-semibold text-[var(--state-warn-fg)]">
            PM2 daemon not reachable — workers may be running outside PM2
          </div>
          <div className="text-xs civic-mono text-[var(--civic-text-muted)] mt-1">
            {pm2.error}
          </div>
          <div className="text-xs text-[var(--civic-text-muted)] mt-2">
            Falling back to heartbeat-only display below. Restart actions will
            still attempt to invoke <code className="civic-mono">pm2 restart</code>{" "}
            and report failure.
          </div>
        </div>
      )}

      {/* ── 1. Worker status table ─────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Worker status
        </h2>
        <div className="civic-card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-[var(--civic-text-muted)] border-b border-[var(--civic-border)]">
                <th className="px-4 py-2 font-semibold">Worker</th>
                <th className="px-4 py-2 font-semibold">PM2</th>
                <th className="px-4 py-2 font-semibold">PID</th>
                <th className="px-4 py-2 font-semibold text-right">Uptime</th>
                <th className="px-4 py-2 font-semibold text-right">Mem</th>
                <th className="px-4 py-2 font-semibold text-right">CPU</th>
                <th className="px-4 py-2 font-semibold text-right">Restarts</th>
                <th className="px-4 py-2 font-semibold">Heartbeat</th>
                <th className="px-4 py-2 font-semibold text-right">Cycles</th>
                <th className="px-4 py-2 font-semibold">Last event</th>
                <th className="px-4 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {workerRows.map((w) => {
                const pmStatus = w.pm2 ? w.pm2.status : "not-found";
                const tone = pm2StatusTone(pmStatus);
                const unstable = w.pm2 ? w.pm2.unstable_restarts : 0;
                const restartCell = w.pm2
                  ? unstable > 0
                    ? `${w.pm2.restart_time} (${unstable}!)`
                    : `${w.pm2.restart_time}`
                  : "—";
                const heartbeatCell = w.heartbeat
                  ? w.stale
                    ? `STALE — ${formatAge(w.staleSeconds ?? 0)}`
                    : formatAge(w.staleSeconds ?? 0)
                  : "no heartbeat";
                return (
                  <tr
                    key={w.name}
                    className="border-b border-[var(--civic-border)] last:border-0 align-top"
                    style={
                      w.stale
                        ? { background: "var(--state-error-bg)" }
                        : undefined
                    }
                  >
                    <td className="px-4 py-2 civic-mono text-[var(--civic-text)]">
                      {w.name}
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1.5 text-xs civic-mono">
                        <StatusDot tone={tone.tone} />
                        {tone.label}
                      </span>
                    </td>
                    <td className="px-4 py-2 civic-mono text-[var(--civic-text-secondary)]">
                      {w.pm2?.pid ? w.pm2.pid : "—"}
                    </td>
                    <td className="px-4 py-2 text-right civic-tabular text-[var(--civic-text-secondary)]">
                      {w.pm2 ? formatUptime(w.pm2.uptime_ms) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right civic-tabular text-[var(--civic-text-secondary)]">
                      {w.pm2 ? formatBytes(w.pm2.memory) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right civic-tabular text-[var(--civic-text-secondary)]">
                      {w.pm2 ? `${w.pm2.cpu.toFixed(0)}%` : "—"}
                    </td>
                    <td className="px-4 py-2 text-right civic-tabular">
                      {unstable > 0 ? (
                        <span className="text-[var(--state-error-fg)]">
                          {restartCell}
                        </span>
                      ) : (
                        restartCell
                      )}
                    </td>
                    <td className="px-4 py-2 civic-tabular">
                      {w.stale ? (
                        <span className="text-[var(--state-error-fg)] font-semibold">
                          {heartbeatCell}
                        </span>
                      ) : w.heartbeat ? (
                        <span className="text-[var(--civic-text-secondary)]">
                          {heartbeatCell}
                        </span>
                      ) : (
                        <span className="text-[var(--civic-text-muted)]">
                          {heartbeatCell}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right civic-tabular text-[var(--civic-text-secondary)]">
                      {w.heartbeat
                        ? w.heartbeat.cycle_count.toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-4 py-2 text-xs text-[var(--civic-text-muted)] max-w-xs truncate">
                      {w.heartbeat?.last_event ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <RestartButton worker={w.name} />
                        <Link
                          href={`/admin/workers/${w.name}/log`}
                          className="text-xs civic-mono text-[var(--civic-primary)] hover:underline"
                        >
                          Tail log
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-4 py-2 text-xs text-[var(--civic-text-muted)] bg-[var(--civic-surface-sunken)]">
            STALE = (now − last heartbeat) &gt; expected_tick_seconds × 2.
            Restarts column shows lifetime restart_time; trailing{" "}
            <span className="civic-mono">(N!)</span> = unstable_restarts.
          </div>
        </div>
      </section>

      {/* ── 1b. Recent agent activity (24h) ───────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-1">
          Recent agent activity (24h)
        </h2>
        <p className="text-sm text-[var(--civic-text-muted)] mb-3">
          Agents wrote{" "}
          <span className="civic-tabular text-[var(--civic-text)]">
            {totalAgentWrites.toLocaleString()}
          </span>{" "}
          rows in the last 24h
          {claudePlanWrites > 0 && (
            <>
              {" "}
              (
              <span className="civic-tabular text-[var(--civic-text)]">
                {claudePlanWrites.toLocaleString()}
              </span>{" "}
              from <code className="civic-mono">claude-plan-agent</code>)
            </>
          )}
          .
        </p>
        {agentActivity.length === 0 ? (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            No agent writes to <code className="civic-mono">interpretations</code>{" "}
            in the last 24 hours.
          </p>
        ) : (
          <div className="civic-card p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-[var(--civic-text-muted)] border-b border-[var(--civic-border)]">
                  <th className="px-4 py-2 font-semibold">Kind</th>
                  <th className="px-4 py-2 font-semibold text-right">
                    24h writes
                  </th>
                  <th className="px-4 py-2 font-semibold text-right">
                    Unique targets
                  </th>
                  <th className="px-4 py-2 font-semibold text-right">
                    Last hour
                  </th>
                  <th className="px-4 py-2 font-semibold">Most recent</th>
                  <th className="px-4 py-2 font-semibold">By model</th>
                </tr>
              </thead>
              <tbody>
                {agentActivity.map((a) => {
                  const byModelEntries = Object.entries(a.by_model)
                    .sort(([, x], [, y]) => y - x);
                  return (
                    <tr
                      key={a.kind}
                      className="border-b border-[var(--civic-border)] last:border-0 align-top"
                    >
                      <td className="px-4 py-2 civic-mono">{a.kind}</td>
                      <td className="px-4 py-2 text-right civic-tabular text-[var(--civic-text)]">
                        {a.total_writes.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right civic-tabular text-[var(--civic-text-secondary)]">
                        {a.unique_targets.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 text-right civic-tabular text-[var(--civic-text-secondary)]">
                        {a.last_hour.toLocaleString()}
                      </td>
                      <td className="px-4 py-2 civic-tabular text-[var(--civic-text-secondary)]">
                        {fmtIso(a.most_recent)}
                      </td>
                      <td className="px-4 py-2 text-xs civic-mono text-[var(--civic-text-muted)] max-w-md">
                        {byModelEntries
                          .map(
                            ([model, n]) =>
                              `${model}: ${n.toLocaleString()}`,
                          )
                          .join(", ")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="px-4 py-2 text-xs text-[var(--civic-text-muted)] bg-[var(--civic-surface-sunken)]">
              Source: <code className="civic-mono">interpretations</code> rows
              created in the last 24h, grouped by{" "}
              <code className="civic-mono">kind</code> ×{" "}
              <code className="civic-mono">model_id</code>.
            </div>
          </div>
        )}
      </section>

      {/* ── 2. Backlog panel ───────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Interpretation backlog
        </h2>
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
        >
          <BacklogCard
            label="cf_resolution"
            pending={cfPending}
            drainPerHour={cfDrain}
          />
          <BacklogCard
            label="bill_dimension"
            pending={billPending}
            drainPerHour={billDrain}
          />
          <BacklogCard
            label="positions"
            pending={posPending}
            drainPerHour={posDrain}
          />
        </div>
        <p className="text-xs text-[var(--civic-text-muted)] mt-2">
          Pending = rows with interpretation_status = 0. Drain rate counts
          rows added to <code className="civic-mono">interpretations</code> in
          the last hour.
        </p>
      </section>

      {/* ── 3. Ingestion velocity ──────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Ingestion velocity · last 6h
        </h2>
        <div className="civic-card p-0 overflow-hidden">
          <div className="px-4 py-3">
            <div className="flex items-end gap-2" style={{ height: 140 }}>
              {velocitySlots.map((s) => {
                const total = s.productive + s.unproductive + s.unchanged + s.failed;
                const pct = (n: number) =>
                  total === 0 ? 0 : (n / maxVelTotal) * 100;
                // Render as a single column with stacked color segments.
                return (
                  <div
                    key={s.hour}
                    className="flex flex-col items-center gap-1 flex-1"
                    style={{ minWidth: 0 }}
                  >
                    <div
                      className="w-full flex flex-col-reverse"
                      style={{ height: 110, maxWidth: 60 }}
                      title={`${hourLabel(s.hour)}: productive=${s.productive}, unchanged=${s.unchanged}, unproductive=${s.unproductive}, failed=${s.failed}`}
                    >
                      <div
                        style={{
                          height: `${pct(s.productive)}%`,
                          background: "var(--state-success-fg)",
                        }}
                      />
                      <div
                        style={{
                          height: `${pct(s.unchanged)}%`,
                          background: "var(--civic-border-strong)",
                        }}
                      />
                      <div
                        style={{
                          height: `${pct(s.unproductive)}%`,
                          background: "var(--state-warn-fg)",
                        }}
                      />
                      <div
                        style={{
                          height: `${pct(s.failed)}%`,
                          background: "var(--state-error-fg)",
                        }}
                      />
                    </div>
                    <div className="text-[10px] civic-mono text-[var(--civic-text-muted)]">
                      {hourLabel(s.hour)}
                    </div>
                    <div className="text-[10px] civic-tabular text-[var(--civic-text-secondary)]">
                      {total}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="px-4 py-2 text-xs text-[var(--civic-text-muted)] bg-[var(--civic-surface-sunken)] flex flex-wrap gap-3">
            <span className="inline-flex items-center gap-1">
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  background: "var(--state-success-fg)",
                }}
              />
              productive
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  background: "var(--civic-border-strong)",
                }}
              />
              unchanged
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  background: "var(--state-warn-fg)",
                }}
              />
              unproductive
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  background: "var(--state-error-fg)",
                }}
              />
              failed/partial
            </span>
          </div>
        </div>
      </section>

      {/* ── 4. Recent failure summary ──────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Recent failures · last 2h (top 20 adapters)
        </h2>
        {failureSummaries.length === 0 ? (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            No failed / partial / unproductive runs in the last 2 hours.
          </p>
        ) : (
          <div className="civic-card p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-[var(--civic-text-muted)] border-b border-[var(--civic-border)]">
                  <th className="px-4 py-2 font-semibold">Adapter</th>
                  <th className="px-4 py-2 font-semibold text-right">Count</th>
                  <th className="px-4 py-2 font-semibold">Most recent</th>
                  <th className="px-4 py-2 font-semibold">Error summary</th>
                </tr>
              </thead>
              <tbody>
                {failureSummaries.map((f) => (
                  <tr
                    key={f.adapter_name}
                    className="border-b border-[var(--civic-border)] last:border-0 align-top"
                  >
                    <td className="px-4 py-2 civic-mono">{f.adapter_name}</td>
                    <td className="px-4 py-2 text-right civic-tabular">
                      <span className="text-[var(--state-error-fg)]">
                        {f.count}
                      </span>
                    </td>
                    <td className="px-4 py-2 civic-tabular text-[var(--civic-text-secondary)]">
                      {fmtIso(f.most_recent_at)}
                    </td>
                    <td className="px-4 py-2 text-xs text-[var(--civic-text-muted)] max-w-md truncate">
                      {f.most_recent_error ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 5. Adapter status (dormant / circuit / quarantined) ────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Adapter status (dormant / circuit-broken / quarantined)
        </h2>
        {adapterStatuses.length === 0 ? (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            No adapters in dormant, circuit_broken, or quarantined state.
          </p>
        ) : (
          <div className="civic-card p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-[var(--civic-text-muted)] border-b border-[var(--civic-border)]">
                  <th className="px-4 py-2 font-semibold">Adapter</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold text-right">Flap count</th>
                  <th className="px-4 py-2 font-semibold">Last trip</th>
                  <th className="px-4 py-2 font-semibold">Last productive</th>
                  <th className="px-4 py-2 font-semibold">Marked dormant</th>
                </tr>
              </thead>
              <tbody>
                {adapterStatuses.map((a) => {
                  const tone =
                    a.status === "quarantined"
                      ? "error"
                      : a.status === "circuit_broken"
                        ? "warn"
                        : "neutral";
                  return (
                    <tr
                      key={a.adapter_name}
                      className="border-b border-[var(--civic-border)] last:border-0"
                    >
                      <td className="px-4 py-2 civic-mono">{a.adapter_name}</td>
                      <td className="px-4 py-2">
                        <span className="inline-flex items-center gap-1.5 text-xs civic-mono">
                          <StatusDot tone={tone} />
                          {a.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right civic-tabular">
                        {a.flap_count > 0 ? (
                          <span className="text-[var(--state-warn-fg)]">
                            {a.flap_count}
                          </span>
                        ) : (
                          "0"
                        )}
                      </td>
                      <td className="px-4 py-2 civic-tabular text-[var(--civic-text-secondary)]">
                        {fmtIso(a.last_breaker_trip_at)}
                      </td>
                      <td className="px-4 py-2 civic-tabular text-[var(--civic-text-secondary)]">
                        {fmtIso(a.last_productive_at)}
                      </td>
                      <td className="px-4 py-2 civic-tabular text-[var(--civic-text-secondary)]">
                        {fmtIso(a.marked_dormant_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="pt-6 border-t border-[var(--civic-border)] text-xs text-[var(--civic-text-muted)]">
        Sources: <code className="civic-mono">pm2 jlist</code>,{" "}
        <code className="civic-mono">worker_heartbeats</code>,{" "}
        <code className="civic-mono">v_interpretation_backlog</code>,{" "}
        <code className="civic-mono">interpretations</code> (24h × model),{" "}
        <code className="civic-mono">v_ingestion_run_velocity</code>,{" "}
        <code className="civic-mono">ingestion_runs</code>,{" "}
        <code className="civic-mono">adapter_status</code>. Logs at{" "}
        <code className="civic-mono">
          pm2-logs/&lt;name&gt;-{"{out,err}"}.log
        </code>
        .
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Restart button — small client-free server-action form
// ---------------------------------------------------------------------------

function RestartButton({ worker }: { worker: WorkerName }) {
  return (
    <form action={restartWorkerForm}>
      <input type="hidden" name="worker" value={worker} />
      <button
        type="submit"
        className="text-xs civic-mono px-2 py-1 border border-[var(--civic-border)] rounded hover:bg-[var(--civic-surface-sunken)]"
      >
        Restart
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Backlog card — one of three, with a big number + drain-rate annotation
// ---------------------------------------------------------------------------

function BacklogCard({
  label,
  pending,
  drainPerHour,
}: {
  label: string;
  pending: number;
  drainPerHour: number;
}) {
  // Estimate ETA only when there's both pending and drain.
  const etaHours =
    pending > 0 && drainPerHour > 0 ? pending / drainPerHour : null;
  const etaLabel =
    etaHours === null
      ? null
      : etaHours < 1
        ? `~${Math.round(etaHours * 60)}m to drain`
        : etaHours < 48
          ? `~${etaHours.toFixed(1)}h to drain`
          : `~${(etaHours / 24).toFixed(1)}d to drain`;

  return (
    <div className="civic-card">
      <div className="text-xs civic-mono text-[var(--civic-text-muted)] uppercase tracking-wider">
        {label}
      </div>
      <div
        className="text-3xl font-semibold civic-tabular mt-1"
        style={{
          color:
            pending === 0
              ? "var(--state-success-fg)"
              : "var(--civic-text)",
        }}
      >
        {pending.toLocaleString()}
      </div>
      <div className="text-xs civic-tabular text-[var(--civic-text-secondary)] mt-1">
        {drainPerHour.toLocaleString()} / hr drained
      </div>
      {etaLabel && (
        <div className="text-xs text-[var(--civic-text-muted)] mt-1">
          {etaLabel}
        </div>
      )}
    </div>
  );
}
