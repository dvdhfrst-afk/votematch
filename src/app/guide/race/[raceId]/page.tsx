import { notFound } from 'next/navigation';
import GuideRaceDetail from '@/components/guide/GuideRaceDetail';
import { getGuideProvider, isGuideRenderable } from '@/lib/guide/provider';

/**
 * Race detail — ranked candidates with inline breakdown.
 *
 * ON-DEVICE (work-order 1B): the server supplies the race + candidate DISPLAY
 * data (public) via the provider. Ranking, match chips, breakdowns and the
 * desktop rail's scores are computed on the CLIENT from the on-device profile
 * inside GuideRaceDetail (useGuideScores). No opinion is read server-side.
 */
export default async function GuideRacePage({
  params,
}: {
  params: Promise<{ raceId: string }>;
}) {
  if (!isGuideRenderable()) return null;
  const { raceId } = await params;
  const provider = getGuideProvider();
  const [race, allRaces] = await Promise.all([
    provider.getRace(raceId),
    provider.listRaces(),
  ]);

  if (!race) notFound();

  return (
    <div className="max-w-3xl lg:max-w-6xl mx-auto px-4 py-6">
      <GuideRaceDetail race={race} allRaces={allRaces} />
    </div>
  );
}
