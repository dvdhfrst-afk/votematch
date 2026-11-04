'use client';

/**
 * Per-issue drill-down within a domain.
 *
 * Design decisions encoded here:
 *   B2 — Collapsed list, tap to expand
 *   C3 — Three labeled rows: YOUR POSITION · CANDIDATE'S POSITION · MATCH · SOURCES
 *   D2 — Inferred issues: language softens ("Likely…"), dashed left border,
 *        tinted background, broadened sourcing phrasing
 *   E2 — Low-confidence inferred rows are dimmed (opacity 0.7)
 *   F2 — Collapsed shows MatchChip verdict pill
 *   F3 — Tapping an expanded chip reveals the one-sentence nuance block
 *   G2 — Sources expand inline below the row, not on a separate route
 *
 * Source: .design-bundles/.../drilldown-frames.jsx DD2 + DD3
 */

import { useState } from 'react';
import type { IssueDiff } from '@/lib/guide/contract';
import type { SourceTier, VisibilityLevel } from '@/types/database';
import { tierVisibleAtLevel, visibilityMeta } from '@/lib/provenance';
import { BottomSheet } from '@/components/guide/BottomSheet';
import {
  SpectrumBar,
  MatchChip,
  ConfidenceBadge,
  verdictFromDelta,
} from '@/components/guide/primitives';

interface Props {
  issues: IssueDiff[];
  candidateName: string;
  /** Voter's visibility level (Brief B). Issues whose provenance is below the
   *  level are collapsed behind a restorable disclosure, never dropped. */
  visibilityLevel?: VisibilityLevel | null;
}

/**
 * Map a guide IssueDiff to a provenance tier so the visibility control can act
 * on the mock-contract data the same way it does on live `source_tier`. Issues
 * with no stated position return null — they're gaps, always shown (never
 * filtered), because "no position" is itself important signal.
 */
function effectiveTier(iss: IssueDiff): SourceTier | null {
  const hasPosition =
    iss.candidateScore !== null && iss.candidateConfidence !== 'no_data';
  if (!hasPosition) return null;
  // Guide treats low/medium confidence as inferred (see IssueRow.inferred).
  if (iss.candidateConfidence === 'low' || iss.candidateConfidence === 'medium') {
    return 'ml_inferred_from_corpus';
  }
  const tiers = iss.candidateSources.map((s) => s.tier);
  if (tiers.includes('primary')) return 'candidate_stated_current';
  if (tiers.includes('reported') || tiers.includes('paraphrase')) {
    return 'media_paraphrase_high_quality';
  }
  // High-confidence with no tiered source — treat as the candidate's own.
  return 'candidate_stated_current';
}

export default function DomainIssueList({
  issues,
  candidateName,
  visibilityLevel,
}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  if (issues.length === 0) {
    return (
      <p
        style={{
          fontSize: 13,
          color: 'var(--civic-text-muted)',
          fontStyle: 'italic',
          padding: '12px 14px',
          border: '1px dashed var(--civic-border)',
          borderRadius: 'var(--r-md)',
        }}
      >
        No issues available in this domain for this candidate.
      </p>
    );
  }

  // Partition by the voter's visibility level. Gaps (null tier) always show.
  const visible: IssueDiff[] = [];
  const hidden: IssueDiff[] = [];
  for (const iss of issues) {
    const tier = effectiveTier(iss);
    if (tier === null || tierVisibleAtLevel(tier, visibilityLevel)) {
      visible.push(iss);
    } else {
      hidden.push(iss);
    }
  }

  const renderRow = (iss: IssueDiff) => {
    const isOpen = openId === iss.issueId;
    return (
      <li key={iss.issueId}>
        <IssueRow
          issue={iss}
          candidateName={candidateName}
          isOpen={isOpen}
          onToggle={() => setOpenId(isOpen ? null : iss.issueId)}
        />
      </li>
    );
  };

  return (
    <div className="space-y-3">
      <ul className="space-y-2">{visible.map(renderRow)}</ul>

      {/* Hidden-by-visibility disclosure — restorable, never a hard drop. */}
      {hidden.length > 0 && (
        <div
          style={{
            border: '1px dashed var(--civic-border)',
            borderRadius: 'var(--r-md)',
            background: 'var(--civic-surface-muted)',
            padding: '10px 14px',
          }}
        >
          <button
            type="button"
            onClick={() => setShowHidden((v) => !v)}
            aria-expanded={showHidden}
            className="w-full text-left"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--civic-text-secondary)',
              minHeight: 36,
            }}
          >
            {showHidden ? '▾' : '▸'} {hidden.length}{' '}
            {hidden.length === 1 ? 'issue' : 'issues'} hidden by your visibility
            setting ({visibilityMeta(visibilityLevel).label})
          </button>
          <p
            style={{
              fontSize: 11,
              color: 'var(--civic-text-muted)',
              fontStyle: 'italic',
              marginTop: 4,
            }}
          >
            These have positions below your chosen trust level. Nothing is
            deleted — they&apos;re one tap away.
          </p>
          {showHidden && <ul className="space-y-2 mt-3">{hidden.map(renderRow)}</ul>}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────

interface RowProps {
  issue: IssueDiff;
  candidateName: string;
  isOpen: boolean;
  onToggle: () => void;
}

function IssueRow({ issue, candidateName, isOpen, onToggle }: RowProps) {
  const inferred = issue.candidateConfidence === 'low' || issue.candidateConfidence === 'medium';
  const hasPosition = issue.candidateScore !== null && issue.candidateConfidence !== 'no_data';
  const isContext = !issue.includedInScore && issue.relevance === 'context_only';
  const verdict = hasPosition ? verdictFromDelta(issue.delta) : 'unknown';

  // E2 · low-confidence inferred rows dim their overall weight
  const dim = inferred && issue.candidateConfidence === 'low';

  // D2 · inferred row visual treatment
  const rowBg = isContext
    ? 'var(--civic-surface-muted)'
    : inferred
      ? 'var(--civic-surface-muted)'
      : 'var(--civic-surface)';

  return (
    <div
      style={{
        border: '1px solid var(--civic-border)',
        borderLeftWidth: inferred ? 5 : 1,
        borderLeftStyle: inferred ? 'dashed' : 'solid',
        borderLeftColor: inferred ? 'var(--civic-border-strong)' : 'var(--civic-border)',
        borderRadius: 'var(--r-md)',
        background: rowBg,
        opacity: dim ? 0.75 : 1,
        transition: 'border-color var(--t-fast) var(--ease-standard)',
      }}
    >
      {/* Collapsed header — always clickable */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={`issue-${issue.issueId}`}
        className="w-full text-left"
        style={{
          padding: '12px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          minHeight: 56,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <div className="flex-1 min-w-0">
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--civic-text)' }}>
            {issue.issueName}
          </div>
          <div
            className="civic-mono"
            style={{ fontSize: 10, color: 'var(--civic-text-muted)', marginTop: 3 }}
          >
            {isContext && 'context only · '}
            {inferred
              ? `inferred · ${issue.candidateConfidence} confidence`
              : hasPosition
                ? 'stated'
                : 'no stated position'}
          </div>
        </div>
        <MatchChip verdict={verdict} small />
        <span
          aria-hidden="true"
          className="civic-mono"
          style={{
            fontSize: 14,
            color: 'var(--civic-text-muted)',
            transition: 'transform var(--t-default) var(--ease-standard)',
            transform: isOpen ? 'rotate(90deg)' : 'none',
          }}
        >
          ›
        </span>
      </button>

      {/* Expanded C3 three-row body */}
      {isOpen && (
        <div
          id={`issue-${issue.issueId}`}
          style={{
            borderTop: '1px solid var(--civic-border)',
            padding: '14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <ExpandedBody
            issue={issue}
            candidateName={candidateName}
            verdict={verdict}
            inferred={inferred}
            hasPosition={hasPosition}
          />
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────

interface ExpandedProps {
  issue: IssueDiff;
  candidateName: string;
  verdict: ReturnType<typeof verdictFromDelta>;
  inferred: boolean;
  hasPosition: boolean;
}

function ExpandedBody({ issue, candidateName, verdict, inferred, hasPosition }: ExpandedProps) {
  const [showNuance, setShowNuance] = useState(false);
  const [showSources, setShowSources] = useState(false);

  return (
    <>
      {/* Row 1 · YOUR POSITION */}
      <div>
        <MonoLabel>Your position</MonoLabel>
        {issue.voterScore !== null ? (
          <SpectrumBar
            low={issue.spectrum.low}
            high={issue.spectrum.high}
            voterScore={issue.voterScore}
            candidateScore={null}
          />
        ) : (
          <p style={{ fontSize: 13, color: 'var(--civic-text-muted)', fontStyle: 'italic' }}>
            You haven&apos;t answered this one yet.
          </p>
        )}
      </div>

      {/* Row 2 · CANDIDATE'S POSITION */}
      <div>
        <MonoLabel>
          Candidate&rsquo;s position
          {inferred && (
            <span
              style={{
                marginLeft: 6,
                padding: '1px 6px',
                background: 'var(--state-warn-bg)',
                color: 'var(--state-warn-fg)',
                border: '1px solid var(--state-warn-bd)',
                borderRadius: 'var(--r-pill)',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.04em',
              }}
            >
              INFERRED · BETA
            </span>
          )}
        </MonoLabel>

        {hasPosition ? (
          <>
            <SpectrumBar
              low={issue.spectrum.low}
              high={issue.spectrum.high}
              voterScore={null}
              candidateScore={issue.candidateScore}
              candidateName={candidateName.split(' ')[0]}
              disabled={!issue.includedInScore}
            />
            {issue.candidateSummary && (
              <p
                style={{
                  marginTop: 8,
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: 'var(--civic-text-secondary)',
                  fontStyle: inferred ? 'italic' : 'normal',
                  borderLeft: inferred ? '2px solid var(--civic-border-strong)' : 'none',
                  paddingLeft: inferred ? 10 : 0,
                }}
              >
                {inferred && <strong>Likely: </strong>}
                {issue.candidateSummary}
              </p>
            )}
          </>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--civic-text-muted)', fontStyle: 'italic' }}>
            No public statement on record. Not inferred.
          </p>
        )}
      </div>

      {/* Row 3 · MATCH · SOURCES */}
      <div>
        <MonoLabel>{inferred ? 'Match · basis' : 'Match · sources'}</MonoLabel>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            marginTop: 4,
          }}
        >
          <button
            type="button"
            onClick={() => setShowNuance((v) => !v)}
            aria-expanded={showNuance}
            aria-controls={`nuance-${issue.issueId}`}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: hasPosition ? 'pointer' : 'default',
            }}
            disabled={!hasPosition}
          >
            <MatchChip verdict={verdict} interactive={hasPosition} />
          </button>

          <ConfidenceBadge level={issue.candidateConfidence} />

          {issue.candidateSources.length > 0 && (
            <button
              type="button"
              onClick={() => setShowSources((v) => !v)}
              aria-expanded={showSources}
              aria-controls={`sources-${issue.issueId}`}
              className="civic-btn civic-btn-tertiary civic-btn-sm"
              style={{ minHeight: 32 }}
            >
              {showSources ? 'Hide' : 'Based on'} {issue.candidateSources.length}{' '}
              source{issue.candidateSources.length === 1 ? '' : 's'}
              <span aria-hidden="true">{showSources ? ' ▴' : ' ▾'}</span>
            </button>
          )}
        </div>

        {issue.delta !== null && hasPosition && (
          <p
            className="civic-mono"
            style={{ fontSize: 11, color: 'var(--civic-text-muted)', marginTop: 6 }}
          >
            Gap {issue.delta.toFixed(2)} ·{' '}
            {issue.delta <= 0.15
              ? 'closely aligned'
              : issue.delta <= 0.35
                ? 'moderate difference'
                : 'wide difference'}
          </p>
        )}
      </div>

      {/* F3 · nuance sentence — the match chip is tappable; the explanation
          arrives in a BottomSheet (ds-README non-negotiable 1: sheets, not
          modals). The sheet centers + caps width on >=768 and slides from the
          bottom on mobile, all handled by BottomSheet. */}
      {hasPosition && (
        <BottomSheet
          open={showNuance}
          onClose={() => setShowNuance(false)}
          title={issue.issueName}
        >
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.6,
              color: 'var(--civic-text)',
              margin: 0,
            }}
          >
            {renderNuanceSentence(issue, candidateName, verdict, inferred)}
          </p>
          {issue.candidateReasoning && (
            <p
              style={{
                marginTop: 10,
                fontSize: 13,
                lineHeight: 1.55,
                color: 'var(--civic-text-secondary)',
              }}
            >
              {issue.candidateReasoning}
            </p>
          )}
        </BottomSheet>
      )}

      {/* G2 · sources expand inline */}
      {showSources && issue.candidateSources.length > 0 && (
        <ul
          id={`sources-${issue.issueId}`}
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            border: '1px dashed var(--civic-border)',
            borderRadius: 'var(--r-md)',
            background: 'var(--civic-surface)',
          }}
        >
          {issue.candidateSources.map((s, i) => (
            <li
              key={i}
              style={{
                padding: '10px 14px',
                borderBottom:
                  i < issue.candidateSources.length - 1
                    ? '1px dashed var(--civic-border)'
                    : 'none',
                fontSize: 13,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                {s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: 'var(--civic-link)',
                      textDecoration: 'underline',
                      textUnderlineOffset: 2,
                      fontWeight: 500,
                    }}
                  >
                    {s.title}
                  </a>
                ) : (
                  <span style={{ color: 'var(--civic-text)' }}>{s.title}</span>
                )}
                {s.date && (
                  <span
                    className="civic-mono"
                    style={{ fontSize: 11, color: 'var(--civic-text-muted)' }}
                  >
                    {s.date}
                  </span>
                )}
              </div>
              {s.tier && (
                <div
                  className="civic-mono"
                  style={{
                    fontSize: 10,
                    color: 'var(--civic-text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    marginTop: 2,
                  }}
                >
                  {s.tier}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────

function MonoLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="civic-mono"
      style={{
        fontSize: 10,
        color: 'var(--civic-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        fontWeight: 600,
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

/**
 * F3 sentence nuance. Single clean sentence that explains the verdict in
 * plain language. Everything else (spectrum, sources) already shows the
 * data — this is the "put it in words" moment.
 */
function renderNuanceSentence(
  issue: IssueDiff,
  candidateName: string,
  verdict: ReturnType<typeof verdictFromDelta>,
  inferred: boolean,
): string {
  const firstName = candidateName.split(' ')[0];
  const verb = inferred ? 'likely ' : '';

  switch (verdict) {
    case 'strong-agree':
      return `You and ${firstName} ${verb}strongly agree on this — your positions are within a few points of each other.`;
    case 'agree':
      return `You and ${firstName} ${verb}mostly agree. Small differences in emphasis, not direction.`;
    case 'partial':
      return `You and ${firstName} ${verb}partially agree. Same general direction, but meaningful differences in how far.`;
    case 'disagree':
      return `You and ${firstName} ${verb}disagree on this — you want different outcomes.`;
    case 'strong-disagree':
      return `You and ${firstName} ${verb}strongly disagree. Opposite ends of the spectrum.`;
    case 'unknown':
      return `No match shown — ${firstName} has not stated a position and we don't infer one here.`;
  }
}
