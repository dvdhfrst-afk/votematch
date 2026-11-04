import type { MetadataRoute } from 'next';
import { createClient } from '@/lib/supabase/server';

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? 'https://ballotbridge.org';

/**
 * /sitemap.xml — surfaces every public office/officeholder/person URL to crawlers.
 * Council #38 (distribution). Capped per route-type to stay under the 50K/sitemap limit;
 * if any list overflows we'll split into a sitemap index later. Federal incumbents and
 * 2026-relevant offices first — those are the searches voters actually run.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const supabase = await createClient();
  const [{ data: offices }, { data: officeholders }, { data: people }] = await Promise.all([
    supabase.from('offices').select('id, updated_at').limit(40000),
    supabase.from('office_tenures').select('person_id, ended_on').is('ended_on', null).limit(8000),
    supabase.from('people').select('id, updated_at').limit(8000),
  ]);
  const stat = ['', '/methodology', '/corrections', '/privacy', '/terms'].map((p) => ({ url: `${BASE}${p}`, changeFrequency: 'weekly' as const, priority: p === '' ? 1 : 0.5 }));
  const off = (offices ?? []).map((o) => ({ url: `${BASE}/office/${o.id}`, lastModified: o.updated_at ?? undefined, changeFrequency: 'weekly' as const, priority: 0.7 }));
  const oh = (officeholders ?? []).map((t) => ({ url: `${BASE}/officeholder/${t.person_id}`, changeFrequency: 'weekly' as const, priority: 0.8 }));
  const ppl = (people ?? []).map((p) => ({ url: `${BASE}/person/${p.id}`, lastModified: p.updated_at ?? undefined, changeFrequency: 'monthly' as const, priority: 0.6 }));
  return [...stat, ...off, ...oh, ...ppl];
}
