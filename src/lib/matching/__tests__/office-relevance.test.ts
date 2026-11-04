/**
 * Office-issue relevance filter: proves that with MATCHING_RESPECT_OFFICE_DIMS
 * ON, each race is scored only on the issues relevant to THAT office, and that
 * an office with NO relevance set degrades to the level-scope fallback with a
 * distinct `dims_source` flag (never a silent zero score).
 *
 * Guards the architecture-audit fix (2026-07-02): the flag was OFF in prod and
 * NULL relevant_dimensions silently meant "score on everything". See
 * src/lib/matching/office-dims.ts and the fallback branch in algorithm.ts.
 *
 * These tests set process.env.MATCHING_RESPECT_OFFICE_DIMS directly because the
 * flag is read at call time by respectOfficeDimsEnabled(). Each test restores
 * the prior value so it never leaks into the rest of the suite.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { computeMatchesForUser } from '../algorithm';
import type {
  CandidateWithPositions,
  Candidate,
  Domain,
  Position,
  Race,
  ScopeApplicability,
  SubDimension,
  User,
} from '@/types/database';

// ---------------------------------------------------------------------------
// Taxonomy fixture: the 20 active sub_dimensions, all state-scope 'matching'.
// Names mirror the live DB (office_types.relevant_dimensions stores these
// names, and the filter matches on sd.id OR sd.name).
// ---------------------------------------------------------------------------

const STATE_MATCHING: ScopeApplicability = {
  federal: 'matching',
  state: 'matching',
  county: 'matching',
};

type DimSeed = { name: string; domain: SubDimension['domain'] };

const DIM_SEEDS: DimSeed[] = [
  { name: 'taxes', domain: 'economy' },
  { name: 'government_spending', domain: 'economy' },
  { name: 'business_regulation', domain: 'economy' },
  { name: 'economic_system', domain: 'economy' },
  { name: 'school_choice', domain: 'education' },
  { name: 'public_school_funding', domain: 'education' },
  { name: 'energy_policy', domain: 'environment' },
  { name: 'public_lands', domain: 'environment' },
  { name: 'water_rights', domain: 'environment' },
  { name: 'election_reform', domain: 'governance' },
  { name: 'government_transparency', domain: 'governance' },
  { name: 'insurance_coverage', domain: 'healthcare' },
  { name: 'reproductive_rights', domain: 'healthcare' },
  { name: 'housing', domain: 'infrastructure' },
  { name: 'transportation', domain: 'infrastructure' },
  { name: 'gun_policy', domain: 'public_safety' },
  { name: 'criminal_justice', domain: 'public_safety' },
  { name: 'immigration', domain: 'social' },
  { name: 'civil_rights', domain: 'social' },
  { name: 'religious_liberty', domain: 'social' },
];

// id === name here so office_types.relevant_dimensions (which stores names)
// intersects cleanly, matching the live data shape.
const SUB_DIMS: SubDimension[] = DIM_SEEDS.map((d, i) => ({
  id: d.name,
  domain: d.domain,
  name: d.name,
  spectrum_low: 'low',
  spectrum_high: 'high',
  display_order: i,
  scope_applicability: STATE_MATCHING,
}));

// Proposed narrow set for a single-purpose executive (State Mine Inspector):
// worker/occupational safety proxied by business_regulation, energy/natural-
// resource oversight, and government_transparency. Deliberately excludes
// immigration and reproductive_rights.
const MINE_INSPECTOR_DIMS = [
  'business_regulation',
  'energy_policy',
  'public_lands',
  'water_rights',
  'government_transparency',
];

// Governor keeps the broad set (whole executive scope): includes immigration
// and reproductive_rights.
const GOVERNOR_DIMS = DIM_SEEDS.map((d) => d.name);

// ---------------------------------------------------------------------------
// Race + candidate + user builders
// ---------------------------------------------------------------------------

function makeRace(id: string, relevant: string[] | null): Race {
  return {
    id,
    name: id,
    level: 'state',
    district: null,
    election_date: '2026-11-03',
    type: 'general',
    relevant_dimensions: relevant,
  };
}

// Candidate diverges hard (score 1.0) from the voter (who answers 0.0) ONLY on
// immigration + reproductive_rights, and barely (0.05) everywhere else. A hard
// divergence lands the dim in disagreement_hotspots (|diff| > 0.5) WHEN it is in
// scope; a 0.05 diff never surfaces. So a hotspot for immigration is a reliable
// witness that immigration was scored.
const HARD_DIVERGE = new Set(['immigration', 'reproductive_rights']);
function divergeScore(dim: string): number {
  return HARD_DIVERGE.has(dim) ? 1.0 : 0.05;
}

function makeCandidate(race: Race, id: string): CandidateWithPositions {
  const base: Candidate = {
    id: `cand-${id}`,
    name: `Candidate ${id}`,
    party: null,
    race_id: race.id,
    bio: null,
    photo_url: null,
    website_url: null,
    questionnaire_status: 'not_invited',
    published: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
  const positions: Position[] = SUB_DIMS.map((sd) => ({
    id: `pos-${id}-${sd.id}`,
    candidate_id: base.id,
    sub_dimension_id: sd.id,
    view_type: 'inferred',
    score: divergeScore(sd.id),
    confidence: 'medium',
    source_citations: [
      { url: `https://example.test/${id}/${sd.id}`, title: `${sd.name} ref`, date: '2026-01-15' },
    ],
    nuance_notes: null,
    ai_summary: null,
    extraction_audit_id: null,
    created_at: '2026-01-01T00:00:00Z',
  }));
  return { ...base, positions, race };
}

function makeUser(): User {
  const quick = {
    domains: ['economy', 'environment', 'governance'] as Domain[],
    positions: SUB_DIMS.map((sd) => ({ sub_dimension_id: sd.id, score: 0.0 })),
  };
  const weights: Record<string, number> = {};
  for (const sd of SUB_DIMS) weights[sd.domain] = 1;
  return {
    id: 'user-1',
    session_token: 'tok-1',
    address_text: null,
    precinct_id: null,
    quick_match_answers: quick,
    weights,
    email: null,
    spi_consent_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
  };
}

// The dims the matcher scored AND found a hard disagreement on. With the
// HARD_DIVERGE candidate, a dim shows up here iff it was in scope (a 0.05 diff
// never becomes a hotspot). So this is a reliable witness of "was scored on".
function hotspotDimIds(result: ReturnType<typeof computeMatchesForUser>[number]): Set<string> {
  const ids = new Set<string>();
  for (const c of result.candidates) {
    for (const mp of c.explanation.disagreement_hotspots) ids.add(mp.sub_dimension_id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('office-issue relevance filter (MATCHING_RESPECT_OFFICE_DIMS on)', () => {
  const prev = process.env.MATCHING_RESPECT_OFFICE_DIMS;
  afterEach(() => {
    if (prev === undefined) delete process.env.MATCHING_RESPECT_OFFICE_DIMS;
    else process.env.MATCHING_RESPECT_OFFICE_DIMS = prev;
  });

  it('a Mine Inspector race is NOT scored on immigration or reproductive_rights', () => {
    process.env.MATCHING_RESPECT_OFFICE_DIMS = 'true';
    const race = makeRace('mine-inspector', MINE_INSPECTOR_DIMS);
    const candidate = makeCandidate(race, 'mi');
    const [result] = computeMatchesForUser(makeUser(), [candidate], SUB_DIMS);

    expect(result.dims_source).toBe('office_scoped');
    // Only the 5 office-scoped dims are applicable, not the full 20.
    expect(result.candidates[0].applicable_count).toBe(MINE_INSPECTOR_DIMS.length);

    // The two off-remit hard-diverge issues are out of scope, so they never
    // surface as disagreements. immigration / reproductive_rights did NOT count.
    const hotspots = hotspotDimIds(result);
    expect(hotspots.has('immigration')).toBe(false);
    expect(hotspots.has('reproductive_rights')).toBe(false);
  });

  it('a Governor race IS still scored on immigration and reproductive_rights', () => {
    process.env.MATCHING_RESPECT_OFFICE_DIMS = 'true';
    const race = makeRace('governor', GOVERNOR_DIMS);
    const candidate = makeCandidate(race, 'gov');
    const [result] = computeMatchesForUser(makeUser(), [candidate], SUB_DIMS);

    expect(result.dims_source).toBe('office_scoped');
    expect(result.candidates[0].applicable_count).toBe(GOVERNOR_DIMS.length);

    // Both hard-diverge issues are in the Governor's broad remit, so they DO
    // count and surface as disagreement hotspots.
    const hotspots = hotspotDimIds(result);
    expect(hotspots.has('immigration')).toBe(true);
    expect(hotspots.has('reproductive_rights')).toBe(true);
  });

  it('a NULL-relevance office falls back to the level set AND flags level_fallback', () => {
    process.env.MATCHING_RESPECT_OFFICE_DIMS = 'true';
    const race = makeRace('unknown-office', null); // relevance unknown
    const candidate = makeCandidate(race, 'unk');
    const [result] = computeMatchesForUser(makeUser(), [candidate], SUB_DIMS);

    // Never silently zeroed: the score is still computed on the full level set.
    expect(result.dims_source).toBe('level_fallback');
    expect(result.candidates[0].applicable_count).toBe(SUB_DIMS.length);
    expect(result.candidates[0].score).not.toBeNull();
  });

  it('an EMPTY-relevance office also flags level_fallback (empty === unknown)', () => {
    process.env.MATCHING_RESPECT_OFFICE_DIMS = 'true';
    const race = makeRace('empty-office', []);
    const candidate = makeCandidate(race, 'emp');
    const [result] = computeMatchesForUser(makeUser(), [candidate], SUB_DIMS);
    expect(result.dims_source).toBe('level_fallback');
    expect(result.candidates[0].applicable_count).toBe(SUB_DIMS.length);
  });

  it('with the flag OFF, even a narrow office scores on the full level set (level_fallback)', () => {
    process.env.MATCHING_RESPECT_OFFICE_DIMS = 'false';
    const race = makeRace('mine-inspector-off', MINE_INSPECTOR_DIMS);
    const candidate = makeCandidate(race, 'off');
    const [result] = computeMatchesForUser(makeUser(), [candidate], SUB_DIMS);

    expect(result.dims_source).toBe('level_fallback');
    expect(result.candidates[0].applicable_count).toBe(SUB_DIMS.length);
    // Flag off: office scoping ignored, immigration is back in scope and counts.
    const hotspots = hotspotDimIds(result);
    expect(hotspots.has('immigration')).toBe(true);
  });
});
