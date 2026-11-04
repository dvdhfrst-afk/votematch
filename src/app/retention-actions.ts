'use server';

import {
  subscribe as subscribeCore,
  followTarget,
  unfollowTarget,
} from '@/lib/retention/subscribe';
import { getSessionUser } from '@/lib/session';

export type SubscribeActionResult = {
  ok: boolean;
  error?: string;
  alreadySubscribed?: boolean;
};

export async function subscribeAction(formData: FormData): Promise<SubscribeActionResult> {
  const email = (formData.get('email') as string | null)?.trim() || null;
  const phone = (formData.get('phone') as string | null)?.trim() || null;
  const state = (formData.get('state') as string | null)?.trim() || '';
  const tagsRaw = (formData.get('interest_tags') as string | null) ?? '';
  const frequency = (formData.get('digest_frequency') as string | null) ?? 'monthly';
  const matchId = (formData.get('match_id') as string | null) || null;
  const spiConsent = formData.get('spi_consent') === 'on' || formData.get('spi_consent') === 'true';

  const user = await getSessionUser();

  const result = await subscribeCore({
    email,
    phone,
    state,
    interest_tags: tagsRaw ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [],
    match_id: matchId,
    user_id: user?.id ?? null,
    digest_frequency: frequency === 'weekly' || frequency === 'biweekly' || frequency === 'none'
      ? frequency
      : 'monthly',
    spi_consent: spiConsent,
  });

  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, alreadySubscribed: result.alreadySubscribed };
}

export type FollowActionResult = { ok: boolean; error?: string };

export async function followAction(formData: FormData): Promise<FollowActionResult> {
  const subscriberId = formData.get('subscriber_id') as string;
  const targetType = formData.get('target_type') as string;
  const targetId = formData.get('target_id') as string;

  if (!subscriberId || !targetType || !targetId) {
    return { ok: false, error: 'Missing required fields' };
  }
  if (
    targetType !== 'federal_member' &&
    targetType !== 'officeholder' &&
    targetType !== 'candidate'
  ) {
    return { ok: false, error: 'Invalid target type' };
  }

  const result = await followTarget({ subscriberId, targetType, targetId });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export async function unfollowAction(formData: FormData): Promise<FollowActionResult> {
  const subscriberId = formData.get('subscriber_id') as string;
  const targetType = formData.get('target_type') as string;
  const targetId = formData.get('target_id') as string;

  if (!subscriberId || !targetType || !targetId) {
    return { ok: false, error: 'Missing required fields' };
  }
  if (
    targetType !== 'federal_member' &&
    targetType !== 'officeholder' &&
    targetType !== 'candidate'
  ) {
    return { ok: false, error: 'Invalid target type' };
  }

  const result = await unfollowTarget({ subscriberId, targetType, targetId });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
