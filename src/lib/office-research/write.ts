/**
 * Write logic for standalone-office research results.
 *
 * Offices table currently doesn't have description/powers_summary/etc.
 * as first-class columns. We store all editorial extracted data into
 * offices.meta.research_extracted = {...} so it's reviewable in
 * /admin/office-review without requiring a schema migration up front.
 *
 * The discipline (parallel to body write.ts):
 *  - Citations appended, never replaced (lives in meta.citations)
 *  - Field-level conflicts route to meta.proposed_<field>
 *  - last_verified_at + verified_by set on offices.meta
 *  - Officeholder data: NOT yet written to office_tenures here either —
 *    surfaced in agent JSON for reviewer to promote.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OfficeAgentResult } from './types';
import { isSourceAllowed, classifySourceKind } from '../body-research/source-allowlist';

export interface OfficeWriteOpts {
  officeId: string;
  templateSlug: string;
  runId: string;
  dryRun: boolean;
}

export interface OfficeWriteResult {
  officeUpdated: boolean;
  fieldsWritten: string[];
  fieldsConflicted: string[];
  citationsAdded: number;
  warnings: string[];
}

export async function writeOfficeAgentResult(
  sb: SupabaseClient,
  result: OfficeAgentResult,
  opts: OfficeWriteOpts,
): Promise<OfficeWriteResult> {
  const warnings: string[] = [];
  const fieldsWritten: string[] = [];
  const fieldsConflicted: string[] = [];

  const { data: existing, error: loadErr } = await sb
    .from('offices')
    .select('*')
    .eq('id', opts.officeId)
    .single();
  if (loadErr || !existing) throw new Error(`Could not load office ${opts.officeId}: ${loadErr?.message}`);
  const office = existing as any;
  const existingMeta = (office.meta && typeof office.meta === 'object') ? { ...office.meta } : {};
  const existingResearch = (existingMeta.research_extracted && typeof existingMeta.research_extracted === 'object')
    ? { ...existingMeta.research_extracted } : {};

  // Normalize citations
  const normalizedCitations = (result.citations ?? []).map((c: any) => ({
    url: c.url ?? c.source_url ?? c.href ?? c.link,
    title: c.title ?? c.name ?? c.page_title ?? '',
    kind: c.kind ?? c.source_kind ?? classifySourceKind(c.url ?? c.source_url ?? ''),
    accessed_at: c.accessed_at ?? c.fetched_at ?? c.date,
    relevant_snippet: c.relevant_snippet ?? c.verbatim_snippet ?? c.snippet,
  }));
  const validCitations = normalizedCitations.filter((c) => {
    const check = isSourceAllowed(c.url);
    if (!check.allowed) {
      warnings.push(`Citation rejected — ${check.reason}: ${c.url ?? '(no url)'}`);
      return false;
    }
    return true;
  });
  if (validCitations.length === 0) warnings.push('No valid citations — refusing to mark authoritative even if agent claims so.');

  // Normalize selection_method
  const ALLOWED_SM = new Set(['elected_partisan','elected_nonpartisan','appointed','retention_election','merit_selection','mixed']);
  let sm: any = result.office.selection_method;
  if (sm === 'elected' || sm === 'partisan_elected') sm = 'elected_partisan';
  if (sm === 'nonpartisan_elected') sm = 'elected_nonpartisan';
  if (sm && !ALLOWED_SM.has(sm)) {
    warnings.push(`selection_method "${result.office.selection_method}" not in enum — storing as meta.research_extracted.proposed_selection_method`);
    sm = undefined;
  }
  const normalizedOffice = { ...result.office };
  if (sm) normalizedOffice.selection_method = sm as any;
  else delete normalizedOffice.selection_method;

  // Build the new research_extracted blob. Field-level conflict rule: if a
  // value already exists and the new one differs, write proposed_<field>
  // and leave the existing.
  const newResearch: Record<string, unknown> = { ...existingResearch };
  const conflictsResearch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(normalizedOffice)) {
    if (v == null || v === '') continue;
    const existingVal = existingResearch[k];
    if (existingVal == null || existingVal === '') {
      newResearch[k] = v;
      fieldsWritten.push(`research_extracted.${k}`);
      continue;
    }
    if (JSON.stringify(existingVal) === JSON.stringify(v)) continue;
    conflictsResearch[`proposed_${k}`] = v;
    fieldsConflicted.push(`research_extracted.${k}`);
  }

  // Officeholder: surface in research_extracted.current_officeholder_extracted
  // (deferring office_tenures write — see notes)
  if (result.current_officeholder) {
    newResearch.current_officeholder_extracted = result.current_officeholder;
    fieldsWritten.push('research_extracted.current_officeholder_extracted');
    warnings.push(`Officeholder data surfaced in meta.research_extracted only — not yet promoted to office_tenures.`);
  }

  // Citations: append into research_extracted.citations
  const existingCitations: any[] = Array.isArray(existingResearch.citations) ? existingResearch.citations : [];
  const existingUrls = new Set(existingCitations.map((c) => c?.url).filter(Boolean));
  let citationsAdded = 0;
  const mergedCitations = [...existingCitations];
  for (const c of validCitations) {
    if (existingUrls.has(c.url)) continue;
    mergedCitations.push(c);
    existingUrls.add(c.url);
    citationsAdded++;
  }
  if (citationsAdded > 0) {
    newResearch.citations = mergedCitations;
    fieldsWritten.push('research_extracted.citations');
  }

  // Conflicts blob
  if (Object.keys(conflictsResearch).length > 0) {
    newResearch.conflicts = { ...(existingResearch.conflicts ?? {}), ...conflictsResearch };
    fieldsWritten.push('research_extracted.conflicts (surfaced)');
  }

  // Verification metadata (always set)
  const willMarkAuth = result.authoritative && validCitations.length > 0;
  newResearch.last_verified_at = new Date().toISOString();
  newResearch.verified_by = `agent:${opts.templateSlug}:${opts.runId}`;
  newResearch.authoritative = willMarkAuth;
  fieldsWritten.push('research_extracted.last_verified_at', 'research_extracted.verified_by', 'research_extracted.authoritative');

  // Disposition (elected_verified | appointed | nonexistent | unconfirmed): the
  // agent's terminal classification. "appointed"/"nonexistent" are RESOLVED — the
  // queue won't re-dispatch them and escalation won't fire on them. Enforce
  // consistency (elected_verified requires valid citations) and derive from
  // authoritative when the agent didn't classify (older single templates).
  const VALID_DISP = new Set(['elected_verified', 'appointed', 'nonexistent', 'unconfirmed']);
  const rawDisp = (result as any).disposition;
  let disposition: string = (typeof rawDisp === 'string' && VALID_DISP.has(rawDisp)) ? rawDisp : (willMarkAuth ? 'elected_verified' : 'unconfirmed');
  if (disposition === 'elected_verified' && !willMarkAuth) disposition = 'unconfirmed';
  newResearch.disposition = disposition;
  fieldsWritten.push('research_extracted.disposition');

  // Compose update
  const update = { meta: { ...existingMeta, research_extracted: newResearch } };

  if (opts.dryRun) {
    return {
      officeUpdated: false,
      fieldsWritten,
      fieldsConflicted,
      citationsAdded,
      warnings: [...warnings, 'DRY-RUN — no writes performed'],
    };
  }

  const { error: uErr } = await sb.from('offices').update(update).eq('id', opts.officeId);
  if (uErr) throw new Error(`Office update failed: ${uErr.message}`);

  return { officeUpdated: true, fieldsWritten, fieldsConflicted, citationsAdded, warnings };
}
