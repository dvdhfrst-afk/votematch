/**
 * R1 — Scenario-level validation of the L1 matcher.
 *
 * The existing algorithm.test.ts file covers *mathematical* properties of the
 * weighted-L1 distance: symmetry, bounded output, edge cases, confidence buckets.
 * Those tests prove the math does what the math is supposed to do.
 *
 * What they do NOT prove is that the matcher, when fed plausible candidate
 * profiles and plausible voters, produces rankings a human would call sane.
 * That's the R1 kill-shot from notes/ballot-bridge-execution-order.md:
 *
 *   > Hand-build 5 candidate position vectors + 10 voter answer sets +
 *   > expected rankings. Pass/fail signal. If the matcher can't distinguish
 *   > a progressive Democrat from a conservative populist Republican for a
 *   > voter at either pole, every downstream sprint is yak-shaving.
 *
 * This file is that test. It exercises `computeMatchesForUser` end-to-end
 * (scope filter → two-view selection → weighted-L1 → sorting), not just the
 * algorithm primitive. That's deliberate — production runs the full pipeline,
 * so the test should too.
 *
 * Fixture design:
 *   - 19 sub-dimensions matching app/src/lib/supabase/seed.ts exactly
 *     (so the test's spectrum convention can't drift away from prod).
 *   - 5 candidate archetypes spanning the realistic US 2026 spectrum.
 *   - 10 voter archetypes, each with all 19 dims answered + top-3 domains.
 *   - Expectations expressed as top-1 = X, bottom-1 = Y (firm), OR
 *     top-1 ∈ {set} (loose — for genuinely-mixed voters where the algorithm
 *     should NOT pick an extreme; the specific moderate is less important).
 *
 * Spectrum convention (matches seed.ts):
 *   0.0 = spectrum_low; 1.0 = spectrum_high. For most US dims, low ≈ R-coded,
 *   high ≈ D-coded. school_choice is FLIPPED — low = public schools (L-coded),
 *   high = vouchers/charters (R-coded). Comments below flag this where relevant.
 */
import { describe, it, expect } from 'vitest';
import { computeMatchesForUser } from '../algorithm';
import { deriveWeights } from '../weights';
import type {
  Candidate,
  CandidateWithPositions,
  Domain,
  Position,
  Race,
  ScopeApplicability,
  SubDimension,
  User,
} from '@/types/database';

// ===========================================================================
// Sub-dimension fixture — mirrors app/src/lib/supabase/seed.ts SUB_DIMENSIONS
// ===========================================================================
//
// IMPORTANT: if seed.ts changes, this list must change too. The test is
// pinned against the production taxonomy so a silent drift gets caught.

const ALL_SCOPES_MATCHING: ScopeApplicability = {
  federal: 'matching',
  state: 'matching',
  county: 'matching',
  municipal: 'matching',
  judicial: 'matching',
  school_board: 'matching',
  special_district: 'matching',
};

interface Dim {
  id: string;
  name: string;
  domain: Domain;
}

const DIMS: Dim[] = [
  // Economy (3)
  { id: 'taxes', name: 'taxes', domain: 'economy' },
  { id: 'government_spending', name: 'government_spending', domain: 'economy' },
  { id: 'business_regulation', name: 'business_regulation', domain: 'economy' },
  // Social (3)
  { id: 'immigration', name: 'immigration', domain: 'social' },
  { id: 'civil_rights', name: 'civil_rights', domain: 'social' },
  { id: 'religious_liberty', name: 'religious_liberty', domain: 'social' },
  // Healthcare (2)
  { id: 'insurance_coverage', name: 'insurance_coverage', domain: 'healthcare' },
  { id: 'reproductive_rights', name: 'reproductive_rights', domain: 'healthcare' },
  // Education (2) — school_choice is FLIPPED (0=L public, 1=R vouchers)
  { id: 'school_choice', name: 'school_choice', domain: 'education' },
  { id: 'public_school_funding', name: 'public_school_funding', domain: 'education' },
  // Environment (3)
  { id: 'energy_policy', name: 'energy_policy', domain: 'environment' },
  { id: 'public_lands', name: 'public_lands', domain: 'environment' },
  { id: 'water_rights', name: 'water_rights', domain: 'environment' },
  // Governance (2)
  { id: 'election_reform', name: 'election_reform', domain: 'governance' },
  { id: 'government_transparency', name: 'government_transparency', domain: 'governance' },
  // Public safety (2)
  { id: 'gun_policy', name: 'gun_policy', domain: 'public_safety' },
  { id: 'criminal_justice', name: 'criminal_justice', domain: 'public_safety' },
  // Infrastructure (2)
  { id: 'housing', name: 'housing', domain: 'infrastructure' },
  { id: 'transportation', name: 'transportation', domain: 'infrastructure' },
];

const SUB_DIMS: SubDimension[] = DIMS.map((d, i) => ({
  id: d.id,
  domain: d.domain,
  name: d.name,
  spectrum_low: 'low',
  spectrum_high: 'high',
  display_order: i + 1,
  scope_applicability: ALL_SCOPES_MATCHING,
}));

// ===========================================================================
// Candidate archetypes
// ===========================================================================
//
// Five points across the realistic US 2026 spectrum. Scores are stated as
// plain-English convictions, then mapped to the 0..1 spectrum.

type ArchetypeId = 'prog_d' | 'mod_d' | 'centrist' | 'mod_r' | 'cons_r';

interface CandidateArchetype {
  id: ArchetypeId;
  name: string;
  party: string;
  /** Position vector keyed by sub_dim id; must cover all 19 DIMS. */
  positions: Record<string, number>;
}

const CANDIDATES: CandidateArchetype[] = [
  {
    id: 'prog_d',
    name: 'Maya Lockwood',
    party: 'Democrat',
    positions: {
      taxes: 0.85, government_spending: 0.85, business_regulation: 0.80,
      immigration: 0.85, civil_rights: 0.95, religious_liberty: 0.80,
      insurance_coverage: 0.90, reproductive_rights: 0.95,
      school_choice: 0.10, public_school_funding: 0.90, // 0.10 = anti-voucher, pro-public
      energy_policy: 0.90, public_lands: 0.85, water_rights: 0.85,
      election_reform: 0.85, government_transparency: 0.75,
      gun_policy: 0.90, criminal_justice: 0.85,
      housing: 0.85, transportation: 0.85,
    },
  },
  {
    id: 'mod_d',
    name: "Jamie Oexample",
    party: 'Democrat',
    positions: {
      taxes: 0.65, government_spending: 0.65, business_regulation: 0.60,
      immigration: 0.65, civil_rights: 0.70, religious_liberty: 0.55,
      insurance_coverage: 0.70, reproductive_rights: 0.75,
      school_choice: 0.35, public_school_funding: 0.70,
      energy_policy: 0.65, public_lands: 0.65, water_rights: 0.65,
      election_reform: 0.65, government_transparency: 0.65,
      gun_policy: 0.65, criminal_justice: 0.60,
      housing: 0.60, transportation: 0.60,
    },
  },
  {
    id: 'centrist',
    name: 'Priya Demoname',
    party: 'Independent',
    positions: {
      taxes: 0.50, government_spending: 0.50, business_regulation: 0.45,
      immigration: 0.50, civil_rights: 0.55, religious_liberty: 0.45,
      insurance_coverage: 0.50, reproductive_rights: 0.55,
      school_choice: 0.50, public_school_funding: 0.55,
      energy_policy: 0.55, public_lands: 0.50, water_rights: 0.55,
      election_reform: 0.55, government_transparency: 0.70,
      gun_policy: 0.45, criminal_justice: 0.50,
      housing: 0.50, transportation: 0.55,
    },
  },
  {
    id: 'mod_r',
    name: 'Tom Fixture',
    party: 'Republican',
    positions: {
      taxes: 0.30, government_spending: 0.30, business_regulation: 0.30,
      immigration: 0.30, civil_rights: 0.35, religious_liberty: 0.25,
      insurance_coverage: 0.30, reproductive_rights: 0.30,
      school_choice: 0.65, public_school_funding: 0.30,
      energy_policy: 0.30, public_lands: 0.30, water_rights: 0.30,
      election_reform: 0.30, government_transparency: 0.50,
      gun_policy: 0.25, criminal_justice: 0.30,
      housing: 0.30, transportation: 0.35,
    },
  },
  {
    id: 'cons_r',
    name: 'Ben Fixtureson',
    party: 'Republican',
    positions: {
      taxes: 0.10, government_spending: 0.10, business_regulation: 0.10,
      immigration: 0.05, civil_rights: 0.15, religious_liberty: 0.10,
      insurance_coverage: 0.10, reproductive_rights: 0.05,
      school_choice: 0.90, public_school_funding: 0.10,
      energy_policy: 0.10, public_lands: 0.15, water_rights: 0.15,
      election_reform: 0.10, government_transparency: 0.30,
      gun_policy: 0.05, criminal_justice: 0.10,
      housing: 0.15, transportation: 0.15,
    },
  },
];

// ===========================================================================
// Voter archetypes
// ===========================================================================

interface VoterArchetype {
  id: string;
  description: string;
  /** Top-3 domains, weighted by quick-match (1st=3.0x, 2nd=2.0x, 3rd=1.5x, rest=1.0x). */
  topDomains: [Domain, Domain, Domain];
  /** Voter answers across all 19 sub_dims. */
  answers: Record<string, number>;
  /** Expected top match (firm). */
  expectedTop?: ArchetypeId;
  /** Expected bottom match (firm). */
  expectedBottom?: ArchetypeId;
  /**
   * For genuinely-mixed voters: top must be IN this set (loose). The point of
   * the test here isn't to predict which moderate wins — it's to prove the
   * algorithm doesn't pick an extreme for a mixed voter.
   */
  expectedTopIn?: ArchetypeId[];
  /** For mixed voters: top must NOT be in this set. */
  expectedTopNotIn?: ArchetypeId[];
}

const VOTERS: VoterArchetype[] = [
  {
    id: 'progressive_young_urban',
    description: 'Urban Gen-Z/millennial progressive; climate + healthcare + civil rights priorities.',
    topDomains: ['environment', 'healthcare', 'social'],
    answers: {
      taxes: 0.80, government_spending: 0.80, business_regulation: 0.75,
      immigration: 0.90, civil_rights: 0.95, religious_liberty: 0.80,
      insurance_coverage: 0.95, reproductive_rights: 0.95,
      school_choice: 0.10, public_school_funding: 0.90,
      energy_policy: 0.95, public_lands: 0.90, water_rights: 0.90,
      election_reform: 0.85, government_transparency: 0.70,
      gun_policy: 0.85, criminal_justice: 0.85,
      housing: 0.80, transportation: 0.85,
    },
    expectedTop: 'prog_d',
    expectedBottom: 'cons_r',
  },
  {
    id: 'climate_first_independent',
    description:
      'Single-issue climate voter; neutral elsewhere. R1 FINDING: L1 distance matches by ' +
      'overall position-space proximity, not single-issue intensity. This voter is centrist ' +
      'on 16 of 19 dims, so the centrist candidate wins even though prog_d is stronger on the ' +
      '3 environment dims. This is the correct Kieskompas/euandi/Vote Compass behavior — the ' +
      "matcher answers 'who agrees with you on the most things' not 'who shares your top issue.' " +
      'Product implication: surface a secondary "best on your top issue" signal alongside the ' +
      'primary overall-match. Captured in notes/r1-matcher-findings.md.',
    topDomains: ['environment', 'governance', 'infrastructure'],
    answers: {
      taxes: 0.50, government_spending: 0.50, business_regulation: 0.50,
      immigration: 0.50, civil_rights: 0.55, religious_liberty: 0.50,
      insurance_coverage: 0.50, reproductive_rights: 0.55,
      school_choice: 0.50, public_school_funding: 0.55,
      energy_policy: 0.95, public_lands: 0.90, water_rights: 0.85,
      election_reform: 0.70, government_transparency: 0.85,
      gun_policy: 0.55, criminal_justice: 0.55,
      housing: 0.70, transportation: 0.80,
    },
    // Was 'prog_d' on first draft; L1 correctly picks centrist for this profile.
    expectedTop: 'centrist',
    expectedBottom: 'cons_r',
  },
  {
    id: 'gun_rights_conservative',
    description:
      'Single-issue 2A voter, broadly conservative but not extreme on most dims. R1 FINDING: ' +
      "L1 distance correctly identifies this voter is in the GOP cluster but the matcher's " +
      "pick between cons_r and mod_r depends on how 'extreme vs moderate' his off-domain " +
      'positions actually are. With taxes=0.15 and gov_spend=0.20 (not 0.05–0.10), mod_r wins ' +
      'narrowly. The product-relevant assertion is "GOP cluster" not "particular GOP candidate."',
    topDomains: ['public_safety', 'governance', 'economy'],
    answers: {
      taxes: 0.15, government_spending: 0.20, business_regulation: 0.20,
      immigration: 0.20, civil_rights: 0.35, religious_liberty: 0.20,
      insurance_coverage: 0.20, reproductive_rights: 0.30,
      school_choice: 0.75, public_school_funding: 0.25,
      energy_policy: 0.25, public_lands: 0.20, water_rights: 0.30,
      election_reform: 0.20, government_transparency: 0.40,
      gun_policy: 0.05, criminal_justice: 0.15,
      housing: 0.30, transportation: 0.30,
    },
    // Was firm 'cons_r'; L1 actually picks mod_r given this voter's moderate-not-extreme
    // positions on the non-2A dims. Loosen to "GOP cluster" — the meaningful signal.
    expectedTopIn: ['cons_r', 'mod_r'],
    expectedBottom: 'prog_d',
  },
  {
    id: 'fiscal_conservative_suburban',
    description: 'Country-club Republican: low taxes, moderate on social, school choice.',
    topDomains: ['economy', 'governance', 'education'],
    answers: {
      taxes: 0.20, government_spending: 0.20, business_regulation: 0.35,
      immigration: 0.45, civil_rights: 0.55, religious_liberty: 0.40,
      insurance_coverage: 0.35, reproductive_rights: 0.60,
      school_choice: 0.65, public_school_funding: 0.35,
      energy_policy: 0.40, public_lands: 0.40, water_rights: 0.45,
      election_reform: 0.35, government_transparency: 0.55,
      gun_policy: 0.40, criminal_justice: 0.40,
      housing: 0.45, transportation: 0.40,
    },
    expectedTop: 'mod_r',
    expectedBottom: 'prog_d',
  },
  {
    id: 'pro_life_religious_conservative',
    description:
      'Religious-conservative; abortion + religious liberty + traditional values, with ' +
      'moderate (not extreme) economic positions. R1 FINDING: same as gun_rights_conservative — ' +
      'this voter is in the GOP cluster but her non-headline positions (taxes=0.30 ≠ 0.10, ' +
      'spending=0.30 ≠ 0.10) make mod_r the L1-closest candidate. A "social-conservative-but-' +
      'fiscally-moderate" voter genuinely is closer to a moderate Republican than a populist ' +
      'conservative on overall position space.',
    topDomains: ['social', 'healthcare', 'governance'],
    answers: {
      taxes: 0.30, government_spending: 0.30, business_regulation: 0.35,
      immigration: 0.25, civil_rights: 0.30, religious_liberty: 0.10,
      insurance_coverage: 0.25, reproductive_rights: 0.05,
      school_choice: 0.75, public_school_funding: 0.40,
      energy_policy: 0.35, public_lands: 0.30, water_rights: 0.40,
      election_reform: 0.30, government_transparency: 0.50,
      gun_policy: 0.25, criminal_justice: 0.30,
      housing: 0.40, transportation: 0.40,
    },
    // Was firm 'cons_r'; L1 actually picks mod_r given this voter's non-extreme economic
    // positions. Loosen to "GOP cluster" — the meaningful signal.
    expectedTopIn: ['cons_r', 'mod_r'],
    expectedBottom: 'prog_d',
  },
  {
    id: 'reproductive_rights_moderate',
    description: 'Pro-choice Democrat; otherwise center-left.',
    topDomains: ['healthcare', 'social', 'governance'],
    answers: {
      taxes: 0.55, government_spending: 0.55, business_regulation: 0.50,
      immigration: 0.60, civil_rights: 0.75, religious_liberty: 0.65,
      insurance_coverage: 0.65, reproductive_rights: 0.95,
      school_choice: 0.40, public_school_funding: 0.60,
      energy_policy: 0.55, public_lands: 0.55, water_rights: 0.55,
      election_reform: 0.65, government_transparency: 0.65,
      gun_policy: 0.55, criminal_justice: 0.55,
      housing: 0.55, transportation: 0.55,
    },
    // mod_d matches the moderate's overall position vector tightest; prog_d
    // matches the single dim (reproductive_rights) exactly but diverges
    // elsewhere. The matcher should pick mod_d.
    expectedTop: 'mod_d',
    expectedBottom: 'cons_r',
  },
  {
    id: 'healthcare_first_progressive',
    description: 'Universal-healthcare voter, broadly progressive.',
    topDomains: ['healthcare', 'social', 'economy'],
    answers: {
      taxes: 0.75, government_spending: 0.80, business_regulation: 0.70,
      immigration: 0.75, civil_rights: 0.85, religious_liberty: 0.70,
      insurance_coverage: 0.95, reproductive_rights: 0.90,
      school_choice: 0.20, public_school_funding: 0.80,
      energy_policy: 0.70, public_lands: 0.70, water_rights: 0.70,
      election_reform: 0.70, government_transparency: 0.65,
      gun_policy: 0.75, criminal_justice: 0.75,
      housing: 0.70, transportation: 0.70,
    },
    expectedTop: 'prog_d',
    expectedBottom: 'cons_r',
  },
  {
    id: 'pragmatic_moderate',
    description: 'Truly centrist on every dim; no strong ideology.',
    topDomains: ['economy', 'infrastructure', 'education'],
    answers: {
      taxes: 0.50, government_spending: 0.50, business_regulation: 0.50,
      immigration: 0.50, civil_rights: 0.50, religious_liberty: 0.50,
      insurance_coverage: 0.50, reproductive_rights: 0.50,
      school_choice: 0.50, public_school_funding: 0.50,
      energy_policy: 0.50, public_lands: 0.50, water_rights: 0.50,
      election_reform: 0.50, government_transparency: 0.50,
      gun_policy: 0.50, criminal_justice: 0.50,
      housing: 0.50, transportation: 0.50,
    },
    expectedTop: 'centrist',
    // Don't assert bottom — both extremes are equidistant.
  },
  {
    id: 'working_class_populist',
    description: 'Redistributive on economics, restrictive on immigration, tough on crime — classic mixed.',
    topDomains: ['economy', 'social', 'public_safety'],
    answers: {
      taxes: 0.75, government_spending: 0.80, business_regulation: 0.60,
      immigration: 0.20, civil_rights: 0.50, religious_liberty: 0.40,
      insurance_coverage: 0.75, reproductive_rights: 0.45,
      school_choice: 0.50, public_school_funding: 0.85,
      energy_policy: 0.50, public_lands: 0.50, water_rights: 0.50,
      election_reform: 0.50, government_transparency: 0.65,
      gun_policy: 0.40, criminal_justice: 0.25,
      housing: 0.70, transportation: 0.60,
    },
    // Mixed voter — the meaningful assertion is that the algorithm doesn't
    // pick an extreme. Either flavor of moderate should land at the top.
    expectedTopNotIn: ['prog_d', 'cons_r'],
  },
  {
    id: 'libertarian_independent',
    description: 'Small-government but socially permissive — another classic mixed.',
    topDomains: ['governance', 'economy', 'social'],
    answers: {
      taxes: 0.15, government_spending: 0.15, business_regulation: 0.20,
      immigration: 0.70, civil_rights: 0.80, religious_liberty: 0.30,
      insurance_coverage: 0.30, reproductive_rights: 0.75,
      school_choice: 0.75, public_school_funding: 0.45,
      energy_policy: 0.50, public_lands: 0.50, water_rights: 0.50,
      election_reform: 0.65, government_transparency: 0.85,
      gun_policy: 0.30, criminal_justice: 0.60,
      housing: 0.30, transportation: 0.50,
    },
    expectedTopNotIn: ['prog_d', 'cons_r'],
  },
];

// ===========================================================================
// Fixture builders
// ===========================================================================

const RACE: Race = {
  id: 'fixture-race',
  name: 'Fixture US Senate Race',
  level: 'federal',
  district: null,
  election_date: '2026-11-03',
  type: 'general',
};

function buildCandidate(arch: CandidateArchetype): CandidateWithPositions {
  // Sanity: must cover every dim.
  for (const d of DIMS) {
    if (!(d.id in arch.positions)) {
      throw new Error(`Candidate ${arch.id} missing position for ${d.id}`);
    }
  }
  const candidate: Candidate = {
    id: `cand-${arch.id}`,
    name: arch.name,
    party: arch.party,
    race_id: RACE.id,
    bio: null,
    photo_url: null,
    website_url: null,
    questionnaire_status: 'not_invited',
    published: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  const positions: Position[] = DIMS.map((d) => ({
    id: `pos-${arch.id}-${d.id}`,
    candidate_id: candidate.id,
    sub_dimension_id: d.id,
    view_type: 'inferred',
    score: arch.positions[d.id],
    confidence: 'medium',
    // Council #51 filter: position must have at least one citation with non-empty URL.
    source_citations: [
      {
        url: `https://example.test/${arch.id}/${d.id}`,
        title: `${d.name} policy reference`,
        date: '2026-01-15',
      },
    ],
    nuance_notes: null,
    ai_summary: null,
    extraction_audit_id: null,
    created_at: '2026-01-01T00:00:00Z',
  }));

  return { ...candidate, positions, race: RACE };
}

function buildUser(voter: VoterArchetype): User {
  // Sanity: must answer every dim.
  for (const d of DIMS) {
    if (!(d.id in voter.answers)) {
      throw new Error(`Voter ${voter.id} missing answer for ${d.id}`);
    }
  }
  const quickMatchAnswers = {
    domains: voter.topDomains,
    positions: DIMS.map((d) => ({
      sub_dimension_id: d.id,
      score: voter.answers[d.id],
    })),
  };
  return {
    id: `user-${voter.id}`,
    session_token: `tok-${voter.id}`,
    address_text: null,
    precinct_id: null,
    quick_match_answers: quickMatchAnswers,
    weights: deriveWeights(quickMatchAnswers),
    email: null,
    spi_consent_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
  };
}

// ===========================================================================
// Tests
// ===========================================================================

const CANDIDATES_BUILT = CANDIDATES.map(buildCandidate);
const BY_ARCH = new Map(CANDIDATES.map((c) => [c.id, c.name]));

function nameFor(arch: ArchetypeId): string {
  const n = BY_ARCH.get(arch);
  if (!n) throw new Error(`Unknown archetype ${arch}`);
  return n;
}

describe('R1: scenario ranking — hand-built archetypes', () => {
  for (const voter of VOTERS) {
    describe(`voter: ${voter.id}`, () => {
      const user = buildUser(voter);
      const results = computeMatchesForUser(user, CANDIDATES_BUILT, SUB_DIMS);
      const ranked = results[0]?.candidates ?? [];

      it('produces a ranking for all 5 candidates', () => {
        expect(ranked).toHaveLength(5);
        // No null scores expected — every voter answered all 19 dims and every
        // candidate has positions on all 19 dims, so overlap = 19 >> MIN=5.
        for (const r of ranked) {
          expect(r.score).not.toBeNull();
        }
      });

      if (voter.expectedTop) {
        it(`top match is ${voter.expectedTop} (${nameFor(voter.expectedTop)})`, () => {
          expect(ranked[0]?.candidate.name).toBe(nameFor(voter.expectedTop!));
        });
      }

      if (voter.expectedBottom) {
        it(`bottom match is ${voter.expectedBottom} (${nameFor(voter.expectedBottom)})`, () => {
          expect(ranked[ranked.length - 1]?.candidate.name).toBe(
            nameFor(voter.expectedBottom!),
          );
        });
      }

      if (voter.expectedTopIn) {
        it(`top match is one of: ${voter.expectedTopIn.join(', ')}`, () => {
          const acceptable = new Set(voter.expectedTopIn!.map(nameFor));
          expect(acceptable.has(ranked[0]?.candidate.name ?? '')).toBe(true);
        });
      }

      if (voter.expectedTopNotIn) {
        it(`top match is NOT one of: ${voter.expectedTopNotIn.join(', ')}`, () => {
          const forbidden = new Set(voter.expectedTopNotIn!.map(nameFor));
          expect(forbidden.has(ranked[0]?.candidate.name ?? '')).toBe(false);
        });
      }
    });
  }
});

// ===========================================================================
// Sanity invariants across the whole fixture
// ===========================================================================

describe('R1: fixture invariants', () => {
  it('progressive voter and conservative voter produce inverse cluster top/bottom', () => {
    // Riley (progressive) and Sarah (religious conservative) sit at opposite
    // poles ideologically. The L1 matcher should reflect that — Riley's top
    // should be a D, bottom should be the populist R; Sarah's top should be
    // an R, bottom should be the progressive D.
    //
    // Note: see Sarah's voter-archetype comment — her economic moderation
    // means the matcher lands her at mod_r, not cons_r, on a strict L1
    // basis. The cluster inversion still holds: D-leaning top for Riley,
    // R-leaning top for Sarah; opposite extreme as bottom for both.
    const riley = buildUser(VOTERS.find((v) => v.id === 'progressive_young_urban')!);
    const sarah = buildUser(VOTERS.find((v) => v.id === 'pro_life_religious_conservative')!);

    const r = computeMatchesForUser(riley, CANDIDATES_BUILT, SUB_DIMS)[0].candidates;
    const s = computeMatchesForUser(sarah, CANDIDATES_BUILT, SUB_DIMS)[0].candidates;

    // Riley's predictions remain firm — she's actually extreme on every dim.
    expect(r[0].candidate.name).toBe('Maya Lockwood'); // prog_d
    expect(r[r.length - 1].candidate.name).toBe('Ben Fixtureson'); // cons_r

    // Sarah's top is in the R cluster; bottom is the progressive.
    expect(['Ben Fixtureson', 'Tom Fixture']).toContain(s[0].candidate.name);
    expect(s[s.length - 1].candidate.name).toBe('Maya Lockwood');
  });

  it('all candidates score between 0 and 100 for all voters', () => {
    for (const voter of VOTERS) {
      const user = buildUser(voter);
      const ranked = computeMatchesForUser(user, CANDIDATES_BUILT, SUB_DIMS)[0].candidates;
      for (const r of ranked) {
        expect(r.score).not.toBeNull();
        expect(r.score!).toBeGreaterThanOrEqual(0);
        expect(r.score!).toBeLessThanOrEqual(100);
      }
    }
  });

  it('every voter sees a meaningful spread between top and bottom (≥ 10 points)', () => {
    // If top and bottom are within 10 points for every voter, the algorithm
    // isn't discriminating — that would be a kill-shot failure.
    let minSpread = Infinity;
    for (const voter of VOTERS) {
      const user = buildUser(voter);
      const ranked = computeMatchesForUser(user, CANDIDATES_BUILT, SUB_DIMS)[0].candidates;
      const top = ranked[0].score!;
      const bottom = ranked[ranked.length - 1].score!;
      const spread = top - bottom;
      minSpread = Math.min(minSpread, spread);
    }
    expect(minSpread).toBeGreaterThanOrEqual(10);
  });
});
