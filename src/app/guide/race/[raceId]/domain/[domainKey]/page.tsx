import { notFound } from 'next/navigation';
import { getGuideProvider, isGuideRenderable } from '@/lib/guide/provider';
import { getSessionUser } from '@/lib/session';
import { DEFAULT_VISIBILITY } from '@/lib/provenance';
import GuideDomainClient from '@/components/guide/GuideDomainClient';

/**
 * Domain-focused page (DD2).
 *
 * ON-DEVICE (work-order 1B): the server supplies the race + candidate DISPLAY
 * data (public). The per-domain / per-issue MATCH breakdown is computed on the
 * CLIENT from the on-device profile inside GuideDomainClient (useGuideScores).
 * No opinion is read server-side.
 */
export default async function GuideDomainPage({
  params,
  searchParams,
}: {
  params: Promise<{ raceId: string; domainKey: string }>;
  searchParams: Promise<{ candidate?: string }>;
}) {
  if (!isGuideRenderable()) return null;
  const { raceId, domainKey } = await params;
  const { candidate: candidateId } = await searchParams;

  const provider = getGuideProvider();
  const [race, allRaces, sessionUser] = await Promise.all([
    provider.getRace(raceId),
    provider.listRaces(),
    getSessionUser(),
  ]);
  if (!race) notFound();

  const visibilityLevel =
    sessionUser?.quick_match_answers?.visibility_level ?? DEFAULT_VISIBILITY;

  return (
    <div className="max-w-3xl lg:max-w-6xl mx-auto px-4 py-6">
      <GuideDomainClient
        race={race}
        allRaces={allRaces}
        domainKey={domainKey}
        candidateId={candidateId}
        visibilityLevel={visibilityLevel}
      />
    </div>
  );
}
