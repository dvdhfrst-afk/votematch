import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import {
  iterCurrentMembers,
  iterRecentBills,
  iterHouseRollCalls,
  fetchHouseRollCallMembers,
} from '@/lib/federal/congress';

/**
 * Daily Congress.gov ingestion. Triggered by cron "0 8 * * *" (08:00 UTC daily).
 * Updates federal_members, federal_bills, federal_votes, federal_vote_positions.
 *
 * Steps:
 *   1. Refresh member roster (low churn — runs weekly in effect but called daily)
 *   2. Ingest recently-updated bills (sinceDate = 48h ago for safety)
 *   3. Ingest recent House roll calls + per-member positions
 *
 * Senate roll calls are intentionally not ingested here — Congress.gov v3 has
 * limited Senate coverage; we'll add a senate.gov XML fallback in a follow-up
 * function. This is noted in the retention doc's "partial" portability rating.
 */
export const ingestCongress = inngest.createFunction(
  {
    id: 'ingest-congress-daily',
    retries: 2,
    concurrency: [{ limit: 1 }], // Single-flight — full national pull
    triggers: [
      { cron: '0 8 * * *' },
      { event: 'retention/ingest.congress' }, // manual trigger
    ],
  },
  async ({ step }: { step: any }) => {
    const currentCongress = 119; // 119th Congress: 2025-01-03 through 2027-01-03

    // Step 1: refresh members
    const membersResult = await step.run('refresh-members', async () => {
      const supabase = await createServiceClient();
      let upserted = 0;
      for await (const m of iterCurrentMembers()) {
        const currentTerm = m.terms?.item?.[m.terms.item.length - 1];
        const { error } = await supabase.from('federal_members').upsert(
          {
            bioguide_id: m.bioguideId,
            first_name: m.firstName ?? null,
            last_name: m.lastName ?? null,
            full_name: m.name,
            party: m.partyName ?? null,
            state: m.state,
            chamber: currentTerm?.chamber?.toLowerCase() === 'senate' ? 'senate' : 'house',
            district: m.district ?? null,
            term_start: currentTerm?.startYear ? `${currentTerm.startYear}-01-03` : null,
            term_end: currentTerm?.endYear ? `${currentTerm.endYear}-01-03` : null,
            is_current: true,
            photo_url: m.depiction?.imageUrl ?? null,
            office_url: m.url ?? null,
          },
          { onConflict: 'bioguide_id' },
        );
        if (!error) upserted += 1;
      }
      return { upserted };
    });

    // Step 2: ingest recent bills (last 48 hours)
    const billsResult = await step.run('ingest-recent-bills', async () => {
      const supabase = await createServiceClient();
      const sinceDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      let upserted = 0;

      for await (const b of iterRecentBills({
        congress: currentCongress,
        sinceDate,
        maxPages: 10,
      })) {
        const billNumber =
          typeof b.number === 'string' ? parseInt(b.number, 10) : b.number;
        if (!billNumber || isNaN(billNumber)) continue;

        const { error } = await supabase.from('federal_bills').upsert(
          {
            congress: b.congress,
            bill_type: b.type.toLowerCase(),
            bill_number: billNumber,
            title: b.title ?? null,
            introduced_date: b.introducedDate ?? null,
            latest_action_date: b.latestAction?.actionDate ?? null,
            latest_action_text: b.latestAction?.text ?? null,
            policy_area: b.policyArea?.name ?? null,
            url: b.url ?? null,
          },
          { onConflict: 'congress,bill_type,bill_number' },
        );
        if (!error) upserted += 1;
      }
      return { upserted };
    });

    // Step 3: House roll calls for current session (1 in odd years, 2 in even)
    const votesResult = await step.run('ingest-house-rolls', async () => {
      const supabase = await createServiceClient();
      const sessionNumber = new Date().getFullYear() % 2 === 1 ? 1 : 2;
      let upsertedVotes = 0;
      let upsertedPositions = 0;

      for await (const v of iterHouseRollCalls(currentCongress, sessionNumber, 5)) {
        // Upsert the vote record.
        const billNumber =
          typeof v.legislationNumber === 'string'
            ? parseInt(v.legislationNumber, 10)
            : v.legislationNumber ?? null;

        const { data: inserted, error: voteErr } = await supabase
          .from('federal_votes')
          .upsert(
            {
              congress: v.congress,
              chamber: 'house',
              session: v.sessionNumber,
              roll_call: v.rollCallNumber,
              vote_date: v.startDate ?? new Date().toISOString(),
              bill_congress: v.congress,
              bill_type: v.legislationType?.toLowerCase() ?? null,
              bill_number: billNumber,
              question: v.voteQuestion ?? null,
              result: v.result ?? null,
              url: v.sourceDataURL ?? null,
            },
            { onConflict: 'congress,chamber,session,roll_call' },
          )
          .select('id')
          .single();

        if (voteErr || !inserted) continue;
        upsertedVotes += 1;

        // Fetch member positions for this roll call.
        const members = await fetchHouseRollCallMembers(
          v.congress,
          v.sessionNumber,
          v.rollCallNumber,
        );

        for (const m of members) {
          if (!m.bioguideId || !m.voteCast) continue;
          const { error: posErr } = await supabase.from('federal_vote_positions').upsert(
            {
              vote_id: inserted.id,
              bioguide_id: m.bioguideId,
              position: m.voteCast,
            },
            { onConflict: 'vote_id,bioguide_id' },
          );
          if (!posErr) upsertedPositions += 1;
        }
      }

      return { upsertedVotes, upsertedPositions };
    });

    return {
      members: membersResult.upserted,
      bills: billsResult.upserted,
      votes: votesResult.upsertedVotes,
      vote_positions: votesResult.upsertedPositions,
    };
  },
);
