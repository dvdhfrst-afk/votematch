import { createServiceClient } from "@/lib/supabase/server";
import {
  resolveDedupMerge,
  resolveDedupSplit,
  resolveDedupDefer,
  reopenDedup,
} from "./actions";

// ---------------------------------------------------------------------------
// /admin/dedup-queue — People-dedup ambiguous-cluster review
// ---------------------------------------------------------------------------
// Replaces the file-only v1 surface that morning-review used to count
// against. Each row = one cluster of `people` rows the dedup pass flagged
// as ambiguous (same canonical_key + state, but the heuristic couldn't
// decide whether they're the same human). Editor picks Merge / Split /
// Defer; the verdict is recorded but the actual data-level merge is run
// later by scripts/apply-dedup-merges.ts.
//
// Auth inherited from /admin/layout.tsx. Actions re-verify role.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

// FIPS → state abbreviation map (matches /admin/coverage).
const FIPS_ABBR: Record<string, string> = {
  "01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT","10":"DE",
  "11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL","18":"IN","19":"IA",
  "20":"KS","21":"KY","22":"LA","23":"ME","24":"MD","25":"MA","26":"MI","27":"MN",
  "28":"MS","29":"MO","30":"MT","31":"NE","32":"NV","33":"NH","34":"NJ","35":"NM",
  "36":"NY","37":"NC","38":"ND","39":"OH","40":"OK","41":"OR","42":"PA","44":"RI",
  "45":"SC","46":"SD","47":"TN","48":"TX","49":"UT","50":"VT","51":"VA","53":"WA",
  "54":"WV","55":"WI","56":"WY","60":"AS","66":"GU","69":"MP","72":"PR","78":"VI",
};

type CandidatePerson = {
  id: string;
  canonical_name: string;
  birth_year: number | null;
  state_fips: string[] | null;
  state_fips_primary: string | null;
  meta: Record<string, unknown> | null;
  office_signals: unknown[] | null;
  candidacies_count: number;
  tenures_count: number;
};

type DedupRow = {
  id: string;
  canonical_key: string;
  state_fips: string | null;
  blocker_category: string;
  blocker_explanation: string;
  candidate_people: CandidatePerson[];
  people_count: number;
  created_at: string;
  reviewed_at: string | null;
  resolution: string | null;
  resolution_target_person_id: string | null;
  resolution_note: string | null;
  source_file: string;
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

async function load(): Promise<{
  open: DedupRow[];
  recent: DedupRow[];
  byBlocker: Map<string, number>;
}> {
  const supabase = await createServiceClient();
  const [openRes, recentRes] = await Promise.all([
    supabase
      .from("dedup_review_queue")
      .select(`
        id, canonical_key, state_fips, blocker_category, blocker_explanation,
        candidate_people, people_count, created_at, reviewed_at, resolution,
        resolution_target_person_id, resolution_note, source_file
      `)
      .is("reviewed_at", null)
      .order("created_at", { ascending: true })
      .limit(200),
    supabase
      .from("dedup_review_queue")
      .select(`
        id, canonical_key, state_fips, blocker_category, blocker_explanation,
        candidate_people, people_count, created_at, reviewed_at, resolution,
        resolution_target_person_id, resolution_note, source_file
      `)
      .not("reviewed_at", "is", null)
      .order("reviewed_at", { ascending: false })
      .limit(25),
  ]);

  const open = (openRes.data ?? []) as unknown as DedupRow[];
  const recent = (recentRes.data ?? []) as unknown as DedupRow[];

  const byBlocker = new Map<string, number>();
  for (const r of open) {
    byBlocker.set(r.blocker_category, (byBlocker.get(r.blocker_category) ?? 0) + 1);
  }

  return { open, recent, byBlocker };
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h ago`;
  return `${Math.floor(ms / (60 * 1000))}m ago`;
}

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

function blockerTone(b: string): "warn" | "error" | "neutral" {
  if (b === "conflicting_strong_id") return "error";
  if (b === "different_offices_same_state") return "warn";
  return "neutral";
}

function resolutionTone(r: string | null): "success" | "warn" | "neutral" {
  if (r === "merge") return "success";
  if (r === "split") return "neutral";
  if (r === "defer") return "warn";
  return "neutral";
}

function stateLabel(fips: string | null): string {
  if (!fips) return "—";
  return FIPS_ABBR[fips] ?? fips;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DedupQueuePage() {
  const { open, recent, byBlocker } = await load();
  const totalOpen = open.length;
  const insuffEv = byBlocker.get("insufficient_evidence") ?? 0;
  const diffOffices = byBlocker.get("different_offices_same_state") ?? 0;
  const conflictId = byBlocker.get("conflicting_strong_id") ?? 0;

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-8">
      <header className="flex items-baseline justify-between border-b border-[var(--civic-border)] pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--civic-text)] tracking-tight">
            People-dedup review
          </h1>
          <p className="text-sm text-[var(--civic-text-muted)] mt-1">
            Ambiguous clusters from <code className="civic-mono">scripts/dedup-people.ts</code>.
            Verdicts are recorded here; the data-level merge is applied by{" "}
            <code className="civic-mono">scripts/apply-dedup-merges.ts</code>.
          </p>
        </div>
        <div className="text-xs civic-mono text-[var(--civic-text-muted)]">
          {totalOpen} open · {recent.length} recently resolved
        </div>
      </header>

      {/* Summary strip */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="civic-card">
          <div className="text-xs civic-mono text-[var(--civic-text-muted)] uppercase tracking-wider">
            insufficient_evidence
          </div>
          <div className="text-3xl font-semibold civic-tabular mt-1 text-[var(--civic-text)]">
            {insuffEv.toLocaleString()}
          </div>
          <div className="text-xs text-[var(--civic-text-muted)] mt-1">
            Same name + state, no corroborating signal. Default = SPLIT.
          </div>
        </div>
        <div className="civic-card">
          <div className="text-xs civic-mono text-[var(--civic-text-muted)] uppercase tracking-wider">
            different_offices_same_state
          </div>
          <div
            className="text-3xl font-semibold civic-tabular mt-1"
            style={{ color: diffOffices === 0 ? "var(--state-success-fg)" : "var(--state-warn-fg)" }}
          >
            {diffOffices.toLocaleString()}
          </div>
          <div className="text-xs text-[var(--civic-text-muted)] mt-1">
            Same name in same state, different offices. Could be the same human running for
            different seats over time.
          </div>
        </div>
        <div className="civic-card">
          <div className="text-xs civic-mono text-[var(--civic-text-muted)] uppercase tracking-wider">
            conflicting_strong_id
          </div>
          <div
            className="text-3xl font-semibold civic-tabular mt-1"
            style={{ color: conflictId === 0 ? "var(--state-success-fg)" : "var(--state-error-fg)" }}
          >
            {conflictId.toLocaleString()}
          </div>
          <div className="text-xs text-[var(--civic-text-muted)] mt-1">
            Same name + state but persistent IDs disagree. High-priority — likely a true dupe
            with bad upstream ID.
          </div>
        </div>
      </div>

      {/* Open clusters */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Open clusters
        </h2>
        {open.length === 0 ? (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            Queue is empty. Either nothing has been loaded
            (run <code className="civic-mono">npm run db:load-dedup-queue</code>),
            or every cluster has been resolved.
          </p>
        ) : (
          <div className="space-y-3">
            {open.map((row) => (
              <DedupCard key={row.id} row={row} />
            ))}
          </div>
        )}
      </section>

      {/* Recently resolved */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Recently resolved · last {recent.length}
        </h2>
        {recent.length === 0 ? (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            No resolved clusters yet.
          </p>
        ) : (
          <details className="civic-card p-0">
            <summary className="px-4 py-2 text-sm cursor-pointer text-[var(--civic-text-secondary)] border-b border-[var(--civic-border)]">
              Show {recent.length} resolved clusters
            </summary>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-[var(--civic-text-muted)] border-b border-[var(--civic-border)]">
                    <th className="px-4 py-2 font-semibold">Cluster</th>
                    <th className="px-4 py-2 font-semibold">State</th>
                    <th className="px-4 py-2 font-semibold">People</th>
                    <th className="px-4 py-2 font-semibold">Outcome</th>
                    <th className="px-4 py-2 font-semibold">Resolved</th>
                    <th className="px-4 py-2 font-semibold">Note</th>
                    <th className="px-4 py-2 font-semibold">Undo</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-[var(--civic-border)] last:border-0 align-top"
                    >
                      <td className="px-4 py-2 civic-mono text-xs">
                        {r.canonical_key}
                      </td>
                      <td className="px-4 py-2 civic-mono text-xs">
                        {stateLabel(r.state_fips)}
                      </td>
                      <td className="px-4 py-2 civic-tabular text-[var(--civic-text-secondary)]">
                        {r.people_count}
                      </td>
                      <td className="px-4 py-2">
                        <span className="inline-flex items-center gap-1.5 text-xs civic-mono">
                          <StatusDot tone={resolutionTone(r.resolution)} />
                          {r.resolution ?? "—"}
                        </span>
                      </td>
                      <td className="px-4 py-2 civic-tabular text-[var(--civic-text-secondary)]">
                        {fmtDate(r.reviewed_at)}
                      </td>
                      <td className="px-4 py-2 text-xs text-[var(--civic-text-muted)] max-w-xs truncate">
                        {r.resolution_note ?? "—"}
                      </td>
                      <td className="px-4 py-2">
                        <form action={reopenDedup}>
                          <input type="hidden" name="id" value={r.id} />
                          <button
                            type="submit"
                            className="text-xs civic-mono px-2 py-1 rounded border border-[var(--civic-border)] hover:bg-[var(--civic-surface-sunken)]"
                          >
                            Re-open
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
        Source: <code className="civic-mono">dedup_review_queue</code>. Hydrate from JSON via{" "}
        <code className="civic-mono">tsx --env-file .env.local scripts/load-dedup-review-queue.ts</code>.
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DedupCard — one cluster, with the people preview + per-row actions
// ---------------------------------------------------------------------------

function DedupCard({ row }: { row: DedupRow }) {
  const blockerToneVal = blockerTone(row.blocker_category);
  const people = row.candidate_people ?? [];
  return (
    <div
      className="civic-card space-y-3"
      style={
        blockerToneVal === "error"
          ? { borderColor: "var(--state-error-fg)" }
          : blockerToneVal === "warn"
            ? { borderColor: "var(--state-warn-fg)" }
            : undefined
      }
    >
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="space-y-0.5">
          <div className="text-xs civic-mono text-[var(--civic-text-muted)]">
            {stateLabel(row.state_fips)} · {row.people_count} candidate row
            {row.people_count === 1 ? "" : "s"}
          </div>
          <div className="text-base font-semibold text-[var(--civic-text)]">
            {row.canonical_key}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs civic-mono">
            <StatusDot tone={blockerToneVal} />
            {row.blocker_category}
          </span>
          <span className="text-xs civic-tabular text-[var(--civic-text-muted)]">
            queued {fmtAge(row.created_at)}
          </span>
        </div>
      </div>

      {/* Blocker explanation */}
      <div className="text-sm text-[var(--civic-text-secondary)] border-l-2 border-[var(--civic-border)] pl-3">
        {row.blocker_explanation}
      </div>

      {/* People table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-[var(--civic-text-muted)] border-b border-[var(--civic-border)]">
              <th className="px-2 py-1 font-semibold">person_id</th>
              <th className="px-2 py-1 font-semibold">Name</th>
              <th className="px-2 py-1 font-semibold">DoB</th>
              <th className="px-2 py-1 font-semibold text-right">Candidacies</th>
              <th className="px-2 py-1 font-semibold text-right">Tenures</th>
              <th className="px-2 py-1 font-semibold">Source</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const src =
                typeof p.meta?.source === "string"
                  ? (p.meta.source as string)
                  : "—";
              return (
                <tr
                  key={p.id}
                  className="border-b border-[var(--civic-border)] last:border-0 align-top"
                >
                  <td className="px-2 py-2 civic-mono text-xs text-[var(--civic-text-muted)]">
                    {p.id.slice(0, 8)}…
                  </td>
                  <td className="px-2 py-2 text-[var(--civic-text)]">
                    {p.canonical_name}
                  </td>
                  <td className="px-2 py-2 civic-tabular text-xs text-[var(--civic-text-muted)]">
                    {p.birth_year ?? "—"}
                  </td>
                  <td className="px-2 py-2 civic-tabular text-right">
                    {p.candidacies_count}
                  </td>
                  <td className="px-2 py-2 civic-tabular text-right">
                    {p.tenures_count}
                  </td>
                  <td className="px-2 py-2 civic-mono text-xs text-[var(--civic-text-muted)]">
                    {src}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-3 border-t border-[var(--civic-border)] flex-wrap">
        {/* Merge — pick a target. We render one merge button per candidate so
            the editor picks the survivor by clicking; this avoids a separate
            modal/select UI for v1 and keeps the click-count low. */}
        <span className="text-xs civic-mono text-[var(--civic-text-muted)]">Merge into:</span>
        {people.map((p) => (
          <form action={resolveDedupMerge} key={p.id}>
            <input type="hidden" name="id" value={row.id} />
            <input type="hidden" name="target_person_id" value={p.id} />
            <button
              type="submit"
              className="text-xs civic-mono px-2 py-1 rounded border"
              style={{
                background: "var(--state-success-bg)",
                color: "var(--state-success-fg)",
                borderColor: "var(--state-success-fg)",
              }}
              title={`Merge cluster into ${p.canonical_name} (${p.id.slice(0, 8)}…)`}
            >
              {p.canonical_name}
            </button>
          </form>
        ))}

        <span className="mx-2 text-[var(--civic-border-strong)]">|</span>

        <form action={resolveDedupSplit}>
          <input type="hidden" name="id" value={row.id} />
          <button
            type="submit"
            className="text-xs civic-mono px-3 py-1 rounded border"
            style={{
              background: "var(--civic-surface)",
              color: "var(--civic-text)",
              borderColor: "var(--civic-border-strong)",
            }}
          >
            Split (distinct people)
          </button>
        </form>

        <form action={resolveDedupDefer}>
          <input type="hidden" name="id" value={row.id} />
          <button
            type="submit"
            className="text-xs civic-mono px-3 py-1 rounded border"
            style={{
              background: "var(--state-warn-bg)",
              color: "var(--state-warn-fg)",
              borderColor: "var(--state-warn-fg)",
            }}
          >
            Defer
          </button>
        </form>

        <span className="ml-auto text-xs civic-tabular text-[var(--civic-text-muted)]">
          id: <code className="civic-mono">{row.id.slice(0, 8)}</code>
        </span>
      </div>
    </div>
  );
}
