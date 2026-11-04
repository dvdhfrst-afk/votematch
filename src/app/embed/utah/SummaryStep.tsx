'use client';

/**
 * SummaryStep - on-device match results, with receipts and the gate banner.
 *
 * Matching runs in the browser (computeEmbedMatches) from the swipe answers +
 * the public bundle. Every candidate position shown here is gate-visible (the
 * server already filtered by the entailment gate's mode), and every scored
 * position carries a receipt. Candidates with no gate-visible position show the
 * abstain-honest card. The gate banner states plainly what band is showing.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { useMemo, useState } from 'react';
import type { EmbedCandidate, EmbedPayload } from '@/lib/embed/payload';
import type { SwipeAnswer } from './embed-match';
import { computeEmbedMatches } from './embed-match';
import { humanizeIssueName, levelLabel, partyLabel, scoreTone } from './ui';

interface SummaryStepProps {
  payload: EmbedPayload;
  answers: SwipeAnswer[];
  onRefine: () => void;
}

export default function SummaryStep({ payload, answers, onRefine }: SummaryStepProps) {
  const matches = useMemo(() => computeEmbedMatches(answers, payload.bundle), [answers, payload]);

  const candidateById = useMemo(() => {
    const m = new Map<string, EmbedCandidate>();
    for (const r of payload.races) for (const c of r.candidates) m.set(c.id, c);
    return m;
  }, [payload]);

  const issueNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const sd of payload.bundle.subDimensions) m.set(sd.id, humanizeIssueName(sd.name));
    return m;
  }, [payload]);

  const voterAnsweredIssues = useMemo(
    () => new Set(answers.filter((a) => a.choice !== 'skip').map((a) => a.issueId)),
    [answers],
  );

  const answeredCount = voterAnsweredIssues.size;

  return (
    <div className="space-y-5">
      <GateBanner payload={payload} />

      <div>
        <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 24, fontWeight: 700, color: 'var(--civic-text)' }}>
          Your matches
        </h2>
        <p style={{ fontSize: 14, color: 'var(--civic-text-secondary)', marginTop: 4 }}>
          Computed on your device from your {answeredCount} answer{answeredCount === 1 ? '' : 's'}. This is
          one input to your decision, not a recommendation.
        </p>
      </div>

      {matches.map((mr) => {
        const scorable = mr.candidates.filter((c) => c.score !== null);
        return (
          <section key={mr.race.id} className="civic-card">
            <div className="flex items-baseline justify-between gap-3">
              <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--civic-text)' }}>{mr.race.name}</h3>
              <span style={{ fontSize: 12, color: 'var(--civic-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                {levelLabel(mr.race.level)}
              </span>
            </div>

            <ul className="mt-3 space-y-3">
              {mr.candidates.map((mc, i) => {
                const ec = candidateById.get(mc.candidate.id);
                const isTop = i === 0 && mc.score !== null;
                return (
                  <li key={mc.candidate.id}>
                    <CandidateRow
                      name={mc.candidate.name}
                      party={mc.candidate.party}
                      score={mc.score}
                      hasVisibleStance={ec?.hasVisibleStance ?? false}
                    />
                    {isTop && ec && ec.hasVisibleStance && (
                      <Receipts ec={ec} issueNameById={issueNameById} voterAnsweredIssues={voterAnsweredIssues} answers={answers} />
                    )}
                    {ec && !ec.hasVisibleStance && (
                      <p style={{ fontSize: 12.5, color: 'var(--civic-text-muted)', marginTop: 4, paddingLeft: 2 }}>
                        Has not stated a public position on these issues yet, and has no relevant voting record we
                        can show. We are still gathering. {payload.gateMode === 'shadow' ? 'Inferred readings are withheld until verified.' : ''}
                      </p>
                    )}
                  </li>
                );
              })}
              {scorable.length === 0 && (
                <li style={{ fontSize: 13, color: 'var(--civic-text-muted)' }}>
                  Not enough overlap between your answers and what these candidates have stated to score this race
                  yet. Answer more cards, or check back as we gather positions.
                </li>
              )}
            </ul>
          </section>
        );
      })}

      <div className="text-center">
        <button type="button" className="civic-btn civic-btn-secondary" onClick={onRefine}>
          Answer more issues to sharpen this
        </button>
      </div>
    </div>
  );
}

function CandidateRow({
  name,
  party,
  score,
  hasVisibleStance,
}: {
  name: string;
  party: string | null;
  score: number | null;
  hasVisibleStance: boolean;
}) {
  const tone = scoreTone(score);
  const pl = partyLabel(party);
  return (
    <div className="flex items-center justify-between gap-3">
      <div style={{ minWidth: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--civic-text)' }}>{name}</span>
        {pl && <span style={{ fontSize: 12.5, color: 'var(--civic-text-muted)', marginLeft: 8 }}>{pl}</span>}
      </div>
      {score !== null ? (
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            padding: '3px 10px',
            borderRadius: 'var(--r-pill)',
            background: tone.bg,
            color: tone.fg,
            border: `1px solid ${tone.bd}`,
            whiteSpace: 'nowrap',
          }}
        >
          {score}% match
        </span>
      ) : (
        <span style={{ fontSize: 12, color: 'var(--civic-text-muted)', whiteSpace: 'nowrap' }}>
          {hasVisibleStance ? 'Answer more to score' : 'No stated position'}
        </span>
      )}
    </div>
  );
}

function Receipts({
  ec,
  issueNameById,
  voterAnsweredIssues,
  answers,
}: {
  ec: EmbedCandidate;
  issueNameById: Map<string, string>;
  voterAnsweredIssues: Set<string>;
  answers: SwipeAnswer[];
}) {
  const answerByIssue = useMemo(() => new Map(answers.map((a) => [a.issueId, a])), [answers]);
  // Prefer positions on issues the voter actually answered (the ones that moved
  // the score), then any others. Show up to 3, each with its receipt.
  const overlapping = ec.visiblePositions.filter((p) => voterAnsweredIssues.has(p.subDimensionId));
  const rest = ec.visiblePositions.filter((p) => !voterAnsweredIssues.has(p.subDimensionId));
  const show = [...overlapping, ...rest].slice(0, 3);
  if (show.length === 0) return null;

  return (
    <div className="mt-2" style={{ borderLeft: '2px solid var(--civic-border)', paddingLeft: 12 }}>
      {show.map((p) => {
        const voterAns = answerByIssue.get(p.subDimensionId);
        const voterScore = voterAns ? (voterAns.choice === 'agree' ? 0.85 : voterAns.choice === 'disagree' ? 0.15 : null) : null;
        const aligns = voterScore !== null ? Math.abs(voterScore - p.score) <= 0.4 : null;
        return (
          <div key={p.subDimensionId} style={{ marginTop: 8 }}>
            <div className="flex items-center gap-2 flex-wrap">
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--civic-text)' }}>
                {issueNameById.get(p.subDimensionId) ?? 'Issue'}
              </span>
              <TierBadge label={p.receipt?.tierShort ?? (p.stated ? 'Stated' : p.record ? 'Record' : 'Cited')} stated={p.stated} record={p.record} />
              {aligns !== null && (
                <span style={{ fontSize: 11, fontWeight: 600, color: aligns ? 'var(--state-success-fg)' : 'var(--civic-text-muted)' }}>
                  {aligns ? 'aligns with you' : 'differs from you'}
                </span>
              )}
            </div>
            {p.receipt?.quote && (
              <blockquote style={{ fontSize: 12.5, color: 'var(--civic-text-secondary)', margin: '4px 0 0', fontStyle: 'italic', lineHeight: 1.4 }}>
                &ldquo;{truncate(p.receipt.quote, 180)}&rdquo;
              </blockquote>
            )}
            {p.receipt?.url && (
              <a
                href={p.receipt.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 11.5, color: 'var(--civic-link)', textDecoration: 'underline' }}
              >
                {p.receipt.title || 'Source'} ↗
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TierBadge({ label, stated, record }: { label: string; stated: boolean; record: boolean }) {
  const bg = stated ? 'var(--conf-high-bg)' : record ? 'var(--score-high-bg)' : 'var(--state-info-bg)';
  const fg = stated ? 'var(--conf-high-fg)' : record ? 'var(--score-high-fg)' : 'var(--state-info-fg)';
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '1px 6px', borderRadius: 'var(--r-sm)', background: bg, color: fg }}>
      {label}
    </span>
  );
}

function GateBanner({ payload }: { payload: EmbedPayload }) {
  const [open, setOpen] = useState(false);
  const g = payload.gateExplainer;
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 'var(--r-md)',
        background: 'var(--civic-surface-muted)',
        border: '1px solid var(--civic-border)',
      }}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true" style={{ fontSize: 14, lineHeight: '20px' }}>🔎</span>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--civic-text)' }}>{g.summary}</p>
          {open && (
            <p style={{ fontSize: 12.5, color: 'var(--civic-text-secondary)', marginTop: 6, lineHeight: 1.5 }}>{g.detail}</p>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            style={{ fontSize: 12, color: 'var(--civic-link)', textDecoration: 'underline', marginTop: 4 }}
          >
            {open ? 'Hide detail' : 'Why?'}
          </button>
          {payload.counts.abstainCandidates > 0 && (
            <p style={{ fontSize: 11.5, color: 'var(--civic-text-muted)', marginTop: 6 }}>
              {payload.counts.abstainCandidates} candidate{payload.counts.abstainCandidates === 1 ? '' : 's'} on your
              ballot have no shown position yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}
