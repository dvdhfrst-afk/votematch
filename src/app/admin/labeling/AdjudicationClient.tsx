"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BANDS, type BandN, bandByN } from "./bands";
import type { QueuePair } from "./data";
import type { AdjQueueItem, AdjResolvedSeed, AgentJudgments } from "./adjudication";
import { submitLabel } from "./actions";
import {
  getAdjudicationPairs,
  getAdjudicationFullContext,
  revealAgentJudgments,
} from "./adjudication-actions";

// ---------------------------------------------------------------------------
// Adjudication surface for /admin/labeling?mode=adjudicate.
//
// One queue pair per screen. The operator reads the claim, quote, and passage-in-
// context exactly as the normal tool shows them, then commits a band. ONLY
// AFTER that pick do the two agent annotators' bands + rationales appear, with
// whether his pick matched each; he then advances. His picks are human labels:
// they append to labels-operator.jsonl through the shared submitLabel action.
//
// Two live gauges sit in the header: disputed-resolved progress and, tracked
// separately, the audit-sample agreement rate (the operator's band vs the consensus
// band on the 10 percent audit pairs), because a downstream calibration gate
// needs that audit agreement at or above 90 percent.
// ---------------------------------------------------------------------------

const ANNOTATOR = "operator";
const AUDIT_GATE = 0.9;
const PREFETCH_AHEAD = 5;
const PREFETCH_BEHIND = 1;

type Resolved = { band: number | null; reason: "disputed" | "audit"; matched: boolean | null };

function toneStyle(tone: string): React.CSSProperties {
  const map: Record<string, { bg: string; fg: string }> = {
    success: { bg: "var(--state-success-bg)", fg: "var(--state-success-fg)" },
    warn: { bg: "var(--state-warn-bg)", fg: "var(--state-warn-fg)" },
    neutral: { bg: "var(--civic-surface-sunken)", fg: "var(--civic-text-secondary)" },
    error: { bg: "var(--state-error-bg)", fg: "var(--state-error-fg)" },
  };
  const c = map[tone] ?? map.neutral;
  return { background: c.bg, color: c.fg, borderColor: c.fg };
}

/** Render a context string with «quote» markers as a highlighted <mark>. */
function ContextView({ context }: { context: string }) {
  const parts = useMemo(() => {
    const out: Array<{ text: string; mark: boolean }> = [];
    const re = /«([^»]*)»/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(context)) !== null) {
      if (m.index > last) out.push({ text: context.slice(last, m.index), mark: false });
      out.push({ text: m[1], mark: true });
      last = m.index + m[0].length;
    }
    if (last < context.length) out.push({ text: context.slice(last), mark: false });
    return out;
  }, [context]);
  return (
    <p className="text-sm leading-relaxed text-[var(--civic-text-secondary)] whitespace-pre-wrap">
      {parts.map((p, i) =>
        p.mark ? (
          <mark
            key={i}
            style={{
              background: "var(--civic-primary-soft)",
              color: "var(--civic-text)",
              padding: "1px 3px",
              borderRadius: 3,
              fontWeight: 600,
            }}
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block text-xs civic-mono px-2 py-0.5 rounded-full border border-[var(--civic-border)] text-[var(--civic-text-muted)]">
      {children}
    </span>
  );
}

function BandTag({ band }: { band: number | null }) {
  const b = band != null ? bandByN(band) : undefined;
  if (!b) {
    return (
      <span className="inline-block text-xs civic-mono px-1.5 py-0.5 rounded" style={toneStyle("neutral")}>
        skip
      </span>
    );
  }
  return (
    <span className="inline-block text-xs civic-mono px-1.5 py-0.5 rounded" style={toneStyle(b.tone)} title={b.label}>
      {b.n} {b.label}
    </span>
  );
}

function fmtTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export default function AdjudicationClient({
  queue,
  total,
  auditTotal,
  disputedTotal,
  initialPairs,
  initialResolved,
}: {
  queue: AdjQueueItem[];
  total: number;
  auditTotal: number;
  disputedTotal: number;
  initialPairs: QueuePair[];
  initialResolved: AdjResolvedSeed[];
}) {
  const pairIds = useMemo(() => queue.map((q) => q.pair_id), [queue]);
  const reasonById = useMemo(
    () => new Map<string, "disputed" | "audit">(queue.map((q) => [q.pair_id, q.reason])),
    [queue],
  );

  const [i, setI] = useState(0);
  const [resolved, setResolved] = useState<Map<string, Resolved>>(
    () =>
      new Map(
        initialResolved.map((r) => [
          r.pair_id,
          { band: r.band, reason: r.reason, matched: r.matched_consensus },
        ]),
      ),
  );
  const [rationale, setRationale] = useState("");
  const [armed, setArmed] = useState<BandN | null>(null);
  const [pending, setPending] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Which pair currently shows the agent-reveal panel. Never equals the current
  // pair until the operator has committed a band for it (or he navigated back to a pair
  // he already resolved). This is the gate that keeps agent judgments hidden
  // before the pick.
  const [revealPairId, setRevealPairId] = useState<string | null>(null);
  const [agentCache, setAgentCache] = useState<Map<string, AgentJudgments>>(new Map());
  const agentInflight = useRef<Set<string>>(new Set());

  // Windowed pair-body cache (seeded from the server's initial window).
  const [cache, setCache] = useState<Map<string, QueuePair>>(
    () => new Map(initialPairs.map((p) => [p.pair_id, p])),
  );
  const inflight = useRef<Set<string>>(new Set());

  // Expand-to-full-document (lazy).
  const [fullText, setFullText] = useState<string | null>(null);
  const [fullOpen, setFullOpen] = useState(false);
  const [fullLoading, setFullLoading] = useState(false);

  // Read the latest resolved map inside effects/callbacks without making it a
  // dependency (so submitting a pair does not immediately re-hide its reveal).
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  // Resume: start at the first un-adjudicated queue pair.
  useEffect(() => {
    const firstUnresolved = pairIds.findIndex((id) => !resolvedRef.current.has(id));
    setI(firstUnresolved >= 0 ? firstUnresolved : 0);
    // Mount-only: pairIds identity is stable enough (memoized) and we only want
    // the initial jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const curId = pairIds[i];
  const cur = curId ? cache.get(curId) : undefined;

  // Lazily fetch the two agent judgments for a pair (used both after a pick and
  // when landing on an already-resolved pair). Never called before a pick on an
  // un-resolved pair.
  const ensureAgents = useCallback(
    (pid: string) => {
      if (agentCache.has(pid) || agentInflight.current.has(pid)) return;
      agentInflight.current.add(pid);
      revealAgentJudgments(pid)
        .then((res) => {
          setAgentCache((prev) => new Map(prev).set(pid, res));
        })
        .catch(() => {})
        .finally(() => {
          agentInflight.current.delete(pid);
        });
    },
    [agentCache],
  );

  // Windowed prefetch of pair bodies around the cursor (bodies only, never
  // agent proposals: getAdjudicationPairs deliberately omits them).
  const ensureWindow = useCallback(
    (center: number) => {
      const lo = Math.max(0, center - PREFETCH_BEHIND);
      const hi = Math.min(pairIds.length - 1, center + PREFETCH_AHEAD);
      const want: string[] = [];
      for (let k = lo; k <= hi; k++) {
        const id = pairIds[k];
        if (id && !cache.has(id) && !inflight.current.has(id)) want.push(id);
      }
      if (want.length === 0) return;
      for (const id of want) inflight.current.add(id);
      getAdjudicationPairs(want)
        .then((res) => {
          setCache((prev) => {
            const n = new Map(prev);
            for (const p of res.pairs) n.set(p.pair_id, p);
            return n;
          });
        })
        .catch(() => {})
        .finally(() => {
          for (const id of want) inflight.current.delete(id);
        });
    },
    [pairIds, cache],
  );

  useEffect(() => {
    ensureWindow(i);
  }, [i, ensureWindow]);

  // On cursor move: reset per-pair transient UI, and decide the reveal gate.
  // A pair the operator already resolved reveals immediately (he has committed); an
  // un-resolved pair stays hidden until he picks.
  useEffect(() => {
    setArmed(null);
    setRationale("");
    setFullOpen(false);
    setFullText(null);
    setErrMsg(null);
    const id = pairIds[i];
    if (id && resolvedRef.current.has(id)) {
      setRevealPairId(id);
      ensureAgents(id);
    } else {
      setRevealPairId(null);
    }
    // Intentionally keyed to the cursor only; resolvedRef is read live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, pairIds]);

  const curResolved = curId ? resolved.get(curId) : undefined;
  const revealed = !!curId && revealPairId === curId;

  // --- live counters (recomputed from the resolved map) ---------------------
  const counters = useMemo(() => {
    let done = 0;
    let disputedResolved = 0;
    let auditAdjudicated = 0;
    let auditMatched = 0;
    for (const [pid, r] of resolved) {
      if (!reasonById.has(pid)) continue;
      done++;
      if (r.reason === "disputed") {
        disputedResolved++;
      } else if (r.reason === "audit" && r.band != null) {
        auditAdjudicated++;
        if (r.matched) auditMatched++;
      }
    }
    return { done, disputedResolved, auditAdjudicated, auditMatched };
  }, [resolved, reasonById]);

  const auditRate = counters.auditAdjudicated > 0 ? counters.auditMatched / counters.auditAdjudicated : null;
  const auditPass = auditRate != null && auditRate >= AUDIT_GATE;
  const pct = total ? Math.round((100 * counters.done) / total) : 0;

  const advance = useCallback(() => {
    const m = resolvedRef.current;
    let next = -1;
    for (let k = i + 1; k < pairIds.length; k++) {
      if (!m.has(pairIds[k])) {
        next = k;
        break;
      }
    }
    if (next < 0) next = pairIds.findIndex((id) => !m.has(id));
    setI(next >= 0 ? next : Math.min(i + 1, pairIds.length - 1));
  }, [i, pairIds]);

  const go = useCallback(
    (delta: number) => {
      setI((k) => Math.max(0, Math.min(pairIds.length - 1, k + delta)));
    },
    [pairIds.length],
  );

  const doSubmitBand = useCallback(
    async (band: BandN) => {
      if (!cur || pending) return;
      const pid = cur.pair_id;
      setPending(true);
      setErrMsg(null);
      try {
        const res = await submitLabel({ pair_id: pid, band, rationale, annotator: ANNOTATOR });
        if (!res.ok) {
          setErrMsg(res.error ?? "save failed");
          setPending(false);
          return;
        }
        // Reveal the agents now that the pick has landed.
        const agents = await revealAgentJudgments(pid);
        setAgentCache((prev) => new Map(prev).set(pid, agents));
        const reason = reasonById.get(pid) ?? "disputed";
        // Audit pairs: consensus band == proposal band == skeptic band. Match on
        // the proposal band. Disputed pairs have no consensus band to match.
        const matched =
          reason === "audit" && agents.proposal?.band != null ? band === agents.proposal.band : null;
        setResolved((mm) => new Map(mm).set(pid, { band, reason, matched }));
        setRevealPairId(pid);
        setArmed(null);
        setPending(false);
      } catch (e) {
        setErrMsg(e instanceof Error ? e.message : String(e));
        setPending(false);
      }
    },
    [cur, pending, rationale, reasonById],
  );

  const loadFull = useCallback(async () => {
    if (!cur) return;
    if (fullOpen) {
      setFullOpen(false);
      return;
    }
    setFullOpen(true);
    if (fullText != null) return;
    setFullLoading(true);
    try {
      const res = await getAdjudicationFullContext(cur.pair_id);
      setFullText(res.text ?? "");
    } catch {
      setFullText("");
    } finally {
      setFullLoading(false);
    }
  }, [cur, fullOpen, fullText]);

  // Keyboard. Deciding phase: 1-4 arm (twice / Enter confirms), arrows navigate.
  // Revealed phase: Enter / n / ArrowRight advances; arrows also navigate.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return; // let them type
      if (revealed) {
        if (e.key === "Enter" || e.key === "n" || e.key === "N" || e.key === "ArrowRight") {
          e.preventDefault();
          advance();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          go(-1);
        }
        return;
      }
      if (e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        const n = Number(e.key) as BandN;
        setArmed((a) => {
          if (a === n) {
            void doSubmitBand(n);
            return null;
          }
          return n;
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        setArmed((a) => {
          if (a) void doSubmitBand(a);
          return a;
        });
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, doSubmitBand, advance, go]);

  const allDone = counters.done >= total;
  const curAgents = curId ? agentCache.get(curId) : undefined;

  return (
    <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
      {/* Header / progress */}
      <header className="space-y-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold text-[var(--civic-text)]">Golden-set adjudication</h1>
            <p className="text-xs text-[var(--civic-text-muted)] mt-0.5">
              Disputed pairs plus a blind audit sample. Agent judgments stay hidden until you pick.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs civic-mono text-[var(--civic-text-muted)]">
            <span>
              annotator: <b className="text-[var(--civic-text)]">{ANNOTATOR}</b>
            </span>
            <a href="/admin/labeling" className="underline hover:text-[var(--civic-primary)]">
              normal labeling →
            </a>
            <a href="/admin/labeling/agreement" className="underline hover:text-[var(--civic-primary)]">
              agreement →
            </a>
          </div>
        </div>

        <div className="h-1.5 rounded bg-[var(--civic-surface-sunken)] overflow-hidden">
          <div className="h-full transition-all" style={{ width: `${pct}%`, background: "var(--civic-primary)" }} />
        </div>

        {/* Three gauges: overall, disputed, audit-agreement (tracked separately) */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="civic-card p-3">
            <div className="text-xs civic-mono uppercase tracking-wider text-[var(--civic-text-muted)]">
              resolved
            </div>
            <div className="text-xl font-semibold civic-tabular mt-0.5 text-[var(--civic-text)]">
              {counters.done} / {total} <span className="text-sm text-[var(--civic-text-muted)]">({pct}%)</span>
            </div>
          </div>
          <div className="civic-card p-3">
            <div className="text-xs civic-mono uppercase tracking-wider text-[var(--civic-text-muted)]">
              disputed resolved
            </div>
            <div className="text-xl font-semibold civic-tabular mt-0.5 text-[var(--civic-text)]">
              {counters.disputedResolved} / {disputedTotal}
            </div>
          </div>
          <div
            className="civic-card p-3"
            style={{
              borderColor:
                auditRate == null
                  ? "var(--civic-border)"
                  : auditPass
                    ? "var(--state-success-fg)"
                    : "var(--state-warn-fg)",
            }}
          >
            <div className="text-xs civic-mono uppercase tracking-wider text-[var(--civic-text-muted)]">
              audit agreement
            </div>
            <div
              className="text-xl font-semibold civic-tabular mt-0.5"
              style={{
                color:
                  auditRate == null
                    ? "var(--civic-text)"
                    : auditPass
                      ? "var(--state-success-fg)"
                      : "var(--state-warn-fg)",
              }}
            >
              {counters.auditMatched} / {counters.auditAdjudicated}{" "}
              <span className="text-sm">
                ({auditRate == null ? "n/a" : `${(auditRate * 100).toFixed(1)}%`})
              </span>
            </div>
            <div className="text-xs text-[var(--civic-text-muted)] mt-0.5">
              gate: {Math.round(AUDIT_GATE * 100)}%{" "}
              {auditRate == null
                ? ""
                : auditPass
                  ? "(meets gate)"
                  : "(below gate)"}{" "}
              · {auditTotal} audit pairs
            </div>
          </div>
        </div>
      </header>

      {allDone && (
        <div
          className="civic-card text-sm"
          style={{ borderColor: "var(--state-success-fg)", color: "var(--state-success-fg)" }}
        >
          All {total} queue pairs adjudicated. You can still navigate back to revise any pair.
        </div>
      )}

      {!cur ? (
        <div className="civic-card text-sm text-[var(--civic-text-muted)]">Loading pair…</div>
      ) : (
        <div className="civic-card space-y-4">
          {/* Metadata (never includes the audit/disputed reason before a pick) */}
          <div className="flex flex-wrap gap-1.5">
            {cur.candidate_name && <Badge>{cur.candidate_name}</Badge>}
            {cur.office && <Badge>{cur.office}</Badge>}
            {cur.level && <Badge>{cur.level}</Badge>}
            {cur.is_utah && <Badge>Utah</Badge>}
            <Badge>{cur.view_type}</Badge>
            {cur.confidence && <Badge>conf: {cur.confidence}</Badge>}
            <Badge>
              {cur.dimension ? `${cur.dimension} / ` : ""}
              {cur.sub_dimension}
            </Badge>
          </div>

          {/* Claim */}
          <div>
            <div className="text-xs uppercase tracking-wider text-[var(--civic-text-muted)] mb-1">
              Does the quote, in context, support this claim?
            </div>
            <div className="text-lg font-semibold text-[var(--civic-text)]">{cur.claim}</div>
          </div>

          {/* Cited quote */}
          <div>
            <div className="text-xs uppercase tracking-wider text-[var(--civic-text-muted)] mb-1">Cited quote</div>
            <blockquote
              className="text-sm px-3 py-2 rounded"
              style={{
                borderLeft: "3px solid var(--civic-primary)",
                background: "var(--civic-surface-sunken)",
                color: "var(--civic-text)",
              }}
            >
              {cur.quote}
            </blockquote>
          </div>

          {/* Context */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs uppercase tracking-wider text-[var(--civic-text-muted)]">
                Passage in context: judge the claim against THIS
              </div>
              {cur.has_full_context && (
                <button
                  onClick={loadFull}
                  className="text-xs civic-mono underline text-[var(--civic-text-muted)] hover:text-[var(--civic-primary)]"
                >
                  {fullOpen ? "collapse" : "expand to full document"}
                </button>
              )}
            </div>
            {cur.context_recovered ? (
              <div className="px-3 py-2 rounded" style={{ background: "var(--civic-surface-sunken)" }}>
                <ContextView context={cur.context} />
              </div>
            ) : (
              <div
                className="px-3 py-2 rounded text-sm"
                style={{ background: "var(--state-warn-bg)", color: "var(--state-warn-fg)" }}
              >
                Surrounding context was not stored for this pair. Judge the bare quote below.
                <div className="mt-2">
                  <ContextView context={cur.context} />
                </div>
              </div>
            )}

            {fullOpen && (
              <div
                className="mt-2 px-3 py-2 rounded max-h-96 overflow-y-auto"
                style={{ background: "var(--civic-surface-sunken)", border: "1px solid var(--civic-border)" }}
              >
                {fullLoading ? (
                  <div className="text-sm text-[var(--civic-text-muted)]">Loading full document…</div>
                ) : fullText ? (
                  <ContextView context={fullText} />
                ) : (
                  <div className="text-sm text-[var(--civic-text-muted)]">Full document unavailable.</div>
                )}
              </div>
            )}

            {cur.url && (
              <div className="text-xs civic-mono text-[var(--civic-text-muted)] mt-1 break-all flex items-center gap-2 flex-wrap">
                {cur.is_video && cur.timestamp_resolved && cur.timestamp_seconds != null && (
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                    style={{ background: "var(--civic-primary-soft)", color: "var(--civic-text)" }}
                  >
                    ▶ opens at {fmtTimestamp(cur.timestamp_seconds)}
                  </span>
                )}
                <a href={cur.url} target="_blank" rel="noreferrer" className="hover:underline">
                  {cur.url}
                </a>
              </div>
            )}
          </div>

          {errMsg && (
            <div className="text-sm" style={{ color: "var(--state-error-fg)" }}>
              {errMsg}
            </div>
          )}

          {/* Rationale (kept when re-picking; cleared on pair change) */}
          <div>
            <div className="text-xs uppercase tracking-wider text-[var(--civic-text-muted)] mb-1">
              Rationale (optional)
            </div>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Why this band? (optional)"
              className="w-full px-3 py-2 rounded border border-[var(--civic-border)] bg-[var(--civic-surface)] text-[var(--civic-text)] text-sm"
              rows={2}
            />
          </div>

          {/* Band buttons */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {BANDS.map((b) => {
              const isCur = curResolved?.band === b.n;
              const isArmed = !revealed && armed === b.n;
              return (
                <button
                  key={b.n}
                  disabled={pending}
                  onClick={() => doSubmitBand(b.n)}
                  onMouseEnter={() => {
                    if (!revealed) setArmed(b.n);
                  }}
                  className="text-left px-3 py-2 rounded border-2 disabled:opacity-50 transition-all"
                  style={{
                    ...toneStyle(b.tone),
                    outline: isArmed ? "2px solid var(--civic-border-focus)" : "none",
                    boxShadow: isCur ? "inset 0 0 0 2px var(--civic-text)" : "none",
                  }}
                  title={b.hint}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm">
                      {b.n}. {b.label}
                    </span>
                    <kbd className="text-xs civic-mono px-1.5 py-0.5 rounded bg-[var(--civic-surface)] text-[var(--civic-text-muted)]">
                      {b.n}
                    </kbd>
                  </div>
                  <div className="text-xs mt-0.5 opacity-90">{b.hint}</div>
                </button>
              );
            })}
          </div>

          {/* Agent reveal panel: ONLY after the operator has picked this pair. */}
          {revealed && curResolved && (
            <div
              className="rounded border-2 p-3 space-y-3"
              style={{ borderColor: "var(--civic-primary)", background: "var(--civic-surface-sunken)" }}
            >
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="text-xs uppercase tracking-wider text-[var(--civic-text-muted)]">
                  Agent judgments (revealed after your pick)
                </div>
                <div className="text-xs civic-mono text-[var(--civic-text-muted)]">
                  your pick: <BandTag band={curResolved.band} />
                  {curResolved.reason === "audit" && (
                    <span className="ml-2">(audit pair)</span>
                  )}
                </div>
              </div>

              {!curAgents ? (
                <div className="text-sm text-[var(--civic-text-muted)]">Loading agent judgments…</div>
              ) : (
                <div className="space-y-2">
                  {(
                    [
                      ["Proposal agent", curAgents.proposal] as const,
                      ["Skeptic agent", curAgents.skeptic] as const,
                    ]
                  ).map(([name, judgment]) => {
                    const matches =
                      judgment != null &&
                      curResolved.band != null &&
                      judgment.band === curResolved.band;
                    return (
                      <div key={name} className="rounded border border-[var(--civic-border)] bg-[var(--civic-surface)] p-2">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs civic-mono text-[var(--civic-text-muted)]">{name}:</span>
                            <BandTag band={judgment?.band ?? null} />
                          </div>
                          {judgment && (
                            <span
                              className="text-xs civic-mono px-1.5 py-0.5 rounded"
                              style={
                                matches
                                  ? { background: "var(--state-success-bg)", color: "var(--state-success-fg)" }
                                  : { background: "var(--state-warn-bg)", color: "var(--state-warn-fg)" }
                              }
                            >
                              {matches ? "matches your pick" : "differs from your pick"}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-[var(--civic-text-secondary)] mt-1">
                          {judgment?.rationale || "(no rationale)"}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-[var(--civic-text-muted)]">
                  Change your mind? Click a band above to re-adjudicate.
                </span>
                <button
                  onClick={advance}
                  className="px-4 py-1.5 rounded text-sm font-semibold"
                  style={{ background: "var(--civic-primary)", color: "var(--civic-on-primary)" }}
                >
                  Next pair →
                </button>
              </div>
            </div>
          )}

          <div className="text-xs text-[var(--civic-text-muted)]">
            Keys:{" "}
            {revealed ? (
              <>
                <kbd className="civic-mono">Enter</kbd>/<kbd className="civic-mono">n</kbd> next pair,{" "}
                <kbd className="civic-mono">←</kbd> back.
              </>
            ) : (
              <>
                <kbd className="civic-mono">1</kbd>-<kbd className="civic-mono">4</kbd> pick a band (press twice or{" "}
                <kbd className="civic-mono">Enter</kbd> to confirm), <kbd className="civic-mono">←</kbd>/
                <kbd className="civic-mono">→</kbd> navigate.
              </>
            )}
            {curResolved && (
              <span className="ml-2" style={{ color: "var(--state-success-fg)" }}>
                current:{" "}
                {curResolved.band == null
                  ? "skipped"
                  : `band ${curResolved.band} (${bandByN(curResolved.band)?.label})`}
              </span>
            )}
          </div>

          {/* Nav */}
          <div className="flex items-center justify-between text-sm text-[var(--civic-text-muted)] pt-2 border-t border-[var(--civic-border)]">
            <button onClick={() => go(-1)} className="hover:underline">
              ← back
            </button>
            <span className="civic-tabular text-xs">
              {i + 1} / {total}
            </span>
            <button onClick={() => go(1)} className="hover:underline">
              skip →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
