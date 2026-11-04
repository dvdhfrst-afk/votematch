/**
 * Server-side subscribe / unsubscribe / verify logic.
 *
 * Uses the service-role client because RLS blocks anonymous inserts on
 * `subscribers`. The public API is exposed via server actions and API routes;
 * this module is the shared business logic.
 */
import { createServiceClient } from '@/lib/supabase/server';
import { sendVerificationEmail } from './mailer';
import { verifyToken } from './tokens';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY',
  'LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND',
  'OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
]);

export type SubscribeInput = {
  email?: string | null;
  phone?: string | null;
  state: string;
  interest_tags?: string[];
  match_id?: string | null;
  user_id?: string | null;
  digest_frequency?: 'weekly' | 'biweekly' | 'monthly' | 'none';
  /**
   * Explicit consent to process political opinions as sensitive data.
   * Required nationally (not just VA-model states) per legal memo 2026-04-18.
   * Political quick-match answers are sensitive in 15+ states including CO, VA,
   * CT, MT, OR, DE, TX, NJ, NH, MD, MN, KY, IN, RI. Virginia-model opt-in >
   * CCPA opt-out where they conflict. Default policy: opt-in nationally.
   */
  spi_consent: boolean;
};

export type SubscribeResult =
  | { ok: true; subscriberId: string; alreadySubscribed: boolean }
  | { ok: false; error: string };

export async function subscribe(input: SubscribeInput): Promise<SubscribeResult> {
  const email = input.email?.trim().toLowerCase() ?? null;
  const phone = input.phone?.trim() ?? null;
  const state = input.state?.trim().toUpperCase();

  if (!state || !US_STATES.has(state)) {
    return { ok: false, error: 'Invalid or missing state code' };
  }
  if (!email && !phone) {
    return { ok: false, error: 'Provide email or phone' };
  }
  if (email && !EMAIL_REGEX.test(email)) {
    return { ok: false, error: 'Invalid email format' };
  }
  if (!input.spi_consent) {
    return {
      ok: false,
      error: 'Consent to process political preferences (SPI) is required.',
    };
  }

  const supabase = await createServiceClient();

  // Check for existing subscription on this email/phone (even if soft-unsubscribed).
  const existing = await supabase
    .from('subscribers')
    .select('id, verified, unsubscribed_at')
    .or(
      [email ? `email.eq.${email}` : null, phone ? `phone.eq.${phone}` : null]
        .filter(Boolean)
        .join(','),
    )
    .limit(1)
    .maybeSingle();

  if (existing.data) {
    const subId = existing.data.id as string;
    if (existing.data.unsubscribed_at) {
      // Re-subscribe: clear unsubscribed_at, reset verification.
      await supabase
        .from('subscribers')
        .update({
          unsubscribed_at: null,
          verified: false,
          state,
          interest_tags: input.interest_tags ?? [],
          match_id: input.match_id ?? null,
          user_id: input.user_id ?? null,
          digest_frequency: input.digest_frequency ?? 'monthly',
          prefers_sms: !!phone && !email,
        })
        .eq('id', subId);
      if (email) await sendVerificationEmail({ to: email, subscriberId: subId });
      return { ok: true, subscriberId: subId, alreadySubscribed: false };
    }
    // Already subscribed (verified or pending) — no-op, don't resend verification
    // to avoid abuse (someone entering random emails).
    return { ok: true, subscriberId: subId, alreadySubscribed: true };
  }

  // Fresh insert
  const { data, error } = await supabase
    .from('subscribers')
    .insert({
      email,
      phone,
      state,
      interest_tags: input.interest_tags ?? [],
      match_id: input.match_id ?? null,
      user_id: input.user_id ?? null,
      digest_frequency: input.digest_frequency ?? 'monthly',
      prefers_sms: !!phone && !email,
      verified: false,
    })
    .select('id')
    .single();

  if (error || !data) return { ok: false, error: error?.message ?? 'Insert failed' };

  if (email) {
    try {
      await sendVerificationEmail({ to: email, subscriberId: data.id as string });
    } catch (err) {
      // Log but don't fail the subscription — user can request re-send.
      console.error('sendVerificationEmail failed:', err);
    }
  }

  return { ok: true, subscriberId: data.id as string, alreadySubscribed: false };
}

export async function verifySubscriber(
  token: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = verifyToken(token);
  if (!result.valid) return { ok: false, error: result.error };
  if (result.action !== 'verify') return { ok: false, error: 'Wrong action' };

  const supabase = await createServiceClient();
  const { error } = await supabase
    .from('subscribers')
    .update({ verified: true, verified_at: new Date().toISOString() })
    .eq('id', result.subscriberId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function unsubscribe(
  token: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = verifyToken(token);
  if (!result.valid) return { ok: false, error: result.error };
  if (result.action !== 'unsubscribe') return { ok: false, error: 'Wrong action' };

  const supabase = await createServiceClient();
  const { error } = await supabase
    .from('subscribers')
    .update({ unsubscribed_at: new Date().toISOString() })
    .eq('id', result.subscriberId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function followTarget(opts: {
  subscriberId: string;
  targetType: 'federal_member' | 'officeholder' | 'candidate';
  targetId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createServiceClient();
  const { error } = await supabase.from('subscriber_follows').upsert(
    {
      subscriber_id: opts.subscriberId,
      target_type: opts.targetType,
      target_id: opts.targetId,
      ended_at: null,
    },
    { onConflict: 'subscriber_id,target_type,target_id' },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function unfollowTarget(opts: {
  subscriberId: string;
  targetType: 'federal_member' | 'officeholder' | 'candidate';
  targetId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createServiceClient();
  const { error } = await supabase
    .from('subscriber_follows')
    .update({ ended_at: new Date().toISOString() })
    .match({
      subscriber_id: opts.subscriberId,
      target_type: opts.targetType,
      target_id: opts.targetId,
    });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
