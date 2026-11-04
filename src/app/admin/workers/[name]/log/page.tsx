import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_noStore as noStore } from "next/cache";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isWorkerName, type WorkerName } from "@/lib/workers";

// ---------------------------------------------------------------------------
// /admin/workers/[name]/log — Tail of a single worker's stdout + stderr logs.
//
// Read-only, server-rendered. Reads the last 200 lines from the matching
// pm2-logs files (the same path PM2 writes via ecosystem.config). No
// streaming for v1 — refresh the page for new lines.
//
// Log dir comes from PM2_LOG_DIR (default: <cwd>/pm2-logs). The worker name
// is validated against the allowlist before any file touches happen, so
// arbitrary directory traversal is impossible.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const PM2_LOG_DIR = process.env.PM2_LOG_DIR ?? join(process.cwd(), "pm2-logs");
const TAIL_LINES = 200;

function tail(path: string, lines: number): { content: string; size: number } | null {
  try {
    const stat = statSync(path);
    // Read the whole file. PM2 logs are size-capped (or rotated externally);
    // for v1 we accept "load it all" since we cap to last N lines anyway.
    const text = readFileSync(path, "utf8");
    const split = text.split(/\r?\n/);
    const tailLines = split.slice(Math.max(0, split.length - lines - 1));
    return { content: tailLines.join("\n"), size: stat.size };
  } catch {
    return null;
  }
}

export default async function WorkerLogPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  noStore();
  const { name } = await params;

  // Validation gate. If the URL contains anything not on the allowlist we
  // 404 — never proceed to filesystem with a tainted name.
  if (!isWorkerName(name)) {
    notFound();
  }
  const worker: WorkerName = name;

  const outPath = join(PM2_LOG_DIR, `${worker}-out.log`);
  const errPath = join(PM2_LOG_DIR, `${worker}-err.log`);
  const out = tail(outPath, TAIL_LINES);
  const err = tail(errPath, TAIL_LINES);

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-8">
      <header className="flex items-baseline justify-between border-b border-[var(--civic-border)] pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--civic-text)] tracking-tight">
            {worker} · log tail
          </h1>
          <p className="text-sm text-[var(--civic-text-muted)] mt-1">
            Last {TAIL_LINES} lines of stdout + stderr. Reload to refresh.
          </p>
        </div>
        <Link
          href="/admin/workers"
          className="text-sm civic-mono text-[var(--civic-primary)] hover:underline"
        >
          ← back to /admin/workers
        </Link>
      </header>

      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-lg font-semibold text-[var(--civic-text)]">
            stdout
          </h2>
          <code className="text-xs civic-mono text-[var(--civic-text-muted)]">
            {outPath}
            {out && ` · ${out.size.toLocaleString()} bytes total`}
          </code>
        </div>
        {out ? (
          <pre
            className="civic-card text-xs civic-mono whitespace-pre-wrap break-all"
            style={{
              background: "var(--civic-surface-sunken)",
              maxHeight: 600,
              overflowY: "auto",
            }}
          >
            {out.content || "(empty)"}
          </pre>
        ) : (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            File not found or unreadable.
          </p>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-lg font-semibold text-[var(--civic-text)]">
            stderr
          </h2>
          <code className="text-xs civic-mono text-[var(--civic-text-muted)]">
            {errPath}
            {err && ` · ${err.size.toLocaleString()} bytes total`}
          </code>
        </div>
        {err ? (
          <pre
            className="civic-card text-xs civic-mono whitespace-pre-wrap break-all"
            style={{
              background: "var(--civic-surface-sunken)",
              maxHeight: 600,
              overflowY: "auto",
              borderColor: "var(--state-error-bd)",
            }}
          >
            {err.content || "(empty)"}
          </pre>
        ) : (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            File not found or unreadable.
          </p>
        )}
      </section>
    </div>
  );
}
