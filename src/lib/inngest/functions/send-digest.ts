import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { collectDigestItems, renderDigestHtml } from '@/lib/retention/digest';
import { sendEmail } from '@/lib/retention/mailer';
import type { Subscriber, DigestType } from '@/types/retention';

/**
 * Monthly/biweekly/weekly digest send. Fans out one event per subscriber.
 *
 * Schedule: 1st of each month at 15:00 UTC for monthly subs.
 * Biweekly = 1st + 15th, weekly = every Monday. All handled by different
 * cron triggers on the same function via event fan-out.
 */

// Orchestrator — fans out to per-subscriber send events.
export const sendDigestFn = inngest.createFunction(
  {
    id: 'send-digest-orchestrator',
    // Bumped 1 -> 2 per council 2026-04-23 uniform ingestion retry policy.
    retries: 2,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: '0 15 1 * *' }, // monthly
      { cron: '0 15 1,15 * *' }, // biweekly
      { cron: '0 15 * * 1' }, // weekly Monday
      { event: 'retention/digest.orchestrate' },
    ],
  },
  async ({ step }: { step: any }) => {
    const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 1=Mon
    const dayOfMonth = new Date().getUTCDate();

    // Decide which frequency buckets to include today.
    const frequencies: string[] = [];
    if (dayOfMonth === 1) frequencies.push('monthly');
    if (dayOfMonth === 1 || dayOfMonth === 15) frequencies.push('biweekly');
    if (dayOfWeek === 1) frequencies.push('weekly');

    if (frequencies.length === 0) {
      return { skipped: true, reason: 'no frequency match today' };
    }

    return await step.run('fan-out', async () => {
      const supabase = await createServiceClient();
      const { data: subs } = await supabase
        .from('subscribers')
        .select('id')
        .eq('verified', true)
        .is('unsubscribed_at', null)
        .in('digest_frequency', frequencies);

      const subscribers = (subs ?? []) as { id: string }[];

      // Fan out via Inngest events.
      for (const sub of subscribers) {
        await inngest.send({
          name: 'retention/digest.send.one',
          data: { subscriberId: sub.id, digestType: 'monthly' as DigestType },
        });
      }

      return { fanned_out: subscribers.length, frequencies };
    });
  },
);

// Per-subscriber send.
export const sendDigestOneFn = inngest.createFunction(
  {
    id: 'send-digest-one',
    retries: 2,
    // Lightweight per-subscriber send; cap at 10 parallel per council
    // 2026-04-23 (was 20 — too aggressive vs Resend per-domain rate).
    concurrency: [{ limit: 10 }],
    triggers: [{ event: 'retention/digest.send.one' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { subscriberId, digestType } = event.data as {
      subscriberId: string;
      digestType: DigestType;
    };

    const sub = await step.run('load-subscriber', async () => {
      const supabase = await createServiceClient();
      const { data } = await supabase
        .from('subscribers')
        .select('*')
        .eq('id', subscriberId)
        .single();
      return data as Subscriber | null;
    });

    if (!sub || !sub.verified || sub.unsubscribed_at || !sub.email) {
      return { skipped: true, reason: 'subscriber not eligible' };
    }

    const items = await step.run('collect-items', async () =>
      collectDigestItems(sub, sub.last_digest_at ? new Date(sub.last_digest_at) : undefined),
    );

    const { subject, html } = renderDigestHtml({
      subscriberId: sub.id,
      state: sub.state,
      items,
      period: digestType === 'weekly' ? 'weekly' : digestType === 'biweekly' ? 'biweekly' : 'monthly',
    });

    const resendResult = await step.run('send', () =>
      sendEmail({ to: sub.email!, subject, bodyHtml: html, subscriberId: sub.id }),
    );

    await step.run('log-send', async () => {
      const supabase = await createServiceClient();
      await supabase.from('digest_sends').insert({
        subscriber_id: sub.id,
        digest_type: digestType,
        channel: 'email',
        items: { items },
        resend_message_id: resendResult.id,
      });
      await supabase
        .from('subscribers')
        .update({ last_digest_at: new Date().toISOString() })
        .eq('id', sub.id);
    });

    return { sent: true, items: items.length, resend_id: resendResult.id };
  },
);

// Election-reminder trigger (on-demand, scheduled elsewhere per-state).
export const sendElectionReminderFn = inngest.createFunction(
  {
    id: 'send-election-reminder',
    retries: 2,
    concurrency: [{ limit: 10 }],
    triggers: [{ event: 'retention/election-reminder.send' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { subscriberId, daysUntil, electionDate, electionType } = event.data as {
      subscriberId: string;
      daysUntil: number;
      electionDate: string;
      electionType: string;
    };

    const sub = await step.run('load-subscriber', async () => {
      const supabase = await createServiceClient();
      const { data } = await supabase.from('subscribers').select('*').eq('id', subscriberId).single();
      return data as Subscriber | null;
    });
    if (!sub || !sub.email || sub.unsubscribed_at || !sub.verified) {
      return { skipped: true };
    }

    const subject = `${daysUntil === 0 ? 'Today' : `${daysUntil} days`}: ${electionType} election in ${sub.state}`;
    const html = `
      <h1 style="font-size: 24px;">${subject}</h1>
      <p>The ${electionType.toLowerCase()} election in ${sub.state} is ${daysUntil === 0 ? 'today' : `in ${daysUntil} days`} (${electionDate}).</p>
      <p>Open Havesay to refresh your ballot preview and see how your matches have shifted since you last checked.</p>
      <p style="margin: 24px 0;">
        <a href="${process.env.NEXT_PUBLIC_APP_URL ?? 'https://ballotbridge.org'}/guide" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">See your ballot</a>
      </p>
    `;

    const result = await step.run('send', () =>
      sendEmail({ to: sub.email!, subject, bodyHtml: html, subscriberId: sub.id }),
    );

    await step.run('log', async () => {
      const supabase = await createServiceClient();
      const digestType: DigestType =
        daysUntil === 0
          ? 'election_day'
          : daysUntil <= 7
            ? 'election_reminder_7d'
            : daysUntil <= 30
              ? 'election_reminder_30d'
              : 'election_reminder_90d';
      await supabase.from('digest_sends').insert({
        subscriber_id: sub.id,
        digest_type: digestType,
        channel: 'email',
        resend_message_id: result.id,
        items: { daysUntil, electionDate, electionType },
      });
    });

    return { sent: true };
  },
);
