import { describe, it, expect, vi } from 'vitest';
import {
  numericDistrict,
  resolveElectionIdsForDistricts,
  type ContainingDistrict,
} from '../district-lookup';

describe('numericDistrict', () => {
  it('strips zero-padding and prose', () => {
    expect(numericDistrict('05')).toBe('5');
    expect(numericDistrict('014')).toBe('14');
    expect(numericDistrict('District 5')).toBe('5');
    expect(numericDistrict('Senate District 20')).toBe('20');
    expect(numericDistrict('5')).toBe('5');
  });
  it('returns null for non-numeric / empty seat designations', () => {
    expect(numericDistrict('Junior Seat')).toBeNull();
    expect(numericDistrict('')).toBeNull();
    expect(numericDistrict(null)).toBeNull();
    expect(numericDistrict(undefined)).toBeNull();
  });
});

/**
 * A tiny fake supabase that returns a fixed office set from `.from('offices')`.
 * We only exercise resolveElectionIdsForDistricts' matching + dedup, so we stub
 * the query builder to resolve to our rows regardless of the chained filters.
 */
function fakeSupabase(officeRows: unknown[]) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain;
  builder.eq = chain;
  builder.in = chain;
  // Make it awaitable (thenable) so `await supabase.from(...).select(...)....`
  // resolves to { data, error }.
  builder.then = (resolve: (v: { data: unknown[]; error: null }) => void) =>
    resolve({ data: officeRows, error: null });
  return {
    from: () => builder,
  } as unknown as Parameters<typeof resolveElectionIdsForDistricts>[1];
}

const AZ_DISTRICTS: ContainingDistrict[] = [
  { district_type: 'us_congressional', district_number: '05', district_name: 'CD5', state_fips: '04' },
  { district_type: 'state_house', district_number: '014', district_name: 'LD14', state_fips: '04' },
  { district_type: 'state_senate', district_number: '014', district_name: 'LD14', state_fips: '04' },
];

describe('resolveElectionIdsForDistricts', () => {
  it('matches districted offices by numeric district and includes statewide offices', async () => {
    const rows = [
      // CD5 house rep — voter is in CD5, keep
      { id: 'o-cd5', level: 'federal', seat_designation: 'District 5', meta: { data_quality_tier: 'authoritative' },
        office_type: { slug: 'us_representative' }, jurisdiction: { fips_state: '04' },
        elections: [{ id: 'e-cd5', election_date: '2026-07-21', election_type: 'primary', candidacies: [{ count: 13 }] }] },
      // CD9 house rep — voter NOT in CD9, drop
      { id: 'o-cd9', level: 'federal', seat_designation: 'District 9', meta: { data_quality_tier: 'authoritative' },
        office_type: { slug: 'us_representative' }, jurisdiction: { fips_state: '04' },
        elections: [{ id: 'e-cd9', election_date: '2026-07-21', election_type: 'primary', candidacies: [{ count: 3 }] }] },
      // LD14 house — keep
      { id: 'o-ld14h', level: 'state', seat_designation: 'District 14', meta: { data_quality_tier: 'compiled' },
        office_type: { slug: 'state_representative' }, jurisdiction: { fips_state: '04' },
        elections: [{ id: 'e-ld14h', election_date: '2026-07-21', election_type: 'primary', candidacies: [{ count: 4 }] }] },
      // Governor — statewide, keep
      { id: 'o-gov', level: 'state', seat_designation: null, meta: { data_quality_tier: 'authoritative' },
        office_type: { slug: 'governor' }, jurisdiction: { fips_state: '04' },
        elections: [{ id: 'e-gov', election_date: '2026-07-21', election_type: 'primary', candidacies: [{ count: 8 }] }] },
    ];
    const { electionIds } = await resolveElectionIdsForDistricts(
      AZ_DISTRICTS,
      fakeSupabase(rows),
      { todayIso: '2026-07-01' },
    );
    expect(electionIds.sort()).toEqual(['e-cd5', 'e-gov', 'e-ld14h'].sort());
    expect(electionIds).not.toContain('e-cd9');
  });

  it('dedups duplicate offices preferring the one with candidacies (not the empty authoritative seat)', async () => {
    // Same district+type covered by BOTH a compiled office (with candidates)
    // and an authoritative office (empty). The compiled one must win.
    const rows = [
      { id: 'o-compiled', level: 'state', seat_designation: 'District 14', meta: { data_quality_tier: 'compiled' },
        office_type: { slug: 'state_representative' }, jurisdiction: { fips_state: '04' },
        elections: [{ id: 'e-compiled', election_date: '2026-07-21', election_type: 'primary', candidacies: [{ count: 4 }] }] },
      { id: 'o-auth-empty', level: 'state', seat_designation: 'District 14', meta: { data_quality_tier: 'authoritative' },
        office_type: { slug: 'state_representative' }, jurisdiction: { fips_state: '04' },
        elections: [{ id: 'e-auth-empty', election_date: '2026-07-21', election_type: 'primary', candidacies: [{ count: 0 }] }] },
    ];
    const { electionIds } = await resolveElectionIdsForDistricts(
      AZ_DISTRICTS,
      fakeSupabase(rows),
      { todayIso: '2026-07-01' },
    );
    expect(electionIds).toEqual(['e-compiled']);
    expect(electionIds).not.toContain('e-auth-empty');
  });

  it('collapses primary + later general for the same office to the nearest upcoming (the primary)', async () => {
    // DELIBERATE EXPECTATION CHANGE (AZ July-21 render-defect fix): this test
    // previously asserted the resolver kept BOTH the primary and the general
    // election IDs for one office. That behavior was the blocker: the ballot
    // page then rendered the seat twice — a candidate-bearing primary card AND
    // an empty "No candidates" general card — for every office. The product
    // rule is now "when an office has an upcoming primary and a later general,
    // surface ONLY the nearest upcoming election (the primary)." So the
    // resolver must emit just the primary's ID here, not both.
    const rows = [
      { id: 'o-gov', level: 'state', seat_designation: null, meta: { data_quality_tier: 'authoritative' },
        office_type: { slug: 'governor' }, jurisdiction: { fips_state: '04' },
        elections: [
          { id: 'e-gov-primary', election_date: '2026-07-21', election_type: 'primary', candidacies: [{ count: 8 }] },
          { id: 'e-gov-general', election_date: '2026-11-03', election_type: 'general', candidacies: [{ count: 0 }] },
        ] },
    ];
    const { electionIds } = await resolveElectionIdsForDistricts(
      AZ_DISTRICTS,
      fakeSupabase(rows),
      { todayIso: '2026-07-01' },
    );
    expect(electionIds).toEqual(['e-gov-primary']);
    expect(electionIds).not.toContain('e-gov-general');
  });

  it('surfaces the general when only a general exists (no primary for the seat)', async () => {
    // The other half of the product rule: a seat whose only upcoming election
    // is the general must still surface that general.
    const rows = [
      { id: 'o-gov', level: 'state', seat_designation: null, meta: { data_quality_tier: 'authoritative' },
        office_type: { slug: 'governor' }, jurisdiction: { fips_state: '04' },
        elections: [
          { id: 'e-gov-general', election_date: '2026-11-03', election_type: 'general', candidacies: [{ count: 5 }] },
        ] },
    ];
    const { electionIds } = await resolveElectionIdsForDistricts(
      AZ_DISTRICTS,
      fakeSupabase(rows),
      { todayIso: '2026-07-01' },
    );
    expect(electionIds).toEqual(['e-gov-general']);
  });

  it('drops past elections', async () => {
    const rows = [
      { id: 'o-gov', level: 'state', seat_designation: null, meta: { data_quality_tier: 'authoritative' },
        office_type: { slug: 'governor' }, jurisdiction: { fips_state: '04' },
        elections: [{ id: 'e-past', election_date: '2024-11-05', election_type: 'general', candidacies: [{ count: 2 }] }] },
    ];
    const { electionIds } = await resolveElectionIdsForDistricts(
      AZ_DISTRICTS,
      fakeSupabase(rows),
      { todayIso: '2026-07-01' },
    );
    expect(electionIds).toEqual([]);
  });

  it('returns empty when no district carries a state_fips', async () => {
    const { electionIds, stateFips } = await resolveElectionIdsForDistricts(
      [{ district_type: 'us_congressional', district_number: '05', district_name: null, state_fips: null }],
      fakeSupabase([]),
      { todayIso: '2026-07-01' },
    );
    expect(stateFips).toBeNull();
    expect(electionIds).toEqual([]);
  });
});

// Silence any incidental console.warn from the module under test.
vi.spyOn(console, 'warn').mockImplementation(() => {});
