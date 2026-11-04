/**
 * Handoff write-side (Booth Mode, V2 pillar 5b).
 *
 * Imports a decoded cross-device handoff into device storage. Kept SEPARATE from
 * the pure codec (handoff.ts) so the third-party embed, which only ever ENCODES,
 * never bundles the IndexedDB write path. Only the first-party booth loads this.
 *
 * On-device rule: this writes the voter's answers to IndexedDB only. Nothing is
 * sent to any server.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import type { QuickMatchAnswers } from '@/types/database';
import { deriveWeights } from '@/lib/matching/weights';
import { updateProfile } from './store';
import type { VoterProfile } from './types';
import {
  HANDOFF_AGREE_SCORE,
  HANDOFF_DISAGREE_SCORE,
  handoffChosenDomains,
  type HandoffAnswer,
} from './handoff';

/**
 * Merge decoded handoff answers into the device profile in one atomic write, and
 * (re)derive the emphasis from the importance stars using the SAME deriveWeights
 * the server and the embed use. Reproduces embed-match.buildEphemeralProfile so
 * the phone scores identically to what the widget displayed. Returns the stored
 * profile.
 *
 * Non-destructive by contract: the caller only invokes this when the device has
 * no answers yet (a fresh phone arriving from a QR), so an existing on-device
 * profile is never clobbered.
 */
export async function applyHandoffToProfile(
  answers: HandoffAnswer[],
): Promise<VoterProfile> {
  const chosenDomains = handoffChosenDomains(answers);
  const qma: QuickMatchAnswers = { domains: chosenDomains, positions: [] };
  const domainWeights = deriveWeights(qma);
  const now = new Date().toISOString();

  return updateProfile((p) => {
    const nextAnswers = { ...p.answers };
    for (const a of answers) {
      nextAnswers[a.issueId] = {
        subDimensionId: a.issueId,
        score: a.choice === 'agree' ? HANDOFF_AGREE_SCORE : HANDOFF_DISAGREE_SCORE,
        answeredAt: now,
        source: 'quick-match',
      };
    }
    return {
      ...p,
      answers: nextAnswers,
      emphasis: { chosenDomains, domainWeights },
    };
  });
}
