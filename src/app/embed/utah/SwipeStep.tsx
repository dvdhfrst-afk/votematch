'use client';

/**
 * SwipeStep - the self-positioning card deck (V2 pillar 5).
 *
 * PURPOSE: help the voter discover and narrow their OWN positioning FIRST;
 * candidate matching comes after, built on that self-discovery. Each card is one
 * office-scoped issue with its RECEIPT visible BEFORE the choice (what the issue
 * is, and which of the voter's own races decide it -> the on-your-ballot banner).
 * The gesture is agree / disagree, PLUS an explicit skip (abstention is never
 * coerced onto a side), PLUS an importance flag that double-weights the domain.
 * Answers stay in this widget's memory and never leave the device.
 *
 * Keyboard: ArrowRight/A = agree, ArrowLeft/D = disagree, ArrowDown/S = skip,
 * ArrowUp or * = toggle importance. (Keys per the card spec.)
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EmbedIssue } from '@/lib/embed/payload';
import type { SwipeAnswer, SwipeChoice } from './embed-match';
import { domainLabel, humanizeIssueName } from './ui';

interface SwipeStepProps {
  issues: EmbedIssue[];
  answers: SwipeAnswer[];
  onAnswer: (answer: SwipeAnswer) => void;
  onComplete: () => void;
  onBack: () => void;
}

export default function SwipeStep({ issues, answers, onAnswer, onComplete, onBack }: SwipeStepProps) {
  const [index, setIndex] = useState(0);
  const [important, setImportant] = useState(false);
  const [exitDir, setExitDir] = useState<'left' | 'right' | 'down' | null>(null);

  const total = issues.length;
  const done = index >= total;
  const current = done ? null : issues[index];
  const answeredCount = useMemo(() => answers.filter((a) => a.choice !== 'skip').length, [answers]);

  const commit = useCallback(
    (choice: SwipeChoice) => {
      if (!current || exitDir) return;
      setExitDir(choice === 'agree' ? 'right' : choice === 'disagree' ? 'left' : 'down');
      const answer: SwipeAnswer = {
        issueId: current.id,
        domain: current.domain,
        choice,
        important,
      };
      // Advance after the exit transition (matches --t-default). Commit the
      // answer up to the parent as we advance so Summary can score it.
      window.setTimeout(() => {
        onAnswer(answer);
        setImportant(false);
        setExitDir(null);
        setIndex((i) => i + 1);
      }, 200);
    },
    [current, exitDir, important, onAnswer],
  );

  // Keyboard controls (the "keys" in the card spec).
  useEffect(() => {
    if (done) return;
    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase();
      if (k === 'arrowright' || k === 'a') { e.preventDefault(); commit('agree'); }
      else if (k === 'arrowleft' || k === 'd') { e.preventDefault(); commit('disagree'); }
      else if (k === 'arrowdown' || k === 's') { e.preventDefault(); commit('skip'); }
      else if (k === 'arrowup' || k === '*' || k === 'i') { e.preventDefault(); setImportant((v) => !v); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commit, done]);

  if (done) {
    return (
      <div className="civic-card text-center" style={{ padding: '2rem 1.25rem' }}>
        <p style={{ fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 700, color: 'var(--civic-text)' }}>
          That is your quick read.
        </p>
        <p style={{ marginTop: 8, fontSize: 15, color: 'var(--civic-text-secondary)', maxWidth: '48ch', marginInline: 'auto' }}>
          You answered {answeredCount} of {total} issues scoped to your ballot. Next we compare your
          answers with what each candidate has stated, on your device. Nothing you entered leaves this page.
        </p>
        <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
          <button type="button" className="civic-btn civic-btn-secondary" onClick={() => setIndex(Math.max(0, total - 1))}>
            Back one card
          </button>
          <button type="button" className="civic-btn civic-btn-primary civic-btn-lg" onClick={onComplete}>
            See my matches
          </button>
        </div>
      </div>
    );
  }

  const exitTransform =
    exitDir === 'right' ? 'translateX(60%) rotate(4deg)'
    : exitDir === 'left' ? 'translateX(-60%) rotate(-4deg)'
    : exitDir === 'down' ? 'translateY(24%)'
    : 'none';

  return (
    <div>
      {/* Progress */}
      <div className="flex items-center justify-between mb-3">
        <button type="button" className="civic-btn civic-btn-tertiary civic-btn-sm" onClick={onBack}>
          Back to ballot
        </button>
        <span style={{ fontSize: 13, color: 'var(--civic-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          Card {index + 1} of {total} · answered {answeredCount}
        </span>
      </div>
      <div
        aria-hidden="true"
        style={{
          height: 4,
          borderRadius: 'var(--r-pill)',
          background: 'var(--civic-surface-sunken)',
          overflow: 'hidden',
          marginBottom: 16,
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.round((index / total) * 100)}%`,
            background: 'var(--civic-primary)',
            transition: 'width var(--t-default) var(--ease-standard)',
          }}
        />
      </div>

      {/* The card */}
      <div
        role="group"
        aria-label={current!.statement}
        className="civic-card civic-card-emphasized"
        style={{
          transform: exitTransform,
          opacity: exitDir ? 0 : 1,
          transition: 'transform var(--t-default) var(--ease-standard), opacity var(--t-default) var(--ease-standard)',
        }}
      >
        {/* On-your-ballot banner (the receipt for WHY this issue is here) */}
        <div
          className="flex items-start gap-2 mb-4"
          style={{
            padding: '8px 12px',
            borderRadius: 'var(--r-md)',
            background: 'var(--civic-primary-soft)',
            border: '1px solid transparent',
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 14, lineHeight: '20px' }}>🗳</span>
          <span style={{ fontSize: 13, color: 'var(--civic-primary)', fontWeight: 600, lineHeight: 1.4 }}>
            On your ballot:{' '}
            <span style={{ fontWeight: 500 }}>
              {current!.onBallotRaceNames.slice(0, 3).join(' · ')}
              {current!.onBallotRaceNames.length > 3 ? ` +${current!.onBallotRaceNames.length - 3} more` : ''}
            </span>
          </span>
        </div>

        <p style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--civic-text-muted)', fontWeight: 600 }}>
          {domainLabel(current!.domain)}
        </p>
        <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 24, fontWeight: 700, color: 'var(--civic-text)', marginTop: 4, lineHeight: 1.15 }}>
          {humanizeIssueName(current!.name)}
        </h2>

        {/* Receipt: the two poles, shown BEFORE the choice. */}
        <p style={{ fontSize: 13, color: 'var(--civic-text-muted)', marginTop: 12, marginBottom: 8 }}>
          This issue runs between two positions. Pick the side closer to you.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <PoleLabel side="disagree" text={current!.spectrumLow} />
          <PoleLabel side="agree" text={current!.spectrumHigh} />
        </div>

        {/* Importance flag */}
        <button
          type="button"
          aria-pressed={important}
          onClick={() => setImportant((v) => !v)}
          className="civic-btn civic-btn-sm mt-4"
          style={{
            width: '100%',
            justifyContent: 'center',
            background: important ? 'var(--state-warn-bg)' : 'var(--civic-surface)',
            color: important ? 'var(--state-warn-fg)' : 'var(--civic-text-secondary)',
            border: `1.5px solid ${important ? 'var(--state-warn-bd)' : 'var(--civic-border)'}`,
          }}
        >
          {important ? '★ Marked important (counts double)' : '☆ This one matters to me'}
        </button>

        {/* Agree / disagree / skip */}
        <div className="grid grid-cols-2 gap-3 mt-4">
          <button
            type="button"
            className="civic-btn civic-btn-secondary civic-btn-lg"
            onClick={() => commit('disagree')}
            style={{ flexDirection: 'column', gap: 2, height: 'auto', padding: '10px 8px', lineHeight: 1.2 }}
          >
            <span aria-hidden="true">←</span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>I lean this way</span>
            <span style={{ fontSize: 11, fontWeight: 500, opacity: 0.85, textAlign: 'center' }}>{truncate(current!.spectrumLow)}</span>
          </button>
          <button
            type="button"
            className="civic-btn civic-btn-primary civic-btn-lg"
            onClick={() => commit('agree')}
            style={{ flexDirection: 'column', gap: 2, height: 'auto', padding: '10px 8px', lineHeight: 1.2 }}
          >
            <span aria-hidden="true">→</span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>I lean this way</span>
            <span style={{ fontSize: 11, fontWeight: 500, opacity: 0.9, textAlign: 'center' }}>{truncate(current!.spectrumHigh)}</span>
          </button>
        </div>
        <button
          type="button"
          className="civic-btn civic-btn-tertiary civic-btn-sm mt-2"
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={() => commit('skip')}
        >
          Skip / no opinion
        </button>

        <p style={{ fontSize: 11, color: 'var(--civic-text-muted)', marginTop: 12, textAlign: 'center' }}>
          Keys: ← disagree · → agree · S skip · ↑ important. Your answers stay on this device.
        </p>
      </div>
    </div>
  );
}

function PoleLabel({ side, text }: { side: 'agree' | 'disagree'; text: string }) {
  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 'var(--r-md)',
        border: '1px solid var(--civic-border)',
        background: 'var(--civic-surface-muted)',
        fontSize: 13,
        color: 'var(--civic-text-secondary)',
        lineHeight: 1.35,
      }}
    >
      <span style={{ display: 'block', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--civic-text-muted)', fontWeight: 600, marginBottom: 2 }}>
        {side === 'disagree' ? 'One side' : 'Other side'}
      </span>
      {text}
    </div>
  );
}

function truncate(s: string, n = 48): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}
