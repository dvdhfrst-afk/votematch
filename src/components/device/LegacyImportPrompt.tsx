'use client';

/**
 * One-time legacy-to-device import prompt (work-order 1B item 4).
 *
 * Shown on the guide index when BOTH:
 *   - the SERVER session still carries legacy quick-match answers, AND
 *   - the DEVICE has no profile yet (nothing to overwrite).
 *
 * Flow on accept:
 *   1. exportLegacyAnswersToDevice() hands the voter's OWN answers back to the
 *      browser,
 *   2. we write them to IndexedDB (setEmphasis + setAnswer per stance),
 *   3. clearLegacyServerOpinions() nulls the server rows + deletes the snapshot.
 *
 * On decline we still clear the server rows (the on-device architecture forbids
 * keeping opinions on the server regardless of import choice) but do not write
 * anything to the device. Either way the prompt is one-time: once the server
 * rows are gone, getLegacyOpinionSummary reports nothing to import.
 *
 * PRIVACY: the only data motion is the voter's own answers moving onto the
 * voter's own device, then being erased from the server. No third party, no log.
 */

import { useEffect, useState } from 'react';
import { useVoterProfile } from '@/lib/device/useVoterProfile';
import {
  clearLegacyServerOpinions,
  exportLegacyAnswersToDevice,
  getLegacyOpinionSummary,
} from '@/app/device-migration-actions';
import { CivicButton, Eyebrow } from '@/components/guide/primitives';
import type { Domain } from '@/types/database';

type Phase = 'checking' | 'offer' | 'importing' | 'done' | 'hidden';

export default function LegacyImportPrompt() {
  const { profile, loading, setEmphasis, setAnswer } = useVoterProfile();
  const [phase, setPhase] = useState<Phase>('checking');
  const [summary, setSummary] = useState<{ domainCount: number; answerCount: number }>({
    domainCount: 0,
    answerCount: 0,
  });

  // Decide whether to offer the import. Only when the device has NO profile and
  // the server still has legacy answers. Wait for the device load to settle so
  // we never prompt a voter who already has an on-device profile.
  useEffect(() => {
    if (loading) return;
    // A voter with an on-device profile does not need the import; leave the
    // server-clear to happen lazily below so we never keep opinions server-side.
    let cancelled = false;
    getLegacyOpinionSummary()
      .then((s) => {
        if (cancelled) return;
        if (!s.hasLegacy) {
          setPhase('hidden');
          return;
        }
        if (profile && Object.keys(profile.answers).length > 0) {
          // Device already has answers: do not offer import, just clear the
          // stale server copy so opinions do not linger on the operational DB.
          void clearLegacyServerOpinions();
          setPhase('hidden');
          return;
        }
        setSummary({ domainCount: s.domainCount, answerCount: s.answerCount });
        setPhase('offer');
      })
      .catch(() => setPhase('hidden'));
    return () => {
      cancelled = true;
    };
    // Intentionally keyed on loading only: we check once the device load settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  async function handleImport() {
    setPhase('importing');
    try {
      const legacy = await exportLegacyAnswersToDevice();
      if (legacy) {
        // Reconstruct the device profile: priorities first (derives weights),
        // then each stance.
        if (legacy.domains.length > 0) {
          await setEmphasis(legacy.domains as Domain[]);
        }
        for (const p of legacy.positions) {
          await setAnswer(p.sub_dimension_id, p.score, 'quick-match');
        }
      }
    } catch {
      // A device-write failure should not strand the server data forever, but we
      // also should not clear the server copy if the import did not land. Leave
      // the server rows in place and let the voter retry on next load.
      setPhase('offer');
      return;
    }
    // Import landed: erase the server-side copy.
    await clearLegacyServerOpinions();
    setPhase('done');
  }

  async function handleDecline() {
    setPhase('importing');
    // On decline we still remove opinions from the server (on-device
    // architecture forbids keeping them there); we simply do not import them.
    await clearLegacyServerOpinions();
    setPhase('hidden');
  }

  if (phase === 'checking' || phase === 'hidden') return null;

  if (phase === 'done') {
    return (
      <section className="civic-card" role="status" aria-live="polite">
        <Eyebrow>Moved to your device</Eyebrow>
        <p style={{ fontSize: 14, marginTop: 6, color: 'var(--civic-text-secondary)' }}>
          Your earlier answers now live only on this device, and the copy on our
          server has been erased.
        </p>
      </section>
    );
  }

  return (
    <section className="civic-card">
      <Eyebrow>Bring your answers onto this device</Eyebrow>
      <p style={{ fontSize: 14, marginTop: 6, color: 'var(--civic-text-secondary)', lineHeight: 1.5 }}>
        You answered {summary.answerCount} question
        {summary.answerCount === 1 ? '' : 's'} across {summary.domainCount}{' '}
        priorit{summary.domainCount === 1 ? 'y' : 'ies'} in an earlier visit. We
        now keep answers only on your device. Move them here, and we will erase
        the copy on our server.
      </p>
      <div className="mt-4 flex flex-col sm:flex-row gap-2">
        <CivicButton
          variant="primary"
          size="md"
          onClick={handleImport}
          disabled={phase === 'importing'}
        >
          {phase === 'importing' ? 'Moving...' : 'Move my answers here'}
        </CivicButton>
        <CivicButton
          variant="tertiary"
          size="md"
          onClick={handleDecline}
          disabled={phase === 'importing'}
        >
          No thanks, start fresh
        </CivicButton>
      </div>
    </section>
  );
}
