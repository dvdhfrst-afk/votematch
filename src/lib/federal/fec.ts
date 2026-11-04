/**
 * FEC OpenFEC API wrapper — bulk ingestion for retention digest.
 *
 * API docs: https://api.open.fec.gov/developers/
 * We specifically want:
 *   - Recent filings for candidates we're tracking (followed federal members)
 *   - Large contributions above a threshold
 *   - Independent expenditures affecting tracked candidates
 */

import { createServiceClient } from '@/lib/supabase/server';

const BASE = 'https://api.open.fec.gov/v1';

function apiKey(): string {
  const k = process.env.FEC_API_KEY;
  if (!k) throw new Error('FEC_API_KEY is required for FEC ingestion');
  return k;
}

async function api<T>(
  path: string,
  params: Record<string, string | number | string[]> = {},
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('api_key', apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, String(item));
    } else {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`FEC ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export type FecCandidate = {
  candidate_id: string;
  name: string;
  party?: string;
  state?: string;
  district?: string | number;
  office?: string;       // 'H' | 'S' | 'P'
  office_full?: string;  // 'House', 'Senate', 'President'
};

export type FecOffice = 'H' | 'S' | 'P';

export type FecMatchContext = {
  /** 2-char USPS state (e.g., 'CA'). We accept FIPS-2 or USPS here; FEC uses USPS. */
  stateFips?: string;
  office?: FecOffice;
  /** Party code as FEC returns it (DEM, REP, IND, etc.) */
  party?: string;
  /** Optional BB person id so staging rows can be attached for admin resolution. */
  bbPersonId?: string;
  /** Optional BB candidacy id for the same reason. */
  bbCandidacyId?: string;
};

/**
 * Map FEC 2-char USPS state code to the same 2-char code we use internally.
 * FEC returns USPS (CA, NY); internally we also use 2-char USPS abbreviations.
 * If in the future we switch to FIPS-2 numeric, this is the single seam.
 */
export function normalizeFecState(fecState: string): string {
  return fecState.trim().toUpperCase().slice(0, 2);
}

/**
 * Map FEC single-letter office code to BB internal office_type slug.
 */
export function normalizeFecOffice(
  office: FecOffice,
): 'us_house' | 'us_senate' | 'us_president' {
  switch (office) {
    case 'H':
      return 'us_house';
    case 'S':
      return 'us_senate';
    case 'P':
      return 'us_president';
  }
}

function fieldMatches(candidate: FecCandidate, ctx: FecMatchContext): number {
  let matched = 0;
  if (ctx.stateFips && candidate.state) {
    if (normalizeFecState(candidate.state) === normalizeFecState(ctx.stateFips)) matched++;
  }
  if (ctx.office && candidate.office) {
    if (candidate.office.toUpperCase() === ctx.office) matched++;
  }
  if (ctx.party && candidate.party) {
    if (candidate.party.toUpperCase() === ctx.party.toUpperCase()) matched++;
  }
  return matched;
}

async function stageAmbiguousMatch(
  queriedName: string,
  candidates: FecCandidate[],
  ctx: FecMatchContext | undefined,
): Promise<void> {
  try {
    const supabase = await createServiceClient();
    const row: Record<string, unknown> = {
      queried_name: queriedName,
      queried_state: ctx?.stateFips ? normalizeFecState(ctx.stateFips) : null,
      queried_office: ctx?.office ? normalizeFecOffice(ctx.office) : null,
      candidate_matches: candidates.slice(0, 5),
    };
    if (ctx?.bbPersonId) row.bb_person_id = ctx.bbPersonId;
    if (ctx?.bbCandidacyId) row.bb_candidacy_id = ctx.bbCandidacyId;
    await supabase.from('fec_match_ambiguous').insert(row);
  } catch {
    // Best-effort: don't break ingestion if staging insert fails. Upstream
    // caller already logs; admin queue will simply not see this ambiguity until
    // the next run.
  }
}

/**
 * Find FEC candidate record by name with multi-field corroboration.
 *
 * Behavior:
 *   - 0 results → null (nothing to do).
 *   - 1 result AND ≥2 of (state, office, party) corroborate → return it.
 *   - >1 result but exactly one survives corroboration filter → return it.
 *   - Otherwise → stage to `fec_match_ambiguous` and return null.
 *
 * When ctx is omitted (backward-compat callers), we cannot corroborate, so ANY
 * multi-result response is considered ambiguous and staged. Single-result
 * responses without corroboration are also staged — a single name hit is not
 * enough to attach filings to a real person.
 */
export async function findFecCandidateByName(
  name: string,
  ctx?: FecMatchContext,
): Promise<FecCandidate | null> {
  const params: Record<string, string | number | string[]> = {
    q: name,
    per_page: 5,
  };
  // Pass FEC-native filters when we have context. This narrows API-side so we
  // don't have to rely purely on client-side filtering of top 5.
  if (ctx?.stateFips) params.state = normalizeFecState(ctx.stateFips);
  if (ctx?.office) params.office = ctx.office;
  if (ctx?.party) params.party = ctx.party.toUpperCase();

  const result = await api<{ results: FecCandidate[] }>('/candidates/search/', params);
  const candidates = result.results ?? [];

  if (candidates.length === 0) return null;

  // Without context, we cannot corroborate. Stage and bail (no first-hit-wins).
  if (!ctx || (!ctx.stateFips && !ctx.office && !ctx.party)) {
    await stageAmbiguousMatch(name, candidates, ctx);
    return null;
  }

  const providedFields =
    (ctx.stateFips ? 1 : 0) + (ctx.office ? 1 : 0) + (ctx.party ? 1 : 0);

  // Single result: require ≥2 corroborating fields. If caller only provided
  // 1 field (e.g., state only), we can't reach 2 — treat as ambiguous.
  if (candidates.length === 1) {
    const matched = fieldMatches(candidates[0], ctx);
    if (matched >= 2) return candidates[0];
    if (providedFields >= 2) {
      // We had enough to check but it didn't corroborate → ambiguous/wrong match.
      await stageAmbiguousMatch(name, candidates, ctx);
      return null;
    }
    // Only 1 context field available; can't confirm 2 matches — stage.
    await stageAmbiguousMatch(name, candidates, ctx);
    return null;
  }

  // Multiple results: filter by all provided context fields (exact match on each).
  const filtered = candidates.filter((c) => fieldMatches(c, ctx) === providedFields);
  if (filtered.length === 1) return filtered[0];

  // 0 or >1 survived the filter → ambiguous.
  await stageAmbiguousMatch(name, candidates, ctx);
  return null;
}

export type FecFiling = {
  beginning_image_number?: string;
  fec_file_id?: string;
  form_type?: string;
  filer_committee_id_number?: string;
  committee_id?: string;
  receipt_date?: string;
  total_receipts?: number;
  total_disbursements?: number;
  cash_on_hand_end_period?: number;
  document_description?: string;
  pdf_url?: string;
  report_year?: number;
};

/**
 * Recent filings for a candidate since a given date.
 */
export async function fetchRecentFilings(
  candidateId: string,
  sinceDate?: string,
): Promise<FecFiling[]> {
  const params: Record<string, string | number> = {
    per_page: 100,
    sort: '-receipt_date',
    candidate_id: candidateId,
  };
  if (sinceDate) params.min_receipt_date = sinceDate;

  const data = await api<{ results: FecFiling[] }>('/filings/', params);
  return data.results ?? [];
}

export type FecLargeContribution = {
  contributor_name?: string;
  contribution_receipt_amount?: number;
  contribution_receipt_date?: string;
  committee?: { name?: string; committee_id?: string };
  candidate?: { name?: string; candidate_id?: string };
};

/**
 * Recent large individual contributions to a candidate's principal committee.
 */
export async function fetchLargeContributions(
  candidateId: string,
  opts: { minAmount?: number; sinceDate?: string } = {},
): Promise<FecLargeContribution[]> {
  const params: Record<string, string | number> = {
    per_page: 100,
    sort: '-contribution_receipt_date',
    candidate_id: candidateId,
    min_amount: opts.minAmount ?? 2500,
  };
  if (opts.sinceDate) params.min_date = opts.sinceDate;

  const data = await api<{ results: FecLargeContribution[] }>(
    '/schedules/schedule_a/by_contributor/',
    params,
  );
  return data.results ?? [];
}
