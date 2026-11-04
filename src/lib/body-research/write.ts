/**
 * Shared write logic for body-research agent results.
 *
 * Discipline (per the office-knowledge-base design):
 *  - Citations are APPENDED, not replaced.
 *  - size_authoritative flips to true when result.authoritative === true
 *    AND there's at least one citation from a primary-source host.
 *  - last_verified_at = now(), verified_by = `agent:<template_slug>:<runId>`.
 *  - Field-level conflicts surface, not overwrite. If catalog has a
 *    non-empty value for description/powers_summary that differs from
 *    the agent's output, write the agent's to meta.proposed_<field> and
 *    leave the existing value alone for reviewer reconciliation.
 *  - Officeholder data goes via office_tenures (separate concern from
 *    body schema). Phase 1 of body research SKIPS officeholder writes
 *    pending the office_tenures write-rule decision — surfaces them in
 *    notes instead.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentResult, PolicyAuthorityDomainV1 } from './types';
import { isSourceAllowed, classifySourceKind, classifySourceTier, countPrimaryCitations, setBodyTrustedHosts } from './source-allowlist';
import { loadShimEvidence, classifyCitationEvidence } from './shim-evidence';
import { lookupPrimarySources } from './primary-source-lookup';

export interface WriteOpts {
  bodyId: string;
  templateSlug: string;
  runId: string;
  dryRun: boolean;
  // Run-window bounds (ms epoch) used to scope the shim-evidence cross-check.
  // Optional — if omitted, the writer skips the evidence check (and just
  // relies on the primary-citation gate). Pass them from research-body.ts.
  ts_start_ms?: number;
  ts_end_ms?: number;
  // Truncation signal from prefetch-sources.ts. When set, persisted to
  // meta.prefetch_truncation. Pipeline B uses this to identify bodies
  // where the agent may have seen only a partial primary source.
  prefetchTruncation?: {
    any_truncated: boolean;
    truncated_sources: Array<{ url: string; kind: string; original_bytes: number; cap_bytes: number }>;
  };
}

export interface WriteResult {
  bodyUpdated: boolean;
  fieldsWritten: string[];
  fieldsConflicted: string[];
  citationsAdded: number;
  warnings: string[];
  /** Did this run mark the body structurally verified (primary source fetched
   *  + structure extracted)? This is the meaningful "verified" signal — the
   *  run status and dashboards should key off this, not the agent's stricter
   *  size_authoritative self-attestation. */
  bodyStructureVerified: boolean;
}

export async function writeAgentResult(
  sb: SupabaseClient,
  result: AgentResult,
  opts: WriteOpts,
): Promise<WriteResult> {
  const warnings: string[] = [];
  const fieldsWritten: string[] = [];
  const fieldsConflicted: string[] = [];

  // Load existing body
  const { data: existing, error: loadErr } = await sb
    .from('governing_bodies')
    .select('*')
    .eq('id', opts.bodyId)
    .single();
  if (loadErr || !existing) throw new Error(`Could not load body ${opts.bodyId}: ${loadErr?.message}`);
  const body = existing as any;

  // Per-body trusted host (2026-06-04, Utah lessons-learned): if an operator-
  // verified roster URL exists in primary_source_urls for this body, citations
  // from that host count as PRIMARY for this body — official school-district
  // .org / small-city .com sites the global tier rules can't bless. (Utah cost:
  // Opus extracted Jordan SD's full roster from jordandistrict.org and the gate
  // rejected it.) Registered for the duration of this write; cleared by the
  // next caller's registration. Harmless no-op if the lookup fails.
  try {
    const { data: jur } = await sb.from('jurisdictions').select('name, fips_state').eq('id', body.jurisdiction_id).single();
    if (jur) {
      const psu = await lookupPrimarySources(sb, { body_kind: body.chamber_type, jurisdiction_name: (jur as any).name, state_fips: (jur as any).fips_state });
      setBodyTrustedHosts(psu.roster_url ? [psu.roster_url] : null);
    } else setBodyTrustedHosts(null);
  } catch { setBodyTrustedHosts(null); }

  // Normalize citation field names (agents sometimes use source_url instead
  // of url, verbatim_snippet instead of relevant_snippet). Be lenient.
  const normalizedCitations = (result.citations ?? []).map((c: any) => ({
    url: c.url ?? c.source_url ?? c.href ?? c.link,
    title: c.title ?? c.name ?? c.page_title ?? '',
    kind: c.kind ?? c.source_kind,
    accessed_at: c.accessed_at ?? c.fetched_at ?? c.date,
    relevant_snippet: c.relevant_snippet ?? c.verbatim_snippet ?? c.snippet,
  }));

  // Validate citations against the allowlist
  const validCitations = normalizedCitations.filter((c) => {
    const check = isSourceAllowed(c.url);
    if (!check.allowed) {
      warnings.push(`Citation rejected — ${check.reason}: ${c.url ?? '(no url)'}`);
      return false;
    }
    return true;
  });

  if (validCitations.length === 0) {
    warnings.push('No valid citations — refusing to mark authoritative even if agent claims so.');
  }

  // ── PRIMARY-CITATION GATE (added 2026-05-26) ───────────────────────────
  // Per user directive: Wikipedia + OpenStates can corroborate or help us
  // discover URLs, but NEVER count as the source of truth. authoritative=true
  // requires at least one citation tier === 'primary' (a .gov / .us state-
  // nested / curated municipal-pattern host). Without one, override to false
  // and surface a warning. This is independent of the WebFetch-evidence
  // enforcement in research-body.ts (which catches "agent did 0 fetches");
  // this catches "agent fetched only Wikipedia."
  const primaryCount = countPrimaryCitations(validCitations);
  if (result.authoritative === true && primaryCount === 0) {
    warnings.push(
      `Agent claimed authoritative=true but no primary-tier citations exist ` +
      `(have ${validCitations.length} corroborating). Wikipedia/OpenStates ` +
      `cannot be source-of-truth. Downgrading to authoritative=false.`,
    );
    result.authoritative = false;
  }

  // ── SHIM-EVIDENCE CROSS-CHECK (added 2026-05-26) ───────────────────────
  // Even with a primary-tier citation, the agent could have fabricated the
  // URL from training data without actually fetching it. Cross-reference
  // every primary citation against the smart-fetch HTTP shim's per-run
  // fetch log. If a primary citation was never actually fetched (via shim
  // OR by plain WebFetch — for now we only track shim because plain
  // WebFetch is opaque to us), the citation is suspect.
  // We're permissive on the "host" match (same host, different page) since
  // agents reasonably navigate between pages on the same .gov site.
  // Always compute evidenceVerdict (independent of agent's authoritative claim).
  // body_structure_verified needs this signal even when the agent honestly
  // says auth=false for per-seat reasons. Fix 2026-05-27.
  let evidenceVerdict: { strong: number; weak: number; missing: number } | null = null;
  if (opts.ts_start_ms && opts.ts_end_ms) {
    const evidence = loadShimEvidence({
      ts_start_ms: opts.ts_start_ms,
      ts_end_ms: opts.ts_end_ms,
      body_id: opts.bodyId,
      run_id: opts.runId,
    });
    let strong = 0, weak = 0, missing = 0;
    const missingUrls: string[] = [];
    for (const c of validCitations) {
      if (classifySourceTier(c.url) !== 'primary') continue;
      const verdict = classifyCitationEvidence(c.url ?? '', evidence);
      if (verdict === 'exact') strong++;
      else if (verdict === 'host') weak++;
      else { missing++; missingUrls.push(c.url ?? '(no url)'); }
    }
    evidenceVerdict = { strong, weak, missing };
    // Only demote authoritative if agent CLAIMED true but no evidence —
    // catches fabricated citations. Don't demote on agent-emitted false
    // (that's a separate per-seat-data concern).
    if (result.authoritative === true && strong + weak === 0 && missing > 0) {
      warnings.push(
        `Agent claimed authoritative=true with ${primaryCount} primary citation(s), ` +
        `but NONE were actually fetched through the shim during this run window ` +
        `(${opts.ts_start_ms}→${opts.ts_end_ms}). Likely fabricated from training data. ` +
        `Unfetched URLs: ${missingUrls.slice(0, 3).join(', ')}${missingUrls.length > 3 ? ` (+${missingUrls.length - 3} more)` : ''}. ` +
        `Downgrading to authoritative=false.`,
      );
      result.authoritative = false;
    }
  }

  // Build the update payload
  const update: Record<string, unknown> = {};
  const conflictMeta: Record<string, unknown> = {};

  // When agent reports authoritative=true AND has valid citations, we trust
  // the research over the catalog's pre-existing placeholder. Conflicts get
  // OVERWRITTEN in the body row + the prior catalog value gets stashed in
  // meta.superseded_<field> so it's never lost. Without this, the catalog's
  // bulk-loaded placeholder text persists forever even after verified
  // research disagrees with it — the bug user surfaced 2026-05-26.
  // Note: post primary-citation gate above, result.authoritative is already
  // false if no primary citation exists, so this check effectively requires
  // primaryCount >= 1.
  const authoritativeOverwrite = result.authoritative === true && primaryCount > 0;
  const supersededMeta: Record<string, unknown> = {};

  const setOrConflict = (
    field: string,
    incoming: unknown,
    existingValue: unknown,
    nonEmptyCheck: (v: unknown) => boolean = (v) => v != null && v !== '',
  ) => {
    if (!nonEmptyCheck(incoming)) return;
    if (!nonEmptyCheck(existingValue)) {
      update[field] = incoming;
      fieldsWritten.push(field);
      return;
    }
    if (JSON.stringify(incoming) === JSON.stringify(existingValue)) {
      return; // no change
    }
    if (authoritativeOverwrite) {
      // Trust the verified research. Stash the prior value for audit but
      // overwrite the field. fieldsWritten gets a "(overwrote)" marker so
      // downstream telemetry/status reflects the substitution.
      update[field] = incoming;
      supersededMeta[`superseded_${field}`] = existingValue;
      fieldsWritten.push(`${field} (overwrote placeholder)`);
      return;
    }
    conflictMeta[`proposed_${field}`] = incoming;
    fieldsConflicted.push(field);
  };

  // Body-level fields
  const b = result.body;
  setOrConflict('canonical_name', b.canonical_name, body.canonical_name);
  setOrConflict('short_name', b.short_name, body.short_name);
  setOrConflict('description', b.description, body.description);
  setOrConflict('powers_summary', b.powers_summary, body.powers_summary);
  setOrConflict('meeting_schedule', b.meeting_schedule, body.meeting_schedule);
  // Normalize selection_method against the enum — drop with a warning if invalid.
  const ALLOWED_SM = new Set(['elected_partisan','elected_nonpartisan','appointed','retention_election','merit_selection','mixed']);
  let normalizedSM: string | undefined = b.selection_method;
  if (normalizedSM === 'elected' || normalizedSM === 'partisan_elected') normalizedSM = 'elected_partisan';
  if (normalizedSM === 'nonpartisan_elected') normalizedSM = 'elected_nonpartisan';
  if (normalizedSM && !ALLOWED_SM.has(normalizedSM)) {
    warnings.push(`selection_method "${b.selection_method}" not in enum; storing as meta.proposed_selection_method instead`);
    conflictMeta.proposed_selection_method = b.selection_method;
    fieldsConflicted.push('selection_method (invalid enum)');
    normalizedSM = undefined;
  }
  setOrConflict('selection_method', normalizedSM, body.selection_method);
  setOrConflict('primary_required', b.primary_required, body.primary_required, (v) => v != null);
  setOrConflict('on_cycle_pattern', b.on_cycle_pattern, body.on_cycle_pattern);
  setOrConflict('vacancy_appointment_authority', b.vacancy_appointment_authority, body.vacancy_appointment_authority);
  setOrConflict('special_election_timing_rule', b.special_election_timing_rule, body.special_election_timing_rule);
  setOrConflict('voter_qualifications_summary', b.voter_qualifications_summary, body.voter_qualifications_summary);

  // Arrays — for seat_structure + vacancy_triggers_special, overwrite if new is non-empty
  if (Array.isArray(b.seat_structure) && b.seat_structure.length > 0) {
    if (JSON.stringify(b.seat_structure) !== JSON.stringify(body.seat_structure ?? [])) {
      const catalogHasSubstance = Array.isArray(body.seat_structure) && body.seat_structure.length > 0;
      if (catalogHasSubstance && !authoritativeOverwrite) {
        conflictMeta.proposed_seat_structure = b.seat_structure;
        fieldsConflicted.push('seat_structure');
      } else {
        update.seat_structure = b.seat_structure;
        if (catalogHasSubstance) {
          // Authoritative overwrite — stash the prior structure for audit.
          supersededMeta.superseded_seat_structure = body.seat_structure;
          fieldsWritten.push('seat_structure (overwrote placeholder)');
        } else {
          fieldsWritten.push('seat_structure');
        }
      }
    }
  }
  if (Array.isArray(b.vacancy_triggers_special) && b.vacancy_triggers_special.length > 0) {
    const existingArr = Array.isArray(body.vacancy_triggers_special) ? body.vacancy_triggers_special : [];
    if (JSON.stringify(b.vacancy_triggers_special) !== JSON.stringify(existingArr)) {
      if (existingArr.length > 0 && !authoritativeOverwrite) {
        conflictMeta.proposed_vacancy_triggers_special = b.vacancy_triggers_special;
        fieldsConflicted.push('vacancy_triggers_special');
      } else {
        update.vacancy_triggers_special = b.vacancy_triggers_special;
        if (existingArr.length > 0) {
          supersededMeta.superseded_vacancy_triggers_special = existingArr;
          fieldsWritten.push('vacancy_triggers_special (overwrote placeholder)');
        } else {
          fieldsWritten.push('vacancy_triggers_special');
        }
      }
    }
  }

  // size_total — write if differs (this is canonical from the agent)
  if (b.size_total != null && b.size_total !== body.size_total) {
    update.size_total = b.size_total;
    fieldsWritten.push('size_total');
  }

  // ── OFFICE-SCOPE WRITES (v1, council 2026-05-26) ─────────────────────
  // Apply chamber_type_defaults from the lookup table, then accept
  // per-body overrides only if accompanied by a primary-source citation
  // that passed the shim-fetch evidence check.
  try {
    const { data: defRow } = await sb
      .from('chamber_type_defaults')
      .select('default_domains_v1, default_authority_mode, jurisdiction_level')
      .eq('chamber_type', body.chamber_type)
      .single();
    if (defRow) {
      const def = defRow as { default_domains_v1: string[]; default_authority_mode: string; jurisdiction_level: string };
      let effectiveDomains: string[] = Array.isArray(def.default_domains_v1) ? [...def.default_domains_v1] : [];

      // Apply override only when (a) override has at least one citation,
      // (b) each cited URL passed the shim-fetch evidence cross-check
      //     above (i.e. host appears in the run's fetched_hosts set), and
      // (c) the citation's source tier is primary.
      const override = b.domain_overrides;
      if (override && Array.isArray(override.citations) && override.citations.length > 0) {
        const citationOk = override.citations.some((c: any) => {
          if (!c?.url) return false;
          if (classifySourceTier(c.url) !== 'primary') return false;
          // If we have an evidence load, also require the citation host to
          // actually appear in the fetched set. Without an evidence load
          // (legacy path), we accept primary-tier citations on faith — the
          // primary-citation gate already happened above.
          if (evidenceVerdict && opts.ts_start_ms && opts.ts_end_ms) {
            const ev = loadShimEvidence({
              ts_start_ms: opts.ts_start_ms,
              ts_end_ms: opts.ts_end_ms,
              body_id: opts.bodyId,
              run_id: opts.runId,
            });
            return classifyCitationEvidence(c.url, ev) !== 'none';
          }
          return true;
        });
        if (citationOk) {
          const added = (override.added ?? []).filter((d: any) => typeof d === 'string');
          const removed = new Set((override.removed ?? []).filter((d: any) => typeof d === 'string'));
          effectiveDomains = Array.from(new Set([...effectiveDomains.filter((d) => !removed.has(d as PolicyAuthorityDomainV1)), ...added]));
          update.domain_overrides = {
            added,
            removed: Array.from(removed),
            citations: override.citations,
            applied_at: new Date().toISOString(),
          };
          fieldsWritten.push('domain_overrides');
        } else {
          warnings.push(
            `domain_overrides rejected — no primary-tier citation with fetched-host evidence. ` +
            `Falling back to chamber_type defaults for ${body.chamber_type}.`,
          );
        }
      }

      // Always write the effective domains + authority_mode + jurisdiction
      // hint. Defaults are written even when the agent provides nothing,
      // so every body gets at least the chamber-type-level scope.
      if (Array.isArray(effectiveDomains) && effectiveDomains.length > 0) {
        if (JSON.stringify(effectiveDomains) !== JSON.stringify(body.policy_authority_domains_v1 ?? [])) {
          update.policy_authority_domains_v1 = effectiveDomains;
          fieldsWritten.push('policy_authority_domains_v1');
        }
      }
      const effectiveMode = b.authority_mode ?? def.default_authority_mode;
      if (effectiveMode && effectiveMode !== body.authority_mode) {
        update.authority_mode = effectiveMode;
        fieldsWritten.push('authority_mode');
      }
    } else {
      // No chamber-type default row → leave domains alone; warn.
      warnings.push(`No chamber_type_defaults row for chamber_type='${body.chamber_type}'. Office scope not populated.`);
    }
  } catch (e: any) {
    warnings.push(`chamber_type_defaults lookup failed: ${e.message ?? String(e)}`);
  }

  // ── voter_facing_scope ─────────────────────────────────────────────────
  // Strict: one_liner ≤ 160 chars, statute_url OR charter_url required,
  // citation host must appear in shim-fetch evidence (if available).
  if (b.voter_facing_scope) {
    const vfs = b.voter_facing_scope as any;
    const oneLiner = typeof vfs.one_liner === 'string' ? vfs.one_liner.trim() : '';
    const hasReceipt = (typeof vfs.statute_url === 'string' && vfs.statute_url.length > 0)
      || (typeof vfs.charter_url === 'string' && vfs.charter_url.length > 0);
    if (oneLiner.length === 0) {
      warnings.push('voter_facing_scope rejected: one_liner is empty');
    } else if (oneLiner.length > 160) {
      warnings.push(`voter_facing_scope rejected: one_liner is ${oneLiner.length} chars (cap 160)`);
    } else if (!hasReceipt) {
      warnings.push('voter_facing_scope rejected: missing statute_url AND charter_url (one is required)');
    } else {
      // Citation receipt must also be a primary source AND (if evidence
      // available) appear in the fetched set.
      const receiptUrl = (vfs.statute_url && vfs.statute_url.length > 0) ? vfs.statute_url : vfs.charter_url;
      if (classifySourceTier(receiptUrl) !== 'primary') {
        warnings.push(`voter_facing_scope rejected: receipt URL "${receiptUrl}" is not primary tier`);
      } else if (evidenceVerdict && opts.ts_start_ms && opts.ts_end_ms) {
        const ev = loadShimEvidence({
          ts_start_ms: opts.ts_start_ms,
          ts_end_ms: opts.ts_end_ms,
          body_id: opts.bodyId,
          run_id: opts.runId,
        });
        if (classifyCitationEvidence(receiptUrl, ev) === 'none') {
          warnings.push(`voter_facing_scope rejected: receipt URL "${receiptUrl}" was never fetched through shim during this run`);
        } else {
          update.voter_facing_scope = {
            one_liner: oneLiner,
            statute_url: vfs.statute_url ?? null,
            charter_url: vfs.charter_url ?? null,
            locale: vfs.locale ?? 'en',
            written_at: new Date().toISOString(),
            written_by_run: opts.runId,
          };
          fieldsWritten.push('voter_facing_scope');
        }
      } else {
        update.voter_facing_scope = {
          one_liner: oneLiner,
          statute_url: vfs.statute_url ?? null,
          charter_url: vfs.charter_url ?? null,
          locale: vfs.locale ?? 'en',
          written_at: new Date().toISOString(),
          written_by_run: opts.runId,
        };
        fieldsWritten.push('voter_facing_scope');
      }
    }
  }

  // statute_url / charter_url at body-level (independent of voter_facing_scope)
  if (b.statute_url && classifySourceTier(b.statute_url) === 'primary' && b.statute_url !== body.statute_url) {
    update.statute_url = b.statute_url;
    fieldsWritten.push('statute_url');
  }
  if (b.charter_url && classifySourceTier(b.charter_url) === 'primary' && b.charter_url !== body.charter_url) {
    update.charter_url = b.charter_url;
    fieldsWritten.push('charter_url');
  }

  // Citations — append; dedup by URL
  const existingCitations: any[] = Array.isArray(body.citations) ? body.citations : [];
  const existingUrls = new Set(existingCitations.map((c) => c?.url).filter(Boolean));
  const newCitations: any[] = [];
  for (const c of validCitations) {
    if (existingUrls.has(c.url)) continue;
    newCitations.push({
      url: c.url,
      title: c.title,
      kind: c.kind || classifySourceKind(c.url),
      accessed_at: c.accessed_at,
      relevant_snippet: c.relevant_snippet,
    });
    existingUrls.add(c.url);
  }
  let citationsAdded = 0;
  if (newCitations.length > 0) {
    update.citations = [...existingCitations, ...newCitations];
    citationsAdded = newCitations.length;
  }

  // ── Two-signal verification (council split 2026-05-27) ────────────────
  //
  // body_structure_verified: "did we fetch the primary source and extract
  //   body-level structure (size, terms, scope)?" — set TRUE whenever a
  //   primary-tier citation exists AND has shim-fetch evidence. Independent
  //   of agent's self-assessment of per-seat completeness. This is the
  //   trustworthy flag for "is this body verified" UI affordances.
  //
  // size_authoritative: the agent's self-attestation, gated as before
  //   (agent says true AND primary citation exists). False when agent is
  //   honest about per-seat ambiguity. Use this for the stricter "no
  //   caveats" flag — e.g., "verified incumbent roster as well."
  //
  // Both refresh on every run; no more stale values.
  const willMarkAuth = result.authoritative === true && primaryCount > 0;
  if (willMarkAuth) {
    update.size_authoritative = true;
  } else {
    update.size_authoritative = false;
  }
  if ((body as any).size_authoritative !== update.size_authoritative) {
    fieldsWritten.push(`size_authoritative (${(body as any).size_authoritative}→${update.size_authoritative})`);
  }

  // body_structure_verified: primary citation + shim-fetch evidence for it.
  // We use the evidenceVerdict computed in the cross-check section above
  // (which already enumerated primary citations against the fetched-hosts
  // set). If at least one primary citation has 'exact' or 'host' evidence,
  // the body's primary source was actually fetched → structure is verified.
  let willMarkStructure = false;
  if (primaryCount > 0 && evidenceVerdict && (evidenceVerdict.strong + evidenceVerdict.weak > 0)) {
    willMarkStructure = true;
  } else if (primaryCount > 0 && !evidenceVerdict) {
    // No evidence loader (legacy/test path) — fall back to "primary
    // citation exists" alone. Real runs always have evidence.
    willMarkStructure = true;
  }
  update.body_structure_verified = willMarkStructure;
  if ((body as any).body_structure_verified !== willMarkStructure) {
    fieldsWritten.push(`body_structure_verified (${(body as any).body_structure_verified ?? 'null'}→${willMarkStructure})`);
  }
  if (willMarkStructure) {
    update.body_structure_verified_at = new Date().toISOString();
    update.body_structure_verified_by = `agent:${opts.templateSlug}:${opts.runId}`;
  }
  update.last_verified_at = new Date().toISOString();
  update.verified_by = `agent:${opts.templateSlug}:${opts.runId}`;
  fieldsWritten.push('last_verified_at', 'verified_by');
  if (willMarkAuth) fieldsWritten.push('size_authoritative');

  // ── verification_evidence_class write-through (gap-fix 2026-05-27) ─────
  // Now keyed on body_structure_verified (the meaningful "we fetched a
  // primary source and extracted structure" signal), not on the stricter
  // size_authoritative (which the agent conservatively sets false on
  // per-seat ambiguity). Per the smoke-batch user feedback: if every body
  // comes back unverified, the gate is gating the source of truth behind
  // unreal standards. 'enforced' means structurally verified under the
  // post-2026-05-27 gates; 'unverified' means no primary-source fetch was
  // proven this run.
  const newEvidenceClass = willMarkStructure ? 'enforced' : 'unverified';
  if ((body as any).verification_evidence_class !== newEvidenceClass) {
    update.verification_evidence_class = newEvidenceClass;
    fieldsWritten.push(`verification_evidence_class (${(body as any).verification_evidence_class ?? 'null'}→${newEvidenceClass})`);
  }

  // Merge conflictMeta + supersededMeta + existing meta. supersededMeta only
  // populates on authoritative overwrites — keeps an audit trail of what we
  // replaced. conflictMeta only populates when authoritative=false (the
  // legacy "surface, don't overwrite" path stays for unverified runs).
  //
  // On a fresh authoritative win we also clear the legacy revocation flag —
  // a body that was revoked in the 2026-05-26 audit and now re-verified
  // shouldn't keep saying "authoritative_revoked=true" in meta. We move
  // the original revocation reason to authoritative_revocation_history[]
  // for audit.
  const existingMeta = (body.meta && typeof body.meta === 'object') ? body.meta as Record<string, unknown> : {};
  const metaUpdate: Record<string, unknown> = { ...existingMeta, ...conflictMeta, ...supersededMeta };
  let metaChanged = Object.keys(conflictMeta).length > 0 || Object.keys(supersededMeta).length > 0;

  // ── Prefetch truncation signal (Pipeline B input) ──────────────────────
  // When the dispatcher's pre-fetch hit the per-source cap, the agent saw
  // only a partial source. Persist this so Pipeline B (verify-harder) can
  // pick the body up for re-fetch with different parameters. Cleared on
  // any future run that didn't truncate.
  if (opts.prefetchTruncation) {
    if (opts.prefetchTruncation.any_truncated) {
      metaUpdate.prefetch_truncation = {
        occurred_at: new Date().toISOString(),
        run_id: opts.runId,
        sources: opts.prefetchTruncation.truncated_sources,
      };
      warnings.push(`prefetch truncation flagged on ${opts.prefetchTruncation.truncated_sources.length} source(s) — body queued for Pipeline B verify-harder`);
      metaChanged = true;
      fieldsWritten.push('meta.prefetch_truncation (set)');
    } else if (existingMeta.prefetch_truncation) {
      // No truncation this run, but a prior run flagged truncation — clear
      // the signal so Pipeline B knows this body has been re-attempted
      // cleanly. Move the prior to history.
      const history = Array.isArray(existingMeta.prefetch_truncation_history)
        ? [...(existingMeta.prefetch_truncation_history as unknown[])]
        : [];
      history.push({ ...(existingMeta.prefetch_truncation as Record<string, unknown>), cleared_at: new Date().toISOString(), cleared_by_run: opts.runId });
      metaUpdate.prefetch_truncation_history = history;
      delete metaUpdate.prefetch_truncation;
      metaChanged = true;
      fieldsWritten.push('meta.prefetch_truncation (cleared, archived)');
    }
  }
  if (willMarkAuth && existingMeta.authoritative_revoked === true) {
    // Archive the prior revocation so we don't lose the audit trail.
    const history = Array.isArray(existingMeta.authoritative_revocation_history)
      ? [...(existingMeta.authoritative_revocation_history as unknown[])]
      : [];
    history.push({
      revoked_at: existingMeta.authoritative_revoked_at ?? null,
      reason: existingMeta.authoritative_revoked_reason ?? null,
      prior_verified_by: existingMeta.authoritative_revoked_prior_verified_by ?? null,
      cleared_at: new Date().toISOString(),
      cleared_by_run: opts.runId,
    });
    metaUpdate.authoritative_revocation_history = history;
    delete metaUpdate.authoritative_revoked;
    delete metaUpdate.authoritative_revoked_at;
    delete metaUpdate.authoritative_revoked_reason;
    delete metaUpdate.authoritative_revoked_prior_verified_by;
    delete metaUpdate.authoritative_revoked_prior_verified_at;
    metaChanged = true;
    fieldsWritten.push('meta.authoritative_revoked (cleared, archived)');
  }
  // ── Research attempt log (Branch C, 2026-05-28) ───────────────────────
  // Append a structured entry to meta.research_attempts[] on every write,
  // verified or not, so future runs can read what was tried without
  // re-burning plan-auth budget. "Stop discarding real work" per task #104:
  // even when the body comes back unverified, the agent's notes + claimed
  // size + claimed authoritative flag get logged. result.seats counts are
  // captured here too (they're not written to office_tenures yet — Phase
  // 1.5 — but at least the count is visible).
  //
  // We cap at 20 entries (FIFO) to keep meta JSONB bounded. Older runs roll
  // off into meta.research_attempts_archived[] (capped at 50 entries) for
  // long-term audit without inflating the active log.
  const newAttempt = {
    run_id: opts.runId,
    ts: new Date().toISOString(),
    template_slug: opts.templateSlug,
    agent_authoritative: result.authoritative === true,
    writer_accepted_authoritative: willMarkAuth,
    body_structure_verified: willMarkStructure,
    primary_citations: primaryCount,
    valid_citations_total: validCitations.length,
    claimed_size_total: result.body?.size_total ?? null,
    seats_extracted: Array.isArray(result.seats) ? result.seats.length : 0,
    evidence_verdict: evidenceVerdict,
    notes: typeof result.notes === 'string' ? result.notes.slice(0, 2000) : null,
    warnings_count: warnings.length,
  };
  const priorAttempts: any[] = Array.isArray(existingMeta.research_attempts)
    ? [...(existingMeta.research_attempts as unknown[])] as any[]
    : [];
  const priorArchived: any[] = Array.isArray(existingMeta.research_attempts_archived)
    ? [...(existingMeta.research_attempts_archived as unknown[])] as any[]
    : [];
  priorAttempts.push(newAttempt);
  const ATTEMPTS_CAP = 20;
  const ARCHIVE_CAP = 50;
  if (priorAttempts.length > ATTEMPTS_CAP) {
    const overflow = priorAttempts.splice(0, priorAttempts.length - ATTEMPTS_CAP);
    priorArchived.push(...overflow);
    if (priorArchived.length > ARCHIVE_CAP) priorArchived.splice(0, priorArchived.length - ARCHIVE_CAP);
    metaUpdate.research_attempts_archived = priorArchived;
  }
  metaUpdate.research_attempts = priorAttempts;
  metaChanged = true;
  fieldsWritten.push('meta.research_attempts (appended)');

  if (metaChanged) {
    update.meta = metaUpdate;
    if (Object.keys(conflictMeta).length > 0) fieldsWritten.push('meta (conflicts surfaced)');
    if (Object.keys(supersededMeta).length > 0) fieldsWritten.push('meta (superseded values archived)');
  }

  // Officeholder updates — defer (Phase 1.5 work). Just include in notes.
  if (result.seats && result.seats.length > 0) {
    warnings.push(`${result.seats.length} officeholder seats extracted but write logic for office_tenures is not in this phase. Surfaced in agent JSON for review.`);
  }

  if (opts.dryRun) {
    return {
      bodyUpdated: false,
      fieldsWritten,
      fieldsConflicted,
      citationsAdded,
      warnings: [...warnings, 'DRY-RUN — no writes performed'],
      bodyStructureVerified: willMarkStructure,
    };
  }

  // Apply
  const { error: uErr } = await sb.from('governing_bodies').update(update).eq('id', opts.bodyId);
  if (uErr) throw new Error(`Body update failed: ${uErr.message}`);

  return {
    bodyUpdated: true,
    fieldsWritten,
    fieldsConflicted,
    citationsAdded,
    warnings,
    bodyStructureVerified: willMarkStructure,
  };
}
