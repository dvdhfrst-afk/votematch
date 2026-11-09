"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BANDS, type BandN, bandByN, SKIP_KEY, SKIP_REASONS } from "./bands";
import type { QueuePair } from "./data";
import {
  submitLabel,
  getAnnotatorProgress,
  getPairs,
  getFullContext,
  getAnnotatorProfile,
  saveAnnotatorProfile,
  type ProposalView,
} from "./actions";
import {
  PARTY_ID_Q1_OPTIONS,
  PARTY_ID_Q2_LEAN_OPTIONS,
  PARTY_ID_Q2_STRENGTH_OPTIONS,
  partyIdNeedsStrength,
  type PartyIdQ1,
  type PartyIdQ2Lean,
  type PartyIdQ2Strength,
} from "./party-id";

const ANNOTATOR_KEY = "g1-annotator";
const PREFETCH_AHEAD = 5;
const PREFETCH_BEHIND = 1;

type Resolved = { band: number | null; skip_reason?: string };

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

function Badge({ children, tone }: { children: React.ReactNode; tone?: "warn" | "primary" }) {
  const style: React.CSSProperties =
    tone === "warn"
      ? { background: "var(--state-warn-bg)", color: "var(--state-warn-fg)", borderColor: "var(--state-warn-fg)" }
      : tone === "primary"
        ? { background: "var(--civic-primary-soft)", color: "var(--civic-text)", borderColor: "var(--civic-primary)" }
        : {};
  return (
    <span
      className="inline-block text-xs civic-mono px-2 py-0.5 rounded-full border border-[var(--civic-border)] text-[var(--civic-text-muted)]"
      style={style}
    >
      {children}
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

export default function LabelingClient({
  pairIds,
  total,
  initialPairs,
  initialProposals,
}: {
  pairIds: string[];
  total: number;
  initialPairs: QueuePair[];
  initialProposals: Record<string, ProposalView>;
}) {
  const [annotator, setAnnotator] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [needProfile, setNeedProfile] = useState(false);

  const [i, setI] = useState(0);
  const [resolved, setResolved] = useState<Map<string, Resolved>>(new Map());
  const [rationale, setRationale] = useState("");
  const [armed, setArmed] = useState<BandN | null>(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipReason, setSkipReason] = useState("");
  const [pending, setPending] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Windowed pair cache (seeded from the server's initial window).
  const [cache, setCache] = useState<Map<string, QueuePair>>(
    () => new Map(initialPairs.map((p) => [p.pair_id, p])),
  );
  const [proposals, setProposals] = useState<Map<string, ProposalView>>(
    () => new Map(Object.entries(initialProposals)),
  );
  const inflight = useRef<Set<string>>(new Set());

  // Expand-to-full-document (lazy).
  const [fullText, setFullText] = useState<string | null>(null);
  const [fullOpen, setFullOpen] = useState(false);
  const [fullLoading, setFullLoading] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);

  // Hydrate annotator from localStorage after mount (SSR-safe).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(ANNOTATOR_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration on mount
      if (saved) setAnnotator(saved);
    } catch {
      /* ignore */
    }
  }, []);

  // On annotator set: pull prior labels (resume + progress) and decide whether
  // to offer the optional profile screen.
  useEffect(() => {
    if (!annotator) return;
    let cancelled = false;
    getAnnotatorProgress(annotator)
      .then((res) => {
        if (cancelled) return;
        const m = new Map<string, Resolved>();
        for (const l of res.labeled) m.set(l.pair_id, { band: l.band, skip_reason: l.skip_reason });
        setResolved(m);
        const firstUnresolved = pairIds.findIndex((id) => !m.has(id));
        setI(firstUnresolved >= 0 ? firstUnresolved : 0);
      })
      .catch(() => {
        /* keep empty */
      });
    // Profile prompt: only if not already stored and not skipped in this browser.
    getAnnotatorProfile(annotator)
      .then((res) => {
        if (cancelled) return;
        let skippedLocally = false;
        try {
          skippedLocally = localStorage.getItem(`g1-profile-${annotator}`) === "skipped";
        } catch {
          /* ignore */
        }
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time decision after annotator set
        setNeedProfile(!res.present && !skippedLocally);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // `pairIds` is intentionally NOT a dependency here (read via closure only).
    // It is a light index PROP that the server component regenerates as a
    // brand-new array on every render (readQueueIndex().pairIds is a fresh
    // .map() call, same content but a new array identity), and calling ANY
    // Server Action from the client (getAnnotatorProgress/getAnnotatorProfile
    // included, even though they only read files) makes Next.js refresh the
    // current route's RSC payload. Listing `pairIds` here previously created
    // an infinite loop: fetch progress/profile, the action call triggers a
    // route refresh, page.tsx re-renders, new `pairIds` array identity (same
    // content) makes this effect see a "changed" dependency and re-fire,
    // which fetches again, which refreshes again, forever. That loop, not
    // routine dev-mode compilation, was the real cause of the labeling
    // page's permanently-busy dev "Compiling..." indicator (diagnosed
    // 2026-07): the network tab showed hundreds of POST+GET request pairs
    // while the page sat completely untouched. `pairIds` only needs to be
    // current at the moment the promise resolves (closure captures that
    // fine); it does not need to re-trigger this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotator]);

  // Windowed prefetch: keep the cache populated around the cursor.
  const ensureWindow = useCallback(
    (center: number) => {
      if (!annotator) return;
      const lo = Math.max(0, center - PREFETCH_BEHIND);
      const hi = Math.min(pairIds.length - 1, center + PREFETCH_AHEAD);
      const want: string[] = [];
      for (let k = lo; k <= hi; k++) {
        const id = pairIds[k];
        if (id && !cache.has(id) && !inflight.current.has(id)) want.push(id);
      }
      if (want.length === 0) return;
      for (const id of want) inflight.current.add(id);
      getPairs(want)
        .then((res) => {
          setCache((prev) => {
            const n = new Map(prev);
            for (const p of res.pairs) n.set(p.pair_id, p);
            return n;
          });
          setProposals((prev) => {
            const n = new Map(prev);
            for (const [pid, pr] of Object.entries(res.proposals)) n.set(pid, pr);
            return n;
          });
        })
        .catch(() => {})
        .finally(() => {
          for (const id of want) inflight.current.delete(id);
        });
    },
    [annotator, pairIds, cache],
  );

  useEffect(() => {
    if (annotator && !needProfile) ensureWindow(i);
  }, [i, annotator, needProfile, ensureWindow]);

  // Reset per-pair transient UI whenever the cursor moves.
  useEffect(() => {
    setArmed(null);
    setRationale("");
    setSkipOpen(false);
    setSkipReason("");
    setFullOpen(false);
    setFullText(null);
    setErrMsg(null);
  }, [i]);

  const curId = pairIds[i];
  const cur = curId ? cache.get(curId) : undefined;
  const curResolved = curId ? resolved.get(curId) : undefined;
  const done = resolved.size;
  const pct = total ? Math.round((100 * done) / total) : 0;

  const advance = useCallback(() => {
    setResolved((m) => {
      let next = -1;
      for (let k = i + 1; k < pairIds.length; k++) {
        if (!m.has(pairIds[k])) {
          next = k;
          break;
        }
      }
      if (next < 0) next = pairIds.findIndex((id) => !m.has(id));
      setI(next >= 0 ? next : Math.min(i + 1, pairIds.length - 1));
      return m;
    });
  }, [i, pairIds]);

  const doSubmitBand = useCallback(
    async (band: BandN) => {
      if (!cur || !annotator || pending) return;
      setPending(true);
      setErrMsg(null);
      try {
        const res = await submitLabel({ pair_id: cur.pair_id, band, rationale, annotator });
        if (!res.ok) {
          setErrMsg(res.error ?? "save failed");
          setPending(false);
          return;
        }
        setResolved((m) => new Map(m).set(cur.pair_id, { band }));
        setPending(false);
        advance();
      } catch (e) {
        setErrMsg(e instanceof Error ? e.message : String(e));
        setPending(false);
      }
    },
    [cur, annotator, pending, rationale, advance],
  );

  const doSubmitSkip = useCallback(
    async (reason: string) => {
      if (!cur || !annotator || pending) return;
      const r = reason.trim();
      if (!r) {
        setErrMsg("a reason is required to skip");
        return;
      }
      setPending(true);
      setErrMsg(null);
      try {
        const res = await submitLabel({
          pair_id: cur.pair_id,
          band: null,
          skip_reason: r,
          rationale,
          annotator,
        });
        if (!res.ok) {
          setErrMsg(res.error ?? "save failed");
          setPending(false);
          return;
        }
        setResolved((m) => new Map(m).set(cur.pair_id, { band: null, skip_reason: r }));
        setPending(false);
        advance();
      } catch (e) {
        setErrMsg(e instanceof Error ? e.message : String(e));
        setPending(false);
      }
    },
    [cur, annotator, pending, rationale, advance],
  );

  const go = useCallback(
    (delta: number) => {
      setI((k) => Math.max(0, Math.min(pairIds.length - 1, k + delta)));
    },
    [pairIds.length],
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
      const res = await getFullContext(cur.pair_id);
      setFullText(res.text ?? "");
    } catch {
      setFullText("");
    } finally {
      setFullLoading(false);
    }
  }, [cur, fullOpen, fullText]);

  // Keyboard: 1-4 arm/submit bands, 5 opens skip, Enter confirms armed,
  // arrows navigate. Inactive while typing or on the gate/profile screens.
  useEffect(() => {
    if (!annotator || needProfile) return;
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return; // let them type
      if (e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        const n = Number(e.key) as BandN;
        setSkipOpen(false);
        setArmed((a) => {
          if (a === n) {
            void doSubmitBand(n);
            return null;
          }
          return n;
        });
      } else if (e.key === SKIP_KEY) {
        e.preventDefault();
        setArmed(null);
        setSkipOpen(true);
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
  }, [annotator, needProfile, doSubmitBand, go]);

  // -------------------------------------------------------------------------
  // Annotator gate
  // -------------------------------------------------------------------------
  if (!annotator) {
    return (
      <div className="max-w-md mx-auto px-6 py-16">
        <div className="civic-card space-y-4">
          <h1 className="text-xl font-semibold text-[var(--civic-text)]">Who is labeling?</h1>
          <p className="text-sm text-[var(--civic-text-muted)]">
            Your name is stored in this browser and stamped on every label you save (file{" "}
            <code className="civic-mono">labels-&lt;name&gt;.jsonl</code>).
          </p>
          <input
            autoFocus
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nameInput.trim()) {
                localStorage.setItem(ANNOTATOR_KEY, nameInput.trim());
                setAnnotator(nameInput.trim());
              }
            }}
            placeholder="e.g. reviewer-1"
            className="w-full px-3 py-2 rounded border border-[var(--civic-border-strong)] bg-[var(--civic-surface)] text-[var(--civic-text)]"
          />
          <button
            disabled={!nameInput.trim()}
            onClick={() => {
              localStorage.setItem(ANNOTATOR_KEY, nameInput.trim());
              setAnnotator(nameInput.trim());
            }}
            className="w-full px-4 py-2 rounded font-semibold disabled:opacity-40"
            style={{ background: "var(--civic-primary)", color: "var(--civic-on-primary)" }}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Optional profile screen (bias-check groundwork). Skippable, never blocks.
  // -------------------------------------------------------------------------
  if (needProfile) {
    return (
      <ProfileScreen
        annotator={annotator}
        onDone={(finalName) => {
          const trimmed = finalName.trim();
          if (trimmed && trimmed !== annotator) {
            try {
              localStorage.setItem(ANNOTATOR_KEY, trimmed);
            } catch {
              /* ignore */
            }
            setAnnotator(trimmed);
          }
          setNeedProfile(false);
        }}
      />
    );
  }

  const allDone = done >= total;

  return (
    <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
      {/* Header / progress */}
      <header className="space-y-2">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-lg font-semibold text-[var(--civic-text)]">Golden-set labeling</h1>
          <div className="flex items-center gap-3 text-xs civic-mono text-[var(--civic-text-muted)]">
            <span>
              annotator: <b className="text-[var(--civic-text)]">{annotator}</b>
            </span>
            <button
              onClick={() => {
                localStorage.removeItem(ANNOTATOR_KEY);
                setAnnotator(null);
                setResolved(new Map());
              }}
              className="underline hover:text-[var(--civic-primary)]"
            >
              change
            </button>
            <a href="/admin/labeling/agreement" className="underline hover:text-[var(--civic-primary)]">
              agreement →
            </a>
          </div>
        </div>
        <div className="h-1.5 rounded bg-[var(--civic-surface-sunken)] overflow-hidden">
          <div className="h-full transition-all" style={{ width: `${pct}%`, background: "var(--civic-primary)" }} />
        </div>
        <div className="text-xs civic-tabular text-[var(--civic-text-muted)]">
          <b className="text-[var(--civic-text)]">{done}</b> / {total} resolved ({pct}%)
          {" · "}viewing pair {i + 1}
        </div>
      </header>

      {allDone && (
        <div
          className="civic-card text-sm"
          style={{ borderColor: "var(--state-success-fg)", color: "var(--state-success-fg)" }}
        >
          All {total} pairs resolved. You can still navigate back to revise any pair.
        </div>
      )}

      {!cur ? (
        <div className="civic-card text-sm text-[var(--civic-text-muted)]">Loading pair…</div>
      ) : (
        <div className="civic-card space-y-4">
          {/* Metadata */}
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
            {cur.is_seed && <Badge>seed</Badge>}
            {cur.is_video && !cur.timestamp_resolved && <Badge tone="warn">video, timestamp unresolved</Badge>}
            {!cur.context_recovered && <Badge tone="warn">limited context available</Badge>}
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
                Surrounding context was not stored for this pair. Judge the bare quote below; if you cannot
                verify it against a source, use action 5 (cannot verify from source).
                <div className="mt-2">
                  <ContextView context={cur.context} />
                </div>
              </div>
            )}

            {/* Full document (lazy) */}
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

            {/* Source link (deep-linked for resolved videos) */}
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
            {cur.is_video && !cur.timestamp_resolved && cur.media_note && (
              <div className="text-xs text-[var(--state-warn-fg)] mt-1">{cur.media_note}</div>
            )}
          </div>

          {/* Agent proposal reference */}
          {proposals.get(cur.pair_id) && (
            <details className="text-sm rounded border border-[var(--civic-border)] p-2">
              <summary className="cursor-pointer text-xs civic-mono text-[var(--civic-text-muted)]">
                Agent proposed: band {proposals.get(cur.pair_id)!.band} (
                {bandByN(proposals.get(cur.pair_id)!.band)?.label}) (click to see rationale)
              </summary>
              <p className="mt-2 text-[var(--civic-text-secondary)]">
                {proposals.get(cur.pair_id)!.rationale || "(no rationale)"}
              </p>
            </details>
          )}

          {/* Rationale */}
          <div>
            <div className="text-xs uppercase tracking-wider text-[var(--civic-text-muted)] mb-1">
              Rationale (optional)
            </div>
            <textarea
              ref={taRef}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Why this band? (optional)"
              className="w-full px-3 py-2 rounded border border-[var(--civic-border)] bg-[var(--civic-surface)] text-[var(--civic-text)] text-sm"
              rows={2}
            />
          </div>

          {errMsg && (
            <div className="text-sm" style={{ color: "var(--state-error-fg)" }}>
              {errMsg}
            </div>
          )}

          {/* Band buttons */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {BANDS.map((b) => {
              const isCur = curResolved?.band === b.n;
              const isArmed = armed === b.n;
              return (
                <button
                  key={b.n}
                  disabled={pending}
                  onClick={() => doSubmitBand(b.n)}
                  onMouseEnter={() => setArmed(b.n)}
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

          {/* Fifth action: cannot verify from source (skip) */}
          <div
            className="rounded border-2 px-3 py-2"
            style={{
              ...toneStyle("neutral"),
              borderColor: skipOpen ? "var(--civic-border-focus)" : "var(--civic-border)",
              outline: curResolved?.band === null && curResolved ? "2px solid var(--civic-text)" : "none",
            }}
          >
            <button
              disabled={pending}
              onClick={() => setSkipOpen((v) => !v)}
              className="w-full flex items-center justify-between disabled:opacity-50"
            >
              <span className="font-semibold text-sm text-[var(--civic-text-secondary)]">
                5. Cannot verify from source
              </span>
              <kbd className="text-xs civic-mono px-1.5 py-0.5 rounded bg-[var(--civic-surface)] text-[var(--civic-text-muted)]">
                5
              </kbd>
            </button>
            <div className="text-xs mt-0.5 text-[var(--civic-text-muted)]">
              Source could not be checked. Pick a reason (required) instead of guessing. Excluded from calibration.
            </div>
            {skipOpen && (
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {SKIP_REASONS.map((r) => (
                    <button
                      key={r}
                      disabled={pending}
                      onClick={() => void doSubmitSkip(r)}
                      className="text-xs px-2 py-1 rounded border border-[var(--civic-border-strong)] hover:border-[var(--civic-primary)] disabled:opacity-50 text-[var(--civic-text)]"
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    value={skipReason}
                    onChange={(e) => setSkipReason(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && skipReason.trim()) void doSubmitSkip(skipReason);
                    }}
                    placeholder="or type a reason, then Enter"
                    className="flex-1 px-2 py-1 rounded border border-[var(--civic-border)] bg-[var(--civic-surface)] text-[var(--civic-text)] text-sm"
                  />
                  <button
                    disabled={pending || !skipReason.trim()}
                    onClick={() => void doSubmitSkip(skipReason)}
                    className="px-3 py-1 rounded text-sm font-semibold disabled:opacity-40"
                    style={{ background: "var(--civic-primary)", color: "var(--civic-on-primary)" }}
                  >
                    Skip
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="text-xs text-[var(--civic-text-muted)]">
            Keys: <kbd className="civic-mono">1</kbd>-<kbd className="civic-mono">4</kbd> band,{" "}
            <kbd className="civic-mono">5</kbd> cannot verify, <kbd className="civic-mono">Enter</kbd> confirm,{" "}
            <kbd className="civic-mono">←</kbd>/<kbd className="civic-mono">→</kbd> navigate.
            {curResolved && (
              <span className="ml-2" style={{ color: "var(--state-success-fg)" }}>
                current:{" "}
                {curResolved.band == null
                  ? `skipped (${curResolved.skip_reason ?? "no reason"})`
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

// ---------------------------------------------------------------------------
// Optional one-screen annotator profile (bias-check groundwork)
// ---------------------------------------------------------------------------
// Age bands start at "Under 18": labeling is not voting, and minors can label
// (operator, 2026-07).
const AGE_BANDS = ["Under 18", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"];

function ChoiceButton({
  on,
  label,
  onClick,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-2 rounded border text-xs text-left"
      style={{
        borderColor: on ? "var(--civic-primary)" : "var(--civic-border)",
        background: on ? "var(--civic-primary-soft)" : "var(--civic-surface)",
        color: "var(--civic-text)",
      }}
    >
      {label}
    </button>
  );
}

function ProfileScreen({
  annotator,
  onDone,
}: {
  annotator: string;
  onDone: (finalAnnotator: string) => void;
}) {
  // Editable right here, prefilled from the name already stored in
  // localStorage (the `annotator` prop). Previously this screen just showed
  // "keyed to <name>" as text with no way to see or fix a typo (the operator,
  // 2026-07). The "change" link in the main header remains as a second way
  // to switch annotators once labeling has started.
  const [name, setName] = useState(annotator);

  const [q1, setQ1] = useState<PartyIdQ1 | null>(null);
  const [q2Strength, setQ2Strength] = useState<PartyIdQ2Strength | null>(null);
  const [q2Lean, setQ2Lean] = useState<PartyIdQ2Lean | null>(null);
  const [ageBand, setAgeBand] = useState("");
  const [state, setState] = useState("");
  const [saving, setSaving] = useState(false);

  const finalName = () => name.trim() || annotator;

  const skip = () => {
    const fn = finalName();
    try {
      localStorage.setItem(`g1-profile-${fn}`, "skipped");
    } catch {
      /* ignore */
    }
    onDone(fn);
  };

  const save = async () => {
    const fn = finalName();
    setSaving(true);
    try {
      await saveAnnotatorProfile({
        annotator: fn,
        party_id_q1: q1,
        party_id_q2_strength: q2Strength,
        party_id_q2_lean: q2Lean,
        age_band: ageBand || null,
        state: state || null,
      });
      try {
        localStorage.setItem(`g1-profile-${fn}`, "done");
      } catch {
        /* ignore */
      }
      onDone(fn);
    } catch {
      onDone(fn); // never block labeling on a profile save failure
    }
  };

  return (
    <div className="max-w-md mx-auto px-6 py-16">
      <div className="civic-card space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-[var(--civic-text)]">Optional: reviewer profile</h1>
          <p className="text-sm text-[var(--civic-text-muted)] mt-1">
            For future bias-checking across reviewers. Entirely optional and never affects your labeling.
          </p>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--civic-text-muted)] mb-1.5 block">
            Your name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. reviewer-1"
            className="w-full px-3 py-2 rounded border border-[var(--civic-border-strong)] bg-[var(--civic-surface)] text-[var(--civic-text)]"
          />
          <p className="text-xs text-[var(--civic-text-muted)] mt-1">
            Stamped on every label you save (file <code className="civic-mono">labels-&lt;name&gt;.jsonl</code>).
            Prefilled from this browser; edit it if it&apos;s wrong.
          </p>
        </div>

        <div>
          <div className="text-xs uppercase tracking-wider text-[var(--civic-text-muted)] mb-1.5">
            Party identification
          </div>
          {/* ANES (American National Election Studies) party-identification battery. */}
          <p className="text-xs text-[var(--civic-text-secondary)] mb-2">
            Generally speaking, do you usually think of yourself as a Democrat, a Republican, an Independent, or
            something else?
          </p>
          <div className="grid grid-cols-1 gap-1">
            {PARTY_ID_Q1_OPTIONS.map((opt) => (
              <ChoiceButton
                key={opt.value}
                label={opt.label}
                on={q1 === opt.value}
                onClick={() => {
                  setQ1((cur) => (cur === opt.value ? null : opt.value));
                  setQ2Strength(null);
                  setQ2Lean(null);
                }}
              />
            ))}
          </div>

          {q1 && partyIdNeedsStrength(q1) && (
            <div className="mt-3">
              <p className="text-xs text-[var(--civic-text-secondary)] mb-2">
                Would you call yourself a strong {q1 === "democrat" ? "Democrat" : "Republican"} or a not very
                strong {q1 === "democrat" ? "Democrat" : "Republican"}?
              </p>
              <div className="grid grid-cols-2 gap-1">
                {PARTY_ID_Q2_STRENGTH_OPTIONS.map((opt) => (
                  <ChoiceButton
                    key={opt.value}
                    label={opt.label}
                    on={q2Strength === opt.value}
                    onClick={() => setQ2Strength((cur) => (cur === opt.value ? null : opt.value))}
                  />
                ))}
              </div>
            </div>
          )}

          {q1 && !partyIdNeedsStrength(q1) && (
            <div className="mt-3">
              <p className="text-xs text-[var(--civic-text-secondary)] mb-2">
                Do you think of yourself as closer to the Democratic Party or the Republican Party?
              </p>
              <div className="grid grid-cols-1 gap-1">
                {PARTY_ID_Q2_LEAN_OPTIONS.map((opt) => (
                  <ChoiceButton
                    key={opt.value}
                    label={opt.label}
                    on={q2Lean === opt.value}
                    onClick={() => setQ2Lean((cur) => (cur === opt.value ? null : opt.value))}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="text-xs uppercase tracking-wider text-[var(--civic-text-muted)] mb-1.5">Age band</div>
          <select
            value={ageBand}
            onChange={(e) => setAgeBand(e.target.value)}
            className="w-full px-3 py-2 rounded border border-[var(--civic-border)] bg-[var(--civic-surface)] text-[var(--civic-text)] text-sm"
          >
            <option value="">(prefer not to say)</option>
            {AGE_BANDS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>

        <div>
          <div className="text-xs uppercase tracking-wider text-[var(--civic-text-muted)] mb-1.5">State</div>
          <input
            value={state}
            onChange={(e) => setState(e.target.value)}
            placeholder="e.g. UT"
            className="w-full px-3 py-2 rounded border border-[var(--civic-border)] bg-[var(--civic-surface)] text-[var(--civic-text)] text-sm"
          />
        </div>

        <div className="flex gap-2 pt-1">
          <button
            onClick={skip}
            disabled={saving}
            className="flex-1 px-4 py-2 rounded font-semibold border border-[var(--civic-border-strong)] text-[var(--civic-text-secondary)] disabled:opacity-40"
          >
            Skip
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex-1 px-4 py-2 rounded font-semibold disabled:opacity-40"
            style={{ background: "var(--civic-primary)", color: "var(--civic-on-primary)" }}
          >
            {saving ? "Saving…" : "Save and start"}
          </button>
        </div>
      </div>
    </div>
  );
}
