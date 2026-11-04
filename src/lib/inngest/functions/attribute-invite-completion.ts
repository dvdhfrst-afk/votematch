import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * attributeInviteCompletion — close the invite-attribution loop.
 *
 * Triggered by `match/quick-match.completed` (fired from
 * submitQuickMatchAction). For the matched user:
 *   1. Stamp `users.first_match_completed_at` if still null. This drives
 *      the participation-rank queries in invite-actions.ts.
 *   2. If an open `invite_acceptances` row exists for this user (i.e.
 *      they came in via an invite link), set `completed_match_at = now()`
 *      so the inviter's "Y completed their match" counter ticks up.
 *
 * Both writes are idempotent — re-running this function on the same user
 * is a no-op. We deliberately keep this in Inngest (rather than inline in
 * the server action) so the user's request returns fast even if there are
 * multiple acceptance rows or the rank query gets slow at scale.
 */
export const attributeInviteCompletion = inngest.createFunction(
  {
    id: 'attribute-invite-completion',
    retries: 2,
    concurrency: [{ limit: 10 }],
    triggers: [{ event: 'match/quick-match.completed' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { user_id, completed_at } = event.data as {
      user_id: string;
      completed_at: string;
    };

    if (!user_id || !completed_at) {
      return { skipped: true, reason: 'missing user_id or completed_at' };
    }

    const supabase = await createServiceClient();

    // Step 1 — stamp first_match_completed_at idempotently.
    const stampResult = await step.run('stamp-first-match', async () => {
      const { data, error } = await supabase
        .from('users')
        .update({ first_match_completed_at: completed_at })
        .eq('id', user_id)
        .is('first_match_completed_at', null)
        .select('id');
      if (error) throw error;
      return { stamped: (data?.length ?? 0) > 0 };
    });

    // Step 2 — close any open invite_acceptances rows for this user. There
    // should be at most one (UNIQUE on (invite_code, invitee_user_id) and
    // self-invite blocked at attribution time), but we update by predicate
    // so duplicates from a race are still handled.
    const acceptanceResult = await step.run('close-acceptance', async () => {
      const { data, error } = await supabase
        .from('invite_acceptances')
        .update({ completed_match_at: completed_at })
        .eq('invitee_user_id', user_id)
        .is('completed_match_at', null)
        .select('id');
      if (error) throw error;
      return { closed_count: data?.length ?? 0 };
    });

    return {
      user_id,
      first_match_stamped: stampResult.stamped,
      acceptances_closed: acceptanceResult.closed_count,
    };
  },
);
