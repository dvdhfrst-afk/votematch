/**
 * Demo officeholder profile page — shows a federal incumbent with their recent
 * voting record, proving the incumbent + votes data pipeline works end-to-end.
 *
 * Route: /officeholder/[bioguide_id]
 * e.g. /officeholder/X000001 → that member's page
 *
 * This is a lightweight read-only public page that joins:
 *   people (by meta.bioguide_id) → federal_members → federal_vote_positions → federal_votes
 */

import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import DeepLinkConvertCTA from '@/components/ui/DeepLinkConvertCTA';

type PageProps = {
  params: Promise<{ bioguide_id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function loadData(bioguideId: string) {
  const supabase = await createClient();

  // 1. Find the person record via meta.bioguide_id
  const { data: peopleRows } = await supabase
    .from('people')
    .select('id, canonical_name, full_legal_name, photo_url, party_history, meta')
    .eq('meta->>bioguide_id', bioguideId)
    .limit(1);
  const person = peopleRows?.[0];
  if (!person) return null;

  // 2. Current office tenure
  const { data: tenures } = await supabase
    .from('office_tenures')
    .select('office_id, party_at_tenure, started_on, offices(canonical_name, level, office_types(generic_name))')
    .eq('person_id', person.id)
    .is('ended_on', null);

  // 3. Federal member info (chamber, state, district)
  const { data: member } = await supabase
    .from('federal_members')
    .select('chamber, state, district, first_name, last_name, party')
    .eq('bioguide_id', bioguideId)
    .maybeSingle();

  // 4. Recent votes — join federal_vote_positions → federal_votes
  const { data: votePositions } = await supabase
    .from('federal_vote_positions')
    .select('position, vote:federal_votes(roll_call, chamber, vote_date, question, description, result)')
    .eq('bioguide_id', bioguideId)
    .order('vote_id', { ascending: false })
    .limit(30);

  return { person, tenures: tenures ?? [], member, votePositions: votePositions ?? [] };
}

function positionBadgeColor(pos: string): string {
  const normalized = pos.toLowerCase();
  if (normalized.includes('yea') || normalized.includes('aye')) return 'bg-green-100 text-green-800 border-green-200';
  if (normalized.includes('nay') || normalized === 'no') return 'bg-red-100 text-red-800 border-red-200';
  if (normalized.includes('present')) return 'bg-yellow-100 text-yellow-800 border-yellow-200';
  return 'bg-gray-100 text-gray-800 border-gray-200';
}

export default async function OfficeholderPage({ params }: PageProps) {
  const { bioguide_id: bioguideId } = await params;
  const data = await loadData(bioguideId);
  if (!data) notFound();
  const { person, tenures, member, votePositions } = data;

  // Tally vote positions
  const tally = votePositions.reduce<Record<string, number>>((acc, vp) => {
    acc[vp.position] = (acc[vp.position] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 text-gray-900">
      <DeepLinkConvertCTA />
      {/* Header */}
      <div className="mb-6 flex gap-4 items-start">
        {person.photo_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={person.photo_url}
            alt={person.canonical_name}
            className="w-24 h-28 object-cover rounded border border-gray-200"
          />
        )}
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{person.canonical_name}</h1>
          {tenures.length > 0 && (
            <div className="text-lg text-gray-700 mt-1">
              {tenures.map((t) => {
                const office = (t as unknown as { offices?: { canonical_name?: string } }).offices;
                return (
                  <div key={t.office_id}>
                    {office?.canonical_name ?? 'Unknown office'}
                    {t.party_at_tenure && ` — ${t.party_at_tenure}`}
                    {t.started_on && ` (since ${t.started_on})`}
                  </div>
                );
              })}
            </div>
          )}
          {member && (
            <div className="text-sm text-gray-500 mt-1">
              bioguide: <code>{bioguideId}</code>
              {member.chamber && ` · ${member.chamber.toUpperCase()}`}
              {member.state && ` · ${member.state}`}
              {member.district != null && ` · District ${member.district}`}
            </div>
          )}
        </div>
      </div>

      {/* Vote summary */}
      <div className="mb-6 p-4 bg-gray-50 rounded border border-gray-200">
        <h2 className="text-xl font-semibold mb-2">Recent Voting Record</h2>
        <div className="flex gap-2 flex-wrap">
          {Object.entries(tally)
            .sort((a, b) => b[1] - a[1])
            .map(([pos, n]) => (
              <span
                key={pos}
                className={`px-3 py-1 text-sm rounded-full border ${positionBadgeColor(pos)}`}
              >
                {pos}: {n}
              </span>
            ))}
        </div>
        <p className="text-sm text-gray-600 mt-2">
          Showing {votePositions.length} of the most recent votes from 119th Congress Session 1 (2025). Data sourced
          from Congress.gov (House) and senate.gov XML (Senate).
        </p>
      </div>

      {/* Recent votes list */}
      <h3 className="text-lg font-semibold mb-3">Recent Roll Calls</h3>
      <div className="space-y-2">
        {votePositions.length === 0 && (
          <p className="text-gray-500">No voting record available.</p>
        )}
        {votePositions.map((vp, i) => {
          const v = (vp as unknown as {
            vote?: {
              roll_call?: number;
              chamber?: string;
              vote_date?: string;
              question?: string;
              description?: string;
              result?: string;
            };
          }).vote;
          return (
            <div
              key={i}
              className="p-3 border border-gray-200 rounded flex justify-between items-start gap-4"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">
                  {v?.description || v?.question || `Roll call ${v?.roll_call}`}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {v?.chamber?.toUpperCase()} · {v?.vote_date?.slice(0, 10)} · Roll call #{v?.roll_call}
                  {v?.result && ` · Result: ${v.result}`}
                </div>
              </div>
              <span
                className={`px-3 py-1 text-xs rounded-full border whitespace-nowrap ${positionBadgeColor(
                  vp.position
                )}`}
              >
                {vp.position}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-8 text-xs text-gray-500">
        <Link href="/" className="underline">
          Back to Havesay
        </Link>
      </div>
    </div>
  );
}
