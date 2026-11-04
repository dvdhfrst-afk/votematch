import type { SupabaseClient } from '@supabase/supabase-js';
import type { MatchResult } from '@/types/database';

/**
 * Session-scoped persistence + retrieval for the FULL computed match payload.
 *
 * Background
 * ----------
 * The legacy `matches` table FKs to candidates(id)/races(id), so /api/match
 * could only persist LEGACY (Utah-era) rows there. New-graph candidacies
 * (is_legacy=false — every state except the Utah pilot) failed those FKs, so
 * /results, which read only `matches`, rendered empty for them even though the
 * API computed real scores.
 *
 * This helper stores the already-shaped MatchResult[] JSON verbatim in a
 * FK-free, session-scoped table (`match_result_snapshots`, migration
 * 20260701000000). /results reads it back and renders legacy + new-graph races
 * identically.
 *
 * Graceful degradation
 * --------------------
 * The snapshot table may not exist yet (the migration ships UNAPPLIED). Every
 * function here treats a missing table (or any Supabase error) as a no-op:
 * saveMatchSnapshot swallows the error, loadMatchSnapshot returns null. When
 * the snapshot is absent, /results falls back to its legacy `matches` join, so
 * Utah keeps working with zero DDL applied.
 */

const SNAPSHOT_TABLE = 'match_result_snapshots';

/**
 * Error codes that mean "the snapshot table isn't there yet" — i.e. the
 * migration (20260701000000) hasn't been applied. These are EXPECTED during
 * the bridging period and must be swallowed silently (they are the trigger for
 * /results to fall back to the legacy `matches` join). Everything else is a
 * genuine failure worth logging.
 *
 *  - '42P01' : Postgres undefined_table (raw PG error, e.g. via direct SQL).
 *  - 'PGRST205' : PostgREST "table not found in schema cache" — what the
 *                 supabase-js client actually returns for a missing table.
 */
const TABLE_ABSENT_CODES = new Set(['42P01', 'PGRST205']);

function isTableAbsent(code: string | undefined): boolean {
  return code !== undefined && TABLE_ABSENT_CODES.has(code);
}

export async function saveMatchSnapshot(
  supabase: SupabaseClient,
  userId: string,
  results: MatchResult[],
): Promise<{ persisted: boolean }> {
  try {
    const { error } = await supabase
      .from(SNAPSHOT_TABLE)
      .upsert(
        {
          user_id: userId,
          results,
          result_count: results.length,
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );

    if (error) {
      if (!isTableAbsent(error.code)) {
        console.error('Failed to save match snapshot:', error);
      }
      return { persisted: false };
    }
    return { persisted: true };
  } catch (err) {
    console.error('Match snapshot write threw:', err);
    return { persisted: false };
  }
}

export async function loadMatchSnapshot(
  supabase: SupabaseClient,
  userId: string,
): Promise<MatchResult[] | null> {
  try {
    const { data, error } = await supabase
      .from(SNAPSHOT_TABLE)
      .select('results')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      if (!isTableAbsent(error.code)) {
        console.error('Failed to load match snapshot:', error);
      }
      return null;
    }
    if (!data) return null;
    const results = (data as { results: unknown }).results;
    if (!Array.isArray(results)) return null;
    return results as MatchResult[];
  } catch (err) {
    console.error('Match snapshot read threw:', err);
    return null;
  }
}
