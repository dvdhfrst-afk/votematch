/**
 * GuideRaceRail — the master list for the desktop two-pane master-detail layout
 * (REDESIGN-MAP §4: "on >=1024 use a two-pane master-detail, candidate list left,
 * expanded detail right, mobile keeps the A2 dedicated-page route"). Founder
 * approved TWO-PANE at desktop.
 *
 * Server-safe, display-only. Renders every race on the ballot as a compact,
 * tappable row with its top-match score chip. The currently-viewed race is
 * highlighted (aria-current). Below lg: this rail is hidden by the parent grid
 * so the phone flow is exactly the single-column route-per-screen experience.
 *
 * Data is passed in (already resolved by the page) so this stays a pure
 * presentational component and does not trigger a second provider round-trip.
 */

import Link from 'next/link';
import { officeLevelLabel } from './format';
import { ScoreChip } from './primitives';
import type { Race, MatchBreakdown } from '@/lib/guide/contract';

export interface RailRace {
  race: Race;
  top: MatchBreakdown | null;
}

interface Props {
  races: RailRace[];
  /** The race currently shown in the detail pane, if any. */
  activeRaceId?: string;
}

export default function GuideRaceRail({ races, activeRaceId }: Props) {
  return (
    <nav aria-label="All races on your ballot" className="space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2
          className="civic-serif"
          style={{
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 18,
            color: 'var(--civic-text)',
          }}
        >
          Your ballot
        </h2>
        <span
          className="civic-mono"
          style={{ fontSize: 11, color: 'var(--civic-text-muted)' }}
        >
          {races.length} race{races.length === 1 ? '' : 's'}
        </span>
      </div>

      <ul className="space-y-2">
        {races.map(({ race, top }) => {
          const isActive = race.id === activeRaceId;
          return (
            <li key={race.id}>
              <Link
                href={`/guide/race/${race.id}`}
                aria-current={isActive ? 'page' : undefined}
                className="block civic-card-interactive"
                style={{
                  padding: '10px 12px',
                  borderRadius: 'var(--r-md)',
                  border: '1px solid',
                  borderColor: isActive
                    ? 'var(--civic-border-strong)'
                    : 'var(--civic-border)',
                  background: isActive
                    ? 'var(--civic-primary-soft)'
                    : 'var(--civic-surface)',
                  textDecoration: 'none',
                  color: 'inherit',
                  minHeight: 56,
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div
                      className="civic-mono"
                      style={{
                        fontSize: 10,
                        color: 'var(--civic-text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      {officeLevelLabel(race.officeLevel)}
                    </div>
                    <div
                      className="truncate"
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: 'var(--civic-text)',
                        marginTop: 2,
                      }}
                    >
                      {race.name}
                    </div>
                  </div>
                  {top && (
                    <div className="shrink-0">
                      <ScoreChip pct={top.overallScore} showTier={false} />
                    </div>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
