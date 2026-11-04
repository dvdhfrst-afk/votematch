/**
 * enrich/fec.ts -- FEC (Federal Election Commission) campaign-finance wrapper.
 *
 * Strong-id source: bound by fec_candidate_id (kind 'fec_candidate_id' in
 * person_xref). AUTO-BIND: verified=true, bind_confidence=1.0.
 *
 * Endpoints (api.open.fec.gov/v1, the official OpenFEC API):
 *   GET /candidate/{candidate_id}/                -> candidate summary record
 *   GET /candidate/{candidate_id}/totals/         -> per-cycle financial totals
 *
 * Key: env FEC_API_KEY, fallback DEMO_KEY (rate-limited but functional). The
 * key is a query parameter (?api_key=...), not a header.
 *
 * Produces ONE candidate_records row of record_type='campaign_finance' whose
 * payload bundles the candidate summary + the most-recent cycle's totals (plus
 * a compact per-cycle history). external_ref = the FEC candidate id.
 */

import {
  fetchJson,
  strongIdRow,
  type CandidateRecordRow,
  type EnrichContext,
} from './types';

const FEC_BASE = 'https://api.open.fec.gov/v1';

function apiKey(): string {
  return process.env.FEC_API_KEY && process.env.FEC_API_KEY.trim()
    ? process.env.FEC_API_KEY.trim()
    : 'DEMO_KEY';
}

/** Minimal shapes for the fields we read; the full record goes into payload. */
interface FecListResponse<T> {
  results?: T[];
  pagination?: { count?: number; pages?: number };
}

export interface FecCandidate {
  candidate_id?: string;
  name?: string;
  party_full?: string;
  party?: string;
  office_full?: string;
  office?: string;
  state?: string;
  district?: string;
  incumbent_challenge_full?: string;
  election_years?: number[];
  cycles?: number[];
}

export interface FecTotals {
  cycle?: number;
  receipts?: number;
  disbursements?: number;
  cash_on_hand_end_period?: number;
  debts_owed_by_committee?: number;
  individual_itemized_contributions?: number;
  individual_unitemized_contributions?: number;
  candidate_contribution?: number;
  coverage_start_date?: string;
  coverage_end_date?: string;
  last_report_type_full?: string;
}

/**
 * normalizeFec: PURE. Map a candidate summary + totals list into the single
 * campaign_finance candidate_records row. Exported for the offline test.
 *
 * Returns [] when there is neither a candidate record nor any totals (so a
 * candidate id with no FEC data produces no row rather than an empty one).
 */
export function normalizeFec(
  fecCandidateId: string,
  candidate: FecCandidate | null,
  totals: FecTotals[],
  ctx: EnrichContext,
  fetchedAt?: string,
): CandidateRecordRow[] {
  if (!candidate && (!totals || totals.length === 0)) return [];

  // Newest cycle first.
  const sorted = [...(totals ?? [])].sort((a, b) => (b.cycle ?? 0) - (a.cycle ?? 0));
  const latest = sorted[0] ?? null;

  const payload: Record<string, unknown> = {
    candidate: candidate ?? null,
    latest_cycle: latest?.cycle ?? null,
    latest_totals: latest
      ? {
          cycle: latest.cycle ?? null,
          receipts: latest.receipts ?? null,
          disbursements: latest.disbursements ?? null,
          cash_on_hand_end_period: latest.cash_on_hand_end_period ?? null,
          debts_owed_by_committee: latest.debts_owed_by_committee ?? null,
          individual_itemized_contributions:
            latest.individual_itemized_contributions ?? null,
          individual_unitemized_contributions:
            latest.individual_unitemized_contributions ?? null,
          candidate_contribution: latest.candidate_contribution ?? null,
          coverage_start_date: latest.coverage_start_date ?? null,
          coverage_end_date: latest.coverage_end_date ?? null,
          last_report_type_full: latest.last_report_type_full ?? null,
        }
      : null,
    // Compact per-cycle history so a dashboard can show a trend without a refetch.
    cycle_history: sorted.map((t) => ({
      cycle: t.cycle ?? null,
      receipts: t.receipts ?? null,
      disbursements: t.disbursements ?? null,
      cash_on_hand_end_period: t.cash_on_hand_end_period ?? null,
    })),
  };

  return [
    strongIdRow({
      person_id: ctx.person_id,
      record_type: 'campaign_finance',
      source: 'fec',
      source_url: `https://www.fec.gov/data/candidate/${fecCandidateId}/`,
      external_ref: fecCandidateId,
      payload,
      id_kind: 'fec_candidate_id',
      fetched_at: fetchedAt,
    }),
  ];
}

/**
 * fetchFec: live fetch + normalize. Strong-id bound by fec_candidate_id.
 * Network failures bubble up to enrichPerson, which records them per-source.
 */
export async function fetchFec(
  fecCandidateId: string,
  ctx: EnrichContext,
): Promise<CandidateRecordRow[]> {
  const key = apiKey();

  // Candidate summary. A 404 here means the id is unknown -> treat as no data.
  let candidate: FecCandidate | null = null;
  try {
    const candRes = await fetchJson<FecListResponse<FecCandidate>>(
      `${FEC_BASE}/candidate/${encodeURIComponent(fecCandidateId)}/?api_key=${encodeURIComponent(key)}`,
    );
    candidate = candRes.results?.[0] ?? null;
  } catch (e) {
    // 404 = unknown candidate id; rethrow anything else so the dispatcher logs it.
    if (!(e instanceof Error && /HTTP 404/.test(e.message))) throw e;
  }

  // Per-cycle totals.
  let totals: FecTotals[] = [];
  try {
    const totRes = await fetchJson<FecListResponse<FecTotals>>(
      `${FEC_BASE}/candidate/${encodeURIComponent(fecCandidateId)}/totals/?api_key=${encodeURIComponent(key)}&sort=-cycle&per_page=20`,
    );
    totals = totRes.results ?? [];
  } catch (e) {
    if (!(e instanceof Error && /HTTP 404/.test(e.message))) throw e;
  }

  return normalizeFec(fecCandidateId, candidate, totals, ctx);
}
