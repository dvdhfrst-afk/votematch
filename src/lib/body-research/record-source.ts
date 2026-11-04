/**
 * record-source.ts — write a roster source URL that a Stage-2 agent
 * DISCOVERED back into primary_source_urls, so the NEXT run uses it as a
 * pre-fetched/hinted source instead of re-discovering it (and so its host
 * becomes a per-body trusted citation source via the write path's
 * setBodyTrustedHosts lookup).
 *
 * This is the persistence half of the two-stage source strategy
 * (2026-06-23): Stage 1 tries the mapped source; Stage 2 actively finds the
 * real one when Stage 1 is missing/empty; this records the Stage-2 win so
 * the source map self-heals over time.
 *
 * Idempotent: skips if a row already exists for (body_kind, jurisdiction_name,
 * primary_url). Mirrors the insert shape used by the _seed-*-urls.ts scripts.
 * Best-effort: never throws — a failed write must not fail the ingestion run.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RecordSourceArgs {
  body_kind: string;            // chamber_type as stored on governing_bodies (no level prefix)
  jurisdiction_name: string;
  state_fips?: string | null;
  url: string;                  // the discovered roster/members page
  url_kind?: 'roster' | 'statute' | 'charter' | 'home';
  /** Where the discovery came from — recorded in the `source` column. */
  discovered_by?: string;       // e.g. 'agent_stage2:unified_local_batch'
  notes?: string;
}

export interface RecordSourceResult {
  recorded: boolean;
  skipped_existing: boolean;
  error?: string;
}

function looksLikeUsableUrl(u: string | null | undefined): boolean {
  if (!u || typeof u !== 'string') return false;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Persist a discovered source into primary_source_urls. Returns a result
 * object instead of throwing so callers can log without try/catch noise.
 */
export async function recordDiscoveredSource(
  sb: SupabaseClient,
  args: RecordSourceArgs,
): Promise<RecordSourceResult> {
  const urlKind = args.url_kind ?? 'roster';
  if (!looksLikeUsableUrl(args.url)) {
    return { recorded: false, skipped_existing: false, error: `not a usable http(s) url: ${args.url}` };
  }
  try {
    // Dedup on (body_kind, jurisdiction_name, primary_url). Keeps us from
    // re-inserting the same discovered URL every run.
    const existing = await sb
      .from('primary_source_urls')
      .select('id')
      .eq('body_kind', args.body_kind)
      .ilike('jurisdiction_name', args.jurisdiction_name)
      .eq('primary_url', args.url)
      .maybeSingle();
    if (existing.data) {
      return { recorded: false, skipped_existing: true };
    }
    const ins = await sb.from('primary_source_urls').insert({
      body_kind: args.body_kind,
      jurisdiction_name: args.jurisdiction_name,
      state_fips: args.state_fips ?? null,
      primary_url: args.url,
      url_kind: urlKind,
      source: args.discovered_by ?? 'agent_discovered',
      // verified_resolves true: the agent only reports a discovered source
      // after smart_fetch confirmed a real roster on it (the write path's
      // primary-citation + shim-evidence gates also independently re-checked
      // that the page was actually fetched before any authoritative flip).
      verified_resolves: true,
      last_resolve_check: new Date().toISOString(),
      notes: args.notes ?? `discovered by Stage-2 active source-finding (${args.discovered_by ?? 'agent'})`,
    });
    if (ins.error) {
      return { recorded: false, skipped_existing: false, error: ins.error.message };
    }
    return { recorded: true, skipped_existing: false };
  } catch (e) {
    return { recorded: false, skipped_existing: false, error: e instanceof Error ? e.message : String(e) };
  }
}
