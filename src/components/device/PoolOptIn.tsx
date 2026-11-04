'use client';

/**
 * PoolOptIn (work-order Phase 3B, part 2, step 2) -- the preview-first opt-in UI
 * for the signal pool.
 *
 * DAVID'S LOCKED LANGUAGE: the pool is "an encrypted, anonymous pool of what
 * voters tell us." No polling jargon (no "panel", no "respondents"). The copy
 * here uses that family of language deliberately (memory: language-avoid-polling-
 * jargon).
 *
 * REQUIRED "SEE EXACTLY WHAT WOULD BE SHARED" PREVIEW: before the voter can turn
 * contribution ON, this renders the LITERAL JSON payload that would be sent,
 * human-annotated (dimension names, what a bucket means, what a freshness epoch
 * is). The preview is the return value of buildContributionPayload -- the SAME
 * function the submission client sends -- so the preview can never diverge from
 * what actually ships. The toggle is disabled until the voter has opened the
 * preview at least once.
 *
 * CONTROLS:
 *   - Contribute toggle (default OFF): schedules a jittered upsert on turn-on.
 *   - "Stop contributing" (device-side off): clears the opt-in + any pending send.
 *   - "Remove my data from the pool" (nuke): schedules a jittered delete and
 *     clears local opt-in. The copy explains epoch-boundary batching honestly.
 *
 * FLAG GATE: the whole component renders null unless NEXT_PUBLIC_SIGNAL_POOL_ENABLED
 * is 'true' (isSignalPoolEnabled reads the build-time-inlined NEXT_PUBLIC flag).
 *
 * GEOGRAPHY: coarse geography (state + congressional district) is passed in as a
 * prop resolved from the session ballot server-side. When absent, the component
 * shows an honest "look up your ballot first" state and does not let the voter
 * contribute (a contribution with no district is not the product).
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useVoterProfile } from '@/lib/device/useVoterProfile';
import { isSignalPoolEnabled } from '@/lib/signal-pool/flag';
import { CivicButton, Eyebrow } from '@/components/guide/primitives';
import {
  buildContributionPayload,
  newSubsetSeed,
  configuredSubsetMax,
  STANCE_BUCKET_COUNT,
  type ContributionPayload,
  type CoarseGeography,
} from '@/lib/device/pool-contribution';
import {
  scheduleContribution,
  stopContributing,
  nukeContribution,
  maybeFlushPending,
  readPoolState,
} from '@/lib/device/pool-submission';

/** Optional map from sub_dimension id -> human name, for annotating the preview. */
export type SubDimensionLabels = Record<string, string>;

export interface PoolOptInProps {
  /** Coarse geography from the session ballot. Null until a ballot is resolved. */
  geography?: CoarseGeography | null;
  /** Optional sub_dimension id -> name map for the annotated preview. */
  subDimensionLabels?: SubDimensionLabels;
}

function bucketMeaning(bucket: number): string {
  // 5 equal-width buckets over 0..1. Describe the fifth of the spectrum.
  const labels = [
    'far toward the low end',
    'toward the low end',
    'middle',
    'toward the high end',
    'far toward the high end',
  ];
  return labels[Math.max(0, Math.min(STANCE_BUCKET_COUNT - 1, bucket))];
}

export default function PoolOptIn({ geography, subDimensionLabels }: PoolOptInProps) {
  const { profile, loading, available } = useVoterProfile();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewedOnce, setPreviewedOnce] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A single random-subset seed fixed for this mount, so the preview shows the
  // EXACT subset that the scheduled send will carry (finding 4). Turning on
  // contribution passes this same seed to scheduleContribution.
  const [subsetSeed] = useState(() => newSubsetSeed());

  // Flush any due pending contribution on mount (send-on-next-open-with-jitter).
  useEffect(() => {
    if (!isSignalPoolEnabled()) return;
    void maybeFlushPending().catch(() => {});
  }, []);

  const poolState = profile ? readPoolState(profile) : { optedIn: false };

  // The literal payload that WOULD be sent. Built from the same function the
  // submission client uses, so the preview cannot diverge. Null when there is no
  // geography (nothing to contribute) or no profile yet.
  const payload: ContributionPayload | null = useMemo(() => {
    if (!profile || !geography) return null;
    // Build with the fixed subset seed so the preview equals the scheduled send.
    return buildContributionPayload({ answers: profile.answers, geography, subsetSeed });
  }, [profile, geography, subsetSeed]);

  // How many answered dims the voter has total, for the honest "subset" copy.
  const totalAnswered = profile ? Object.keys(profile.answers).length : 0;
  const subsetCap = configuredSubsetMax();

  const openPreview = useCallback(() => {
    setPreviewOpen(true);
    setPreviewedOnce(true);
  }, []);

  const handleTurnOn = useCallback(async () => {
    if (!geography) return;
    setBusy(true);
    setStatus(null);
    try {
      const { dueAtMs } = await scheduleContribution({ geography, subsetSeed });
      // Try to flush immediately in case jitter rounded to ~0; otherwise it will
      // send on next open or when the in-page interval below fires.
      const flush = await maybeFlushPending();
      if (flush.result && !flush.result.ok && flush.result.reason === 'relay_required') {
        setStatus(
          'Contribution is enabled but this build has no privacy relay configured, so ' +
            'your device will not send over a direct connection (that would reveal your ' +
            'network address). Nothing was sent.',
        );
        return;
      }
      const mins = Math.max(0, Math.round((dueAtMs - Date.now()) / 60000));
      setStatus(
        mins <= 0
          ? 'You are contributing. Your device shared a small, anonymous, bucketed subset of your answers.'
          : `You are contributing. To avoid revealing when you answered, your device will send a small anonymous subset within the next few hours (scheduled about ${mins} minutes out, and on your next visit).`,
      );
    } catch {
      setStatus('Could not start contributing on this device.');
    } finally {
      setBusy(false);
    }
  }, [geography, subsetSeed]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    try {
      await stopContributing();
      setStatus('Stopped. Your device will not send anything new. Data already in the pool stays until you remove it below.');
    } catch {
      setStatus('Could not stop on this device.');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleNuke = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    try {
      await nukeContribution();
      await maybeFlushPending();
      setStatus('Removal scheduled. Your slot is dropped from the pool at the next weekly recompute; the published numbers are rebuilt only from slots present then, so your data leaves on that boundary. The delay is batched on purpose so a removal cannot be timed back to you.');
    } catch {
      setStatus('Could not schedule removal on this device.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (!isSignalPoolEnabled()) return null;
  if (loading) return null;

  return (
    <section
      style={{
        marginTop: 16,
        padding: '18px 20px',
        borderRadius: 12,
        border: '1px solid var(--civic-border, #e5e7eb)',
        background: 'var(--civic-surface-muted, #f8f9fa)',
      }}
    >
      <Eyebrow>Encrypted, anonymous pool</Eyebrow>
      <h3 style={{ fontSize: 18, fontWeight: 700, margin: '6px 0 8px' }}>
        Add your voice to the pool
      </h3>
      <p style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--civic-text-secondary, #555)' }}>
        You can add what you have told us to an encrypted, anonymous pool of what
        voters across the country are saying. It travels without your name, your
        address, or anything that ties it back to you or this device. It is off
        unless you turn it on, and you can stop or remove it any time.
      </p>

      {!available ? (
        <p style={{ fontSize: 14, marginTop: 10, color: 'var(--civic-text-secondary, #555)' }}>
          This browser does not support on-device storage, so there is nothing to
          contribute from here.
        </p>
      ) : !geography ? (
        <p style={{ fontSize: 14, marginTop: 10, color: 'var(--civic-text-secondary, #555)' }}>
          Look up your ballot first. The pool works at the level of your state and
          congressional district, so it needs to know which one before you can
          contribute.
        </p>
      ) : (
        <>
          {/* REQUIRED preview: see exactly what would be shared. */}
          <div className="mt-4">
            <CivicButton variant="secondary" size="md" onClick={openPreview} disabled={busy}>
              {previewOpen ? 'Hide what would be shared' : 'See exactly what would be shared'}
            </CivicButton>
          </div>

          {previewOpen && payload && (
            <div
              style={{
                marginTop: 12,
                padding: '14px 16px',
                borderRadius: 10,
                border: '1px solid var(--civic-border, #e5e7eb)',
                background: 'var(--civic-surface, #fff)',
              }}
            >
              <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                This is the entire message your device would send. Nothing else
                leaves this device.
              </p>

              {/* Human-annotated summary. */}
              <ul style={{ fontSize: 13, lineHeight: 1.6, paddingLeft: 18, margin: '0 0 12px' }}>
                <li>
                  <strong>Where:</strong> {payload.state}, district {payload.cd}. This
                  is as specific as the location gets, no address, no precinct.
                </li>
                <li>
                  <strong>What:</strong> {payload.stances.length} bucketed stance
                  {payload.stances.length === 1 ? '' : 's'}
                  {totalAnswered > payload.stances.length
                    ? ` (a random subset of your ${totalAnswered} answered topics, at most ${subsetCap} per send)`
                    : ''}
                  . Each is coarsened to one of five bands, never your exact score.
                  Each time you contribute, a different random handful of your topics
                  goes, so no single send carries a full fingerprint of your views;
                  the pool still fills in over time.
                </li>
                <li>
                  <strong>When:</strong> only a weekly freshness marker per stance, so
                  the pool can retire stale answers. Never a precise time.
                </li>
              </ul>

              {payload.stances.length > 0 && (
                <div style={{ fontSize: 13, marginBottom: 12 }}>
                  {payload.stances.map((s) => (
                    <div key={s.subDimensionId} style={{ marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>
                        {subDimensionLabels?.[s.subDimensionId] ?? s.subDimensionId}
                      </span>
                      : {bucketMeaning(s.bucket)} (band {s.bucket} of{' '}
                      {STANCE_BUCKET_COUNT - 1}), fresh as of week {s.freshnessEpoch}.
                    </div>
                  ))}
                </div>
              )}

              {/* The literal JSON, verbatim. */}
              <p style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--civic-text-secondary, #555)' }}>
                The exact data, verbatim:
              </p>
              <pre
                style={{
                  fontSize: 12,
                  fontFamily: 'var(--font-mono, monospace)',
                  background: 'var(--civic-surface-muted, #f4f4f5)',
                  padding: '10px 12px',
                  borderRadius: 8,
                  overflowX: 'auto',
                  whiteSpace: 'pre',
                  margin: 0,
                }}
              >
                {JSON.stringify(payload, null, 2)}
              </pre>
            </div>
          )}

          {/* Toggle: disabled until the voter has opened the preview once. */}
          <div className="mt-4 flex flex-col sm:flex-row gap-2">
            {!poolState.optedIn ? (
              <CivicButton
                variant="primary"
                size="md"
                onClick={handleTurnOn}
                disabled={busy || !previewedOnce}
              >
                {previewedOnce ? 'Contribute to the pool' : 'Preview first, then contribute'}
              </CivicButton>
            ) : (
              <CivicButton variant="secondary" size="md" onClick={handleStop} disabled={busy}>
                Stop contributing
              </CivicButton>
            )}
            <CivicButton variant="destructive" size="md" onClick={handleNuke} disabled={busy}>
              Remove my data from the pool
            </CivicButton>
          </div>

          {!previewedOnce && (
            <p style={{ fontSize: 12, marginTop: 8, color: 'var(--civic-text-secondary, #777)' }}>
              Open the preview above to enable contributing. You should see exactly
              what leaves your device before any of it does.
            </p>
          )}
        </>
      )}

      {status && (
        <p
          role="status"
          aria-live="polite"
          style={{ marginTop: 12, fontSize: 13, color: 'var(--civic-text, #222)' }}
        >
          {status}
        </p>
      )}
    </section>
  );
}
