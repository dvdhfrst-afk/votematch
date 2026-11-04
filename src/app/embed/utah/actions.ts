'use server';

/**
 * Server actions for the Utah embeddable widget.
 *
 *  - resolveEmbedBallot: address -> public, gate-filtered EmbedPayload. No voter
 *    opinion is read or written; the address only resolves which races are on
 *    the ballot (loadBallotForAddress is read-only). The heavy assembly lives in
 *    lib/embed/payload.ts.
 *  - captureEmbedLead: opt-in email capture. Reuses the EXISTING retention
 *    double-opt-in subscribe path (source-tagged 'embed' + partner) so the widget
 *    does not invent a second list. Voter opinions are never sent with it.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { buildEmbedPayload, type EmbedResult } from '@/lib/embed/payload';
import { subscribe as subscribeCore } from '@/lib/retention/subscribe';

export async function resolveEmbedBallot(address: string): Promise<EmbedResult> {
  return buildEmbedPayload(address);
}

export type EmbedLeadResult = { ok: boolean; error?: string; alreadySubscribed?: boolean };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function captureEmbedLead(formData: FormData): Promise<EmbedLeadResult> {
  const email = (formData.get('email') as string | null)?.trim() || null;
  const partner = (formData.get('partner') as string | null)?.trim() || null;
  if (!email || !EMAIL_RE.test(email)) {
    return { ok: false, error: 'Enter a valid email address.' };
  }

  // Source-tag the lead so the durable list can attribute it to the embed +
  // partner. State is the Utah pilot. The existing subscribe path handles the
  // verification email and dedup; the widget never stores opinions.
  const interest_tags = ['embed', ...(partner ? [`partner:${partner}`] : [])];
  try {
    const result = await subscribeCore({
      email,
      phone: null,
      state: 'UT',
      interest_tags,
      match_id: null,
      user_id: null,
      digest_frequency: 'monthly',
      spi_consent: false,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, alreadySubscribed: result.alreadySubscribed };
  } catch {
    return { ok: false, error: 'We could not save that just now. Please try again.' };
  }
}
