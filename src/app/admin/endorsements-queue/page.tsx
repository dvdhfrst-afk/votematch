import { createServiceClient } from "@/lib/supabase/server";
import {
  approveEndorsement,
  rejectEndorsement,
  rescindEndorsement,
} from "./actions";

// ---------------------------------------------------------------------------
// /admin/endorsements-queue — Human-in-the-loop publish gate
// ---------------------------------------------------------------------------
// Lists endorsements with published=FALSE and lets an editor/admin flip the
// publish bit. This is the *only* path (outside of a manual SQL patch) that
// should ever set published=TRUE; the DB CHECK constraint + trigger enforces
// the rest (reviewed_by + reviewed_at + URL; reviewer role in editor/admin).
//
// Auth: inherited from app/admin/layout.tsx — layout already redirected the
// non-editor/non-admin before we ran. We still re-verify role inside the
// Server Actions (belt-and-suspenders; Server Actions receive form posts
// that could theoretically be hand-crafted).
//
// Styling: neutral-gray ops dashboard to match /admin/coverage. No partisan
// color anywhere. Extraction-provenance warnings use the state-warn/error
// CSS vars already defined globally.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types (loose — generated db types don't yet cover these joined shapes)
// ---------------------------------------------------------------------------

type PendingEndorsement = {
  id: string;
  endorsement_date: string;
  endorsement_url: string | null;
  archive_url: string | null;
  excerpt: string | null;
  supporting_quote: string | null;
  endorsement_type: string | null;
  extracted_by: string | null;
  extraction_confidence: number | null;
  rescinded_at: string | null;
  created_at: string;
  meta: Record<string, unknown> | null;
  endorsers: {
    canonical_name: string;
    endorser_type: string;
  } | null;
  candidacies: {
    id: string;
    party: string | null;
    people: {
      canonical_name: string;
    } | null;
  } | null;
};

type PublishedEndorsement = {
  id: string;
  endorsement_date: string;
  endorsement_url: string | null;
  reviewed_at: string | null;
  rescinded_at: string | null;
  endorsers: { canonical_name: string } | null;
  candidacies: {
    people: { canonical_name: string } | null;
  } | null;
};

// ---------------------------------------------------------------------------
// Data loader
// ---------------------------------------------------------------------------

async function load(): Promise<{
  pending: PendingEndorsement[];
  published: PublishedEndorsement[];
}> {
  const supabase = await createServiceClient();

  const selectPending = `
    id,
    endorsement_date,
    endorsement_url,
    archive_url,
    excerpt,
    supporting_quote,
    endorsement_type,
    extracted_by,
    extraction_confidence,
    rescinded_at,
    created_at,
    meta,
    endorsers!inner ( canonical_name, endorser_type ),
    candidacies!inner (
      id,
      party,
      people!inner ( canonical_name )
    )
  `;

  const selectPublished = `
    id,
    endorsement_date,
    endorsement_url,
    reviewed_at,
    rescinded_at,
    endorsers!inner ( canonical_name ),
    candidacies!inner (
      people!inner ( canonical_name )
    )
  `;

  const [pendingRes, publishedRes] = await Promise.all([
    supabase
      .from("endorsements")
      .select(selectPending)
      .eq("published", false)
      .is("rescinded_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("endorsements")
      .select(selectPublished)
      .eq("published", true)
      .order("reviewed_at", { ascending: false })
      .limit(50),
  ]);

  const pending = (pendingRes.data ?? []) as unknown as PendingEndorsement[];
  const published = (publishedRes.data ?? []) as unknown as PublishedEndorsement[];

  return { pending, published };
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function truncate(text: string | null, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "…";
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

/**
 * Derive a display-status from the endorsement row. `validation_status` isn't a
 * top-level column on `endorsements` — it may be stashed in `meta` by the
 * extractor, or we can infer from `extracted_by` + `extraction_confidence`.
 */
function validationStatusOf(e: PendingEndorsement): {
  label: string;
  tone: "success" | "warn" | "error" | "neutral";
} {
  const metaStatus =
    (e.meta as { validation_status?: string } | null)?.validation_status ?? null;

  if (metaStatus === "flagged" || metaStatus === "rejected") {
    return { label: metaStatus, tone: "error" };
  }
  if (metaStatus === "auto_passed" || metaStatus === "human_verified") {
    return { label: metaStatus, tone: "success" };
  }
  if (metaStatus === "pending") {
    return { label: "pending", tone: "warn" };
  }

  // No explicit meta.validation_status — infer from provenance.
  if (e.extracted_by === "human" || e.extracted_by === "manual_entry") {
    return { label: "human-entered", tone: "success" };
  }
  if (e.extracted_by === "ai_extraction_verified") {
    const conf = e.extraction_confidence ?? 0;
    if (conf >= 0.85) return { label: `ai · conf ${conf.toFixed(2)}`, tone: "warn" };
    return { label: `ai · low conf ${conf.toFixed(2)}`, tone: "error" };
  }
  return { label: e.extracted_by ?? "unknown", tone: "neutral" };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function EndorsementsQueuePage() {
  const { pending, published } = await load();

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-10">
      <header className="flex items-baseline justify-between border-b border-[var(--civic-border)] pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--civic-text)] tracking-tight">
            Endorsement review queue
          </h1>
          <p className="text-sm text-[var(--civic-text-muted)] mt-1">
            Approve, reject, or rescind endorsements. Approved rows go public
            immediately — make sure the URL and excerpt are defensible.
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
            Queue is empty. Nothing to review.
          </p>
        ) : (
          <div className="space-y-3">
            {pending.map((e) => {
              const endorserName = e.endorsers?.canonical_name ?? "—";
              const endorserType = e.endorsers?.endorser_type ?? "—";
              const candidateName =
                e.candidacies?.people?.canonical_name ?? "—";
              const party = e.candidacies?.party ?? null;
              const missingUrl = !e.endorsement_url;
              const vs = validationStatusOf(e);
              const isFlaggedOrUnverified =
                vs.tone === "error" ||
                e.extracted_by === "ai_extraction_verified";

              return (
                <div
                  key={e.id}
                  className="civic-card space-y-3"
                  style={
                    isFlaggedOrUnverified
                      ? { borderColor: "var(--state-warn-fg)" }
                      : undefined
                  }
                >
                  {/* Header row: endorser → candidate */}
                  <div className="flex items-baseline justify-between gap-4 flex-wrap">
                    <div className="space-y-0.5">
                      <div className="text-sm text-[var(--civic-text-muted)] civic-mono">
                        {endorserType}
                      </div>
                      <div className="text-base font-semibold text-[var(--civic-text)]">
                        {endorserName}
                      </div>
                      <div className="text-sm text-[var(--civic-text-secondary)]">
                        → endorses{" "}
                        <span className="font-semibold text-[var(--civic-text)]">
                          {candidateName}
                        </span>
                        {party && (
                          <span className="ml-2 text-xs civic-mono text-[var(--civic-text-muted)]">
                            ({party})
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="inline-flex items-center gap-1.5 text-xs civic-mono">
                        <StatusDot status={vs.tone} />
                        {vs.label}
                      </span>
                      <span className="text-xs civic-tabular text-[var(--civic-text-muted)]">
                        endorsed {fmtDate(e.endorsement_date)}
                      </span>
                    </div>
                  </div>

                  {/* Flagged banner */}
                  {isFlaggedOrUnverified && (
                    <div
                      className="text-xs civic-mono px-3 py-2 rounded"
                      style={{
                        background: "var(--state-warn-bg)",
                        color: "var(--state-warn-fg)",
                      }}
                    >
                      ⚠ flagged / unverified — AI extraction requires human
                      confirmation before publish
                    </div>
                  )}

                  {/* URLs + metadata */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                    <div>
                      <span className="text-[var(--civic-text-muted)] civic-mono text-xs">
                        endorsement_url
                      </span>{" "}
                      {e.endorsement_url ? (
                        <a
                          href={e.endorsement_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--civic-primary)] hover:underline break-all"
                        >
                          {truncate(e.endorsement_url, 80)}
                        </a>
                      ) : (
                        <span className="text-[var(--state-error-fg)] civic-mono">
                          missing — cannot publish
                        </span>
                      )}
                    </div>
                    <div>
                      <span className="text-[var(--civic-text-muted)] civic-mono text-xs">
                        archive_url
                      </span>{" "}
                      {e.archive_url ? (
                        <a
                          href={e.archive_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--civic-primary)] hover:underline break-all"
                        >
                          {truncate(e.archive_url, 80)}
                        </a>
                      ) : (
                        <span className="text-[var(--civic-text-muted)]">—</span>
                      )}
                    </div>
                    {e.endorsement_type && (
                      <div>
                        <span className="text-[var(--civic-text-muted)] civic-mono text-xs">
                          type
                        </span>{" "}
                        <span className="civic-mono text-xs">
                          {e.endorsement_type}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Excerpt */}
                  {e.excerpt && (
                    <div className="text-sm text-[var(--civic-text-secondary)] border-l-2 border-[var(--civic-border)] pl-3">
                      {truncate(e.excerpt, 300)}
                    </div>
                  )}

                  {/* Supporting quote */}
                  {e.supporting_quote && (
                    <div className="text-sm text-[var(--civic-text)] italic">
                      “{truncate(e.supporting_quote, 300)}”
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-2 pt-2 border-t border-[var(--civic-border)]">
                    <form action={approveEndorsement}>
                      <input type="hidden" name="id" value={e.id} />
                      <button
                        type="submit"
                        disabled={missingUrl}
                        className="text-sm px-3 py-1.5 rounded border civic-mono disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{
                          background: "var(--state-success-bg)",
                          color: "var(--state-success-fg)",
                          borderColor: "var(--state-success-fg)",
                        }}
                      >
                        Approve &amp; publish
                      </button>
                    </form>
                    <form action={rejectEndorsement}>
                      <input type="hidden" name="id" value={e.id} />
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
                      id: <code className="civic-mono">{e.id.slice(0, 8)}</code>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Published (last 50, rescindable) ───────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Published endorsements · last {published.length}
        </h2>
        {published.length === 0 ? (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            No published endorsements yet.
          </p>
        ) : (
          <details className="civic-card p-0">
            <summary className="px-4 py-2 text-sm cursor-pointer text-[var(--civic-text-secondary)] border-b border-[var(--civic-border)]">
              Show {published.length} published endorsements
            </summary>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-[var(--civic-text-muted)] border-b border-[var(--civic-border)]">
                    <th className="px-4 py-2 font-semibold">Endorser</th>
                    <th className="px-4 py-2 font-semibold">Candidate</th>
                    <th className="px-4 py-2 font-semibold">Endorsed</th>
                    <th className="px-4 py-2 font-semibold">Reviewed</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2 font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {published.map((p) => {
                    const rescinded = p.rescinded_at !== null;
                    return (
                      <tr
                        key={p.id}
                        className="border-b border-[var(--civic-border)] last:border-0 align-top"
                      >
                        <td className="px-4 py-2 text-[var(--civic-text)]">
                          {p.endorsers?.canonical_name ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-[var(--civic-text)]">
                          {p.candidacies?.people?.canonical_name ?? "—"}
                        </td>
                        <td className="px-4 py-2 civic-tabular text-[var(--civic-text-secondary)]">
                          {fmtDate(p.endorsement_date)}
                        </td>
                        <td className="px-4 py-2 civic-tabular text-[var(--civic-text-secondary)]">
                          {fmtDate(p.reviewed_at)}
                        </td>
                        <td className="px-4 py-2">
                          {rescinded ? (
                            <span className="inline-flex items-center gap-1.5 text-xs civic-mono">
                              <StatusDot status="error" />
                              rescinded
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-xs civic-mono">
                              <StatusDot status="success" />
                              live
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          {rescinded ? (
                            <span className="text-xs text-[var(--civic-text-muted)]">
                              —
                            </span>
                          ) : (
                            <form action={rescindEndorsement}>
                              <input type="hidden" name="id" value={p.id} />
                              <input
                                type="text"
                                name="reason"
                                placeholder="reason (optional)"
                                className="text-xs px-2 py-1 border border-[var(--civic-border)] rounded w-48 mr-2"
                              />
                              <button
                                type="submit"
                                className="text-xs px-2 py-1 rounded border civic-mono"
                                style={{
                                  color: "var(--state-error-fg)",
                                  borderColor: "var(--state-error-fg)",
                                }}
                              >
                                Rescind
                              </button>
                            </form>
                          )}
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
        Queries: <code className="civic-mono">endorsements</code> (published=FALSE
        pending; published=TRUE last 50). Trigger{" "}
        <code className="civic-mono">trg_endorsement_reviewer_role</code>{" "}
        enforces reviewer role ∈ (editor, admin) at the DB layer.
      </footer>
    </div>
  );
}
