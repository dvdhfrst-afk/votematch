/**
 * Source-gathering orchestrator.
 *
 * For each candidate:
 *   1. Resolve the unified `CandidateContext` — prefers the office-centric
 *      graph (candidacies + people + elections + offices + jurisdictions),
 *      falls back to legacy candidates + races by id.
 *   2. Load applicable connectors, filtered by:
 *      - connector.applicable(ctx) — e.g. state-gated outlet connectors
 *      - stateOutletsRegistry — only the outlet connector for the candidate's
 *        state is attempted (council F17: utah_outlets must not run for NJ
 *        candidates).
 *   3. Run each connector's fetch() — collect SourceRow[].
 *   4. Upsert distinct (url, content_hash) pairs into `data_sources`, then
 *      insert `candidate_sources` with a data_source_id FK.
 *   5. Skip decisions are recorded to `ingestion_runs` with status='skipped'
 *      so the gap is visible as data — not a silent connector-doesn't-fire.
 *
 * Upsert is via the (candidate_id, source_type, url) unique constraint added
 * by migration 20260417000001. If url is null (Google News with no resolvable
 * link, say), we allow duplicates — news items without URLs are rare and
 * shouldn't be silently merged.
 *
 * Usage:
 *   import { gatherSourcesFor } from '@/lib/sourcing/orchestrator';
 *   const result = await gatherSourcesFor(candidateId, supabase);
 */
import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ApplicableResult,
  CandidateContext,
  ConnectorRunResult,
  SourceConnector,
  SourceRow,
} from './connector-types';
import { websiteConnector } from './connectors/website';
import { googleNewsConnector } from './connectors/google-news';
import { utahOutletsConnector } from './connectors/utah-outlets';
import { questionnaireConnector } from './connectors/questionnaire';
import { congressVotesConnector } from './connectors/congress-votes';
import { wikipediaConnector } from './connectors/wikipedia';

/**
 * Connectors that run for every candidate regardless of state.
 * (website = candidate's own URL; google_news = state-scoped at query time;
 *  questionnaire = candidate-submitted; congress_votes = federal-only, self-gated;
 *  wikipedia = phase-C, free encyclopedia coverage with disambiguation guards.)
 */
const NATIONAL_CONNECTORS: SourceConnector[] = [
  websiteConnector,
  googleNewsConnector,
  questionnaireConnector,
  congressVotesConnector,
  wikipediaConnector,
  // openStatesConnector, // deferred pending per-state quality audit (council 2026-04-19)
];

/**
 * Per-state outlet connectors. Keyed by 2-char FIPS state code.
 *
 * Council F17 (2026-04-23): running utah_outlets against an NJ candidate
 * either returns empty (silent gap) or risks matching unrelated news. This
 * registry makes state-gating explicit: only the outlet connector for the
 * candidate's state is considered.
 *
 * To add a state: slot a new connector here. The orchestrator will
 * automatically skip-log non-matching states so coverage gaps are visible.
 */
export const stateOutletsRegistry: Record<string, SourceConnector> = {
  '49': utahOutletsConnector, // Utah
  // '34': newJerseyOutletsConnector,  // future
  // '36': newYorkOutletsConnector,    // future
};

/**
 * Stable content hash for a source row's raw_data. Used for cross-candidate
 * dedup (council item 2): if the same hash appears for ≥2 other candidates
 * in the same race, the row is flagged as shared_race_coverage and the tier
 * is downgraded.
 */
function computeContentHash(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Tier-3 is our lowest authenticity class; shared race coverage gets pinned there. */
function downgradeTier(_tier: 1 | 2 | 3): 1 | 2 | 3 {
  return 3;
}

/**
 * State-name → FIPS mapping used by the legacy fallback path (when race_name
 * is like "U.S. House — Utah District 1"). Kept in sync with the Census FIPS
 * codes. Not exhaustive for territories — those rarely appear in legacy race
 * names.
 */
const STATE_NAME_TO_FIPS: Record<string, string> = {
  alabama: '01', alaska: '02', arizona: '04', arkansas: '05', california: '06',
  colorado: '08', connecticut: '09', delaware: '10', 'district of columbia': '11',
  florida: '12', georgia: '13', hawaii: '15', idaho: '16', illinois: '17',
  indiana: '18', iowa: '19', kansas: '20', kentucky: '21', louisiana: '22',
  maine: '23', maryland: '24', massachusetts: '25', michigan: '26', minnesota: '27',
  mississippi: '28', missouri: '29', montana: '30', nebraska: '31', nevada: '32',
  'new hampshire': '33', 'new jersey': '34', 'new mexico': '35', 'new york': '36',
  'north carolina': '37', 'north dakota': '38', ohio: '39', oklahoma: '40',
  oregon: '41', pennsylvania: '42', 'rhode island': '44', 'south carolina': '45',
  'south dakota': '46', tennessee: '47', texas: '48', utah: '49', vermont: '50',
  virginia: '51', washington: '53', 'west virginia': '54', wisconsin: '55',
  wyoming: '56',
};

function extractStateFipsFromRaceName(raceName: string | null | undefined): string | undefined {
  if (!raceName) return undefined;
  const lower = raceName.toLowerCase();
  // Longest-first match so "new york" beats "york" etc.
  const sorted = Object.keys(STATE_NAME_TO_FIPS).sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const re = new RegExp(`\\b${name.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(lower)) return STATE_NAME_TO_FIPS[name];
  }
  return undefined;
}

/**
 * Unified candidate-context resolver.
 *
 * Tries the office-centric graph first (candidacies + people + elections +
 * offices + jurisdictions); falls back to the legacy candidates + races
 * lookup. The fallback uses `people.legacy_candidate_ids @> ARRAY[id]` when a
 * new-world person exists for the legacy candidate; pure-legacy rows (no
 * corresponding people row yet) still return a `CandidateContext` built from
 * candidates + races.
 *
 * The `idOrCandidacyId` arg is either a candidacies.id (new path) or a
 * candidates.id (legacy path). Callers pass the id they have; this shim
 * unifies the resulting context shape.
 *
 * All new code should prefer the candidacies path. Legacy path is kept only
 * for backward-compat until candidate_sources is migrated to reference
 * candidacies directly.
 */
export async function resolveCandidateContext(
  s: SupabaseClient,
  idOrCandidacyId: string,
): Promise<CandidateContext | null> {
  // 1. Try candidacies.id first (new path).
  const candidacyCtx = await tryResolveByCandidacyId(s, idOrCandidacyId);
  if (candidacyCtx) return candidacyCtx;

  // 2. Fall back to legacy candidates.id.
  const legacyCtx = await tryResolveByLegacyCandidateId(s, idOrCandidacyId);
  return legacyCtx;
}

async function tryResolveByCandidacyId(
  s: SupabaseClient,
  candidacyId: string,
): Promise<CandidateContext | null> {
  const { data, error } = await s
    .from('candidacies')
    .select(`
      id,
      legacy_candidate_id,
      party,
      election:elections!inner (
        id,
        office:offices!inner (
          id,
          canonical_name,
          level,
          jurisdiction:jurisdictions!inner ( fips_state )
        )
      ),
      person:people!inner (
        id,
        canonical_name,
        website_url,
        legacy_candidate_ids
      )
    `)
    .eq('id', candidacyId)
    .maybeSingle();

  if (error || !data) return null;

  // PostgREST returns joined rows as either objects or single-element arrays
  // depending on version + Accept header. Normalize.
  const row = data as unknown as {
    id: string;
    legacy_candidate_id: string | null;
    party: string | null;
    election: {
      id: string;
      office: {
        id: string;
        canonical_name: string;
        level: string;
        jurisdiction: { fips_state: string | null } | Array<{ fips_state: string | null }>;
      } | Array<{
        id: string;
        canonical_name: string;
        level: string;
        jurisdiction: { fips_state: string | null } | Array<{ fips_state: string | null }>;
      }>;
    } | Array<{
      id: string;
      office: {
        id: string;
        canonical_name: string;
        level: string;
        jurisdiction: { fips_state: string | null } | Array<{ fips_state: string | null }>;
      } | Array<{
        id: string;
        canonical_name: string;
        level: string;
        jurisdiction: { fips_state: string | null } | Array<{ fips_state: string | null }>;
      }>;
    }>;
    person: {
      id: string;
      canonical_name: string;
      website_url: string | null;
      legacy_candidate_ids: string[] | null;
    } | Array<{
      id: string;
      canonical_name: string;
      website_url: string | null;
      legacy_candidate_ids: string[] | null;
    }>;
  };

  const election = Array.isArray(row.election) ? row.election[0] : row.election;
  if (!election) return null;
  const office = Array.isArray(election.office) ? election.office[0] : election.office;
  if (!office) return null;
  const jurisdiction = Array.isArray(office.jurisdiction)
    ? office.jurisdiction[0]
    : office.jurisdiction;
  const person = Array.isArray(row.person) ? row.person[0] : row.person;
  if (!person) return null;

  // candidate_sources.candidate_id references the legacy candidates table FK,
  // so we need a legacy id to insert with. If the new-world row doesn't have
  // one, skip — we can't write sources yet.
  const legacyId =
    row.legacy_candidate_id ??
    (person.legacy_candidate_ids && person.legacy_candidate_ids.length > 0
      ? person.legacy_candidate_ids[0]
      : null);
  if (!legacyId) return null;

  const raceLevel = normalizeRaceLevel(office.level);

  // Other candidates in the same election — for relevance scoring.
  const { data: siblingsData } = await s
    .from('candidacies')
    .select('person:people!inner (canonical_name)')
    .eq('election_id', election.id)
    .neq('id', row.id);
  const otherCandidates: string[] = [];
  for (const sib of (siblingsData ?? []) as Array<{
    person: { canonical_name: string } | Array<{ canonical_name: string }>;
  }>) {
    const p = Array.isArray(sib.person) ? sib.person[0] : sib.person;
    if (p?.canonical_name) otherCandidates.push(p.canonical_name);
  }

  return {
    id: legacyId,
    candidacy_id: row.id,
    person_id: person.id,
    office_id: office.id,
    election_id: election.id,
    name: person.canonical_name,
    party: row.party,
    website_url: person.website_url ?? null,
    race_level: raceLevel,
    race_name: office.canonical_name,
    race_id: undefined, // legacy races.id not reachable from here — fine, scripts prefer office_id
    stateFips: jurisdiction?.fips_state ?? undefined,
    other_race_candidates: otherCandidates,
  };
}

async function tryResolveByLegacyCandidateId(
  s: SupabaseClient,
  candidateId: string,
): Promise<CandidateContext | null> {
  const { data, error } = await s
    .from('candidates')
    .select('id, name, party, website_url, race_id, race:races(level, name)')
    .eq('id', candidateId)
    .single();
  if (error || !data) return null;
  const race = Array.isArray(data.race) ? data.race[0] : data.race;

  // Try to enrich from the new-world graph by searching for a people row
  // whose legacy_candidate_ids contains this id. Cheap lookup; falls through
  // to pure-legacy if no match.
  let candidacy_id: string | undefined;
  let person_id: string | undefined;
  let office_id: string | undefined;
  let election_id: string | undefined;
  let stateFips: string | undefined;
  let canonicalName: string | undefined;
  let newRaceLevel: CandidateContext['race_level'] | undefined;
  let newRaceName: string | undefined;
  let newWebsite: string | null | undefined;

  const { data: pmatch } = await s
    .from('people')
    .select('id, canonical_name, website_url, legacy_candidate_ids')
    .contains('legacy_candidate_ids', [candidateId])
    .maybeSingle();

  const person = pmatch as
    | { id: string; canonical_name: string; website_url: string | null; legacy_candidate_ids: string[] }
    | null;
  if (person) {
    person_id = person.id;
    canonicalName = person.canonical_name;
    newWebsite = person.website_url;
    // Pull the most-recent candidacy for this person.
    const { data: cand } = await s
      .from('candidacies')
      .select(`
        id,
        election:elections!inner (
          id,
          election_date,
          office:offices!inner (
            id,
            canonical_name,
            level,
            jurisdiction:jurisdictions!inner ( fips_state )
          )
        )
      `)
      .eq('person_id', person.id)
      .order('election(election_date)', { ascending: false })
      .limit(1)
      .maybeSingle();
    const candRow = cand as unknown as {
      id: string;
      election: {
        id: string;
        office: {
          id: string;
          canonical_name: string;
          level: string;
          jurisdiction: { fips_state: string | null } | Array<{ fips_state: string | null }>;
        } | Array<{
          id: string;
          canonical_name: string;
          level: string;
          jurisdiction: { fips_state: string | null } | Array<{ fips_state: string | null }>;
        }>;
      } | Array<{
        id: string;
        office: {
          id: string;
          canonical_name: string;
          level: string;
          jurisdiction: { fips_state: string | null } | Array<{ fips_state: string | null }>;
        } | Array<{
          id: string;
          canonical_name: string;
          level: string;
          jurisdiction: { fips_state: string | null } | Array<{ fips_state: string | null }>;
        }>;
      }>;
    } | null;

    if (candRow) {
      const election = Array.isArray(candRow.election) ? candRow.election[0] : candRow.election;
      const office = election && (Array.isArray(election.office) ? election.office[0] : election.office);
      const jurisdiction = office && (Array.isArray(office.jurisdiction) ? office.jurisdiction[0] : office.jurisdiction);
      candidacy_id = candRow.id;
      election_id = election?.id;
      office_id = office?.id;
      stateFips = jurisdiction?.fips_state ?? undefined;
      newRaceLevel = office ? normalizeRaceLevel(office.level) : undefined;
      newRaceName = office?.canonical_name;
    }
  }

  // Legacy fallback for stateFips: parse out of races.name.
  if (!stateFips) {
    stateFips = extractStateFipsFromRaceName(race?.name);
  }

  // Other candidates in the same race (legacy) — for relevance scoring.
  let otherCandidates: string[] = [];
  if (data.race_id) {
    const { data: siblings } = await s
      .from('candidates')
      .select('name')
      .eq('race_id', data.race_id)
      .neq('id', candidateId);
    otherCandidates = (siblings ?? []).map((r) => (r as { name: string }).name);
  }

  return {
    id: data.id,
    candidacy_id,
    person_id,
    office_id,
    election_id,
    name: canonicalName ?? data.name,
    party: data.party,
    website_url: (newWebsite ?? data.website_url) ?? null,
    race_level: newRaceLevel ?? normalizeRaceLevel(race?.level),
    race_name: newRaceName ?? race?.name,
    race_id: data.race_id ?? undefined,
    stateFips,
    other_race_candidates: otherCandidates,
  };
}

function normalizeRaceLevel(
  level: string | null | undefined,
): CandidateContext['race_level'] | undefined {
  if (!level) return undefined;
  switch (level) {
    case 'federal':
    case 'state':
    case 'county':
    case 'municipal':
    case 'school':
    case 'special':
    case 'judicial':
      return level;
    default:
      return undefined;
  }
}

/**
 * Back-compat export: the old code called `loadCandidateContext(s, id)`.
 * Delegates to the new shim; still returns the legacy shape plus new fields.
 */
export async function loadCandidateContext(
  s: SupabaseClient,
  candidateId: string,
): Promise<CandidateContext | null> {
  return resolveCandidateContext(s, candidateId);
}

/**
 * Log a connector-skip to `ingestion_runs` so the gap is visible as data.
 *
 * If the insert fails (e.g., the migration hasn't been applied, or RLS
 * blocks us), we fall back to console.info with the same shape and a TODO
 * marker so downstream log-collection tools can surface it.
 *
 * TODO: when the adapter-runner is built, wire skip logs to it so the
 * orchestrator isn't duplicating the runner's run-tracking.
 */
async function logSkip(
  s: SupabaseClient,
  args: {
    connector: string;
    reason: string;
    stateFips: string | undefined;
    candidateId: string;
  },
): Promise<void> {
  const payload = {
    adapter_name: `sourcing.${args.connector}`,
    state_fips: args.stateFips ?? null,
    status: 'skipped' as const,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    rows_inserted: 0,
    rows_skipped: 1,
    error_summary: args.reason,
    meta: {
      reason: args.reason,
      candidate_id: args.candidateId,
      connector: args.connector,
    },
  };
  try {
    const { error } = await s.from('ingestion_runs').insert(payload);
    if (error) {
      // eslint-disable-next-line no-console
      console.info('[sourcing skip]', {
        skipped: true,
        reason: args.reason,
        state_fips: args.stateFips ?? null,
        connector: args.connector,
        // TODO: wire to ingestion_runs once runner exists
        insert_error: error.message.slice(0, 160),
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.info('[sourcing skip]', {
      skipped: true,
      reason: args.reason,
      state_fips: args.stateFips ?? null,
      connector: args.connector,
      // TODO: wire to ingestion_runs once runner exists
      threw: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
  }
}

/**
 * Upsert a `data_sources` row for a (connector-derived url, content_hash) pair.
 * Returns the id; null on failure (orchestrator still inserts the row without
 * a data_source_id FK in that case — the column is nullable).
 *
 * Why we do this: every ingested fact should be provenance-linked. Council
 * F17 (2026-04-23): "source_type → FK discipline" — candidate_sources rows
 * without a corresponding data_sources row can't be defended in a correction
 * workflow. We create the data_sources row inline rather than requiring a
 * separate adapter run.
 */
async function upsertDataSource(
  s: SupabaseClient,
  args: {
    connector: string;
    url: string | null;
    contentHash: string;
    stateFips: string | undefined;
  },
): Promise<string | null> {
  // Map connector → data_sources.source_type taxonomy.
  const sourceType = mapConnectorToDataSourceType(args.connector);

  const payload = {
    source_type: sourceType,
    name: `sourcing.${args.connector}`,
    url: args.url,
    content_hash: args.contentHash,
    state_fips: args.stateFips ?? null,
    fetched_at: new Date().toISOString(),
    created_by: 'orchestrator',
    meta: { connector: args.connector },
  };

  try {
    // Try to find an existing row for this (url, content_hash) so we don't
    // create duplicates across re-runs. No unique constraint exists; this is
    // a best-effort dedup.
    if (args.url) {
      const { data: existing } = await s
        .from('data_sources')
        .select('id')
        .eq('url', args.url)
        .eq('content_hash', args.contentHash)
        .maybeSingle();
      if (existing && (existing as { id: string }).id) {
        return (existing as { id: string }).id;
      }
    } else {
      const { data: existing } = await s
        .from('data_sources')
        .select('id')
        .is('url', null)
        .eq('content_hash', args.contentHash)
        .maybeSingle();
      if (existing && (existing as { id: string }).id) {
        return (existing as { id: string }).id;
      }
    }

    const { data, error } = await s
      .from('data_sources')
      .insert(payload)
      .select('id')
      .single();
    if (error || !data) return null;
    return (data as { id: string }).id;
  } catch {
    return null;
  }
}

function mapConnectorToDataSourceType(connector: string): string {
  switch (connector) {
    case 'website':
      return 'campaign_website';
    case 'google_news':
      return 'editorial_rss';
    case 'utah_outlets_rss':
      return 'editorial_rss';
    case 'questionnaire':
      return 'candidate_questionnaire';
    case 'congress_votes':
      return 'federal_vote_record';
    default:
      return 'other';
  }
}

/**
 * Determine the connector list for a given context:
 *   national connectors (always) + the outlet connector for ctx.stateFips.
 *
 * Outlet connectors for OTHER states are not included; attempting to run
 * them would be logged as a skip (see logSkip), but we skip that work
 * entirely — the registry is the authority on which outlet connector (if
 * any) applies.
 */
function selectConnectors(ctx: CandidateContext): SourceConnector[] {
  const out: SourceConnector[] = [...NATIONAL_CONNECTORS];
  if (ctx.stateFips && stateOutletsRegistry[ctx.stateFips]) {
    out.push(stateOutletsRegistry[ctx.stateFips]);
  }
  return out;
}

/**
 * Run all applicable connectors for one candidate, write results to
 * candidate_sources, and return per-connector metrics.
 */
export async function gatherSourcesFor(
  candidateId: string,
  s: SupabaseClient,
  opts: { skipExisting?: boolean } = {},
): Promise<{ results: ConnectorRunResult[]; totalInserted: number }> {
  const ctx = await resolveCandidateContext(s, candidateId);
  if (!ctx) {
    return { results: [], totalInserted: 0 };
  }

  const results: ConnectorRunResult[] = [];
  let totalInserted = 0;

  // If skipExisting, count existing sources per connector-name-prefix so we
  // don't re-fetch for candidates that are already well-sourced
  let existingByConnector: Record<string, number> | null = null;
  if (opts.skipExisting) {
    existingByConnector = {};
    const { data } = await s
      .from('candidate_sources')
      .select('source_type')
      .eq('candidate_id', ctx.id);
    for (const r of (data ?? []) as Array<{ source_type: string }>) {
      existingByConnector[r.source_type] = (existingByConnector[r.source_type] ?? 0) + 1;
    }
  }

  // Connector list = national + state-gated outlet for ctx.stateFips (if any).
  const connectors = selectConnectors(ctx);

  // Also log skips for OTHER outlet connectors so the state-gap is visible
  // as data. Only logs one per distinct outlet connector that didn't match.
  const seenOutlets = new Set<string>();
  for (const [fips, conn] of Object.entries(stateOutletsRegistry)) {
    if (fips === ctx.stateFips) continue;
    if (seenOutlets.has(conn.name)) continue;
    seenOutlets.add(conn.name);
    void logSkip(s, {
      connector: conn.name,
      reason: `state_mismatch: candidate stateFips=${ctx.stateFips ?? '(unknown)'} not in registry for ${conn.name} (requires ${fips})`,
      stateFips: ctx.stateFips,
      candidateId: ctx.id,
    });
  }

  for (const connector of connectors) {
    const applicable: ApplicableResult = connector.applicable(ctx);
    if (!applicable.applicable) {
      // Connector voluntarily gated itself out — log skip and move on.
      await logSkip(s, {
        connector: connector.name,
        reason: applicable.reason,
        stateFips: ctx.stateFips,
        candidateId: ctx.id,
      });
      results.push({
        connector: connector.name,
        candidate_name: ctx.name,
        rows_returned: 0,
        rows_inserted: 0,
        errors: [`skipped: ${applicable.reason}`],
        duration_ms: 0,
      });
      continue;
    }

    const t0 = Date.now();
    const result: ConnectorRunResult = {
      connector: connector.name,
      candidate_name: ctx.name,
      rows_returned: 0,
      rows_inserted: 0,
      errors: [],
      duration_ms: 0,
    };
    try {
      const rows: SourceRow[] = await connector.fetch(ctx, s);
      result.rows_returned = rows.length;
      if (rows.length > 0) {
        // Content-hash each row and check for shared-race-coverage.
        // Council item 2 (2026-04-19): if the same content_hash already
        // appears for ≥2 other candidates in the same race, this article is
        // race-wide context, not candidate-specific. Downgrade tier to 3 and
        // flag shared_race_coverage=true so the UI can annotate.
        const rowsWithHash = rows.map((r) => ({
          ...r,
          content_hash: computeContentHash(r.raw_data),
        }));

        let sharedByHash = new Map<string, number>();
        if (ctx.race_id) {
          const hashes = [...new Set(rowsWithHash.map((r) => r.content_hash))];
          const { data: existing } = await s
            .from('candidate_sources')
            .select('content_hash, candidate_id, candidate:candidates!inner(race_id)')
            .in('content_hash', hashes)
            .eq('candidate.race_id', ctx.race_id)
            .neq('candidate_id', ctx.id);
          sharedByHash = new Map<string, number>();
          for (const row of (existing ?? []) as Array<{
            content_hash: string;
            candidate_id: string;
          }>) {
            sharedByHash.set(row.content_hash, (sharedByHash.get(row.content_hash) ?? 0) + 1);
          }
        }

        // Upsert data_sources rows first so every candidate_sources row can
        // link to a provenance record. One data_source row per distinct
        // (url, content_hash) pair.
        const dataSourceIdByHash = new Map<string, string | null>();
        const dataSourceKey = (url: string | null, hash: string) => `${url ?? ''}::${hash}`;
        const dataSourceByKey = new Map<string, string | null>();
        for (const r of rowsWithHash) {
          const key = dataSourceKey(r.url, r.content_hash);
          if (dataSourceByKey.has(key)) continue;
          const dsId = await upsertDataSource(s, {
            connector: connector.name,
            url: r.url,
            contentHash: r.content_hash,
            stateFips: ctx.stateFips,
          });
          dataSourceByKey.set(key, dsId);
          dataSourceIdByHash.set(r.content_hash, dsId);
        }

        // Upsert with onConflict on unique key (candidate_id, source_type, url)
        const toInsert = rowsWithHash.map((r) => {
          const sharedCount = sharedByHash.get(r.content_hash) ?? 0;
          const shared = sharedCount >= 2;
          const key = dataSourceKey(r.url, r.content_hash);
          const dataSourceId = dataSourceByKey.get(key) ?? null;
          return {
            candidate_id: ctx.id,
            source_type: r.source_type,
            source_subtype: r.source_subtype ?? null,
            authenticity_tier: shared ? downgradeTier(r.authenticity_tier) : r.authenticity_tier,
            outlet_ideology: r.outlet_ideology ?? null,
            url: r.url,
            title: shared
              ? `[shared race coverage across ${sharedCount + 1} candidates] ${r.title ?? ''}`.slice(0, 500)
              : r.title,
            raw_data: r.raw_data,
            published_at: r.published_at ?? null,
            extraction_audit_id: r.extraction_audit_id ?? null,
            content_hash: r.content_hash,
            shared_race_coverage: shared,
            // Provenance: data_source_id from inline upsert above.
            data_source_id: dataSourceId,
            // TODO: wire to ingestion_runs once adapter runner exists. For
            // now, null — the column is nullable and downstream readers
            // tolerate missing ingestion_run_id.
            ingestion_run_id: null as string | null,
          };
        });
        const { data: inserted, error } = await s
          .from('candidate_sources')
          .upsert(toInsert, { onConflict: 'candidate_id,source_type,url', ignoreDuplicates: true })
          .select('id');
        if (error) {
          result.errors.push(error.message.slice(0, 200));
        } else {
          result.rows_inserted = inserted?.length ?? 0;
          totalInserted += result.rows_inserted;
        }
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message.slice(0, 200) : String(err));
    }
    result.duration_ms = Date.now() - t0;
    results.push(result);
  }

  // Reference existingByConnector so TS doesn't complain about unused reads
  // when opts.skipExisting is true; future per-connector skip logic hangs off
  // this. (Preserves legacy behavior without refactoring the skip loop.)
  void existingByConnector;

  return { results, totalInserted };
}
