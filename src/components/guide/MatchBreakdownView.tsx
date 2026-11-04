'use client';

/**
 * Drill-down view · Depth 1 + 2 (headline + per-domain).
 *
 * Per committed design decisions (DD1 / DD2):
 *   · Headline tap → inline expand (A) — state lives here, the card grows
 *   · Each domain row is a LINK to its own page (A2), not another accordion
 *   · Per-issue diffs live on the domain page, not here
 *
 * Source: .design-bundles/ballot-bridge/project/drilldown-frames.jsx
 * Interactions: .design-bundles/ballot-bridge/project/design-system/ds-interactions.jsx §3a
 */

import { useState } from 'react';
import Link from 'next/link';
import type { MatchBreakdown, Race, Candidate } from '@/lib/guide/contract';
import { ScoreBar, ConfidenceBadge, Caveat } from './primitives';
import { domainLabel, formatPct, officeNoun } from './format';

interface Props {
  breakdown: MatchBreakdown;
  candidate: Candidate;
  race: Race;
  /** Open the breakdown by default. */
  startOpen?: boolean;
}

export default function MatchBreakdownView({
  breakdown,
  candidate,
  race,
  startOpen = false,
}: Props) {
  const [open, setOpen] = useState(startOpen);

  const hasContext =
    breakdown.contextIssuesCount > 0 || breakdown.excludedByOfficeCount > 0;

  return (
    <div className="civic-card">
      {/* ── L1 · Headline — always visible, always tappable ────────────── */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={`breakdown-${candidate.id}`}
        className="w-full text-left flex items-center gap-4 p-1 -m-1 rounded-lg min-h-[64px]"
        style={{ transition: 'background var(--t-fast) var(--ease-standard)' }}
      >
        <div className="flex-1 min-w-0">
          <ScoreBar pct={breakdown.overallScore} label={`Match · ${candidate.name}`} />
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <ConfidenceBadge level={breakdown.confidence} />
            <span
              className="civic-mono"
              style={{
                fontSize: 11,
                color: 'var(--civic-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {breakdown.countedIssuesCount} of {breakdown.totalCountableIssuesCount} issues counted
            </span>
          </div>
        </div>
        <span
          aria-hidden="true"
          style={{
            fontSize: 20,
            color: 'var(--civic-text-muted)',
            transition: 'transform var(--t-default) var(--ease-standard)',
            transform: open ? 'rotate(90deg)' : 'none',
          }}
        >
          ›
        </span>
      </button>

      {/* Tied-with caveat (separate from notes so it's prominent) */}
      {breakdown.tiedWith.length > 0 && (
        <div className="mt-3">
          <Caveat kind="info">
            Within 5 points of {breakdown.tiedWith.join(', ')}: treat as a close call,
            not a ranked order.
          </Caveat>
        </div>
      )}

      {/* ── L2 · By-domain ──────────────────────────────────────────────── */}
      {open && (
        <div id={`breakdown-${candidate.id}`} className="mt-5">
          <div
            className="civic-mono mb-3"
            style={{
              fontSize: 11,
              color: 'var(--civic-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            By domain: tap any to open
          </div>

          <ul className="space-y-2">
            {breakdown.byDomain.map((d) => (
              <li key={d.domain}>
                <Link
                  href={`/guide/race/${race.id}/domain/${d.domain}?candidate=${candidate.id}`}
                  prefetch={false}
                  className="block civic-card-interactive"
                  style={{
                    padding: '12px 14px',
                    border: '1px solid var(--civic-border)',
                    borderRadius: 'var(--r-md)',
                    background: 'var(--civic-surface)',
                    minHeight: 64,
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          style={{ fontWeight: 600, color: 'var(--civic-text)' }}
                          className="truncate"
                        >
                          {domainLabel(d.domain)}
                        </span>
                        {d.countedIssues > 0 ? (
                          <span
                            className="civic-tabular"
                            style={{
                              fontFamily: 'var(--font-serif)',
                              fontWeight: 700,
                              fontSize: 18,
                              color: 'var(--civic-text)',
                            }}
                          >
                            {formatPct(d.alignment)}
                          </span>
                        ) : (
                          <span
                            className="civic-mono"
                            style={{ fontSize: 11, color: 'var(--civic-text-muted)' }}
                          >
                            no coverage
                          </span>
                        )}
                      </div>

                      {d.countedIssues > 0 && (
                        <div
                          style={{
                            marginTop: 6,
                            height: 6,
                            background: 'var(--civic-surface-sunken)',
                            borderRadius: 'var(--r-pill)',
                            overflow: 'hidden',
                            border: '1px solid var(--civic-border)',
                          }}
                        >
                          <div
                            aria-hidden="true"
                            style={{
                              width: `${Math.max(2, d.alignment)}%`,
                              height: '100%',
                              background:
                                d.alignment >= 75
                                  ? 'var(--score-high-bar)'
                                  : d.alignment >= 50
                                    ? 'var(--score-mid-bar)'
                                    : 'var(--score-low-bar)',
                              borderRadius: 'var(--r-pill)',
                            }}
                          />
                        </div>
                      )}

                      <div
                        className="civic-mono"
                        style={{
                          marginTop: 6,
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 8,
                          fontSize: 11,
                          color: 'var(--civic-text-muted)',
                        }}
                      >
                        <span>
                          {d.countedIssues} of {d.totalIssues} issues
                          {d.weight > 0 && ` · priority ${Math.round(d.weight * 100)}%`}
                        </span>
                        {d.countedIssues > 0 && d.contribution !== 0 && (
                          <span
                            style={{
                              color:
                                d.contribution > 0
                                  ? 'var(--state-success-fg)'
                                  : 'var(--state-warn-fg)',
                              fontWeight: 700,
                            }}
                          >
                            {d.contribution > 0 ? '+' : ''}
                            {d.contribution} pts
                          </span>
                        )}
                      </div>
                    </div>
                    <span
                      aria-hidden="true"
                      style={{ fontSize: 18, color: 'var(--civic-text-muted)' }}
                    >
                      ›
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* Office-scope explanation (3b pattern — NOT a warning) */}
          {hasContext && (
            <p
              className="mt-4"
              style={{
                fontSize: 13,
                color: 'var(--civic-text-secondary)',
                padding: '10px 14px',
                background: 'var(--civic-surface-muted)',
                borderRadius: 'var(--r-md)',
                border: '1px solid var(--civic-border)',
              }}
            >
              {breakdown.contextIssuesCount > 0 && (
                <>
                  {breakdown.contextIssuesCount} issue
                  {breakdown.contextIssuesCount === 1 ? ' is' : 's are'} listed for context;
                  a {officeNoun(race.officeLevel)} can&rsquo;t change them, so they don&rsquo;t
                  count toward the score.
                </>
              )}
            </p>
          )}

          {/* Caveats / notes */}
          {breakdown.notes.length > 0 && (
            <ul
              className="mt-4 space-y-1.5"
              style={{
                fontSize: 12,
                color: 'var(--civic-text-muted)',
                paddingTop: 12,
                borderTop: '1px solid var(--civic-border)',
              }}
            >
              {breakdown.notes.map((n) => (
                <li key={n.type} style={{ lineHeight: 1.5 }}>
                  <span aria-hidden="true" style={{ marginRight: 6 }}>
                    ·
                  </span>
                  {n.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
