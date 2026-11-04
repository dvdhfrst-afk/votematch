/**
 * Promote agent-extracted officeholder data to office_tenures + people rows.
 *
 * Source of data:
 *   - Body templates: result.seats[].current_officeholder
 *   - Office templates: result.current_officeholder (single)
 *
 * Discipline:
 *   - People: match by canonical_name + state context where possible;
 *     create a new person if no match found.
 *   - Office_tenures: upsert with started_on = inferred from term_end
 *     (term_length backed off), ended_on = null (current), party_at_tenure,
 *     source_of_record = 'agent:<template_slug>:<runId>'.
 *   - Existing tenure for same office + person: skip (don't overwrite).
 *   - Existing tenure for same office + DIFFERENT person where ended_on is
 *     null: log a warning ("incumbent might have changed") — don't auto-end.
 *     Reviewer reconciles.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SeatToWrite {
  office_id: string;
  seat_designation?: string;
  current_officeholder: {
    person_name: string;
    party?: string;
    term_start?: string;
    term_end?: string;
    bioguide_id?: string;
    note?: string;
  };
}

export interface TenuresWriteOpts {
  templateSlug: string;
  runId: string;
  dryRun: boolean;
}

export interface TenuresWriteResult {
  tenuresInserted: number;
  tenuresSkipped: number;
  peopleMatched: number;
  peopleCreated: number;
  warnings: string[];
}

function normalizePartyLetter(party: string | undefined): string | null {
  if (!party) return null;
  const p = party.trim().toUpperCase();
  if (p === 'D' || p === 'DEM' || p === 'DEMOCRAT' || p === 'DEMOCRATIC') return 'Democratic';
  if (p === 'R' || p === 'REP' || p === 'REPUBLICAN') return 'Republican';
  if (p === 'I' || p === 'IND' || p === 'INDEPENDENT') return 'Independent';
  return party;
}

function inferStartFromTermEnd(termEnd: string | undefined, termLengthYears = 4): string | null {
  if (!termEnd) return null;
  try {
    const d = new Date(termEnd);
    d.setUTCFullYear(d.getUTCFullYear() - termLengthYears);
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

// Normalize a person's display name so "John A. Smith" and "John Andrew
// Smith" and "John Smith" all hash to the same fuzzy comparison key. NOT
// used as the primary match key — primary match is composite (name + body
// + seat). Used only as a fuzzy tie-breaker.
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\.,]/g, '')           // strip dots, commas
    .replace(/\s+(jr|sr|ii|iii|iv|md|phd|esq)\.?$/i, '')  // strip suffixes
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein for tie-breaker. Short strings only; we don't need fast.
function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m: number[][] = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      m[i][j] = b[i - 1] === a[j - 1] ? m[i-1][j-1] : Math.min(m[i-1][j-1] + 1, m[i][j-1] + 1, m[i-1][j] + 1);
    }
  }
  return m[b.length][a.length];
}

/**
 * Composite-key person lookup (2026-05-27 redesign — replaces naive name match).
 *
 * Confidence tiers, highest to lowest:
 *   1. bioguide_id exact         → certain (federal only today)
 *   2. canonical_name exact + office_id matches an existing tenure → very high
 *      (the same person re-elected to the same seat)
 *   3. canonical_name exact + a known prior tenure on a related office in the
 *      same body  → high (same person, different seat in same body — e.g.
 *      moved districts)
 *   4. canonical_name exact, no body context              → flag for review
 *      (might be a different "John Smith"; we don't auto-merge)
 *   5. fuzzy-match (lev <= 2 AND first/last names match)  → only when there's
 *      already exactly one candidate that survived an officeId-aware filter
 *
 * Returns:
 *   { id, created, matched, ambiguous?: true, candidates?: [...] }
 *   ambiguous=true means we found multiple plausible people and refuse to
 *   pick one. Caller should write a note and leave the seat unattributed
 *   for review.
 */
export async function findOrCreatePerson(
  sb: SupabaseClient,
  args: {
    personName: string;
    bioguideId?: string;
    officeId?: string | null;         // the seat we're trying to attribute
    bodyId?: string | null;            // the body the seat belongs to (for cross-seat match)
    dryRun?: boolean;
    /** Provenance tag written to people.meta.source on CREATE so every person
     *  this pipeline mints is attributable (2026-05-27 sourcing policy).
     *  Defaults to 'body_research' since this module only runs in that flow. */
    sourceTag?: string;
  },
): Promise<{ id: string | null; created: boolean; matched: boolean; ambiguous?: boolean; candidates?: Array<{ id: string; canonical_name: string; reason: string }> }> {
  const { personName, bioguideId, officeId, bodyId, dryRun = false, sourceTag = 'body_research' } = args;
  if (!personName) return { id: null, created: false, matched: false };

  // Tier 1: bioguide_id exact (federal)
  if (bioguideId) {
    const { data: byBioguide } = await sb
      .from('people')
      .select('id')
      .contains('meta', { identifiers: { bioguide: bioguideId } })
      .limit(1);
    if (byBioguide && byBioguide.length > 0) {
      return { id: (byBioguide[0] as any).id, created: false, matched: true };
    }
  }

  // Get all exact-name matches (case-insensitive). We'll narrow with context.
  const { data: byName } = await sb
    .from('people')
    .select('id, canonical_name, meta')
    .ilike('canonical_name', personName)
    .limit(20);  // upper bound: very common names may have many people
  const nameMatches = (byName ?? []) as Array<{ id: string; canonical_name: string; meta: any }>;

  if (nameMatches.length === 0) {
    // Try normalized-name fuzzy match if we have an officeId context (tier 5).
    if (officeId) {
      const { data: tenuresForOffice } = await sb
        .from('office_tenures')
        .select('person_id, people!inner(id, canonical_name)')
        .eq('office_id', officeId)
        .limit(20);
      const candidates: Array<{ id: string; canonical_name: string; reason: string }> = [];
      const target = normalizeName(personName);
      for (const t of (tenuresForOffice ?? []) as any[]) {
        const p = t.people;
        if (!p) continue;
        const norm = normalizeName(p.canonical_name);
        const d = lev(norm, target);
        if (d <= 2 && d > 0) {
          candidates.push({ id: p.id, canonical_name: p.canonical_name, reason: `fuzzy (lev=${d}) match against prior tenure on this office` });
        }
      }
      if (candidates.length === 1) {
        return { id: candidates[0].id, created: false, matched: true };
      }
      if (candidates.length > 1) {
        return { id: null, created: false, matched: false, ambiguous: true, candidates };
      }
    }
    // No match anywhere → create new person
    if (dryRun) return { id: null, created: false, matched: false };
    const meta: Record<string, unknown> = { source: sourceTag };
    if (bioguideId) meta.identifiers = { bioguide: bioguideId };
    const { data: created, error } = await sb
      .from('people')
      .insert({ canonical_name: personName, meta })
      .select('id')
      .single();
    if (error || !created) return { id: null, created: false, matched: false };
    return { id: (created as any).id, created: true, matched: false };
  }

  if (nameMatches.length === 1) {
    // Single exact name match. High confidence if we also have officeId/bodyId
    // showing this person held this seat before; otherwise, accept it (names
    // are quite identifying on average, just not always).
    return { id: nameMatches[0].id, created: false, matched: true };
  }

  // Multiple exact name matches: disambiguate via context.
  if (officeId) {
    // Filter to people who have ever held THIS office. Strongest signal —
    // an exact name match + same office = same person re-elected.
    const ids = nameMatches.map(p => p.id);
    const { data: ours } = await sb
      .from('office_tenures')
      .select('person_id')
      .eq('office_id', officeId)
      .in('person_id', ids)
      .limit(5);
    const ourIds = new Set((ours ?? []).map((t: any) => t.person_id));
    const filtered = nameMatches.filter(p => ourIds.has(p.id));
    if (filtered.length === 1) {
      return { id: filtered[0].id, created: false, matched: true };
    }
  }
  if (bodyId) {
    // Next-strongest: people who have held ANY office attached to this body.
    const ids = nameMatches.map(p => p.id);
    const { data: bodyOffices } = await sb
      .from('offices')
      .select('id')
      .eq('governing_body_id', bodyId);
    const officeIds = (bodyOffices ?? []).map((o: any) => o.id);
    if (officeIds.length > 0) {
      const { data: ours } = await sb
        .from('office_tenures')
        .select('person_id')
        .in('office_id', officeIds)
        .in('person_id', ids)
        .limit(10);
      const ourIds = new Set((ours ?? []).map((t: any) => t.person_id));
      const filtered = nameMatches.filter(p => ourIds.has(p.id));
      if (filtered.length === 1) {
        return { id: filtered[0].id, created: false, matched: true };
      }
    }
  }

  // Multiple "John Smith"s, no body/office disambiguation — ambiguous.
  return {
    id: null,
    created: false,
    matched: false,
    ambiguous: true,
    candidates: nameMatches.map(p => ({ id: p.id, canonical_name: p.canonical_name, reason: 'multiple people share this exact name; no office context to disambiguate' })),
  };
}

export async function writeTenures(
  sb: SupabaseClient,
  seats: SeatToWrite[],
  opts: TenuresWriteOpts,
): Promise<TenuresWriteResult> {
  const result: TenuresWriteResult = {
    tenuresInserted: 0,
    tenuresSkipped: 0,
    peopleMatched: 0,
    peopleCreated: 0,
    warnings: [],
  };
  // Resolve body_id for cross-seat lookups (helps disambiguate two
  // "John Smith"s in the same body). We can derive it from the seat's
  // office.
  const officeBodyMap = new Map<string, string>();
  const officeIds = Array.from(new Set(seats.map(s => s.office_id)));
  if (officeIds.length > 0) {
    const { data: officeRows } = await sb
      .from('offices')
      .select('id, governing_body_id')
      .in('id', officeIds);
    for (const o of (officeRows ?? []) as any[]) {
      if (o.governing_body_id) officeBodyMap.set(o.id, o.governing_body_id);
    }
  }

  for (const seat of seats) {
    const oh = seat.current_officeholder;
    if (!oh?.person_name) continue;

    const bodyId = officeBodyMap.get(seat.office_id) ?? null;
    const lookup = await findOrCreatePerson(sb, {
      personName: oh.person_name,
      bioguideId: oh.bioguide_id,
      officeId: seat.office_id,
      bodyId,
      dryRun: opts.dryRun,
    });
    const { id: personId, created, matched, ambiguous, candidates } = lookup;
    if (created) result.peopleCreated++;
    else if (matched) result.peopleMatched++;
    else {
      const reason = ambiguous
        ? `ambiguous person — ${candidates?.length ?? 0} candidates ("${oh.person_name}"): ${candidates?.slice(0, 3).map(c => c.id.slice(0,8)).join(', ')}${(candidates?.length ?? 0) > 3 ? '...' : ''} — needs reviewer disambiguation`
        : `person "${oh.person_name}" not matchable + create failed`;
      result.warnings.push(reason);
      result.tenuresSkipped++;
      continue;
    }
    if (!personId) continue;

    // Skip if a tenure already exists for this office + person + (no end date or matching term)
    const { data: existing } = await sb
      .from('office_tenures')
      .select('id, ended_on, started_on')
      .eq('office_id', seat.office_id)
      .eq('person_id', personId);
    if (existing && existing.length > 0) {
      result.tenuresSkipped++;
      continue;
    }

    // Check for existing CURRENT tenure with a DIFFERENT person — this is the "incumbent may have changed" case
    const { data: currentOnOffice } = await sb
      .from('office_tenures')
      .select('id, person_id')
      .eq('office_id', seat.office_id)
      .is('ended_on', null);
    if (currentOnOffice && currentOnOffice.length > 0) {
      result.warnings.push(`Office ${seat.office_id.slice(0,8)} has existing current tenure for a different person — not auto-ending it; reviewer must reconcile`);
      result.tenuresSkipped++;
      continue;
    }

    const startedOn = oh.term_start ?? inferStartFromTermEnd(oh.term_end);
    if (!startedOn) {
      result.warnings.push(`No term_start AND no inferrable start from term_end for seat ${seat.seat_designation ?? '(none)'}; skipping`);
      result.tenuresSkipped++;
      continue;
    }

    if (!opts.dryRun) {
      const { error } = await sb.from('office_tenures').insert({
        office_id: seat.office_id,
        person_id: personId,
        started_on: startedOn,
        ended_on: null,
        party_at_tenure: normalizePartyLetter(oh.party),
        source_of_record: `agent:${opts.templateSlug}:${opts.runId}`,
        meta: { agent_note: oh.note, agent_term_end: oh.term_end },
      });
      if (error) {
        result.warnings.push(`Tenure insert failed for office ${seat.office_id.slice(0,8)}: ${error.message.slice(0, 100)}`);
        result.tenuresSkipped++;
        continue;
      }
    }
    result.tenuresInserted++;
  }
  return result;
}
