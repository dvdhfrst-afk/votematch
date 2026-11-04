import { getGuideProvider, isGuideRenderable } from '@/lib/guide/provider';
import GuidePlanClient from '@/components/guide/GuidePlanClient';

/**
 * Booth companion — the thing a voter brings with them to vote.
 *
 * ON-DEVICE (work-order 1B): the server supplies the ballot's races (display).
 * The PLAN — top picks, scores, decided/undecided counts — is computed on the
 * CLIENT from the on-device profile + saved picks (GuidePlanClient). Havesay
 * never stores who the voter chose.
 *
 * Print reference:
 *   .design-bundles/ballot-bridge/project/design-system/ds-responsive.jsx
 *   — @media print collapses all nation color to grayscale (globals.css)
 */
export default async function GuidePlanPage() {
  if (!isGuideRenderable()) return null;
  const provider = getGuideProvider();
  const races = await provider.listRaces();

  return <GuidePlanClient races={races} />;
}
