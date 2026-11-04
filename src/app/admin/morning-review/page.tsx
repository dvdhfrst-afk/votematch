import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import {
  batchApproveEndorsementsSamePaperSameDay,
  batchResolveFecSameCommittee,
} from "./actions";

// ---------------------------------------------------------------------------
// /admin/morning-review — Aggregator dashboard
// ---------------------------------------------------------------------------
// One-stop "what needs a human today" view. Five queues, five counts,
// a preview of the three oldest items in each, and single-click batch
// approve where the pattern is well-defined:
//
//   1. Endorsement publish-gate   → published = FALSE AND rescinded_at IS NULL
//      Batch = "approve all same-paper same-day" (same endorser_id +
//      endorsement_date). Safe because once you've read one op-ed
//      the rest from the same paper on the same day are usually the
//      same editorial board's slate.
//
//   2. FEC ambiguous              → resolved_at IS NULL on fec_match_ambiguous
//      Batch = "approve all same-committee" — resolves every row where
//      candidate_matches all point to a single committee_id.
//
//   3. Dedup ambiguous            → dedup_review_queue.reviewed_at IS NULL
//      Hydrated from scripts/data/dedup-people-manual-review.json by
//      scripts/load-dedup-review-queue.ts. Routes to /admin/dedup-queue
//      for per-row Merge / Split / Defer actions.
//
//   4. Extraction flagged         → validation_status='flagged' on extraction_audit
//      No batch. Flags exist for a reason; human must look.
//
//   5. Voter corrections          → resolved_at IS NULL on corrections
//      Routes to /admin/corrections-review (2h SLA surface lives there).
//
// Auth inherited from /admin/layout.tsx. Auto-refresh every 60s so the
// aggregator page reflects ingestion runs completed since the last
// editor visit without a manual reload.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";
export const revalidate = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EndorsementPreview = {
  id: string;
  endorser_name: string;
  candidate_name: string;
  endorsement_date: string;
  endorser_id: string;
  created_at: string;
};

type FecPreview = {
  id: string;
  queried_name: string;
  queried_state: string | null;
  candidate_matches_count: number;
  created_at: string;
};

type ExtractionPreview = {
  id: string;
  extractor_name: string;
  source_url: string;
  validation_status: string;
  confidence_score: number | null;
  created_at: string;
};

type DedupPreview = {
  id: string;
  canonical_key: string;
  state_fips: string | null;
  blocker_category: string;
  people_count: number;
  created_at: string;
};

type CorrectionPreview = {
  id: string;
  target_type: string | null;
  submitter: string;
  claim: string | null;
  submitted_at: string;
  sla_breached: boolean;
};

type QueueSnapshot = {
  endorsements: {
    count: number;
    preview: EndorsementPreview[];
  };
  fec: {
    count: number;
    preview: FecPreview[];
  };
  dedup: {
    count: number;
    preview: DedupPreview[];
  };
  extraction: {
    count: number;
    preview: ExtractionPreview[];
  };
  corrections: {
    count: number;
    preview: CorrectionPreview[];
    breached: number;
  };
};

// ---------------------------------------------------------------------------
// Data loader — one query per queue, all parallel.
// ---------------------------------------------------------------------------

async function load(): Promise<QueueSnapshot> {
  const supabase = await createServiceClient();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const [
    endorsementCountRes,
    endorsementPreviewRes,
    fecCountRes,
    fecPreviewRes,
    extractionCountRes,
    extractionPreviewRes,
    correctionCountRes,
    correctionPreviewRes,
    correctionBreachedRes,
    dedupCountRes,
    dedupPreviewRes,
  ] = await Promise.all([
    supabase
      .from("endorsements")
      .select("id", { count: "exact", head: true })
      .eq("published", false)
      .is("rescinded_at", null),
    supabase
      .from("endorsements")
      .select(
        `
        id,
        endorsement_date,
        endorser_id,
        created_at,
        endorsers!inner ( canonical_name ),
        candidacies!inner ( people!inner ( canonical_name ) )
        `,
      )
      .eq("published", false)
      .is("rescinded_at", null)
      .order("created_at", { ascending: true })
      .limit(3),
    supabase
      .from("fec_match_ambiguous")
      .select("id", { count: "exact", head: true })
      .is("resolved_at", null),
    supabase
      .from("fec_match_ambiguous")
      .select("id, queried_name, queried_state, candidate_matches, created_at")
      .is("resolved_at", null)
      .order("created_at", { ascending: true })
      .limit(3),
    supabase
      .from("extraction_audit")
      .select("id", { count: "exact", head: true })
      .eq("validation_status", "flagged"),
    supabase
      .from("extraction_audit")
      .select(
        "id, extractor_name, source_url, validation_status, confidence_score, created_at",
      )
      .eq("validation_status", "flagged")
      .order("created_at", { ascending: true })
      .limit(3),
    supabase
      .from("corrections")
      .select("id", { count: "exact", head: true })
      .is("resolved_at", null),
    supabase
      .from("corrections")
      .select(
        "id, target_type, submitter_email, submitted_by, claim, created_at",
      )
      .is("resolved_at", null)
      .order("created_at", { ascending: true })
      .limit(3),
    supabase
      .from("corrections")
      .select("id", { count: "exact", head: true })
      .is("resolved_at", null)
      .lt("created_at", twoHoursAgo),
    supabase
      .from("dedup_review_queue")
      .select("id", { count: "exact", head: true })
      .is("reviewed_at", null),
    supabase
      .from("dedup_review_queue")
      .select(
        "id, canonical_key, state_fips, blocker_category, people_count, created_at",
      )
      .is("reviewed_at", null)
      .order("created_at", { ascending: true })
      .limit(3),
  ]);

  const dedupPreview: DedupPreview[] = (
    (dedupPreviewRes.data ?? []) as unknown as DedupPreview[]
  ).map((d) => ({
    id: d.id,
    canonical_key: d.canonical_key,
    state_fips: d.state_fips,
    blocker_category: d.blocker_category,
    people_count: d.people_count,
    created_at: d.created_at,
  }));

  const endorsementPreview: EndorsementPreview[] = (
    (endorsementPreviewRes.data ?? []) as unknown as Array<{
      id: string;
      endorsement_date: string;
      endorser_id: string;
      created_at: string;
      endorsers: { canonical_name: string } | null;
      candidacies: { people: { canonical_name: string } | null } | null;
    }>
  ).map((e) => ({
    id: e.id,
    endorser_name: e.endorsers?.canonical_name ?? "—",
    candidate_name: e.candidacies?.people?.canonical_name ?? "—",
    endorsement_date: e.endorsement_date,
    endorser_id: e.endorser_id,
    created_at: e.created_at,
  }));

  const fecPreview: FecPreview[] = (
    (fecPreviewRes.data ?? []) as unknown as Array<{
      id: string;
      queried_name: string;
      queried_state: string | null;
      candidate_matches: unknown;
      created_at: string;
    }>
  ).map((f) => ({
    id: f.id,
    queried_name: f.queried_name,
    queried_state: f.queried_state,
    candidate_matches_count: Array.isArray(f.candidate_matches)
      ? f.candidate_matches.length
      : 0,
    created_at: f.created_at,
  }));

  const extractionPreview: ExtractionPreview[] = (
    (extractionPreviewRes.data ?? []) as unknown as ExtractionPreview[]
  ).map((x) => ({
    id: x.id,
    extractor_name: x.extractor_name,
    source_url: x.source_url,
    validation_status: x.validation_status,
    confidence_score: x.confidence_score,
    created_at: x.created_at,
  }));

  const correctionPreview: CorrectionPreview[] = (
    (correctionPreviewRes.data ?? []) as unknown as Array<{
      id: string;
      target_type: string | null;
      submitter_email: string | null;
      submitted_by: string | null;
      claim: string | null;
      created_at: string;
    }>
  ).map((c) => {
    const ageMs = Date.now() - new Date(c.created_at).getTime();
    return {
      id: c.id,
      target_type: c.target_type,
      submitter: c.submitter_email ?? c.submitted_by ?? "(anon)",
      claim: c.claim,
      submitted_at: c.created_at,
      sla_breached: ageMs > 2 * 60 * 60 * 1000,
    };
  });

  return {
    endorsements: {
      count: endorsementCountRes.count ?? 0,
      preview: endorsementPreview,
    },
    fec: {
      count: fecCountRes.count ?? 0,
      preview: fecPreview,
    },
    dedup: {
      count: dedupCountRes.count ?? 0,
      preview: dedupPreview,
    },
    extraction: {
      count: extractionCountRes.count ?? 0,
      preview: extractionPreview,
    },
    corrections: {
      count: correctionCountRes.count ?? 0,
      preview: correctionPreview,
      breached: correctionBreachedRes.count ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return `${Math.floor(ms / (60 * 1000))}m ago`;
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncate(s: string | null, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}

function CountBadge({ n }: { n: number }) {
  const tone =
    n === 0
      ? { bg: "var(--state-success-bg)", fg: "var(--state-success-fg)" }
      : n < 10
        ? { bg: "var(--civic-surface)", fg: "var(--civic-text)" }
        : { bg: "var(--state-warn-bg)", fg: "var(--state-warn-fg)" };
  return (
    <span
      className="inline-flex items-baseline justify-center text-2xl font-semibold civic-tabular px-3 py-1 rounded"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {n}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function MorningReviewPage() {
  const snap = await load();
  const total =
    snap.endorsements.count +
    snap.fec.count +
    snap.dedup.count +
    snap.extraction.count +
    snap.corrections.count;

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-8">
      <header className="flex items-baseline justify-between border-b border-[var(--civic-border)] pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--civic-text)] tracking-tight">
            Morning review
          </h1>
          <p className="text-sm text-[var(--civic-text-muted)] mt-1">
            One place to clear the five human-in-the-loop queues. Auto-refreshes
            every 60s.
          </p>
        </div>
        <div className="text-xs civic-mono text-[var(--civic-text-muted)]">
          {total} items across 5 queues · refreshed{" "}
          {new Date().toISOString().slice(11, 19)}Z
        </div>
      </header>

      {snap.corrections.breached > 0 && (
        <div
          className="civic-card text-sm"
          style={{
            background: "var(--state-error-bg)",
            color: "var(--state-error-fg)",
            borderColor: "var(--state-error-fg)",
          }}
        >
          <strong>SLA breach:</strong> {snap.corrections.breached} voter
          correction{snap.corrections.breached === 1 ? " is" : "s are"} past the
          2-hour re-verify window. Jump to{" "}
          <Link
            href="/admin/corrections-review"
            className="underline font-semibold"
          >
            corrections review
          </Link>
          .
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Endorsements ─────────────────────────────────────────── */}
        <section className="civic-card space-y-3">
          <div className="flex items-baseline justify-between">
            <div>
              <h2 className="text-base font-semibold text-[var(--civic-text)]">
                Endorsements
              </h2>
              <p className="text-xs text-[var(--civic-text-muted)] civic-mono">
                endorsements.published = FALSE
              </p>
            </div>
            <CountBadge n={snap.endorsements.count} />
          </div>

          {snap.endorsements.preview.length > 0 && (
            <ul className="text-sm space-y-1">
              {snap.endorsements.preview.map((e) => (
                <li
                  key={e.id}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="text-[var(--civic-text)]">
                    {e.endorser_name} → {e.candidate_name}
                  </span>
                  <span className="text-xs civic-tabular text-[var(--civic-text-muted)] whitespace-nowrap">
                    {fmtDate(e.endorsement_date)} · {relativeAge(e.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-[var(--civic-border)]">
            <Link
              href="/admin/endorsements-queue"
              className="text-xs civic-mono px-2 py-1 rounded border border-[var(--civic-border)]"
            >
              Open queue →
            </Link>
            {snap.endorsements.preview.length > 0 && (
              <form action={batchApproveEndorsementsSamePaperSameDay}>
                <input
                  type="hidden"
                  name="endorser_id"
                  value={snap.endorsements.preview[0].endorser_id}
                />
                <input
                  type="hidden"
                  name="endorsement_date"
                  value={snap.endorsements.preview[0].endorsement_date}
                />
                <button
                  type="submit"
                  className="text-xs civic-mono px-2 py-1 rounded border"
                  style={{
                    background: "var(--state-success-bg)",
                    color: "var(--state-success-fg)",
                    borderColor: "var(--state-success-fg)",
                  }}
                >
                  Batch approve: {snap.endorsements.preview[0].endorser_name} ·{" "}
                  {fmtDate(snap.endorsements.preview[0].endorsement_date)}
                </button>
              </form>
            )}
          </div>
        </section>

        {/* ── FEC ambiguous ───────────────────────────────────────── */}
        <section className="civic-card space-y-3">
          <div className="flex items-baseline justify-between">
            <div>
              <h2 className="text-base font-semibold text-[var(--civic-text)]">
                FEC ambiguous
              </h2>
              <p className="text-xs text-[var(--civic-text-muted)] civic-mono">
                fec_match_ambiguous.resolved_at IS NULL
              </p>
            </div>
            <CountBadge n={snap.fec.count} />
          </div>

          {snap.fec.preview.length > 0 && (
            <ul className="text-sm space-y-1">
              {snap.fec.preview.map((f) => (
                <li
                  key={f.id}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="text-[var(--civic-text)]">
                    {f.queried_name}
                    {f.queried_state && (
                      <span className="ml-2 text-xs civic-mono text-[var(--civic-text-muted)]">
                        ({f.queried_state})
                      </span>
                    )}
                  </span>
                  <span className="text-xs civic-tabular text-[var(--civic-text-muted)] whitespace-nowrap">
                    {f.candidate_matches_count} matches ·{" "}
                    {relativeAge(f.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-[var(--civic-border)]">
            {snap.fec.preview.length > 0 && (
              <form action={batchResolveFecSameCommittee}>
                <button
                  type="submit"
                  className="text-xs civic-mono px-2 py-1 rounded border"
                  style={{
                    background: "var(--state-success-bg)",
                    color: "var(--state-success-fg)",
                    borderColor: "var(--state-success-fg)",
                  }}
                >
                  Batch resolve same-committee
                </button>
              </form>
            )}
            <span className="ml-auto text-xs text-[var(--civic-text-muted)] civic-mono">
              no dedicated queue page yet
            </span>
          </div>
        </section>

        {/* ── Dedup ambiguous ─────────────────────────────────────── */}
        <section className="civic-card space-y-3">
          <div className="flex items-baseline justify-between">
            <div>
              <h2 className="text-base font-semibold text-[var(--civic-text)]">
                Dedup ambiguous
              </h2>
              <p className="text-xs text-[var(--civic-text-muted)] civic-mono">
                dedup_review_queue.reviewed_at IS NULL
              </p>
            </div>
            <CountBadge n={snap.dedup.count} />
          </div>

          {snap.dedup.preview.length > 0 && (
            <ul className="text-sm space-y-1">
              {snap.dedup.preview.map((d) => (
                <li
                  key={d.id}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="text-[var(--civic-text)]">
                    {d.canonical_key}
                    {d.state_fips && (
                      <span className="ml-2 text-xs civic-mono text-[var(--civic-text-muted)]">
                        ({d.state_fips})
                      </span>
                    )}
                  </span>
                  <span className="text-xs civic-tabular text-[var(--civic-text-muted)] whitespace-nowrap">
                    {d.people_count} ppl · {d.blocker_category} ·{" "}
                    {relativeAge(d.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-[var(--civic-border)]">
            <Link
              href="/admin/dedup-queue"
              className="text-xs civic-mono px-2 py-1 rounded border border-[var(--civic-border)]"
            >
              Open queue →
            </Link>
            <span className="ml-auto text-xs text-[var(--civic-text-muted)] civic-mono">
              per-row merge / split / defer in queue
            </span>
          </div>
        </section>

        {/* ── Extraction flagged ──────────────────────────────────── */}
        <section className="civic-card space-y-3">
          <div className="flex items-baseline justify-between">
            <div>
              <h2 className="text-base font-semibold text-[var(--civic-text)]">
                Extraction flagged
              </h2>
              <p className="text-xs text-[var(--civic-text-muted)] civic-mono">
                extraction_audit.validation_status = &apos;flagged&apos;
              </p>
            </div>
            <CountBadge n={snap.extraction.count} />
          </div>

          {snap.extraction.preview.length > 0 && (
            <ul className="text-sm space-y-1">
              {snap.extraction.preview.map((x) => (
                <li
                  key={x.id}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="text-[var(--civic-text)]">
                    {x.extractor_name}{" "}
                    <span className="text-xs text-[var(--civic-text-muted)] break-all">
                      · {truncate(x.source_url, 50)}
                    </span>
                  </span>
                  <span className="text-xs civic-tabular text-[var(--civic-text-muted)] whitespace-nowrap">
                    conf{" "}
                    {x.confidence_score != null
                      ? x.confidence_score.toFixed(2)
                      : "—"}{" "}
                    · {relativeAge(x.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-[var(--civic-border)]">
            <span className="text-xs text-[var(--civic-text-muted)] civic-mono">
              no batch · flags require per-row review
            </span>
          </div>
        </section>

        {/* ── Voter corrections ───────────────────────────────────── */}
        <section className="civic-card space-y-3 lg:col-span-2">
          <div className="flex items-baseline justify-between">
            <div>
              <h2 className="text-base font-semibold text-[var(--civic-text)]">
                Voter corrections{" "}
                {snap.corrections.breached > 0 && (
                  <span
                    className="ml-2 text-xs civic-mono px-2 py-0.5 rounded"
                    style={{
                      background: "var(--state-error-bg)",
                      color: "var(--state-error-fg)",
                    }}
                  >
                    {snap.corrections.breached} past SLA
                  </span>
                )}
              </h2>
              <p className="text-xs text-[var(--civic-text-muted)] civic-mono">
                corrections.resolved_at IS NULL · 2h SLA
              </p>
            </div>
            <CountBadge n={snap.corrections.count} />
          </div>

          {snap.corrections.preview.length > 0 && (
            <ul className="text-sm space-y-1">
              {snap.corrections.preview.map((c) => (
                <li
                  key={c.id}
                  className="flex items-baseline justify-between gap-2"
                >
                  <span className="text-[var(--civic-text)]">
                    {c.target_type ?? "legacy"} · {c.submitter}
                    {c.claim && (
                      <span className="ml-2 text-[var(--civic-text-secondary)]">
                        — {truncate(c.claim, 60)}
                      </span>
                    )}
                  </span>
                  <span
                    className="text-xs civic-tabular whitespace-nowrap"
                    style={{
                      color: c.sla_breached
                        ? "var(--state-error-fg)"
                        : "var(--civic-text-muted)",
                    }}
                  >
                    {relativeAge(c.submitted_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-2 pt-2 border-t border-[var(--civic-border)]">
            <Link
              href="/admin/corrections-review"
              className="text-xs civic-mono px-2 py-1 rounded border border-[var(--civic-border)]"
            >
              Open triage →
            </Link>
          </div>
        </section>
      </div>

      <footer className="pt-6 border-t border-[var(--civic-border)] text-xs text-[var(--civic-text-muted)]">
        Aggregator queries run in parallel (one count + one top-3 preview per
        queue). Page revalidates every 60s; mutations force immediate
        revalidation via <code className="civic-mono">revalidatePath</code>.
      </footer>
    </div>
  );
}
