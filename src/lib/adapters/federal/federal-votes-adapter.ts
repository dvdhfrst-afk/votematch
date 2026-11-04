/**
 * Federal House roll-call votes source adapter.
 *
 * Pilot #2 of the SourceAdapter framework. Fetches recent House roll calls
 * for the 119th Congress from Congress.gov v3, then per-roll-call fetches
 * individual member positions. Inserts into `federal_votes` +
 * `federal_vote_positions`.
 *
 * Senate votes are NOT covered — they come from senate.gov XML via
 * `scripts/ingest-senate-votes.ts` (separate adapter to be ported later).
 *
 * Schema gap (2026-04-23): `federal_votes` and `federal_vote_positions`
 * do not carry `data_source_id` / `ingestion_run_id` columns. Lineage is
 * captured on `ingestion_runs` only until a follow-up migration adds them.
 */

import { createHash } from 'node:crypto';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../types';
import {
  iterHouseRollCalls,
  fetchHouseRollCallMembers,
  type HouseRollCallSummary,
  type VoteMember,
} from '@/lib/federal/congress';

const CURRENT_CONGRESS = 119;
const SESSION = 1;
const DEFAULT_LIMIT = 100;

/** Each row is one roll call carrying its full set of member positions. */
export type FederalVoteRow = {
  vote: {
    congress: number;
    chamber: 'house';
    session: number;
    roll_call: number;
    vote_date: string | null;
    bill_congress: number | null;
    bill_type: string | null;
    bill_number: number | null;
    question: string | null;
    description: string | null;
    result: string | null;
    yes_count: number | null;
    no_count: number | null;
    url: string | null;
  };
  members: VoteMember[];
};

export type FederalVotesAdapterOptions = {
  congress?: number;
  session?: number;
  /** Max roll calls to ingest in one run. */
  limit?: number;
};

export function createFederalVotesAdapter(
  opts: FederalVotesAdapterOptions = {},
): SourceAdapter<FederalVoteRow> {
  const congress = opts.congress ?? CURRENT_CONGRESS;
  const session = opts.session ?? SESSION;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  // 2026-04-26 fix: removed per-yield/per-RC tokenBucket. politeFetch handles
  // per-host pacing via host_rate_limits (api.congress.gov: 500ms / burst 3).
  const url = `https://api.congress.gov/v3/house-vote/${congress}/${session}`;

  return {
    name: 'federal-votes',
    tokenBucket: { rps: 5, burst: 10 },
    costService: 'congress_gov',
    estimatedCostUsd: 0,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<FederalVoteRow>> {
      ctx.logger.info('federal-votes: starting fetch', { congress, session, limit });

      // 1. Page through roll call summaries (most recent first).
      const rollCalls: HouseRollCallSummary[] = [];
      for await (const rc of iterHouseRollCalls(congress, session, 2)) {
        rollCalls.push(rc);
        if (rollCalls.length >= limit) break;
      }
      ctx.logger.info('federal-votes: fetched roll calls', { count: rollCalls.length });

      // 2. For each roll call, fetch member positions. politeFetch enforces
      //    per-host spacing on the actual API call.
      const rows: FederalVoteRow[] = [];
      for (const rc of rollCalls) {
        let members: VoteMember[] = [];
        try {
          members = await fetchHouseRollCallMembers(
            rc.congress,
            rc.sessionNumber,
            rc.rollCallNumber,
          );
        } catch (err) {
          ctx.logger.warn('federal-votes: member fetch failed', {
            roll_call: rc.rollCallNumber,
            error: err instanceof Error ? err.message : String(err),
          });
          // Skip this roll call rather than fail the whole run; the
          // summary row gets skipped below by the missing-members branch.
          continue;
        }

        // Extract bill reference from the roll-call summary. Without these,
        // the SQL rollup can't join votes → bills → dimensions, so every
        // federal officeholder's voting record stays inert. Original
        // adapter (pre-2026-04-25) hardcoded these to null and required a
        // `backfill-federal-vote-bill-refs.ts` rescue pass; this patch keeps
        // future runs first-class.
        //
        // Bill-type slug normalization: Congress.gov returns uppercase
        // ("HR", "HCONRES"); BB schema uses lowercase ("hr", "hconres").
        const billType = rc.legislationType
          ? rc.legislationType.toLowerCase()
          : null;
        const billNumber =
          rc.legislationNumber != null
            ? parseInt(String(rc.legislationNumber), 10)
            : null;
        const validBillType =
          billType &&
          ['hr', 's', 'hres', 'sres', 'hconres', 'sconres', 'hjres', 'sjres'].includes(
            billType,
          );
        const billCongress =
          validBillType && Number.isFinite(billNumber) ? rc.congress : null;

        rows.push({
          vote: {
            congress: rc.congress,
            chamber: 'house',
            session: rc.sessionNumber,
            roll_call: rc.rollCallNumber,
            vote_date: rc.startDate ?? null,
            bill_congress: billCongress,
            bill_type: validBillType ? billType : null,
            bill_number:
              validBillType && Number.isFinite(billNumber) ? billNumber : null,
            question: rc.voteQuestion ?? null,
            description:
              rc.legislationType && rc.legislationNumber
                ? `${rc.legislationType} ${rc.legislationNumber}: ${rc.voteType ?? ''}`.trim()
                : (rc.voteType ?? null),
            result: rc.result ?? null,
            yes_count: null,
            no_count: null,
            url: null,
          },
          members,
        });
      }

      ctx.logger.info('federal-votes: fetch complete', {
        roll_calls: rows.length,
        total_positions: rows.reduce((a, r) => a + r.members.length, 0),
      });

      // Hash a bounded fingerprint — first few roll-call summaries + counts.
      const fingerprint = rows.slice(0, 50).map((r) => ({
        rc: r.vote.roll_call,
        session: r.vote.session,
        congress: r.vote.congress,
        members_len: r.members.length,
        result: r.vote.result,
      }));
      const hash = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');

      return {
        rows,
        expectedMinRows: 10,
        source: {
          sourceType: 'federal_vote_record',
          name: 'Congress.gov v3 House roll-call votes',
          url,
          contentHash: hash,
          license: 'public_domain',
          meta: {
            congress,
            session,
            limit,
            roll_calls_fetched: rows.length,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.vote.congress) return 'missing vote.congress';
      if (!row.vote.roll_call) return 'missing vote.roll_call';
      if (!row.vote.vote_date) return 'missing vote.vote_date';
      return null;
    },

    async insert(
      rows: FederalVoteRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      // 20260423000012_federal_provenance.sql added data_source_id +
      // ingestion_run_id to federal_votes and federal_vote_positions.
      // Wire them onto every row so /corrections can prove provenance.

      const stats: InsertStats = {
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        errors: [],
      };

      if (rows.length === 0) return stats;

      // 1. Insert vote summary rows. (congress, chamber, session, roll_call)
      //    has a UNIQUE constraint — re-running the same adapter will fail
      //    on that. Use upsert to make re-runs safe.
      const voteInserts = rows.map((r) => ({
        ...r.vote,
        ingested_at: new Date().toISOString(),
        data_source_id: refs.dataSourceId,
        ingestion_run_id: refs.ingestionRunId,
      }));

      const voteIdByRoll: Record<number, string> = {};
      const BATCH = 100;
      for (let i = 0; i < voteInserts.length; i += BATCH) {
        const chunk = voteInserts.slice(i, i + BATCH);
        const { data, error } = await ctx.supabase
          .from('federal_votes')
          .upsert(chunk, { onConflict: 'congress,chamber,session,roll_call' })
          .select('id, roll_call');
        if (error) {
          stats.rowsFailed += chunk.length;
          stats.errors.push({
            type: 'other',
            message: `vote upsert batch ${i}: ${error.message}`,
          });
          continue;
        }
        for (const v of data ?? []) {
          voteIdByRoll[v.roll_call as number] = v.id as string;
        }
        stats.rowsInserted += data?.length ?? 0;
      }

      // 2. Auto-create federal_members we see in the vote sets but don't yet
      //    have. Mirrors legacy script behavior.
      const { data: existingMembers } = await ctx.supabase
        .from('federal_members')
        .select('bioguide_id');
      const knownBioguides = new Set(
        (existingMembers ?? []).map((m) => m.bioguide_id as string),
      );

      const newMemberRows: Record<string, unknown>[] = [];
      for (const row of rows) {
        for (const m of row.members) {
          const bg = m.bioguideID ?? m.bioguideId;
          if (!bg || knownBioguides.has(bg)) continue;
          knownBioguides.add(bg);
          newMemberRows.push({
            bioguide_id: bg,
            first_name: m.firstName ?? null,
            last_name: m.lastName ?? null,
            full_name: [m.firstName, m.lastName].filter(Boolean).join(' ') || null,
            party: m.voteParty ?? null,
            state: m.voteState ?? null,
            chamber: 'house',
            is_current: true,
          });
        }
      }
      if (newMemberRows.length > 0) {
        const { error } = await ctx.supabase
          .from('federal_members')
          .upsert(newMemberRows, { onConflict: 'bioguide_id' });
        if (error) {
          stats.errors.push({
            type: 'other',
            message: `federal_members upsert: ${error.message}`,
          });
        } else {
          ctx.logger.info('federal-votes: auto-created members', {
            count: newMemberRows.length,
          });
        }
      }

      // 3. Insert position rows.
      for (const row of rows) {
        const voteId = voteIdByRoll[row.vote.roll_call];
        if (!voteId) {
          stats.rowsSkipped += row.members.length;
          continue;
        }
        const positions = row.members
          .map((m) => {
            const bg = m.bioguideID ?? m.bioguideId;
            if (!bg || !m.voteCast) return null;
            return {
              vote_id: voteId,
              bioguide_id: bg,
              position: m.voteCast,
              data_source_id: refs.dataSourceId,
              ingestion_run_id: refs.ingestionRunId,
            };
          })
          .filter(
            (
              x,
            ): x is {
              vote_id: string;
              bioguide_id: string;
              position: string;
              data_source_id: string;
              ingestion_run_id: string;
            } => x !== null,
          );

        for (let j = 0; j < positions.length; j += 500) {
          const chunk = positions.slice(j, j + 500);
          const { data, error } = await ctx.supabase
            .from('federal_vote_positions')
            .upsert(chunk, { onConflict: 'vote_id,bioguide_id' })
            .select('vote_id');
          if (error) {
            stats.rowsFailed += chunk.length;
            stats.errors.push({
              type: 'other',
              message: `vote_positions upsert: ${error.message}`,
            });
            continue;
          }
          stats.rowsInserted += data?.length ?? 0;
        }
      }

      return stats;
    },
  };
}

export const federalVotesAdapter: SourceAdapter<FederalVoteRow> =
  createFederalVotesAdapter();
