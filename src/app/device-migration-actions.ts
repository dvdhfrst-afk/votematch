'use server';

/**
 * Legacy-to-device migration shim (work-order 1B item 4).
 *
 * Before the on-device rewire, a voter's quick-match answers + derived weights
 * lived on `users.quick_match_answers` / `users.weights`, and a computed
 * snapshot lived in `match_result_snapshots`. Those are opinion data and must
 * no longer live on the operational DB (memory: voter-data-architecture-ondevice).
 *
 * This module powers a one-time, opt-in import when a returning voter's SERVER
 * session still carries legacy answers:
 *   1. getLegacyOpinionSummary() — a PII-safe presence check (counts only, never
 *      the answer values) so the guide can decide whether to offer the import.
 *   2. exportLegacyAnswersToDevice() — returns the legacy answers to the CALLER
 *      (the voter's own browser) so the client can write them into IndexedDB via
 *      the device store. This is a transfer of the user's own data onto the
 *      user's own device; it is never logged.
 *   3. clearLegacyServerOpinions() — nulls users.quick_match_answers +
 *      users.weights and deletes the voter's match_result_snapshots row. It ONLY
 *      nulls/deletes; it never reads the values into logs. Called after the
 *      client confirms the device import succeeded.
 *
 * The legacy Utah `matches` table rows are intentionally left in place (the
 * work-order says leave the tables, remove the voter-flow WRITE). Nulling the
 * user columns + deleting the snapshot is the reversible-in-spirit removal of
 * the opinion payload; matches rows FK to legacy candidates/races and are not a
 * per-voter opinion vector on their own.
 */

import { createClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/session';
import type { QuickMatchAnswers } from '@/types/database';

/**
 * PII-safe check: does this session still have legacy server-side opinions?
 * Returns counts only, never the answer values, so the guide can decide whether
 * to surface the one-time import prompt without ever handling the stances here.
 */
export async function getLegacyOpinionSummary(): Promise<{
  hasLegacy: boolean;
  domainCount: number;
  answerCount: number;
}> {
  const user = await getSessionUser();
  const qma = user?.quick_match_answers;
  const hasLegacy =
    !!qma &&
    Array.isArray(qma.domains) &&
    qma.domains.length > 0;
  return {
    hasLegacy,
    domainCount: hasLegacy ? qma!.domains.length : 0,
    answerCount: hasLegacy ? (qma!.positions?.length ?? 0) : 0,
  };
}

/**
 * Hand the voter's OWN legacy answers back to their browser so the client can
 * write them into the on-device store. Returns null when there is nothing to
 * import. Never logs the answer values.
 */
export async function exportLegacyAnswersToDevice(): Promise<{
  domains: string[];
  positions: Array<{ sub_dimension_id: string; score: number }>;
  match_view: QuickMatchAnswers['match_view'];
} | null> {
  const user = await getSessionUser();
  const qma = user?.quick_match_answers;
  if (!qma || !Array.isArray(qma.domains) || qma.domains.length === 0) {
    return null;
  }
  // Project to the exact shape the client needs to reconstruct the device
  // profile (domains -> setEmphasis, positions -> setAnswer per sub_dimension).
  return {
    domains: qma.domains,
    positions: (qma.positions ?? []).map((p) => ({
      sub_dimension_id: p.sub_dimension_id,
      score: p.score,
    })),
    match_view: qma.match_view ?? null,
  };
}

/**
 * Remove the legacy server-side opinion payload for this session. ONLY nulls
 * users.quick_match_answers + users.weights and deletes the match snapshot; it
 * does not read those values into any log. Idempotent: safe to call when there
 * is nothing to clear. Called after the client confirms the device import.
 */
export async function clearLegacyServerOpinions(): Promise<{ cleared: boolean }> {
  const user = await getSessionUser();
  if (!user) return { cleared: false };

  try {
    const supabase = await createClient();

    // Null the opinion columns. We do not SELECT them first; the write is
    // blind-by-design so the values never touch a log line here.
    await supabase
      .from('users')
      .update({ quick_match_answers: null, weights: null })
      .eq('id', user.id);

    // Delete the session-scoped computed snapshot, if the table exists. A
    // missing table (migration unapplied) is a silent no-op.
    try {
      await supabase.from('match_result_snapshots').delete().eq('user_id', user.id);
    } catch {
      // Snapshot table absent or delete blocked: non-fatal. The opinion columns
      // above are the primary payload; the snapshot is derived.
    }

    return { cleared: true };
  } catch (err) {
    // Never log answer values. A generic failure line only.
    console.error('clearLegacyServerOpinions failed (non-fatal):', err);
    return { cleared: false };
  }
}
