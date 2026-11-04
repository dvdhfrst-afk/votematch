import Link from "next/link";
import { bandByN, type BandN } from "../bands";
import {
  readQueue,
  listAnnotators,
  latestLabelsByPair,
  readAnnotatorProfiles,
  type QueuePair,
} from "../data";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// ---------------------------------------------------------------------------
// /admin/labeling/agreement: inter-annotator agreement for the golden set.
// For every pair with 2+ annotators: are they unanimous? For every annotator
// PAIR: shared count, exact % agreement, and Cohen's kappa (unweighted).
// The agent proposal file counts as one "annotator" so the operator can see how
// closely his review tracks the pre-proposals.
// ---------------------------------------------------------------------------

function kappa(a: BandN[], b: BandN[]): number | null {
  const n = a.length;
  if (n === 0) return null;
  let agree = 0;
  const ca: Record<number, number> = {};
  const cb: Record<number, number> = {};
  for (let k = 0; k < n; k++) {
    if (a[k] === b[k]) agree++;
    ca[a[k]] = (ca[a[k]] ?? 0) + 1;
    cb[b[k]] = (cb[b[k]] ?? 0) + 1;
  }
  const po = agree / n;
  let pe = 0;
  for (const c of [1, 2, 3, 4]) pe += ((ca[c] ?? 0) / n) * ((cb[c] ?? 0) / n);
  if (pe >= 1) return 1;
  return (po - pe) / (1 - pe);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function BandChip({ band }: { band: BandN }) {
  const b = bandByN(band)!;
  const tone: Record<string, { bg: string; fg: string }> = {
    success: { bg: "var(--state-success-bg)", fg: "var(--state-success-fg)" },
    warn: { bg: "var(--state-warn-bg)", fg: "var(--state-warn-fg)" },
    neutral: { bg: "var(--civic-surface-sunken)", fg: "var(--civic-text-secondary)" },
    error: { bg: "var(--state-error-bg)", fg: "var(--state-error-fg)" },
  };
  const c = tone[b.tone];
  return (
    <span
      className="inline-block text-xs civic-mono px-1.5 py-0.5 rounded"
      style={{ background: c.bg, color: c.fg }}
      title={b.label}
    >
      {band} {b.label}
    </span>
  );
}

export default function AgreementPage() {
  const queue = readQueue();
  const byId = new Map<string, QueuePair>(queue.map((p) => [p.pair_id, p]));
  const annotators = listAnnotators();
  const profiles = readAnnotatorProfiles();

  // annotator -> (pair_id -> band). Skip rows (band null, "cannot verify from
  // source") are NOT agreement votes, so they are excluded from these maps; they
  // are counted separately in the per-annotator overview below.
  const labels = new Map<string, Map<string, BandN>>();
  const stats = new Map<string, { banded: number; skipped: number }>();
  for (const ann of annotators) {
    const m = new Map<string, BandN>();
    let skipped = 0;
    for (const [pid, rec] of latestLabelsByPair(ann)) {
      if (rec.band == null) {
        skipped++;
        continue;
      }
      m.set(pid, rec.band);
    }
    labels.set(ann, m);
    stats.set(ann, { banded: m.size, skipped });
  }

  if (annotators.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="civic-card">
          <h1 className="text-xl font-semibold text-[var(--civic-text)]">No labels yet</h1>
          <p className="text-sm text-[var(--civic-text-muted)] mt-2">
            Once anyone labels via{" "}
            <Link href="/admin/labeling" className="underline">
              /admin/labeling
            </Link>
            , agreement stats appear here.
          </p>
        </div>
      </div>
    );
  }

  // Per-pair consensus among annotators that labeled it.
  let pairsMulti = 0;
  let unanimous = 0;
  const disagreements: Array<{ pair: QueuePair | undefined; pair_id: string; votes: Array<[string, BandN]> }> = [];
  for (const p of queue) {
    const votes: Array<[string, BandN]> = [];
    for (const ann of annotators) {
      const b = labels.get(ann)!.get(p.pair_id);
      if (b) votes.push([ann, b]);
    }
    if (votes.length >= 2) {
      pairsMulti++;
      const distinct = new Set(votes.map((v) => v[1]));
      if (distinct.size === 1) unanimous++;
      else disagreements.push({ pair: byId.get(p.pair_id), pair_id: p.pair_id, votes });
    }
  }

  // Pairwise annotator agreement.
  const pairwise: Array<{
    a: string;
    b: string;
    n: number;
    exact: number;
    kappa: number | null;
  }> = [];
  for (let x = 0; x < annotators.length; x++) {
    for (let y = x + 1; y < annotators.length; y++) {
      const A = labels.get(annotators[x])!;
      const B = labels.get(annotators[y])!;
      const va: BandN[] = [];
      const vb: BandN[] = [];
      for (const [pid, band] of A) {
        const bb = B.get(pid);
        if (bb) {
          va.push(band);
          vb.push(bb);
        }
      }
      const n = va.length;
      if (n === 0) continue;
      let agree = 0;
      for (let k = 0; k < n; k++) if (va[k] === vb[k]) agree++;
      pairwise.push({
        a: annotators[x],
        b: annotators[y],
        n,
        exact: agree / n,
        kappa: kappa(va, vb),
      });
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-8">
      <header className="flex items-baseline justify-between border-b border-[var(--civic-border)] pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--civic-text)] tracking-tight">
            Inter-annotator agreement
          </h1>
          <p className="text-sm text-[var(--civic-text-muted)] mt-1">
            Four-band ordinal golden set. Annotators:{" "}
            {annotators.map((a) => (
              <code key={a} className="civic-mono mr-2">
                {a} ({labels.get(a)!.size})
              </code>
            ))}
          </p>
        </div>
        <Link href="/admin/labeling" className="text-sm underline text-[var(--civic-text-muted)]">
          ← back to labeling
        </Link>
      </header>

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="civic-card">
          <div className="text-xs civic-mono uppercase tracking-wider text-[var(--civic-text-muted)]">
            pairs with 2+ annotators
          </div>
          <div className="text-3xl font-semibold civic-tabular mt-1 text-[var(--civic-text)]">
            {pairsMulti}
          </div>
        </div>
        <div className="civic-card">
          <div className="text-xs civic-mono uppercase tracking-wider text-[var(--civic-text-muted)]">
            unanimous
          </div>
          <div
            className="text-3xl font-semibold civic-tabular mt-1"
            style={{ color: "var(--state-success-fg)" }}
          >
            {unanimous}
            <span className="text-base text-[var(--civic-text-muted)] ml-2">
              {pairsMulti ? pct(unanimous / pairsMulti) : "n/a"}
            </span>
          </div>
        </div>
        <div className="civic-card">
          <div className="text-xs civic-mono uppercase tracking-wider text-[var(--civic-text-muted)]">
            disagreements
          </div>
          <div
            className="text-3xl font-semibold civic-tabular mt-1"
            style={{ color: disagreements.length ? "var(--state-warn-fg)" : "var(--state-success-fg)" }}
          >
            {disagreements.length}
          </div>
        </div>
      </div>

      {/* Per-annotator overview (incl. bias-check profile presence) */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">Annotators</h2>
        <div className="overflow-x-auto civic-card p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-[var(--civic-text-muted)] border-b border-[var(--civic-border)]">
                <th className="px-4 py-2 font-semibold">Annotator</th>
                <th className="px-4 py-2 font-semibold text-right">Band-labeled</th>
                <th className="px-4 py-2 font-semibold text-right">Skipped (cannot verify)</th>
                <th className="px-4 py-2 font-semibold text-center">Profile present</th>
              </tr>
            </thead>
            <tbody>
              {annotators.map((a) => {
                const st = stats.get(a) ?? { banded: 0, skipped: 0 };
                const hasProfile = profiles.has(a);
                return (
                  <tr key={a} className="border-b border-[var(--civic-border)] last:border-0">
                    <td className="px-4 py-2 civic-mono">{a}</td>
                    <td className="px-4 py-2 civic-tabular text-right">{st.banded}</td>
                    <td className="px-4 py-2 civic-tabular text-right">{st.skipped}</td>
                    <td className="px-4 py-2 text-center">
                      <span
                        className="inline-block text-xs civic-mono px-1.5 py-0.5 rounded"
                        style={
                          hasProfile
                            ? { background: "var(--state-success-bg)", color: "var(--state-success-fg)" }
                            : { background: "var(--civic-surface-sunken)", color: "var(--civic-text-muted)" }
                        }
                      >
                        {hasProfile ? "yes" : "no"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-[var(--civic-text-muted)] mt-2">
          Bias analysis across profiles comes later, with real multi-annotator data. This column just tracks
          whether each reviewer has filled the optional profile.
        </p>
      </section>

      {/* Pairwise */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Pairwise agreement
        </h2>
        <div className="overflow-x-auto civic-card p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-[var(--civic-text-muted)] border-b border-[var(--civic-border)]">
                <th className="px-4 py-2 font-semibold">Annotator A</th>
                <th className="px-4 py-2 font-semibold">Annotator B</th>
                <th className="px-4 py-2 font-semibold text-right">Shared pairs</th>
                <th className="px-4 py-2 font-semibold text-right">Exact agreement</th>
                <th className="px-4 py-2 font-semibold text-right">Cohen&apos;s κ</th>
              </tr>
            </thead>
            <tbody>
              {pairwise.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-3 text-[var(--civic-text-muted)]">
                    No overlapping pairs between annotators yet.
                  </td>
                </tr>
              ) : (
                pairwise.map((r) => (
                  <tr key={`${r.a}|${r.b}`} className="border-b border-[var(--civic-border)] last:border-0">
                    <td className="px-4 py-2 civic-mono">{r.a}</td>
                    <td className="px-4 py-2 civic-mono">{r.b}</td>
                    <td className="px-4 py-2 civic-tabular text-right">{r.n}</td>
                    <td className="px-4 py-2 civic-tabular text-right">{pct(r.exact)}</td>
                    <td className="px-4 py-2 civic-tabular text-right">
                      {r.kappa == null ? "n/a" : r.kappa.toFixed(2)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Disagreements */}
      <section>
        <h2 className="text-lg font-semibold text-[var(--civic-text)] mb-3">
          Disagreements {disagreements.length > 50 ? "(first 50)" : ""}
        </h2>
        {disagreements.length === 0 ? (
          <p className="text-sm text-[var(--civic-text-muted)] civic-card">
            No disagreements among pairs with 2+ annotators.
          </p>
        ) : (
          <div className="space-y-3">
            {disagreements.slice(0, 50).map((d) => (
              <div key={d.pair_id} className="civic-card space-y-2">
                <div className="text-sm font-semibold text-[var(--civic-text)]">
                  {d.pair?.claim ?? d.pair_id}
                </div>
                {d.pair && (
                  <blockquote
                    className="text-xs px-3 py-1.5 rounded text-[var(--civic-text-secondary)]"
                    style={{ borderLeft: "3px solid var(--civic-border-strong)", background: "var(--civic-surface-sunken)" }}
                  >
                    {d.pair.quote}
                  </blockquote>
                )}
                <div className="flex flex-wrap gap-2 items-center">
                  {d.votes.map(([ann, band]) => (
                    <span key={ann} className="inline-flex items-center gap-1.5 text-xs">
                      <span className="civic-mono text-[var(--civic-text-muted)]">{ann}:</span>
                      <BandChip band={band} />
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
