import LabelingClient from "./LabelingClient";
import AdjudicationClient from "./AdjudicationClient";
import { readQueueIndex, pairsByIds, proposalsForIds } from "./data";
import { readAdjudicationQueue, adjudicationPairs, operatorAdjudicationProgress } from "./adjudication";

// The queue + labels are files on disk; never cache this surface.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// ---------------------------------------------------------------------------
// /admin/labeling: four-band ordinal labeling of the G1 golden set (+ a fifth
// "cannot verify from source" skip action). One pair per screen; annotator name
// captured once (localStorage); labels append to labels-<annotator>.jsonl.
//
// v2 performance: this server component ships only a LIGHT index (ordered
// pair_ids) plus a small initial window of pair bodies, instead of the whole
// ~1 MB queue. The client pulls further windows on demand via the getPairs
// server action. v1 serialized all ~700 pairs into the client props on every
// load; that was the "thinking harder than a page should be" cost.
// ---------------------------------------------------------------------------

const INITIAL_WINDOW = 6;

// searchParams is a Promise in the Next.js 16 App Router; await it before use.
export default async function LabelingPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string | string[] }>;
}) {
  const params = await searchParams;
  const mode = Array.isArray(params.mode) ? params.mode[0] : params.mode;

  // ?mode=adjudicate: the operator's second-read surface over the disputed + audit
  // queue. Absent this param, behavior below is exactly the normal tool.
  if (mode === "adjudicate") {
    return <AdjudicationView />;
  }

  const { pairIds, total } = readQueueIndex();

  if (total === 0) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-16">
        <div className="civic-card space-y-2">
          <h1 className="text-xl font-semibold text-[var(--civic-text)]">
            No labeling queue found
          </h1>
          <p className="text-sm text-[var(--civic-text-muted)]">
            Expected <code className="civic-mono">data/golden/queue-2026-07.jsonl</code>.
            Generate it with:
          </p>
          <pre className="text-xs civic-mono bg-[var(--civic-surface-sunken)] p-3 rounded overflow-x-auto">
            npx tsx --env-file=.env.local scripts/g1-sample-golden-queue.ts
          </pre>
        </div>
      </div>
    );
  }

  // A small initial window so a fresh annotator (starting at index 0) sees the
  // first pair with zero round-trips. Returning annotators jump to their first
  // unlabeled pair client-side and fetch that window on demand.
  const initialIds = pairIds.slice(0, INITIAL_WINDOW);
  const initialPairs = pairsByIds(initialIds);
  const initialProposals: Record<string, { band: number; band_label: string; rationale: string }> = {};
  for (const [pid, rec] of proposalsForIds(initialIds)) {
    if (rec.band == null) continue;
    initialProposals[pid] = { band: rec.band, band_label: rec.band_label ?? "", rationale: rec.rationale };
  }

  return (
    <LabelingClient
      pairIds={pairIds}
      total={total}
      initialPairs={initialPairs}
      initialProposals={initialProposals}
    />
  );
}

// ---------------------------------------------------------------------------
// Adjudication surface (?mode=adjudicate): the operator's second read over the
// disputed + audit queue in consensus-2026-07.json. Ships the queue (ids +
// reason), an initial window of pair bodies, and his existing progress. It does
// NOT ship the agent bands/rationales; those come only via the reveal action
// after each pick, so nothing leaks before the operator decides.
// ---------------------------------------------------------------------------
function AdjudicationView() {
  const queue = readAdjudicationQueue();
  const total = queue.length;

  if (total === 0) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-16">
        <div className="civic-card space-y-2">
          <h1 className="text-xl font-semibold text-[var(--civic-text)]">No adjudication queue found</h1>
          <p className="text-sm text-[var(--civic-text-muted)]">
            Expected pairs with <code className="civic-mono">in_adjudication_queue: true</code> in{" "}
            <code className="civic-mono">data/golden/consensus-2026-07.json</code>.
          </p>
        </div>
      </div>
    );
  }

  const { resolved, auditTotal, disputedTotal } = operatorAdjudicationProgress();

  // Seed the window at the operator's first un-adjudicated pair so resume is instant.
  const resolvedIds = new Set(resolved.map((r) => r.pair_id));
  const firstUnresolved = queue.findIndex((q) => !resolvedIds.has(q.pair_id));
  const start = firstUnresolved >= 0 ? firstUnresolved : 0;
  const initialIds = queue.slice(start, start + INITIAL_WINDOW).map((q) => q.pair_id);
  const initialPairs = adjudicationPairs(initialIds);

  return (
    <AdjudicationClient
      queue={queue}
      total={total}
      auditTotal={auditTotal}
      disputedTotal={disputedTotal}
      initialPairs={initialPairs}
      initialResolved={resolved}
    />
  );
}
