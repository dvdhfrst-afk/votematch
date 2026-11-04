/**
 * parsers/finance.ts -- Build 5 campaign-finance bulk SourceParser
 * (source_type='finance_bulk') on the Phase 0 source-centric harvest runner.
 *
 * WHAT IT PRODUCES (a COARSE, clearly-INFERRED ideological signal):
 *   For each person in the source's race ROSTER who carries a strong
 *   fec_candidate_id (person_xref kind 'fec_candidate_id'), this parser pulls the
 *   candidate's federal campaign-finance picture from the EXISTING FEC (Federal
 *   Election Commission) wrapper (src/lib/enrich/fec.ts -- fetchFec, REUSED, not
 *   reimplemented) plus a small additional OpenFEC committee call for the
 *   individual-vs-PAC (political action committee) split and the largest
 *   contributors, and emits ONE ParsedUnit per candidate:
 *     - strongId = { kind:'fec_candidate_id', external_id }  (deterministic bind
 *       via person_xref; the runner resolves it, NOT a name guess)
 *     - locus    = { source, cycle, kind:'fec' }
 *     - content  = a human-readable donor / PAC profile summary (total raised,
 *       individual-vs-PAC split, top donors / committees)
 *     - source_family = 'finance'
 *     - signal_view   = 'inferred'  (a third-party READ of who funds the
 *       candidate, never the candidate's own words)
 *     - extra = { totals, top_donors, pac_share, individual_share, cycle, ... }
 *
 * WHY INFERRED + GATED. Funding composition (PAC-heavy vs small-dollar, which
 * industries / committees give) is at best a COARSE proxy for positioning. It is
 * tagged signal_view='inferred' so the downstream signal gate treats it as a
 * third-party inference, never as a stated position, and the bind_confidence on a
 * strong-id resolution does not promote the *interpretation* -- only the
 * attribution -- to verified. Per-axis use of this evidence waits on the
 * multivariable schema (doc 13 Build 5 / "what is gated").
 *
 * STATE FINANCE (honest status). State campaign-finance portals are
 * heterogeneous: different APIs / bulk formats / terms per state, and many
 * disallow automated bulk pulls. This parser carries a STATE-PORTAL REGISTRY
 * (STATE_FINANCE_PORTALS) that is intentionally EMPTY by default -- so no state
 * data is fabricated. When a state portal IS configured (a fetcher that returns
 * normalized contributor records under terms that permit our use), the parser
 * emits candidateMention-keyed units that the runner resolves against the race
 * ROSTER (never a national namesake). Until a portal is wired, the parser simply
 * reports "no state portal configured for FIPS XX" and emits nothing for state.
 *
 * COMPLIANCE: FEC is a public / primary federal source (OpenFEC API, the same
 * one enrich/fec.ts already uses). State finance is pulled ONLY where a portal is
 * explicitly configured under permissive terms. No aggregator, no scraping of a
 * source whose terms forbid it.
 *
 * Single TypeScript runtime, no Python, no new npm deps: native fetch via the
 * shared fetchJson helper (enrich/types.ts), the existing fetchFec wrapper, and
 * the QueryClient the runner already passes in.
 */

import type {
  SourceParser,
  ParsedUnit,
  HarvestSource,
  ParserDeps,
} from '../source-harvest-runner';
import type { QueryClient } from '../../identity-resolve';
import { loadRosterForSource, type RosterEntry } from '../race-roster';
import { fetchFec, type FecTotals, type FecCandidate } from '../../../enrich/fec';
import { fetchJson } from '../../../enrich/types';
import type { CandidateRecordRow } from '../../../enrich/types';

const FEC_BASE = 'https://api.open.fec.gov/v1';

function fecApiKey(): string {
  return process.env.FEC_API_KEY && process.env.FEC_API_KEY.trim()
    ? process.env.FEC_API_KEY.trim()
    : 'DEMO_KEY';
}

// ---------------------------------------------------------------------------
// Money formatting + profile summary (PURE; exported for the offline test).
// ---------------------------------------------------------------------------

/** Format a dollar amount as "$1,234,567" (whole dollars). Null -> "unknown". */
export function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'unknown';
  const rounded = Math.round(n);
  return '$' + rounded.toLocaleString('en-US');
}

/** A single largest-contributor / committee line for the donor profile. */
export interface TopDonor {
  name: string;
  amount: number;
  /** 'individual' or 'committee' (PAC / party / other-committee). */
  kind: 'individual' | 'committee';
}

/** The structured donor / PAC profile that becomes ParsedUnit.extra. */
export interface DonorProfile {
  cycle: number | null;
  total_receipts: number | null;
  individual_contributions: number | null;
  pac_contributions: number | null;
  /** individual_contributions / (individual + pac), in [0,1] or null. */
  individual_share: number | null;
  /** pac_contributions / (individual + pac), in [0,1] or null. */
  pac_share: number | null;
  top_donors: TopDonor[];
  source: 'fec' | string;
}

/**
 * buildDonorProfile -- PURE. Combine the FEC per-cycle totals with an optional
 * committee-level individual/PAC breakdown + top-donor list into a DonorProfile.
 *
 * Exported so the offline test can assert the profile shape + share math from a
 * fixture without any network. The FEC totals model splits individual into
 * itemized + unitemized; "PAC" here is the other-political-committee contribution
 * line (so the individual-vs-PAC ratio is the small-dollar-vs-organized read).
 */
export function buildDonorProfile(
  latest: FecTotals | null,
  committeeBreakdown: {
    individual?: number | null;
    pac?: number | null;
    top_donors?: TopDonor[];
  } | null,
): DonorProfile {
  const cycle = latest?.cycle ?? null;
  const total = latest?.receipts ?? null;

  // Prefer an explicit committee-level breakdown when present; otherwise derive
  // the individual figure from the candidate totals (itemized + unitemized) and
  // leave PAC null (candidate totals do not carry the other-committee line).
  const individualFromTotals =
    latest &&
    (latest.individual_itemized_contributions != null ||
      latest.individual_unitemized_contributions != null)
      ? (latest.individual_itemized_contributions ?? 0) +
        (latest.individual_unitemized_contributions ?? 0)
      : null;

  const individual =
    committeeBreakdown?.individual != null
      ? committeeBreakdown.individual
      : individualFromTotals;
  const pac = committeeBreakdown?.pac ?? null;

  let individualShare: number | null = null;
  let pacShare: number | null = null;
  if (individual != null && pac != null && individual + pac > 0) {
    const denom = individual + pac;
    individualShare = individual / denom;
    pacShare = pac / denom;
  }

  const topDonors = (committeeBreakdown?.top_donors ?? [])
    .filter((d) => d && typeof d.name === 'string' && Number.isFinite(d.amount))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  return {
    cycle,
    total_receipts: total,
    individual_contributions: individual,
    pac_contributions: pac,
    individual_share: individualShare,
    pac_share: pacShare,
    top_donors: topDonors,
    source: 'fec',
  };
}

/**
 * donorProfileSummary -- PURE. Render the DonorProfile as the extracted_text
 * (content) of the ParsedUnit: a compact, factual donor/PAC paragraph. No
 * interpretation of meaning here -- just the funding facts. The classifier
 * (later, gated) turns this into an inferred axis read.
 */
export function donorProfileSummary(name: string, profile: DonorProfile): string {
  const lines: string[] = [];
  const cycleStr = profile.cycle != null ? ` (${profile.cycle} cycle)` : '';
  lines.push(`Campaign-finance profile for ${name}${cycleStr}, from FEC filings.`);
  lines.push(`Total receipts: ${fmtMoney(profile.total_receipts)}.`);

  if (profile.individual_contributions != null || profile.pac_contributions != null) {
    const ind = fmtMoney(profile.individual_contributions);
    const pac = fmtMoney(profile.pac_contributions);
    lines.push(`Individual contributions: ${ind}. PAC / committee contributions: ${pac}.`);
  }
  if (profile.individual_share != null && profile.pac_share != null) {
    const indPct = Math.round(profile.individual_share * 100);
    const pacPct = Math.round(profile.pac_share * 100);
    lines.push(
      `Funding mix: ${indPct}% individual, ${pacPct}% PAC/committee ` +
        `(coarse small-dollar vs organized-money read).`,
    );
  }
  if (profile.top_donors.length > 0) {
    const donorLines = profile.top_donors
      .slice(0, 8)
      .map((d) => `  - ${d.name} (${d.kind}): ${fmtMoney(d.amount)}`);
    lines.push(`Largest contributors / committees:`);
    lines.push(...donorLines);
  }
  lines.push(
    `This is an INFERRED, coarse funding-composition signal (a third-party read ` +
      `of who funds the campaign), not the candidate's stated position.`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Optional committee-level breakdown (individual vs PAC + top contributors).
// Reuses the shared fetchJson http primitive; OpenFEC is the same public API
// the enrich/fec.ts wrapper already hits. Best-effort: any failure degrades to
// "candidate totals only" rather than throwing.
// ---------------------------------------------------------------------------

interface FecCommitteeTotals {
  committee_id?: string;
  individual_contributions?: number;
  other_political_committee_contributions?: number;
  political_party_committee_contributions?: number;
  cycle?: number;
}

interface FecScheduleAByContributor {
  contributor_name?: string;
  total?: number;
}

interface FecListResponse<T> {
  results?: T[];
}

/**
 * fetchCommitteeBreakdown -- pull the principal-campaign-committee level
 * individual-vs-PAC split + top individual contributors for a candidate's
 * committees in a cycle. Best-effort and TOTAL (never throws): on any error it
 * returns null and the profile falls back to candidate-totals-only.
 *
 * Endpoints (OpenFEC, public):
 *   GET /candidate/{id}/committees/         -> committee ids
 *   GET /committee/{cid}/totals/            -> individual + other-committee lines
 *   GET /schedule/schedule_a/by_contributor/?committee_id=...  -> top donors
 *
 * Injectable via deps.fetchJsonImpl for the offline test (so no network runs).
 */
async function fetchCommitteeBreakdown(
  fecCandidateId: string,
  cycle: number | null,
  fetchJsonImpl: typeof fetchJson,
): Promise<{ individual: number | null; pac: number | null; top_donors: TopDonor[] } | null> {
  const key = fecApiKey();
  const cycleQ = cycle != null ? `&cycle=${cycle}` : '';
  try {
    const committees = await fetchJsonImpl<FecListResponse<{ committee_id?: string }>>(
      `${FEC_BASE}/candidate/${encodeURIComponent(fecCandidateId)}/committees/` +
        `?api_key=${encodeURIComponent(key)}&per_page=20`,
    );
    const committeeIds = (committees.results ?? [])
      .map((c) => c.committee_id)
      .filter((c): c is string => typeof c === 'string' && c.length > 0)
      .slice(0, 5);
    if (committeeIds.length === 0) return null;

    let individual = 0;
    let pac = 0;
    let sawAny = false;
    const donorTally = new Map<string, number>();

    for (const cid of committeeIds) {
      // Committee totals -> individual + other-committee (PAC) contribution lines.
      try {
        const tot = await fetchJsonImpl<FecListResponse<FecCommitteeTotals>>(
          `${FEC_BASE}/committee/${encodeURIComponent(cid)}/totals/` +
            `?api_key=${encodeURIComponent(key)}${cycleQ}&per_page=1&sort=-cycle`,
        );
        const t = tot.results?.[0];
        if (t) {
          sawAny = true;
          individual += t.individual_contributions ?? 0;
          pac +=
            (t.other_political_committee_contributions ?? 0) +
            (t.political_party_committee_contributions ?? 0);
        }
      } catch {
        /* skip this committee's totals */
      }
      // Top individual contributors (schedule A aggregated by contributor).
      try {
        const sched = await fetchJsonImpl<FecListResponse<FecScheduleAByContributor>>(
          `${FEC_BASE}/schedule/schedule_a/by_contributor/` +
            `?api_key=${encodeURIComponent(key)}&committee_id=${encodeURIComponent(cid)}` +
            `${cycleQ}&per_page=20&sort=-total`,
        );
        for (const row of sched.results ?? []) {
          if (row.contributor_name && Number.isFinite(row.total)) {
            const prev = donorTally.get(row.contributor_name) ?? 0;
            donorTally.set(row.contributor_name, prev + (row.total ?? 0));
          }
        }
      } catch {
        /* skip this committee's schedule A */
      }
    }

    if (!sawAny && donorTally.size === 0) return null;

    const top_donors: TopDonor[] = Array.from(donorTally.entries())
      .map(([name, amount]) => ({ name, amount, kind: 'individual' as const }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);

    return {
      individual: sawAny ? individual : null,
      pac: sawAny ? pac : null,
      top_donors,
    };
  } catch {
    return null; // candidate/committees call failed -> totals-only fallback
  }
}

// ---------------------------------------------------------------------------
// State campaign-finance portal registry (intentionally empty -- see header).
// ---------------------------------------------------------------------------

/** Normalized contributor record a configured state portal must return. */
export interface StateContributorRecord {
  /** The candidate's name as it appears on the state filing (resolved vs roster). */
  candidate_name: string;
  total_receipts: number | null;
  individual_contributions: number | null;
  pac_contributions: number | null;
  top_donors: TopDonor[];
  /** The state portal's own public URL for this candidate's finance record. */
  source_url: string | null;
}

/** A configured state-finance fetcher. Returns records for the source's scope. */
export type StateFinanceFetcher = (
  source: HarvestSource,
) => Promise<StateContributorRecord[]>;

/**
 * STATE_FINANCE_PORTALS: FIPS state code -> fetcher. EMPTY by default: no state
 * is wired, so the parser fabricates NO state finance data. Wire a state here
 * ONLY with a fetcher that pulls under terms permitting our use (an official
 * bulk export or API). Until then, state finance is reported as "not configured".
 */
export const STATE_FINANCE_PORTALS: Record<string, StateFinanceFetcher> = {};

// ---------------------------------------------------------------------------
// person_xref lookup -- the fec_candidate_id strong id for a roster person.
// ---------------------------------------------------------------------------

async function fecIdForPerson(
  client: QueryClient,
  personId: string,
): Promise<string | null> {
  const res = await client.query<{ external_id: string }>(
    `select external_id from person_xref
      where person_id = $1 and kind = 'fec_candidate_id' limit 1`,
    [personId],
  );
  return res.rows[0]?.external_id ?? null;
}

// ---------------------------------------------------------------------------
// The parser.
// ---------------------------------------------------------------------------

/** Deps the finance parser may receive (all optional / injectable for tests). */
export interface FinanceParserDeps extends ParserDeps {
  /** Injected FEC fetch (default the real fetchFec). Offline tests override. */
  fetchFecImpl?: typeof fetchFec;
  /** Injected fetchJson for the committee-breakdown call. Offline tests override. */
  fetchJsonImpl?: typeof fetchJson;
  /** Override the state-portal registry (offline tests). */
  statePortals?: Record<string, StateFinanceFetcher>;
}

/**
 * Pull the latest FecTotals + FecCandidate out of the single campaign_finance
 * CandidateRecordRow that fetchFec returns, so we can build the donor profile
 * without re-deriving the wrapper's normalization. Returns null when fetchFec
 * produced no row (unknown id / no data).
 */
function extractFecFacts(
  rows: CandidateRecordRow[],
): { candidate: FecCandidate | null; latest: FecTotals | null; cycle: number | null } | null {
  const row = rows[0];
  if (!row) return null;
  const payload = row.payload as {
    candidate?: FecCandidate | null;
    latest_cycle?: number | null;
    latest_totals?: FecTotals | null;
  };
  return {
    candidate: payload.candidate ?? null,
    latest: payload.latest_totals ?? null,
    cycle: payload.latest_cycle ?? null,
  };
}

export const financeParser: SourceParser = {
  source_type: 'finance_bulk',

  async fetchAndParse(source: HarvestSource, deps: ParserDeps): Promise<ParsedUnit[]> {
    const d = deps as FinanceParserDeps;
    const client = d.client;
    const doFetchFec = d.fetchFecImpl ?? fetchFec;
    const doFetchJson = d.fetchJsonImpl ?? fetchJson;
    const statePortals = d.statePortals ?? STATE_FINANCE_PORTALS;

    const units: ParsedUnit[] = [];

    // --- (A) FEDERAL: roster persons with a fec_candidate_id strong id. --------
    const roster = await loadRosterForSource(client, source);
    // De-dup people across multiple candidacies in scope.
    const seenPerson = new Set<string>();
    const rosterPeople: RosterEntry[] = roster.entries.filter((e) => {
      if (seenPerson.has(e.person_id)) return false;
      seenPerson.add(e.person_id);
      return true;
    });

    for (const entry of rosterPeople) {
      const fecId = await fecIdForPerson(client, entry.person_id);
      if (!fecId) continue; // no federal finance strong id -> skip federal for them

      let rows: CandidateRecordRow[];
      try {
        rows = await doFetchFec(fecId, {
          person_id: entry.person_id,
          canonical_name: entry.canonical_name,
          state_fips: source.fips_state ?? null,
        });
      } catch {
        // A network / API failure for one candidate must not abort the source.
        continue;
      }

      const facts = extractFecFacts(rows);
      if (!facts || (!facts.candidate && !facts.latest)) continue;

      // Optional committee-level individual/PAC split + top donors (best-effort).
      const breakdown = await fetchCommitteeBreakdown(fecId, facts.cycle, doFetchJson);
      const profile = buildDonorProfile(facts.latest, breakdown);
      const content = donorProfileSummary(entry.canonical_name, profile);

      units.push({
        // strongId drives the bind (deterministic via person_xref); the mention
        // is supplied too as a human-readable label, but the strong id wins.
        candidateMention: entry.canonical_name,
        strongId: { kind: 'fec_candidate_id', external_id: fecId },
        locus: { source: 'fec', cycle: profile.cycle, kind: 'fec' },
        content,
        source_family: 'finance',
        signal_view: 'inferred',
        extra: {
          totals: facts.latest ?? null,
          top_donors: profile.top_donors,
          pac_share: profile.pac_share,
          individual_share: profile.individual_share,
          cycle: profile.cycle,
          fec_candidate_id: fecId,
          coarse_inferred_signal: true,
        },
      });
    }

    // --- (B) STATE: only when a portal is explicitly configured for the FIPS. --
    const fips = source.fips_state ?? null;
    const portal = fips ? statePortals[fips] : undefined;
    if (fips && portal) {
      let stateRecords: StateContributorRecord[] = [];
      try {
        stateRecords = await portal(source);
      } catch {
        stateRecords = [];
      }
      for (const rec of stateRecords) {
        const profile = buildDonorProfile(
          {
            cycle: source.election_cycle ? Number(source.election_cycle) : undefined,
            receipts: rec.total_receipts ?? undefined,
            individual_itemized_contributions: rec.individual_contributions ?? undefined,
          },
          { individual: rec.individual_contributions, pac: rec.pac_contributions, top_donors: rec.top_donors },
        );
        const content = donorProfileSummary(rec.candidate_name, profile);
        units.push({
          // State records are keyed by NAME -> the runner resolves them against
          // the race ROSTER (never a national namesake). No strong id for state.
          candidateMention: rec.candidate_name,
          locus: {
            source: 'state_finance',
            cycle: source.election_cycle ?? null,
            kind: 'state_finance',
            state_fips: fips,
            url: rec.source_url ?? null,
          },
          content,
          source_family: 'finance',
          signal_view: 'inferred',
          extra: {
            top_donors: profile.top_donors,
            pac_share: profile.pac_share,
            individual_share: profile.individual_share,
            cycle: profile.cycle,
            state_fips: fips,
            coarse_inferred_signal: true,
            source: 'state_finance',
          },
        });
      }
    }

    return units;
  },
};
