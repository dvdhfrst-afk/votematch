import { createServiceClient } from "@/lib/supabase/server";
import {
  reverifyCorrection,
  dismissCorrection,
  resolveCorrection,
} from "./actions";

// ---------------------------------------------------------------------------
// /admin/corrections-review — Voter-correction triage
// ---------------------------------------------------------------------------
// Triage surface for the public /corrections submissions. Four columns:
//   - submitter | target_type | target_id | claim | submitted_at
//   - time_remaining vs a 2-hour SLA
//   - status
// Per-row actions: Re-verify now · Dismiss · Resolve as-corrected.
//
// "Re-verify now" fires a `corrections/flagged.received` event to Inngest;
// the `correction-reverify` function re-runs the underlying adapter (when
// target_type='candidacy') or re-fetches the source (for endorsements,
// positions) and flips resolution_status. See
// src/lib/inngest/functions/correction-reverify.ts.
//
// Auth inherited from /admin/layout.tsx. Actions re-verify role.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const SLA_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CorrectionRow = {
  id: string;
  target_type: string | null;
  target_id: string | null;
  candidate_id: string | null;
  position_id: string | null;
  submitter_email: string | null;
  submitted_by: string | null;
  claim: string | null;
  claim_type: string | null;
  evidence: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution_status: string | null;
  resolution_note: string | null;
  reverify_triggered_at: string | null;
  status: string;
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

async function load(): Promise<{
  unresolved: CorrectionRow[];
  recent: CorrectionRow[];
  breached: number;
  inWindow: number;
}> {
  const supabase = await createServiceClient();

  const [unresolvedRes, recentRes] = await Promise.all([
    supabase
      .from("corrections")
      .select(
        `
        id,
        target_type,
        target_id,
        candidate_id,
        position_id,
        submitter_email,
        submitted_by,
        claim,
        claim_type,
        evidence,
        created_at,
        resolved_at,
        resolution_status,
        resolution_note,
        reverify_triggered_at,
        status
      `,
      )
      .is("resolved_at", null)
      .order("created_at", { ascending: true })
      .limit(200),
    supabase
      .from("corrections")
      .select(
        `
        id,
        target_type,
        target_id,
        candidate_id,
        position_id,
        submitter_email,
        submitted_by,
        claim,
        claim_type,
        evidence,
        created_at,
        resolved_at,
        resolution_status,
        resolution_note,
        reverify_triggered_at,
        status
      `,
      )
      .not("resolved_at", "is", null)
      .order("resolved_at", { ascending: false })
      .limit(25),
  ]);

  const unresolved = (unresolvedRes.data ?? []) as unknown as CorrectionRow[];
  const recent = (recentRes.data ?? []) as unknown as CorrectionRow[];

  let breached = 0;
  let inWindow = 0;
  const now = Date.now();
  for (const r of unresolved) {
    const age = now - new Date(r.created_at).getTime();
    if (age > SLA_MS) breached += 1;
    else inWindow += 1;
  }

  return { unresolved, recent, breached, inWindow };
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function fmtTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19) + "Z";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function timeRemaining(createdAt: string): {
  label: string;
  tone: "success" | "warn" | "error";
} {
  const age = Date.now() - new Date(createdAt).getTime();
  const remaining = SLA_MS - age;
  if (remaining <= 0) {
    const overBy = Math.floor(Math.abs(remaining) / (60 * 1000));
    if (overBy >= 60) {
      return {
        label: `${Math.floor(overBy / 60)}h ${overBy % 60}m over`,
        tone: "error",
      };
    }
    return { label: `${overBy}m over`, tone: "error" };
  }
  const minsLeft = Math.floor(remaining / (60 * 1000));
  const tone: "success" | "warn" = minsLeft < 30 ? "warn" : "success";
  if (minsLeft >= 60) {
    return {
      label: `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m left`,
      tone,
    };
  }
  return { label: `${minsLeft}m left`, tone };
}

function StatusDot({
  status,
}: {
  status: "success" | "warn" | "error" | "neutral";
}) {
  const bg =
    status === "success"
      ? "var(--state-success-fg)"
      : status === "warn"
        ? "var(--state-warn-fg)"
        : status === "error"
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

function inferStatus(r: CorrectionRow): {
  label: string;
  tone: "success" | "warn" | "error" | "neutral";
} {
  if (r.resolution_status) {
    const tone: "success" | "warn" | "error" | "neutral" =
      r.resolution_status === "verified_corrected"
        ? "success"
        : r.resolution_status === "no_change_found"
          ? "neutral"
          : r.resolution_status === "dismissed"
            ? "neutral"
            : "warn";
    return { label: r.resolution_status, tone };
  }
  if (r.reverify_triggered_at && !r.resolved_at) {
    return { label: "re-verify pending", tone: "warn" };
  }
  return { label: r.status ?? "submitted", tone: "warn" };
}

function truncate(s: string | null, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function CorrectionsReviewPage() {
  const { unresolved, recent, breached, inWindow } = await load();

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-8">
      <header className="flex items-baseline justify-between border-b border-[var(--civic-border)] pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--civic-text)] tracking-tight">
            Voter corrections
          </h1>
          <p className="text-sm text-[var(--civic-text-muted)] mt-1">
            Re-verify flagged claims against the live source, dismiss
            bad-faith, or accept and patch the canonical row.
          </p>
        </div>
        <div className="text-xs civic-mono text-[var(--civic-text-muted)]">
          {unresolved.length} open · {recent.length} recently resolved ·
          refreshed {fmtTime(new Date().toISOString())}
        </div>
      </header>

      {/* ── SLA banner ──────────────────────────────────────────────── */}
      <div
        className="civic-card text-sm"
        style={{
          background:
            breached > 0
              ? "var(--state-error-bg)"
              : "var(--state-success-bg)",
          color:
            breached > 0
              ? "var(--state-error-fg)"
              : "var(--state-success-fg)",
          borderColor:
            breached > 0
              ? "var(--state-error-fg)"
              : "var(--state-success-fg)",
        }}
      >
        <strong>Corrections SLA:</strong> 2 hours from submission.{" "}
        <span className="civic-tabular">{breached}</span>{" "}
        {breached === 1 ? "item" : "items"} past SLA,{" "}
        <span className="civic-tabular">{inWindow}</span>{" "}
        {inWindow === 1 ? "item" : "items"} inside window.
      </div>

      {/* ── Unresolved table ────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Open corrections
        </h2>
        {unresolved.length === 0 ? (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            No unresolved corrections. Queue is clear.
          </p>
        ) : (
          <div className="civic-card p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-[var(--civic-text-muted)] border-b border-[var(--civic-border)]">
                  <th className="px-4 py-2 font-semibold">Submitter</th>
                  <th className="px-4 py-2 font-semibold">Target</th>
                  <th className="px-4 py-2 font-semibold">Claim</th>
                  <th className="px-4 py-2 font-semibold">Submitted</th>
                  <th className="px-4 py-2 font-semibold">SLA</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {unresolved.map((r) => {
                  const remaining = timeRemaining(r.created_at);
                  const status = inferStatus(r);
                  const submitter =
                    r.submitter_email ?? r.submitted_by ?? "(anon)";
                  const targetType = r.target_type ?? "legacy";
                  const targetId =
                    r.target_id ??
                    r.candidate_id ??
                    r.position_id ??
                    null;
                  const reverifyPending =
                    r.reverify_triggered_at != null && r.resolved_at == null;

                  return (
                    <tr
                      key={r.id}
                      className="border-b border-[var(--civic-border)] last:border-0 align-top"
                    >
                      <td className="px-4 py-3 text-[var(--civic-text)]">
                        <div className="truncate max-w-[180px]">{submitter}</div>
                        {r.claim_type && (
                          <div className="text-xs civic-mono text-[var(--civic-text-muted)] mt-0.5">
                            {r.claim_type}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-xs civic-mono text-[var(--civic-text-muted)]">
                          {targetType}
                        </div>
                        {targetId && (
                          <div className="text-xs civic-mono text-[var(--civic-text)] break-all">
                            {targetId.slice(0, 8)}…
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[var(--civic-text-secondary)] max-w-[280px]">
                        <div>{truncate(r.claim, 160)}</div>
                        {r.evidence && (
                          <div className="mt-1 text-xs text-[var(--civic-text-muted)] italic">
                            evidence: {truncate(r.evidence, 120)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 civic-tabular text-[var(--civic-text-secondary)] whitespace-nowrap">
                        {fmtDate(r.created_at)}{" "}
                        <span className="text-xs text-[var(--civic-text-muted)]">
                          {fmtTime(r.created_at)}
                        </span>
                      </td>
                      <td className="px-4 py-3 civic-tabular whitespace-nowrap">
                        <span
                          className="inline-flex items-center gap-1.5 text-xs"
                          style={{
                            color:
                              remaining.tone === "error"
                                ? "var(--state-error-fg)"
                                : remaining.tone === "warn"
                                  ? "var(--state-warn-fg)"
                                  : "var(--state-success-fg)",
                          }}
                        >
                          <StatusDot status={remaining.tone} />
                          {remaining.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-xs civic-mono">
                          <StatusDot status={status.tone} />
                          {status.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1 min-w-[140px]">
                          <form action={reverifyCorrection}>
                            <input type="hidden" name="id" value={r.id} />
                            <button
                              type="submit"
                              disabled={reverifyPending}
                              className="w-full text-xs civic-mono px-2 py-1 rounded border disabled:opacity-40 disabled:cursor-not-allowed"
                              style={{
                                background: "var(--state-warn-bg)",
                                color: "var(--state-warn-fg)",
                                borderColor: "var(--state-warn-fg)",
                              }}
                            >
                              {reverifyPending
                                ? "re-verify pending…"
                                : "Re-verify now"}
                            </button>
                          </form>
                          <form action={resolveCorrection}>
                            <input type="hidden" name="id" value={r.id} />
                            <button
                              type="submit"
                              className="w-full text-xs civic-mono px-2 py-1 rounded border"
                              style={{
                                background: "var(--state-success-bg)",
                                color: "var(--state-success-fg)",
                                borderColor: "var(--state-success-fg)",
                              }}
                            >
                              Resolve as corrected
                            </button>
                          </form>
                          <form action={dismissCorrection}>
                            <input type="hidden" name="id" value={r.id} />
                            <button
                              type="submit"
                              className="w-full text-xs civic-mono px-2 py-1 rounded border"
                              style={{
                                background: "var(--civic-surface)",
                                color: "var(--state-error-fg)",
                                borderColor: "var(--state-error-fg)",
                              }}
                            >
                              Dismiss
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Recently resolved ───────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Recently resolved · last {recent.length}
        </h2>
        {recent.length === 0 ? (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            No resolved corrections yet.
          </p>
        ) : (
          <details className="civic-card p-0">
            <summary className="px-4 py-2 text-sm cursor-pointer text-[var(--civic-text-secondary)] border-b border-[var(--civic-border)]">
              Show {recent.length} resolved corrections
            </summary>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-[var(--civic-text-muted)] border-b border-[var(--civic-border)]">
                    <th className="px-4 py-2 font-semibold">Submitter</th>
                    <th className="px-4 py-2 font-semibold">Target</th>
                    <th className="px-4 py-2 font-semibold">Claim</th>
                    <th className="px-4 py-2 font-semibold">Resolved</th>
                    <th className="px-4 py-2 font-semibold">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => {
                    const status = inferStatus(r);
                    const submitter =
                      r.submitter_email ?? r.submitted_by ?? "(anon)";
                    return (
                      <tr
                        key={r.id}
                        className="border-b border-[var(--civic-border)] last:border-0 align-top"
                      >
                        <td className="px-4 py-2 text-[var(--civic-text)] truncate max-w-[180px]">
                          {submitter}
                        </td>
                        <td className="px-4 py-2 civic-mono text-xs text-[var(--civic-text-muted)]">
                          {r.target_type ?? "legacy"}
                        </td>
                        <td className="px-4 py-2 text-[var(--civic-text-secondary)] max-w-[280px]">
                          {truncate(r.claim, 120)}
                        </td>
                        <td className="px-4 py-2 civic-tabular text-[var(--civic-text-secondary)] whitespace-nowrap">
                          {fmtDate(r.resolved_at)}
                        </td>
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center gap-1.5 text-xs civic-mono">
                            <StatusDot status={status.tone} />
                            {status.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>

      <footer className="pt-6 border-t border-[var(--civic-border)] text-xs text-[var(--civic-text-muted)]">
        Queries: <code className="civic-mono">corrections</code>{" "}
        (resolved_at IS NULL sorted ascending by submission). Re-verify fires{" "}
        <code className="civic-mono">corrections/flagged.received</code> into{" "}
        <code className="civic-mono">correction-reverify</code> (2h SLA).
      </footer>
    </div>
  );
}
