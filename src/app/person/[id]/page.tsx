/**
 * Unified person profile page — handles anyone in the people table:
 * federal incumbents, state legislators, state executives, UT candidates,
 * etc. Shows:
 *   - Current office tenures (if incumbent)
 *   - 2026+ candidacies (if running)
 *   - Recent voting record (federal House/Senate — via bioguide)
 *   - Party history
 *
 * Route: /person/[id] where id is a UUID.
 */

import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import DataQualityBadge, { type DataQualityTier } from '@/components/DataQualityBadge';
import DeepLinkConvertCTA from '@/components/ui/DeepLinkConvertCTA';

type PageProps = {
  params: Promise<{ id: string }>;
};

function positionBadgeColor(pos: string): string {
  const n = pos.toLowerCase();
  if (n.includes('yea') || n.includes('aye')) return 'bg-green-100 text-green-800 border-green-200';
  if (n.includes('nay') || n === 'no') return 'bg-red-100 text-red-800 border-red-200';
  if (n.includes('present')) return 'bg-yellow-100 text-yellow-800 border-yellow-200';
  return 'bg-gray-100 text-gray-800 border-gray-200';
}

async function loadData(personId: string) {
  const supabase = await createClient();

  const { data: person } = await supabase
    .from('people')
    .select('id, canonical_name, full_legal_name, photo_url, bio, website_url, wikipedia_url, party_history, meta')
    .eq('id', personId)
    .maybeSingle();
  if (!person) return null;

  // Current tenures (incumbent roles)
  const { data: tenures } = await supabase
    .from('office_tenures')
    .select('office_id, party_at_tenure, started_on, offices(canonical_name, level, seat_designation, office_types(generic_name))')
    .eq('person_id', personId)
    .is('ended_on', null);

  // Candidacies (current/future elections)
  const { data: candidacies } = await supabase
    .from('candidacies')
    .select('election_id, party, status, profile_claimed, elections(election_date, election_type, offices(canonical_name, level))')
    .eq('person_id', personId)
    .order('election_id', { ascending: false });

  // Voting record (if bioguide_id)
  const bioguide = (person.meta as { bioguide_id?: string })?.bioguide_id;
  let votes: Array<Record<string, unknown>> = [];
  let topicTally: Record<string, { Yea: number; Nay: number }> = {};
  if (bioguide) {
    const { data } = await supabase
      .from('federal_vote_positions')
      .select('position, vote:federal_votes(roll_call, chamber, vote_date, question, description, result, bill_congress, bill_type, bill_number)')
      .eq('bioguide_id', bioguide)
      .order('vote_id', { ascending: false })
      .limit(25);
    votes = data ?? [];

    // Compute per-topic tally by joining to federal_bills.topic_tags where linkable.
    // Since many votes don't have bill FKs, we match on description pattern "HR 1234: ..."
    const { data: topicVotes } = await supabase.rpc(
      'person_vote_topics' as never,  // may not exist yet
      { p_bioguide: bioguide }
    ).select?.() ?? { data: null };
    // Fallback: parse vote descriptions like "HR 3492: Yea-and-Nay", match to bills
    if (!topicVotes) {
      // Fetch all bills with topic_tags
      // TODO: this caps at 5000 — federal_bills may exceed that. Add a paged
      // loop or move to a precomputed index. .order('id') for now so the cap
      // is deterministic across renders.
      const { data: taggedBills } = await supabase
        .from('federal_bills')
        .select('bill_type, bill_number, topic_tags')
        .not('topic_tags', 'is', null)
        .order('id')
        .range(0, 5000);
      const billTopicIndex: Record<string, string[]> = {};
      for (const b of taggedBills ?? []) {
        const tags = b.topic_tags as string[] | null;
        if (!tags || tags.length === 0) continue;
        const key = `${(b.bill_type ?? '').toLowerCase()}${b.bill_number}`;
        billTopicIndex[key] = tags;
      }
      // Fetch all user's vote positions with bill references
      const { data: allMyVotes } = await supabase
        .from('federal_vote_positions')
        .select('position, vote:federal_votes!inner(description)')
        .eq('bioguide_id', bioguide);
      for (const mv of allMyVotes ?? []) {
        const desc = ((mv as { vote?: { description?: string } }).vote?.description ?? '') as string;
        const match = /^(\w+)\s+(\d+):/.exec(desc);
        if (!match) continue;
        const key = `${match[1].toLowerCase()}${match[2]}`;
        const tags = billTopicIndex[key];
        if (!tags) continue;
        const pos = (mv as { position?: string }).position ?? '';
        const isYea = pos.toLowerCase().includes('yea') || pos.toLowerCase().includes('aye');
        const isNay = pos.toLowerCase().includes('nay') || pos.toLowerCase() === 'no';
        for (const tag of tags) {
          if (!topicTally[tag]) topicTally[tag] = { Yea: 0, Nay: 0 };
          if (isYea) topicTally[tag].Yea++;
          else if (isNay) topicTally[tag].Nay++;
        }
      }
    }
  }

  // Vote-based dimension positions (Likert 0-1 from v_person_vote_based_positions)
  let votePositions: Array<{ dimension: string; score_0_1: number; vote_count: number; aligned_high_votes: number; aligned_low_votes: number; avg_map_confidence: number; confidence_tier: string }> = [];
  {
    const { data: vp } = await supabase
      .from('v_person_vote_based_positions')
      .select('dimension, score_0_1, vote_count, aligned_high_votes, aligned_low_votes, avg_map_confidence')
      .eq('person_id', personId);
    votePositions = (vp ?? []).map((r) => {
      const vc = (r.vote_count as number) ?? 0;
      const tier = vc >= 8 ? 'high' : vc >= 3 ? 'medium' : vc >= 1 ? 'low' : 'insufficient';
      return {
        dimension: r.dimension as string,
        score_0_1: Number(r.score_0_1),
        vote_count: vc,
        aligned_high_votes: (r.aligned_high_votes as number) ?? 0,
        aligned_low_votes: (r.aligned_low_votes as number) ?? 0,
        avg_map_confidence: Number(r.avg_map_confidence),
        confidence_tier: tier,
      };
    });
  }

  return { person, tenures: tenures ?? [], candidacies: candidacies ?? [], votes, bioguide, topicTally, votePositions };
}

export default async function PersonPage({ params }: PageProps) {
  const { id } = await params;
  const data = await loadData(id);
  if (!data) notFound();
  const { person, tenures, candidacies, votes, bioguide, topicTally, votePositions } = data;

  const tally = votes.reduce<Record<string, number>>((acc, vp) => {
    const p = (vp as { position?: string }).position;
    if (p) acc[p] = (acc[p] ?? 0) + 1;
    return acc;
  }, {});

  const partyHistory = (person.party_history as Array<Record<string, unknown>>) ?? [];

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 text-gray-900">
      <DeepLinkConvertCTA />
      {/* Header */}
      <div className="mb-6 flex gap-4 items-start">
        {person.photo_url && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={person.photo_url as string}
            alt={person.canonical_name as string}
            className="w-24 h-28 object-cover rounded border border-gray-200"
          />
        )}
        <div className="flex-1">
          <h1 className="text-3xl font-bold text-gray-900">{person.canonical_name}</h1>
          {person.full_legal_name && person.full_legal_name !== person.canonical_name && (
            <div className="text-sm text-gray-500">{person.full_legal_name as string}</div>
          )}
          {partyHistory.length > 0 && (
            <div className="text-sm text-gray-600 mt-1">
              Party: {partyHistory.map((p) => p.party).filter(Boolean).join(', ')}
            </div>
          )}
          <div className="text-xs text-gray-400 mt-1 flex items-center gap-2 flex-wrap">
            <span>Person ID: <code>{id}</code></span>
            {!!bioguide && <span>bioguide: <code>{bioguide}</code></span>}
            <DataQualityBadge
              tier={((person.meta as Record<string, unknown>)?.data_quality_tier as DataQualityTier) ?? 'compiled'}
              sourceUrl={((person.meta as Record<string, unknown>)?.source_url as string | undefined) ?? null}
              lastVerified={
                ((person.meta as Record<string, unknown>)?.human_verified_at as string | undefined) ??
                ((person.meta as Record<string, unknown>)?.verified_at as string | undefined) ??
                null
              }
            />
            {(person.meta as Record<string, unknown>)?.needs_review === true && (
              <span className="text-[10px] px-1.5 py-0.5 bg-red-50 text-red-700 border border-red-200 rounded font-medium" title={String((person.meta as Record<string, unknown>)?.needs_review_reason ?? '')}>
                needs review
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Currently holding office */}
      {tenures.length > 0 && (
        <section className="mb-6 p-4 bg-blue-50 rounded border border-blue-200">
          <h2 className="text-xl font-semibold mb-2">Currently Serving</h2>
          {tenures.map((t) => {
            const office = (t as unknown as {
              offices?: { canonical_name?: string; level?: string };
            }).offices;
            return (
              <div key={t.office_id as string} className="text-gray-800">
                <strong>{office?.canonical_name ?? 'Unknown office'}</strong>
                {t.party_at_tenure && ` · ${t.party_at_tenure}`}
                {t.started_on && ` · since ${t.started_on}`}
              </div>
            );
          })}
        </section>
      )}

      {/* Running in these elections */}
      {candidacies.length > 0 && (
        <section className="mb-6 p-4 bg-green-50 rounded border border-green-200">
          <h2 className="text-xl font-semibold mb-2">
            Candidacies ({candidacies.length})
          </h2>
          <div className="space-y-2">
            {candidacies.map((c, i) => {
              const e = (c as unknown as {
                elections?: {
                  election_date?: string;
                  election_type?: string;
                  offices?: { canonical_name?: string };
                };
              }).elections;
              return (
                <div key={i} className="flex justify-between items-start gap-3 text-sm">
                  <div>
                    <div className="font-medium">{e?.offices?.canonical_name}</div>
                    <div className="text-gray-500 text-xs">
                      {e?.election_type?.toUpperCase()} · {e?.election_date}
                    </div>
                  </div>
                  {c.party && (
                    <span className="text-xs text-gray-600 whitespace-nowrap">{c.party as string}</span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Inferred policy positions (from vote × direction map).
          Publish gate: vote_count >= 5 (after procedural filter in SQL view).
          - n >= 10: full confidence, "high" badge
          - n 5–9: published with "low confidence" badge prominently shown
          - n < 5: suppressed entirely; listed as "insufficient voting record"
          The SQL view (v_person_vote_based_positions) already drops procedural votes
          (motion-to-table/recommit/cloture) and near-unanimous votes (>95%). */}
      {(() => {
        const PUBLISH_MIN_VOTES = 5;
        const displayable = votePositions.filter((p) => p.vote_count >= PUBLISH_MIN_VOTES);
        const insufficient = votePositions.filter((p) => p.vote_count < PUBLISH_MIN_VOTES);
        if (displayable.length === 0 && insufficient.length === 0) return null;
        return (
          <section className="mb-6 p-4 bg-indigo-50 rounded border border-indigo-200">
            <h2 className="text-xl font-semibold mb-2">Inferred Policy Positions</h2>
            <p className="text-xs text-gray-600 mb-3">
              Scores are derived from substantive roll-call votes (procedural and near-unanimous
              votes are excluded), weighted by whether a Yea on each bill pushes the dimension
              HIGH or LOW. 0.0 = strongly opposes, 0.5 = mixed record, 1.0 = strongly supports.
              Dimensions with fewer than 5 votes are suppressed. Dimensions with 5–9 votes are
              labeled &quot;low confidence.&quot;
            </p>
            {displayable.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {displayable
                  .sort((a, b) => b.vote_count - a.vote_count)
                  .map((p) => {
                    const pct = Math.round(p.score_0_1 * 100);
                    const isHighConfidence = p.vote_count >= 10;
                    const barColor = isHighConfidence ? 'bg-indigo-600' : 'bg-indigo-300';
                    return (
                      <div key={p.dimension} className="bg-white border border-gray-200 rounded p-2 text-sm">
                        <div className="flex justify-between items-baseline mb-1 gap-2">
                          <span className="font-medium capitalize truncate">{p.dimension.replaceAll('_', ' ')}</span>
                          <span className="text-xs whitespace-nowrap">
                            <span className="text-gray-500">{p.vote_count} votes</span>
                            {!isHighConfidence && (
                              <span className="ml-1 px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded text-[10px] font-medium">
                                low confidence
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="relative h-2 bg-gray-100 rounded overflow-hidden">
                          <div
                            className={`absolute left-0 top-0 h-full ${barColor}`}
                            style={{ width: `${pct}%` }}
                          />
                          <div className="absolute left-1/2 top-0 h-full border-l border-gray-400" />
                        </div>
                        <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
                          <span>low</span>
                          <span>{p.score_0_1.toFixed(1)}</span>
                          <span>high</span>
                        </div>
                      </div>
                    );
                  })}
              </div>
            ) : (
              <div className="text-sm text-gray-600 italic">
                No dimensions yet have 5+ substantive topic-tagged votes. Check back as the voting record grows.
              </div>
            )}
            {insufficient.length > 0 && (
              <details className="mt-3">
                <summary className="text-xs text-gray-500 cursor-pointer select-none">
                  {insufficient.length} dimension{insufficient.length === 1 ? '' : 's'} with insufficient voting record
                  (&lt; 5 votes) — click to see
                </summary>
                <div className="mt-2 text-xs text-gray-600 grid grid-cols-2 gap-1">
                  {insufficient
                    .sort((a, b) => b.vote_count - a.vote_count)
                    .map((p) => (
                      <div key={p.dimension} className="flex justify-between px-2 py-1 bg-white rounded border border-gray-200">
                        <span className="capitalize">{p.dimension.replaceAll('_', ' ')}</span>
                        <span className="text-gray-400">{p.vote_count} vote{p.vote_count === 1 ? '' : 's'}</span>
                      </div>
                    ))}
                </div>
              </details>
            )}
          </section>
        );
      })()}

      {/* Voting record by topic */}
      {Object.keys(topicTally).length > 0 && (
        <section className="mb-6 p-4 bg-yellow-50 rounded border border-yellow-200">
          <h2 className="text-xl font-semibold mb-2">Voting Record by Policy Topic</h2>
          <p className="text-xs text-gray-600 mb-3">
            Derived from bills in this Congress classified against Havesay&apos;s 19 policy dimensions.
            Showing Yea / Nay tally for bills touching each topic.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(topicTally)
              .sort((a, b) => (b[1].Yea + b[1].Nay) - (a[1].Yea + a[1].Nay))
              .map(([topic, t]) => (
                <div key={topic} className="flex justify-between items-center text-sm px-3 py-1.5 bg-white border border-gray-200 rounded">
                  <span className="text-gray-800 capitalize">{topic.replaceAll('_', ' ')}</span>
                  <span className="text-xs">
                    <span className="text-green-700">{t.Yea} Y</span>
                    <span className="text-gray-400 mx-1">·</span>
                    <span className="text-red-700">{t.Nay} N</span>
                  </span>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Recent votes list */}
      {votes.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xl font-semibold mb-2">Recent Voting Record</h2>
          <div className="flex gap-2 flex-wrap mb-3">
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
          <div className="space-y-2">
            {votes.map((vp, i) => {
              const v = (vp as {
                vote?: {
                  roll_call?: number;
                  chamber?: string;
                  vote_date?: string;
                  description?: string;
                  result?: string;
                };
                position?: string;
              }).vote;
              const pos = (vp as { position?: string }).position ?? '';
              return (
                <div
                  key={i}
                  className="p-3 border border-gray-200 rounded flex justify-between items-start gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {v?.description || `Roll call ${v?.roll_call}`}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {v?.chamber?.toUpperCase()} · {v?.vote_date?.slice(0, 10)} · Roll #{v?.roll_call}
                      {v?.result && ` · ${v.result}`}
                    </div>
                  </div>
                  <span
                    className={`px-3 py-1 text-xs rounded-full border whitespace-nowrap ${positionBadgeColor(pos)}`}
                  >
                    {pos}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Bio + links */}
      {(person.bio || person.website_url || person.wikipedia_url) && (
        <section className="mb-6 p-4 border border-gray-200 rounded">
          <h2 className="text-xl font-semibold mb-2">About</h2>
          {person.bio && <p className="text-sm text-gray-700 mb-2">{person.bio as string}</p>}
          <div className="flex gap-3 text-sm">
            {person.website_url && (
              <a
                href={person.website_url as string}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 underline"
              >
                Campaign site
              </a>
            )}
            {person.wikipedia_url && (
              <a
                href={person.wikipedia_url as string}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 underline"
              >
                Wikipedia
              </a>
            )}
          </div>
        </section>
      )}

      <div className="mt-8 text-xs text-gray-500">
        <Link href="/" className="underline">Back to Havesay</Link>
      </div>
    </div>
  );
}
