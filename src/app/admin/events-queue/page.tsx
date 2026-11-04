import { createServiceClient } from "@/lib/supabase/server";
import { approveEvent, rejectEvent, rescindEvent } from "./actions";

// ---------------------------------------------------------------------------
// /admin/events-queue — Review queue for candidate_events (debates, forums)
// ---------------------------------------------------------------------------
// Same publish-gate pattern as endorsements but simpler: no URL requirement
// (just reviewed_by + reviewed_at), and fewer fields to eyeball. Auth via
// admin/layout.tsx; server actions re-verify role and the
// `trg_candidate_event_reviewer_role` trigger enforces at the DB layer.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PendingEvent = {
  id: string;
  event_type: string;
  event_name: string | null;
  event_datetime: string;
  duration_minutes: number | null;
  timezone: string | null;
  location_description: string | null;
  virtual_url: string | null;
  moderator_names: string[] | null;
  created_at: string;
  endorsers: { canonical_name: string } | null;
  offices: { canonical_name: string } | null;
  elections: { election_date: string; election_type: string } | null;
};

type PublishedEvent = {
  id: string;
  event_type: string;
  event_name: string | null;
  event_datetime: string;
  reviewed_at: string | null;
  location_description: string | null;
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

async function load(): Promise<{
  pending: PendingEvent[];
  published: PublishedEvent[];
}> {
  const supabase = await createServiceClient();

  const selectPending = `
    id,
    event_type,
    event_name,
    event_datetime,
    duration_minutes,
    timezone,
    location_description,
    virtual_url,
    moderator_names,
    created_at,
    endorsers:host_endorser_id ( canonical_name ),
    offices:office_id ( canonical_name ),
    elections:election_id ( election_date, election_type )
  `;

  const selectPublished = `
    id,
    event_type,
    event_name,
    event_datetime,
    reviewed_at,
    location_description
  `;

  const [pendingRes, publishedRes] = await Promise.all([
    supabase
      .from("candidate_events")
      .select(selectPending)
      .eq("published", false)
      .order("event_datetime", { ascending: true })
      .limit(200),
    supabase
      .from("candidate_events")
      .select(selectPublished)
      .eq("published", true)
      .order("reviewed_at", { ascending: false })
      .limit(50),
  ]);

  const pending = (pendingRes.data ?? []) as unknown as PendingEvent[];
  const published = (publishedRes.data ?? []) as unknown as PublishedEvent[];

  return { pending, published };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDateTime(iso: string | null, tz: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const base = d.toISOString().slice(0, 16).replace("T", " ");
  return tz ? `${base}Z (${tz})` : `${base}Z`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function EventsQueuePage() {
  const { pending, published } = await load();

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-10">
      <header className="flex items-baseline justify-between border-b border-[var(--civic-border)] pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--civic-text)] tracking-tight">
            Candidate events review queue
          </h1>
          <p className="text-sm text-[var(--civic-text-muted)] mt-1">
            Debates, forums, town halls. Publishing makes them visible on
            voter-facing "upcoming events" surfaces.
          </p>
        </div>
        <div className="text-xs civic-mono text-[var(--civic-text-muted)]">
          {pending.length} pending · {published.length} recently published
        </div>
      </header>

      {/* ── Pending review ─────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Pending review
        </h2>
        {pending.length === 0 ? (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            Queue is empty.
          </p>
        ) : (
          <div className="space-y-3">
            {pending.map((ev) => {
              const moderators = (ev.moderator_names ?? []).filter(
                (m) => m && m.length > 0,
              );
              return (
                <div key={ev.id} className="civic-card space-y-3">
                  <div className="flex items-baseline justify-between gap-4 flex-wrap">
                    <div>
                      <div className="text-xs civic-mono text-[var(--civic-text-muted)]">
                        {ev.event_type}
                      </div>
                      <div className="text-base font-semibold text-[var(--civic-text)]">
                        {ev.event_name ?? "(unnamed event)"}
                      </div>
                    </div>
                    <div className="text-sm civic-tabular text-[var(--civic-text-secondary)]">
                      {fmtDateTime(ev.event_datetime, ev.timezone)}
                      {ev.duration_minutes && (
                        <span className="ml-2 text-xs text-[var(--civic-text-muted)]">
                          {ev.duration_minutes}m
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                    <div>
                      <span className="text-[var(--civic-text-muted)] civic-mono text-xs">
                        location
                      </span>{" "}
                      {ev.location_description ?? "—"}
                    </div>
                    <div>
                      <span className="text-[var(--civic-text-muted)] civic-mono text-xs">
                        virtual_url
                      </span>{" "}
                      {ev.virtual_url ? (
                        <a
                          href={ev.virtual_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--civic-primary)] hover:underline break-all"
                        >
                          {ev.virtual_url.length > 60
                            ? ev.virtual_url.slice(0, 60) + "…"
                            : ev.virtual_url}
                        </a>
                      ) : (
                        "—"
                      )}
                    </div>
                    <div>
                      <span className="text-[var(--civic-text-muted)] civic-mono text-xs">
                        host
                      </span>{" "}
                      {ev.endorsers?.canonical_name ?? "—"}
                    </div>
                    <div>
                      <span className="text-[var(--civic-text-muted)] civic-mono text-xs">
                        moderators
                      </span>{" "}
                      {moderators.length > 0 ? moderators.join(", ") : "—"}
                    </div>
                    <div>
                      <span className="text-[var(--civic-text-muted)] civic-mono text-xs">
                        office
                      </span>{" "}
                      {ev.offices?.canonical_name ?? "—"}
                    </div>
                    <div>
                      <span className="text-[var(--civic-text-muted)] civic-mono text-xs">
                        election
                      </span>{" "}
                      {ev.elections
                        ? `${fmtDate(ev.elections.election_date)} · ${ev.elections.election_type}`
                        : "—"}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-2 border-t border-[var(--civic-border)]">
                    <form action={approveEvent}>
                      <input type="hidden" name="id" value={ev.id} />
                      <button
                        type="submit"
                        className="text-sm px-3 py-1.5 rounded border civic-mono"
                        style={{
                          background: "var(--state-success-bg)",
                          color: "var(--state-success-fg)",
                          borderColor: "var(--state-success-fg)",
                        }}
                      >
                        Approve &amp; publish
                      </button>
                    </form>
                    <form action={rejectEvent}>
                      <input type="hidden" name="id" value={ev.id} />
                      <button
                        type="submit"
                        className="text-sm px-3 py-1.5 rounded border civic-mono"
                        style={{
                          background: "var(--civic-surface)",
                          color: "var(--state-error-fg)",
                          borderColor: "var(--state-error-fg)",
                        }}
                      >
                        Reject
                      </button>
                    </form>
                    <span className="ml-auto text-xs civic-tabular text-[var(--civic-text-muted)]">
                      id:{" "}
                      <code className="civic-mono">{ev.id.slice(0, 8)}</code>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Published ──────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Published events · last {published.length}
        </h2>
        {published.length === 0 ? (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            No published events yet.
          </p>
        ) : (
          <details className="civic-card p-0">
            <summary className="px-4 py-2 text-sm cursor-pointer text-[var(--civic-text-secondary)] border-b border-[var(--civic-border)]">
              Show {published.length} published events
            </summary>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-[var(--civic-text-muted)] border-b border-[var(--civic-border)]">
                    <th className="px-4 py-2 font-semibold">Event</th>
                    <th className="px-4 py-2 font-semibold">When</th>
                    <th className="px-4 py-2 font-semibold">Where</th>
                    <th className="px-4 py-2 font-semibold">Reviewed</th>
                    <th className="px-4 py-2 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {published.map((p) => (
                    <tr
                      key={p.id}
                      className="border-b border-[var(--civic-border)] last:border-0 align-top"
                    >
                      <td className="px-4 py-2">
                        <div className="text-xs civic-mono text-[var(--civic-text-muted)]">
                          {p.event_type}
                        </div>
                        <div className="text-[var(--civic-text)]">
                          {p.event_name ?? "(unnamed)"}
                        </div>
                      </td>
                      <td className="px-4 py-2 civic-tabular text-[var(--civic-text-secondary)]">
                        {fmtDateTime(p.event_datetime, null)}
                      </td>
                      <td className="px-4 py-2 text-[var(--civic-text-secondary)]">
                        {p.location_description ?? "—"}
                      </td>
                      <td className="px-4 py-2 civic-tabular text-[var(--civic-text-secondary)]">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <StatusDot status="success" />
                          {fmtDate(p.reviewed_at)}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <form action={rescindEvent}>
                          <input type="hidden" name="id" value={p.id} />
                          <button
                            type="submit"
                            className="text-xs px-2 py-1 rounded border civic-mono"
                            style={{
                              color: "var(--state-error-fg)",
                              borderColor: "var(--state-error-fg)",
                            }}
                          >
                            Unpublish
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>

      <footer className="pt-6 border-t border-[var(--civic-border)] text-xs text-[var(--civic-text-muted)]">
        Queries: <code className="civic-mono">candidate_events</code>. Trigger{" "}
        <code className="civic-mono">trg_candidate_event_reviewer_role</code>{" "}
        enforces reviewer role ∈ (editor, admin).
      </footer>
    </div>
  );
}
