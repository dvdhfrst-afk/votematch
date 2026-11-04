/**
 * primary-source-lookup.ts — fetch the canonical primary-source URLs for a
 * given body from primary_source_urls. Used by templates to inject the
 * exact .gov URL into the agent prompt, eliminating "agent guesses from
 * memorized URLs" as a failure mode.
 *
 * Returns { roster_url?, statute_url?, charter_url?, home_url? } — the
 * template builds these into the prompt's "fetch sequence" so the agent
 * doesn't need to discover them.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PrimarySourceUrls {
  roster_url?: string;
  statute_url?: string;
  charter_url?: string;
  home_url?: string;
  source: 'wikidata' | 'manual' | 'nces' | 'state_register' | 'mixed' | 'none';
}

const FRESHNESS_DAYS = 365;

export async function lookupPrimarySources(
  sb: SupabaseClient,
  opts: { body_kind: string; jurisdiction_name: string; state_fips?: string | null },
): Promise<PrimarySourceUrls> {
  const { body_kind, jurisdiction_name, state_fips } = opts;

  // chamber_type in governing_bodies doesn't carry a level prefix
  // ('legislative_upper' covers both US and state senates). The
  // primary_source_urls table keys on a level-qualified body_kind
  // ('state_legislative_upper' vs 'federal_legislative_upper').
  // We disambiguate via state_fips: NULL → federal, otherwise → state.
  const qualifiedKinds: string[] = [body_kind];
  const isLeg = /^legislative_/.test(body_kind);
  if (isLeg) {
    if (state_fips) qualifiedKinds.unshift(`state_${body_kind}`);
    else qualifiedKinds.unshift(`federal_${body_kind}`);
  }
  if (body_kind === 'state_supreme_court' || body_kind === 'appellate_court' || body_kind === 'municipal_court') {
    // already qualified
  } else if (/^(school_board|city_council|city_commission|town_council|township_board|selectboard|county_commission|county_council|special_district_board|state_board_of_education|state_board_of_regents|public_service_commission)$/.test(body_kind)) {
    // unique on its own
  }

  // Try qualified-kind exact match (jurisdiction_name), then bare-kind,
  // then state-fips fallback for state-level lookups.
  let rows: any[] | null = null;
  for (const k of qualifiedKinds) {
    const r = await sb
      .from('primary_source_urls')
      .select('primary_url, url_kind, source, source_fetched_at')
      .eq('body_kind', k)
      .ilike('jurisdiction_name', jurisdiction_name)
      .order('id');
    if (r.data && r.data.length > 0) { rows = r.data; break; }
  }
  if ((!rows || rows.length === 0) && state_fips) {
    for (const k of qualifiedKinds) {
      const r = await sb
        .from('primary_source_urls')
        .select('primary_url, url_kind, source, source_fetched_at')
        .eq('body_kind', k)
        .eq('state_fips', state_fips)
        .order('id');
      if (r.data && r.data.length > 0) { rows = r.data; break; }
    }
  }

  if (!rows || rows.length === 0) {
    return { source: 'none' };
  }

  const result: PrimarySourceUrls = { source: 'none' };
  const sources = new Set<string>();
  for (const r of rows as any[]) {
    sources.add(r.source);
    if (r.url_kind === 'roster' && !result.roster_url) result.roster_url = r.primary_url;
    else if (r.url_kind === 'statute' && !result.statute_url) result.statute_url = r.primary_url;
    else if (r.url_kind === 'charter' && !result.charter_url) result.charter_url = r.primary_url;
    else if (r.url_kind === 'home' && !result.home_url) result.home_url = r.primary_url;
  }
  result.source = sources.size === 1 ? (sources.values().next().value as any) : 'mixed';
  return result;
}

/**
 * Build the URL-encoded shim URL for the agent to fetch. The agent will
 * include bb_run_id + bb_body_id correlation params separately.
 */
export function shimUrlFor(targetUrl: string): string {
  return `http://localhost:4002/fetch?url=${encodeURIComponent(targetUrl)}`;
}
