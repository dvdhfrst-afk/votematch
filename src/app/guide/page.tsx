import { getGuideProvider, isGuideRenderable } from '@/lib/guide/provider';
import { formatElectionDate } from '@/components/guide/format';
import { Eyebrow } from '@/components/guide/primitives';
import VisibilityControl from '@/components/match/VisibilityControl';
import InstallPrompt from '@/components/pwa/InstallPrompt';
import GuideRaceList from '@/components/guide/GuideRaceList';
import {
  GuideProfileSummary,
  GuidePlanCta,
} from '@/components/guide/GuideProfileSummary';
import LegacyImportPrompt from '@/components/device/LegacyImportPrompt';
import DailyPromptCard from '@/components/device/DailyPromptCard';
import DailyReminder from '@/components/pwa/DailyReminder';
import PoolOptIn from '@/components/device/PoolOptIn';
import { getSessionUser } from '@/lib/session';
import { DEFAULT_VISIBILITY } from '@/lib/provenance';
import { isSignalPoolEnabled } from '@/lib/signal-pool/flag';
import { resolveCoarseGeography } from '@/lib/signal-pool/geography';

/**
 * Guide index — the "where do I start" surface.
 *
 * ON-DEVICE (work-order 1B): the server supplies the ballot's race + candidate
 * DISPLAY data (public) via the provider. Every SCORE — the match chips, the top
 * match per race, the plan pick count, the profile priorities — is computed on
 * the CLIENT from the on-device voter profile (GuideRaceList / GuideProfileSummary
 * / GuidePlanCta all use useGuideScores). No opinion is read from or written to
 * the server here.
 */
export default async function GuideIndexPage() {
  // Guard: when the guide has no live provider, do not touch the (mock)
  // provider. The layout renders the honest "in development" notice in place
  // of this null. See src/lib/guide/provider.ts.
  if (!isGuideRenderable()) return null;
  const provider = getGuideProvider();
  // DISPLAY data only: the ballot's races + candidates (public). No voter
  // profile or match computation on the server.
  const [races, sessionUser] = await Promise.all([
    provider.listRaces(),
    getSessionUser(),
  ]);
  const visibilityLevel =
    sessionUser?.quick_match_answers?.visibility_level ?? DEFAULT_VISIBILITY;

  // Signal pool (Phase 3B, part 2): resolve coarse geography server-side ONLY
  // when the feature flag is on. Off by default, so this is skipped entirely and
  // the card never renders in production until the operator flips the flag.
  const poolGeography = isSignalPoolEnabled() ? await resolveCoarseGeography() : null;

  // Earliest election date across this ballot's races. Voters holding an early
  // ballot need the deadline surfaced up front. `electionDate` is an ISO
  // YYYY-MM-DD string; sort lexicographically and format as a local calendar date.
  const nextElectionDate = races
    .map((r) => r.electionDate)
    .filter((d): d is string => Boolean(d))
    .sort()[0];

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      {/* Hero */}
      <section>
        <h1
          style={{
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 'clamp(28px, 1.6rem + 1.4vw, 44px)',
            lineHeight: 1.1,
            letterSpacing: '-0.01em',
            color: 'var(--civic-text)',
          }}
        >
          Your whole ballot, explained.
        </h1>
        <p
          style={{
            fontSize: 16,
            lineHeight: 1.55,
            color: 'var(--civic-text-secondary)',
            marginTop: 12,
            maxWidth: '56ch',
          }}
        >
          Every race on your ballot, matched against your priorities. Tap any
          match score to see the domain breakdown, and every issue underneath.
        </p>
        {nextElectionDate && (
          <div
            className="mt-4 inline-flex items-center gap-2"
            style={{
              padding: '6px 12px',
              borderRadius: 'var(--r-pill)',
              background: 'var(--civic-primary-soft)',
              border: '1px solid transparent',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 13 }}>
              🗓
            </span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--civic-primary)',
              }}
            >
              Election day: {formatElectionDate(nextElectionDate)}
            </span>
          </div>
        )}
      </section>

      {/* One-time legacy-to-device import (only shows when the server still has
          legacy answers and the device has none). Clears the server copy after. */}
      <LegacyImportPrompt />

      {/* Install affordance — dismissible, frequency-capped on-device. */}
      <InstallPrompt />

      {/* Voter profile summary — device-derived, honest no-profile state. */}
      <GuideProfileSummary />

      {/* Today's question — device-picked from a server-blind candidate list.
          Keeps the stance vector current ("your stance survives the latest
          news"). Answers write to the device only; the guide re-scores live. */}
      <DailyPromptCard />

      {/* Opt-in daily reminder (PWA local notification, device-scheduled). */}
      <DailyReminder />

      {/* Visibility control — governs how much candidate evidence is shown by
          default across the guide drill-downs. Never hides data. */}
      <section>
        <VisibilityControl current={visibilityLevel} />
      </section>

      {/* Races list — display from the server, scores from the device. */}
      <section>
        <h2
          style={{
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 22,
            color: 'var(--civic-text)',
            marginBottom: 12,
          }}
        >
          Races on your ballot
        </h2>
        {races.length > 0 ? (
          <GuideRaceList races={races} />
        ) : (
          <div className="civic-card">
            <Eyebrow>No ballot yet</Eyebrow>
            <p style={{ fontSize: 14, marginTop: 6, color: 'var(--civic-text-secondary)' }}>
              Look up your address to see the races on your ballot.
            </p>
          </div>
        )}
      </section>

      {/* Booth CTA — device-derived pick count. */}
      <GuidePlanCta />

      {/* Signal pool opt-in (Phase 3B, part 2). Renders null unless the flag is
          on. Preview-first: the voter must see exactly what would be shared
          before contributing. Coarse geography resolved server-side above. */}
      <PoolOptIn geography={poolGeography} />
    </div>
  );
}
