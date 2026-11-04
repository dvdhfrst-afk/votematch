/**
 * Resolve election_results rows that have candidacy_id IS NULL.
 *
 * SoS results adapters write `election_results` rows with `reported_name`
 * + `party_abbreviation`, but they don't always resolve to a specific
 * candidacy.id when the reported name doesn't trivially match a person's
 * canonical_name (e.g. "Smith, Jane M." vs "Jane Smith").  This service
 * fixes that gap: for each unmatched row, find candidacies in the SAME
 * election, normalize the names, and pick the unique match.
 *
 * Pair this with updateCandidacyStatusesFromResults — once results are
 * resolved to candidacy_id, the status-flip pipeline can do its job.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type ResolveOutcome = {
  examined: number;
  resolved: number;
  ambiguous: number;     // multiple candidacy matches, couldn't break tie
  noMatch: number;       // zero candidacy matches
  noCandidates: number;  // no candidacies exist for the election yet
  errors: Array<{ result_id: string; error: string }>;
};

// ────────────────────────────────────────────────────────────────────────────
// Name normalization
// ────────────────────────────────────────────────────────────────────────────

// Strip suffixes (Jr., Sr., II, III, IV, MD, PhD, Esq.)
const SUFFIX_RE = /\b(jr|sr|ii|iii|iv|v|md|phd|esq)\.?$/i;

function normalizeName(raw: string | null | undefined): string {
  if (!raw) return "";
  let n = raw.trim().toLowerCase();
  // "Last, First M." → "First M. Last"
  if (n.includes(",")) {
    const parts = n.split(",").map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      // Take the first two segments only ("Smith, Jane, Inc." is weird; ignore tail)
      n = `${parts[1]} ${parts[0]}`;
    }
  }
  // Strip punctuation (apostrophes, periods, commas, quotes)
  n = n.replace(/[.,'"`’]/g, "");
  // Collapse whitespace + strip suffix tokens
  const toks = n.split(/\s+/).filter((t) => t && !SUFFIX_RE.test(t));
  return toks.join(" ");
}

function tokenSet(s: string): Set<string> {
  // Skip single-letter tokens (middle initials) — they don't carry signal
  return new Set(s.split(/\s+/).filter((t) => t.length > 1));
}

function namesLikelyMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const aT = tokenSet(a);
  const bT = tokenSet(b);
  if (aT.size === 0 || bT.size === 0) return false;
  // One is a subset of the other → match (handles "Jane Smith" ⊂ "Jane Marie Smith")
  let aInB = 0;
  for (const t of aT) if (bT.has(t)) aInB++;
  let bInA = 0;
  for (const t of bT) if (aT.has(t)) bInA++;
  return aInB === aT.size || bInA === bT.size;
}

function partiesAgree(
  reportedAbbr: string | null | undefined,
  candidacyParty: string | null | undefined,
): boolean {
  if (!reportedAbbr || !candidacyParty) return false;
  const a = reportedAbbr.trim().toLowerCase();
  const b = candidacyParty.trim().toLowerCase();
  if (!a || !b) return false;
  // Match on first character (D=Democratic=Dem; R=Republican=Rep; etc.).
  // Conservative: only useful as a tiebreaker.
  return a.charAt(0) === b.charAt(0);
}

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

export async function resolveResultCandidacies(
  supabase: SupabaseClient,
  opts: { dryRun?: boolean; electionId?: string } = {},
): Promise<ResolveOutcome> {
  const out: ResolveOutcome = {
    examined: 0,
    resolved: 0,
    ambiguous: 0,
    noMatch: 0,
    noCandidates: 0,
    errors: [],
  };

  // ── 1. Fetch unmatched election_results
  let q = supabase
    .from("election_results")
    .select("id, election_id, reported_name, party_abbreviation")
    .is("candidacy_id", null);
  if (opts.electionId) q = q.eq("election_id", opts.electionId);
  // .order('id') so the 10K cap is deterministic across calls. If unmatched
  // exceeds 10K, the remainder will be picked up on subsequent runs (since
  // matched ones drop out of the `is null` filter).
  const { data: unmatched, error } = await q.order('id').range(0, 9999);
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) return out;
    throw error;
  }
  out.examined = (unmatched ?? []).length;
  if (out.examined === 0) return out;

  // ── 2. Fetch candidacies (+ people) for every election in scope
  const electionIds = [...new Set((unmatched ?? []).map((r: any) => r.election_id))];
  type Cand = {
    id: string;
    election_id: string;
    person_id: string | null;
    party: string | null;
    person: { id: string; canonical_name: string } | null;
  };
  const candsByElection = new Map<string, Cand[]>();
  const BATCH = 100;
  for (let i = 0; i < electionIds.length; i += BATCH) {
    const slice = electionIds.slice(i, i + BATCH);
    const { data, error: cErr } = await supabase
      .from("candidacies")
      .select("id, election_id, person_id, party, person:people(id, canonical_name)")
      .in("election_id", slice);
    if (cErr) throw cErr;
    for (const c of (data as unknown as Cand[]) ?? []) {
      const arr = candsByElection.get(c.election_id) ?? [];
      arr.push(c);
      candsByElection.set(c.election_id, arr);
    }
  }

  // ── 3. Resolve each unmatched result
  for (const r of (unmatched ?? []) as Array<{
    id: string;
    election_id: string;
    reported_name: string;
    party_abbreviation: string | null;
  }>) {
    const cands = candsByElection.get(r.election_id) ?? [];
    if (cands.length === 0) {
      out.noCandidates++;
      continue;
    }
    const reportedNorm = normalizeName(r.reported_name);
    if (!reportedNorm) {
      out.noMatch++;
      continue;
    }

    // Find name matches
    const nameMatches: Cand[] = [];
    for (const c of cands) {
      const candNorm = normalizeName(c.person?.canonical_name);
      if (!candNorm) continue;
      if (namesLikelyMatch(reportedNorm, candNorm)) nameMatches.push(c);
    }

    let chosen: Cand | null = null;
    if (nameMatches.length === 1) {
      chosen = nameMatches[0];
    } else if (nameMatches.length > 1) {
      // Party tiebreak: prefer the candidacy whose party matches the result.
      const partyMatches = nameMatches.filter((c) =>
        partiesAgree(r.party_abbreviation, c.party),
      );
      if (partyMatches.length === 1) chosen = partyMatches[0];
    }

    if (chosen) {
      if (!opts.dryRun) {
        const { error: uErr } = await supabase
          .from("election_results")
          .update({
            candidacy_id: chosen.id,
            person_id: chosen.person_id,
          })
          .eq("id", r.id);
        if (uErr) {
          out.errors.push({ result_id: r.id, error: uErr.message });
          continue;
        }
      }
      out.resolved++;
    } else if (nameMatches.length > 1) {
      out.ambiguous++;
    } else {
      out.noMatch++;
    }
  }

  return out;
}
