import { SupabaseClient } from '@supabase/supabase-js';
import type { SubDimension, Race, Candidate, Position, Confidence } from '@/types/database';

// ============================================================
// Sub-Dimensions (20 across 8 domains)
// ============================================================

interface SubDimensionSeed {
  domain: string;
  name: string;
  spectrum_low: string;
  spectrum_high: string;
  display_order: number;
}

const SUB_DIMENSIONS: SubDimensionSeed[] = [
  // Economy (1-3)
  {
    domain: 'economy',
    name: 'taxes',
    spectrum_low: 'Lower taxes, smaller government revenue',
    spectrum_high: 'Higher taxes to fund public services',
    display_order: 1,
  },
  {
    domain: 'economy',
    name: 'government_spending',
    spectrum_low: 'Reduce government spending significantly',
    spectrum_high: 'Increase government investment in public programs',
    display_order: 2,
  },
  {
    domain: 'economy',
    name: 'business_regulation',
    spectrum_low: 'Minimal regulation, free-market approach',
    spectrum_high: 'Strong regulation to protect consumers and workers',
    display_order: 3,
  },

  // Social (4-6)
  {
    domain: 'social',
    name: 'immigration',
    spectrum_low: 'Restrict immigration, strengthen enforcement',
    spectrum_high: 'Expand legal immigration pathways',
    display_order: 4,
  },
  {
    domain: 'social',
    name: 'civil_rights',
    spectrum_low: 'Prioritize traditional social structures',
    spectrum_high: 'Expand civil rights protections for all groups',
    display_order: 5,
  },
  {
    domain: 'social',
    name: 'religious_liberty',
    spectrum_low: 'Protect religious exemptions broadly',
    spectrum_high: 'Limit religious exemptions when they conflict with civil law',
    display_order: 6,
  },

  // Healthcare (7-8)
  {
    domain: 'healthcare',
    name: 'insurance_coverage',
    spectrum_low: 'Market-based healthcare, reduce mandates',
    spectrum_high: 'Expand public health insurance coverage',
    display_order: 7,
  },
  {
    domain: 'healthcare',
    name: 'reproductive_rights',
    spectrum_low: 'Restrict abortion access',
    spectrum_high: 'Protect broad access to reproductive healthcare',
    display_order: 8,
  },

  // Education (9-10)
  {
    domain: 'education',
    name: 'school_choice',
    spectrum_low: 'Strengthen traditional public school systems',
    spectrum_high: 'Expand school choice through vouchers and charters',
    display_order: 9,
  },
  {
    domain: 'education',
    name: 'public_school_funding',
    spectrum_low: 'Reduce or hold public school spending',
    spectrum_high: 'Significantly increase public school funding',
    display_order: 10,
  },

  // Environment (11-13)
  {
    domain: 'environment',
    name: 'energy_policy',
    spectrum_low: 'Prioritize fossil fuel production and energy independence',
    spectrum_high: 'Accelerate transition to renewable energy sources',
    display_order: 11,
  },
  {
    domain: 'environment',
    name: 'public_lands',
    spectrum_low: 'Transfer federal lands to state/local control',
    spectrum_high: 'Maintain federal stewardship and expand protections',
    display_order: 12,
  },
  {
    domain: 'environment',
    name: 'water_rights',
    spectrum_low: 'Prioritize agricultural and development water use',
    spectrum_high: 'Strengthen conservation and environmental water protections',
    display_order: 13,
  },

  // Governance (14-15)
  {
    domain: 'governance',
    name: 'election_reform',
    spectrum_low: 'Maintain current election systems, tighten voter ID',
    spectrum_high: 'Expand voting access, ranked-choice or open primaries',
    display_order: 14,
  },
  {
    domain: 'governance',
    name: 'government_transparency',
    spectrum_low: 'Allow operational discretion for government agencies',
    spectrum_high: 'Mandate open data, audits, and public accountability',
    display_order: 15,
  },

  // Public Safety (16-17)
  {
    domain: 'public_safety',
    name: 'gun_policy',
    spectrum_low: 'Protect gun rights with minimal restrictions',
    spectrum_high: 'Enact stricter gun safety regulations',
    display_order: 16,
  },
  {
    domain: 'public_safety',
    name: 'criminal_justice',
    spectrum_low: 'Tough-on-crime policies, stronger sentencing',
    spectrum_high: 'Reform-oriented approach, reduce incarceration',
    display_order: 17,
  },

  // Infrastructure (18-20 — using 18-19 for the two defined)
  {
    domain: 'infrastructure',
    name: 'housing',
    spectrum_low: 'Let the market determine housing supply and prices',
    spectrum_high: 'Government intervention to increase affordable housing',
    display_order: 18,
  },
  {
    domain: 'infrastructure',
    name: 'transportation',
    spectrum_low: 'Prioritize roads and individual vehicle infrastructure',
    spectrum_high: 'Invest in public transit and multimodal transportation',
    display_order: 19,
  },
];

// ============================================================
// Sample Races — Utah 2026 Primary
// ============================================================

interface RaceSeed {
  key: string; // local reference key (not stored)
  name: string;
  level: string;
  district: string | null;
  election_date: string;
  type: string;
}

const RACES: RaceSeed[] = [
  {
    key: 'us_senate',
    name: 'U.S. Senate — Utah',
    level: 'federal',
    district: null,
    election_date: '2026-06-30',
    type: 'primary',
  },
  {
    key: 'us_house_1',
    name: 'U.S. House — Utah 1st District',
    level: 'federal',
    district: 'UT-1',
    election_date: '2026-06-30',
    type: 'primary',
  },
  {
    key: 'ut_governor',
    name: 'Governor of Utah',
    level: 'state',
    district: null,
    election_date: '2026-06-30',
    type: 'primary',
  },
  {
    key: 'ut_senate_17',
    name: 'Utah State Senate — District 17',
    level: 'state',
    district: 'UT-SD-17',
    election_date: '2026-06-30',
    type: 'primary',
  },
  {
    key: 'weber_commission',
    name: 'Weber County Commission Seat A',
    level: 'county',
    district: 'Weber',
    election_date: '2026-06-30',
    type: 'primary',
  },
];

// ============================================================
// Sample Candidates
// ============================================================
//
// SAFETY: every entry here is FICTIONAL. The names are realistic-sounding
// on purpose (so demos look plausible), which means a real ingested
// candidate could legitimately share a name with one of these rows.
//
// Two guards protect against overwriting real production data:
//   1. The SEED_PUBLISH env var — `seedCandidates` no-ops unless
//      `process.env.SEED_PUBLISH === 'true'`. The reference data
//      (sub_dimensions, races) still seeds without the flag, so dev
//      onboarding doesn't break.
//   2. Each row carries `meta = { seed_id, is_seed: true }`. The upsert
//      uses `meta->>'seed_id'` as `onConflict` (backed by a partial
//      unique index added in migration 20260425000005), which is
//      guaranteed unique to seed rows — real candidates have meta=NULL.
//
// To remove fictional rows from a live DB, run the cleanup migration
// `20260425000005_remove_seed_candidates.sql`.

interface CandidateSeed {
  name: string;
  party: string;
  raceKey: string; // matches RaceSeed.key
  bio: string;
  published: boolean;
  seedId: string; // stable, fictional, never collides with real ingestion
}

const CANDIDATES: CandidateSeed[] = [
  // US Senate (2)
  {
    name: 'Margaret Sampleton',
    party: 'Republican',
    raceKey: 'us_senate',
    bio: 'Former state legislator and business owner from Provo. Served two terms in the Utah House representing District 62.',
    published: true,
    seedId: 'bb-seed-001-margaret-sampleton',
  },
  {
    name: 'Carlos Fictivo',
    party: 'Democrat',
    raceKey: 'us_senate',
    bio: 'Civil rights attorney and community organizer from Salt Lake City. Founded the Utah Civic Engagement Coalition.',
    published: true,
    seedId: 'bb-seed-002-carlos-fictivo',
  },

  // US House UT-1 (2)
  {
    name: 'Dana Exampleson',
    party: 'Republican',
    raceKey: 'us_house_1',
    bio: 'Retired Air Force colonel and Logan city council member. Advocates for veterans and rural communities.',
    published: true,
    seedId: 'bb-seed-003-dana-exampleson',
  },
  {
    name: 'Sarah Placeholder',
    party: 'Republican',
    raceKey: 'us_house_1',
    bio: 'Small business owner from Ogden running on fiscal conservatism and education reform.',
    published: true,
    seedId: 'bb-seed-004-sarah-placeholder',
  },

  // Governor (2)
  {
    name: 'Robin Testwell',
    party: 'Republican',
    raceKey: 'ut_governor',
    bio: 'Current Lt. Governor with a background in tech entrepreneurship. Focused on economic growth and infrastructure.',
    published: true,
    seedId: 'bb-seed-005-robin-testwell',
  },
  {
    name: 'Linda Mockwood',
    party: 'Democrat',
    raceKey: 'ut_governor',
    bio: 'Environmental scientist and former Salt Lake County mayor. Priorities include clean air and water policy.',
    published: true,
    seedId: 'bb-seed-006-linda-mockwood',
  },

  // State Senate District 17 (2)
  {
    name: 'Jamie Notreal',
    party: 'Republican',
    raceKey: 'ut_senate_17',
    bio: 'Attorney and local business leader in Roy. Active in community planning for northern Davis and Weber counties.',
    published: true,
    seedId: 'bb-seed-007-jamie-notreal',
  },
  {
    name: 'Priya Demoname',
    party: 'United Utah',
    raceKey: 'ut_senate_17',
    bio: 'High school principal and education advocate. Campaigning on bipartisan solutions for school funding.',
    published: true,
    seedId: 'bb-seed-008-priya-demoname',
  },

  // Weber County Commission (2)
  {
    name: 'Tom Fixture',
    party: 'Republican',
    raceKey: 'weber_commission',
    bio: 'Rancher and small business owner from Huntsville. Focused on water rights and county spending.',
    published: true,
    seedId: 'bb-seed-009-tom-fixture',
  },
  {
    name: 'Angela Fakerly',
    party: 'Democrat',
    raceKey: 'weber_commission',
    bio: 'Non-profit director from Ogden working on housing affordability and public transit access.',
    published: true,
    seedId: 'bb-seed-010-angela-fakerly',
  },
];

// ============================================================
// Position Generator
// Generates realistic positions for each candidate across
// a subset of sub_dimensions relevant to their race level.
// ============================================================

function generatePositions(
  candidateId: string,
  subDimensions: { id: string; name: string }[],
  party: string
): Omit<Position, 'id' | 'created_at'>[] {
  // Base lean: Republican candidates lean low (0.2-0.4), Democrats lean high (0.6-0.8)
  // United Utah is centrist (0.4-0.6)
  const baseLow = party === 'Republican' ? 0.15 : party === 'Democrat' ? 0.55 : 0.35;
  const baseHigh = party === 'Republican' ? 0.45 : party === 'Democrat' ? 0.85 : 0.65;

  // Deterministic pseudo-random based on candidateId hash
  let seed = candidateId
    .split('')
    .reduce((acc, c) => acc + c.charCodeAt(0), 0);
  function nextRand(): number {
    seed = (seed * 16807 + 7) % 2147483647;
    return (seed % 1000) / 1000;
  }

  return subDimensions.map((sd) => {
    const raw = baseLow + nextRand() * (baseHigh - baseLow);
    const score = Math.round(raw * 100) / 100;
    const conf: Confidence =
      nextRand() > 0.6 ? 'high' : nextRand() > 0.4 ? 'medium' : 'low';

    return {
      candidate_id: candidateId,
      sub_dimension_id: sd.id,
      score,
      confidence: conf,
      source_citations: [
        {
          url: `https://example.com/source/${sd.name}`,
          title: `${sd.name} policy page`,
          date: '2026-01-15',
        },
      ],
      nuance_notes: null,
      ai_summary: null,
      view_type: 'inferred' as const,
      extraction_audit_id: null,
    };
  });
}

// ============================================================
// Seed Functions
// ============================================================

export async function seedSubDimensions(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('sub_dimensions')
    .upsert(SUB_DIMENSIONS, { onConflict: 'name' })
    .select();

  if (error) throw new Error(`Failed to seed sub_dimensions: ${error.message}`);
  console.log(`Seeded ${data.length} sub_dimensions`);
  return data;
}

export async function seedRaces(supabase: SupabaseClient) {
  const racesWithoutKeys = RACES.map(({ key, ...rest }) => rest);
  const { data, error } = await supabase
    .from('races')
    .upsert(racesWithoutKeys, { onConflict: 'name' })
    .select();

  if (error) throw new Error(`Failed to seed races: ${error.message}`);
  console.log(`Seeded ${data.length} races`);

  // Return a map of key -> inserted race id
  const raceMap = new Map<string, string>();
  RACES.forEach((raceDef, i) => {
    const match = data.find((r: Race) => r.name === raceDef.name);
    if (match) raceMap.set(raceDef.key, match.id);
  });
  return raceMap;
}

/**
 * Seed the 10 fictional candidates and their dummy positions.
 *
 * SAFETY: skipped unless `SEED_PUBLISH=true`. The default behavior is to
 * NOT touch the candidates table — this prevents an accidental
 * `npm run db:seed` against a production project from overwriting real
 * ingested rows that share a name with one of the fictional seed entries
 * (a real candidate could share a name with a seed entry).
 *
 * Returns an empty array when the guard is off, which is correct: the
 * downstream `seedPositions` step then has no candidates to attach
 * dummy positions to, and skips cleanly.
 */
export async function seedCandidates(
  supabase: SupabaseClient,
  raceMap: Map<string, string>
) {
  if (process.env.SEED_PUBLISH !== 'true') {
    console.log(
      'Skipped candidate seed: set SEED_PUBLISH=true to insert the 10 fictional candidates. ' +
        'Reference data (sub_dimensions, races) was still seeded.'
    );
    return [] as Candidate[];
  }

  const candidateRows = CANDIDATES.map(({ raceKey, seedId, ...rest }) => ({
    ...rest,
    race_id: raceMap.get(raceKey)!,
    questionnaire_status: 'not_invited' as const,
    meta: { seed_id: seedId, is_seed: true },
  }));

  // Upsert on the synthetic seed_id (backed by the partial unique index
  // `candidates_meta_seed_id_unique` from migration 20260425000005).
  // This key is impossible to collide with real ingestion, which leaves
  // meta NULL.
  const { data, error } = await supabase
    .from('candidates')
    .upsert(candidateRows, { onConflict: 'meta->>seed_id' })
    .select();

  if (error) throw new Error(`Failed to seed candidates: ${error.message}`);
  console.log(`Seeded ${data.length} candidates (SEED_PUBLISH=true)`);
  return data as Candidate[];
}

export async function seedPositions(
  supabase: SupabaseClient,
  candidates: Candidate[],
  subDimensions: { id: string; name: string }[]
) {
  const allPositions = candidates.flatMap((c) => {
    const cSeed = CANDIDATES.find((cs) => cs.name === c.name);
    return generatePositions(c.id, subDimensions, cSeed?.party ?? 'Republican');
  });

  // Insert in batches of 100
  const batchSize = 100;
  let inserted = 0;
  for (let i = 0; i < allPositions.length; i += batchSize) {
    const batch = allPositions.slice(i, i + batchSize);
    const { error } = await supabase.from('positions').insert(batch);
    if (error) throw new Error(`Failed to seed positions batch: ${error.message}`);
    inserted += batch.length;
  }

  console.log(`Seeded ${inserted} positions`);
}

// ============================================================
// Main seeder — call with a service-role Supabase client
// ============================================================

export async function seedAll(supabase: SupabaseClient) {
  console.log('Starting Havesay seed...');

  const subDimensions = await seedSubDimensions(supabase);
  const raceMap = await seedRaces(supabase);
  const candidates = await seedCandidates(supabase, raceMap);
  await seedPositions(
    supabase,
    candidates,
    subDimensions.map((sd: SubDimension) => ({ id: sd.id, name: sd.name }))
  );

  console.log('Seed complete.');
}

// Export raw data for testing
export { SUB_DIMENSIONS, RACES, CANDIDATES };
