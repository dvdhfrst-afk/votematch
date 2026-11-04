// ---------------------------------------------------------------------------
// Shared utilities for the /admin/workers dashboard.
//
// Two responsibilities:
//   1. Run `pm2 jlist` and parse the JSON array PM2 emits, normalising to a
//      stable shape the page can render. Resilient to PM2 not running.
//   2. Worker-name validation. The Server Action that restarts a worker
//      shells out to `pm2 restart <name>`; we MUST validate the name against
//      a hard-coded allowlist or accept a strict alphanum/hyphen pattern to
//      avoid command injection.
//
// All callers run on the server (Server Components or Server Actions). No
// imports leak to the browser bundle.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";

// The 7 workers the pipeline runs. Anything not in this list is rejected by
// the restart action.
//
// Naming wrinkle: PM2 manages processes by `bb-<name>` (the `bb-` prefix
// distinguishes our processes from anything else PM2 might host). The
// workers themselves heartbeat to `worker_heartbeats.worker_name` WITHOUT
// the prefix (e.g. 'continuous-ingest'). Helpers below convert between
// the two namespaces.
export const WORKER_NAMES = [
  "bb-continuous-ingest",
  "bb-continuous-interpret",
  "bb-failure-analyzer",
  "bb-stuck-task-janitor",
  "bb-adapter-doctor",
  "bb-data-quality-watcher",
  "bb-primary-readiness-checker",
] as const;

export type WorkerName = (typeof WORKER_NAMES)[number];

export function isWorkerName(name: string): name is WorkerName {
  return (WORKER_NAMES as readonly string[]).includes(name);
}

/** Strip the `bb-` prefix used in PM2 to get the heartbeat key. */
export function pm2NameToHeartbeatName(pm2Name: string): string {
  return pm2Name.replace(/^bb-/, "");
}

/** Add the `bb-` prefix to convert a heartbeat key to the PM2 process name. */
export function heartbeatNameToPm2Name(hbName: string): string {
  return hbName.startsWith("bb-") ? hbName : `bb-${hbName}`;
}

// ---------------------------------------------------------------------------
// PM2 jlist
// ---------------------------------------------------------------------------

export type Pm2Status =
  | "online"
  | "stopping"
  | "stopped"
  | "launching"
  | "errored"
  | "one-launch-status"
  | "not-found";

export type Pm2Process = {
  name: string;
  pm_id: number;
  pid: number;
  status: Pm2Status;
  restart_time: number;
  unstable_restarts: number;
  exec_mode: string;
  uptime_ms: number; // (now - pm_uptime); 0 if not online
  memory: number; // bytes
  cpu: number; // percent
};

export type Pm2Snapshot =
  | { ok: true; processes: Pm2Process[] }
  | { ok: false; error: string };

// Raw shape from `pm2 jlist`. Loose because PM2's output is loosely typed.
type RawPm2Process = {
  name?: unknown;
  pm_id?: unknown;
  pid?: unknown;
  pm2_env?: {
    status?: unknown;
    restart_time?: unknown;
    unstable_restarts?: unknown;
    exec_mode?: unknown;
    pm_uptime?: unknown;
  };
  monit?: { memory?: unknown; cpu?: unknown };
};

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function readPm2Snapshot(): Pm2Snapshot {
  try {
    // 5s timeout: PM2 daemon should respond instantly. If it hangs, fail fast
    // and the page falls back to heartbeats only.
    const stdout = execSync("pm2 jlist", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // PM2 sometimes prints log preamble before the JSON. Find the first '['.
    const start = stdout.indexOf("[");
    if (start === -1) {
      return { ok: false, error: "pm2 jlist produced no JSON" };
    }
    const json = stdout.slice(start);
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "pm2 jlist did not return an array" };
    }
    const now = Date.now();
    const processes: Pm2Process[] = parsed.map((p) => {
      const raw = p as RawPm2Process;
      const env = raw.pm2_env ?? {};
      const monit = raw.monit ?? {};
      const status = str(env.status, "stopped") as Pm2Status;
      const pmUptime = num(env.pm_uptime);
      const uptimeMs =
        status === "online" && pmUptime > 0 ? Math.max(0, now - pmUptime) : 0;
      return {
        name: str(raw.name),
        pm_id: num(raw.pm_id, -1),
        pid: num(raw.pid, 0),
        status,
        restart_time: num(env.restart_time),
        unstable_restarts: num(env.unstable_restarts),
        exec_mode: str(env.exec_mode, "fork"),
        uptime_ms: uptimeMs,
        memory: num(monit.memory),
        cpu: num(monit.cpu),
      };
    });
    return { ok: true, processes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Heartbeat staleness
// ---------------------------------------------------------------------------

export type HeartbeatRow = {
  worker_name: string;
  pid: number | null;
  last_heartbeat_at: string;
  expected_tick_seconds: number;
  cycle_count: number;
  last_event: string | null;
};

export function stalenessSeconds(lastHeartbeatAt: string, nowMs = Date.now()): number {
  const t = new Date(lastHeartbeatAt).getTime();
  if (Number.isNaN(t)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

export function isStale(
  lastHeartbeatAt: string,
  expectedTickSeconds: number,
  nowMs = Date.now(),
): boolean {
  const threshold = expectedTickSeconds * 2;
  if (threshold <= 0) return false;
  return stalenessSeconds(lastHeartbeatAt, nowMs) > threshold;
}

// Human-format a delta in seconds into "12s ago" / "5m ago" / "3h ago".
export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatUptime(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return `${d}d ${h}h`;
}
