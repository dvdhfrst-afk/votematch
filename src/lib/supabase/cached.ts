/**
 * Shared cached Supabase reads for tables that change rarely.
 *
 * These helpers wrap simple fetches in `unstable_cache` so hot pages don't
 * round-trip the DB on every render. Keep this file scoped to *truly static*
 * tables — anything user-specific or write-frequent should fetch directly.
 */
import { unstable_cache } from 'next/cache';
import type { SubDimension } from '@/types/database';
import { createServiceClient } from './server';

/**
 * Sub-dimensions are the spine of the matching engine: 19 rows, governed by
 * a methodology council, and updated maybe once per quarter. Render-path
 * pages (`/candidate/[id]` and the on-device guide) hit this list, so a
 * 1-hour cache trades a tiny staleness window for a free DB call on every
 * hot render.
 *
 * Tag: ['sub-dimensions'] — invalidate from a methodology-update server
 * action when the taxonomy actually changes.
 */
export const getSubDimensionsCached = unstable_cache(
  async (): Promise<SubDimension[]> => {
    // Service client: cookies()-based clients can't be constructed inside
    // an unstable_cache scope. sub_dimensions is public-read so this is fine.
    const supabase = await createServiceClient();
    const { data, error } = await supabase
      .from('sub_dimensions')
      .select('*')
      .order('display_order');
    if (error || !data) return [];
    return data as SubDimension[];
  },
  ['sub-dimensions-v1'],
  { revalidate: 3600, tags: ['sub-dimensions'] },
);
