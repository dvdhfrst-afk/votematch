'use client';

/**
 * Device-derived profile summary + plan CTA for the guide index (1B item 2).
 *
 * Reads the on-device profile (priorities/weights) and the client-computed
 * scores. No server round-trip for opinions. When there is no profile it shows
 * the honest "answer questions" affordance instead of an empty card.
 */

import Link from 'next/link';
import { useVoterProfile } from '@/lib/device/useVoterProfile';
import { useGuideScores } from '@/lib/device/guide-scores';
import { domainLabel } from './format';
import { Eyebrow, CivicLinkButton } from './primitives';

export function GuideProfileSummary() {
  const { profile, loading } = useVoterProfile();
  const hasProfile =
    !!profile && !!profile.emphasis && Object.keys(profile.answers).length > 0;

  if (loading) return null;

  if (!hasProfile) {
    return (
      <section className="civic-card">
        <Eyebrow>Your profile</Eyebrow>
        <p style={{ fontSize: 14, marginTop: 6, color: 'var(--civic-text-secondary)', lineHeight: 1.5 }}>
          Answer a few quick questions and your ballot gets matched to your
          priorities, right here on your device. Nothing you answer ever leaves
          this phone.
        </p>
        <div className="mt-4">
          <CivicLinkButton href="/quick-match" size="md">
            Answer a few questions
          </CivicLinkButton>
        </div>
      </section>
    );
  }

  const topDomains = Object.entries(profile!.emphasis!.domainWeights)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([d]) => d);

  return (
    <section className="civic-card">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Eyebrow>Your profile</Eyebrow>
          <p style={{ fontSize: 14, marginTop: 6, color: 'var(--civic-text-secondary)' }}>
            Built from your answers. Never leaves this device.
          </p>
        </div>
        <Link
          href="/quick-match"
          className="text-sm font-medium min-h-[44px] flex items-center"
          style={{ color: 'var(--civic-primary)' }}
        >
          Update
        </Link>
      </div>
      {topDomains.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 items-center">
          <span
            className="civic-mono"
            style={{
              fontSize: 11,
              color: 'var(--civic-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginRight: 4,
            }}
          >
            Top priorities:
          </span>
          {topDomains.map((d) => (
            <span
              key={d}
              style={{
                fontSize: 12,
                fontWeight: 500,
                padding: '3px 10px',
                borderRadius: 'var(--r-pill)',
                background: 'var(--civic-primary-soft)',
                color: 'var(--civic-primary)',
                border: '1px solid transparent',
              }}
            >
              {domainLabel(d)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/** Plan CTA with a device-derived decided-count. */
export function GuidePlanCta() {
  const scores = useGuideScores();
  const decided = [...scores.byRace.values()].filter((e) => e.topCandidateId).length;

  return (
    <section>
      <CivicLinkButton href="/guide/plan" size="lg" fullWidth>
        Take my plan to the booth
      </CivicLinkButton>
      <p
        style={{
          fontSize: 12,
          textAlign: 'center',
          color: 'var(--civic-text-muted)',
          marginTop: 8,
        }}
      >
        {scores.hasProfile
          ? `${decided} pick${decided === 1 ? '' : 's'} ready, save or print before you vote`
          : 'Answer a few questions to build your plan'}
      </p>
    </section>
  );
}
