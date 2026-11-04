/**
 * Tests for the AXIS-WEIGHT composition and loader (doc 09 Part 3.4).
 *
 * These exercise the PURE functions only - no database. The DB loader
 * (loadAxisWeightsForRace) is intentionally not unit-tested here: it is a thin
 * fetch-and-compose shell over the pure functions, and the project's sandbox
 * cannot run a live Supabase. A Windows-side vitest run against the live local
 * DB is the place to integration-test the loader end to end.
 *
 * Run on Windows:  cd app && npm run test:matcher
 * (The cowork Linux sandbox cannot run vitest reliably: Windows-native
 * node_modules + the stale FUSE mount. These tests are authored against the
 * documented contract and verified by Read/tsc here; a Windows run is required
 * to execute them.)
 */

import { describe, it, expect } from 'vitest';
import {
  competenceMaskForAxis,
  jurisdictionSalienceForAxis,
  composeAxisWeights,
  axisUid,
  INDIRECT_FACTOR,
  WEIGHT_EPSILON,
  toUspsCode,
  type AxisAuthorityRequirement,
  type OfficeAuthority,
} from '@/lib/matching/axis-weights';

// ---------------------------------------------------------------------------
// axisUid format (must match v_axis_positions.axis_uid exactly)
// ---------------------------------------------------------------------------

describe('axisUid format', () => {
  it('builds the primary-axis uid with the literal "primary" tail', () => {
    expect(
      axisUid({ sub_dimension_id: 'sd1', axis_kind: 'sub_dimension', axis_id: null }),
    ).toBe('sd1:sub_dimension:primary');
  });

  it('builds a backbone-axis uid with its axis_id', () => {
    expect(
      axisUid({ sub_dimension_id: 'sd1', axis_kind: 'backbone', axis_id: 'b1' }),
    ).toBe('sd1:backbone:b1');
  });

  it('treats undefined axis_id the same as null (primary)', () => {
    expect(axisUid({ sub_dimension_id: 'sd1', axis_kind: 'proposition' })).toBe(
      'sd1:proposition:primary',
    );
  });
});

// ---------------------------------------------------------------------------
// competenceMaskForAxis: the three office-authority cases (doc 09 Part 3.2)
// ---------------------------------------------------------------------------

describe('competenceMaskForAxis', () => {
  // An education axis requires the 'education' authority domain at a legislative
  // (strong) mode - the seed's education mapping.
  const educationReq: AxisAuthorityRequirement[] = [
    {
      required_authority_domain: 'education',
      authority_subdomain: null,
      min_authority_mode: 'legislative',
    },
  ];

  // An abortion-style axis that a body sets legislatively. The governor case
  // below shows the indirect down-weight when the office can only veto.
  const reproductiveReq: AxisAuthorityRequirement[] = [
    {
      required_authority_domain: 'social_services',
      authority_subdomain: null,
      min_authority_mode: 'legislative',
    },
  ];

  it('returns 0 (DROP) when the office holds no required domain - a sheriff drops education', () => {
    // Sheriff: public_safety + justice, executive mode. No 'education' domain.
    const sheriff: OfficeAuthority = {
      domains: ['public_safety', 'justice'],
      mode: 'executive',
    };
    expect(competenceMaskForAxis(educationReq, sheriff)).toBe(0);
  });

  it('returns 1 (KEEP) when the office holds the required domain at a strong-enough mode - a school board keeps education', () => {
    // School board: education domain, legislative mode (a direct actor).
    const schoolBoard: OfficeAuthority = {
      domains: ['education'],
      mode: 'legislative',
    };
    expect(competenceMaskForAxis(educationReq, schoolBoard)).toBe(1);
  });

  it('returns INDIRECT_FACTOR when the office holds the domain but only at a weak mode - a governor can only veto', () => {
    // Governor as modeled here: holds the social_services domain but in a weak
    // (advisory/confirming) posture for this axis - the veto-only lever. The
    // axis is down-weighted, not dropped.
    const governorVetoOnly: OfficeAuthority = {
      domains: ['social_services', 'fiscal', 'public_safety'],
      mode: 'advisory', // weaker than the legislative the axis requires
    };
    expect(competenceMaskForAxis(reproductiveReq, governorVetoOnly)).toBe(INDIRECT_FACTOR);
    expect(INDIRECT_FACTOR).toBeGreaterThan(0);
    expect(INDIRECT_FACTOR).toBeLessThan(1);
  });

  it('keeps the axis when ANY of several required domains is held at strong mode', () => {
    // criminal_justice requires public_safety (executive) OR justice (legislative).
    const criminalJusticeReq: AxisAuthorityRequirement[] = [
      { required_authority_domain: 'public_safety', authority_subdomain: null, min_authority_mode: 'executive' },
      { required_authority_domain: 'justice', authority_subdomain: null, min_authority_mode: 'legislative' },
    ];
    // Sheriff holds public_safety at executive -> direct on that requirement.
    const sheriff: OfficeAuthority = { domains: ['public_safety', 'justice'], mode: 'executive' };
    expect(competenceMaskForAxis(criminalJusticeReq, sheriff)).toBe(1);
  });

  it('returns 1 (ungated) for an axis with no authority requirements at all', () => {
    const office: OfficeAuthority = { domains: ['education'], mode: 'legislative' };
    expect(competenceMaskForAxis([], office)).toBe(1);
  });

  it('does not subdomain-drop: a water district whose row only says utilities still keeps a water axis', () => {
    // Water axis requires health_environment/water OR utilities/water at legislative.
    const waterReq: AxisAuthorityRequirement[] = [
      { required_authority_domain: 'health_environment', authority_subdomain: 'water', min_authority_mode: 'legislative' },
      { required_authority_domain: 'utilities', authority_subdomain: 'water', min_authority_mode: 'legislative' },
    ];
    // The office row only lists the coarse 'utilities' domain (no subdomain on the
    // office). The conservative rule keeps the axis (domain match is sufficient).
    const waterDistrict: OfficeAuthority = { domains: ['utilities'], mode: 'legislative' };
    expect(competenceMaskForAxis(waterReq, waterDistrict)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// jurisdictionSalienceForAxis: cluster RAISES salience (doc 09 Part 3.3)
// ---------------------------------------------------------------------------

describe('jurisdictionSalienceForAxis', () => {
  it('returns the baseline when there is no cluster (the Maine-water case)', () => {
    // A low water baseline, no cluster modifier (Maine is not in Western Water).
    expect(jurisdictionSalienceForAxis(0.2, [])).toBeCloseTo(0.2, 10);
  });

  it('is HIGHER for a Western Water axis in Utah than the same axis with no cluster', () => {
    const baseline = 0.5;
    const noCluster = jurisdictionSalienceForAxis(baseline, []);
    // Utah is in Western Water; the cluster raises water salience to ~0.95.
    const utahWater = jurisdictionSalienceForAxis(baseline, [0.95]);
    expect(utahWater).toBeGreaterThan(noCluster);
    expect(utahWater).toBeCloseTo(0.95, 10);
  });

  it('never LOWERS salience below baseline - a cluster raises, it does not dilute', () => {
    // A cluster modifier below the baseline must not drag the result down (MAX,
    // not product: 0.5 * 0.3 would wrongly be 0.15).
    expect(jurisdictionSalienceForAxis(0.5, [0.3])).toBeCloseTo(0.5, 10);
  });

  it('lets a jurisdiction override win when it is the strongest signal', () => {
    expect(jurisdictionSalienceForAxis(0.4, [0.6], 0.9)).toBeCloseTo(0.9, 10);
  });

  it('clamps the composed value to [0,1]', () => {
    expect(jurisdictionSalienceForAxis(1.5, [2.0])).toBe(1);
    expect(jurisdictionSalienceForAxis(-0.5, [])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// composeAxisWeights: multiply, normalize, drop masked, M4 guards (Part 3.4)
// ---------------------------------------------------------------------------

describe('composeAxisWeights', () => {
  it('multiplies competence x jurisdiction x voter and normalizes to sum 1.0', () => {
    const axes = ['a', 'b'];
    const out = composeAxisWeights({
      axes,
      competenceByAxisUid: new Map([['a', 1], ['b', 1]]),
      jurisdictionSalienceByAxisUid: new Map([['a', 0.8], ['b', 0.4]]),
      voterSalienceByAxisUid: new Map([['a', 1], ['b', 1]]),
    });
    // raw: a = 0.8, b = 0.4, sum 1.2 -> a = 2/3, b = 1/3.
    expect(out.get('a')).toBeCloseTo(2 / 3, 6);
    expect(out.get('b')).toBeCloseTo(1 / 3, 6);
    const sum = [...out.values()].reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });

  it('applies the INDIRECT down-weight as a multiplicative factor', () => {
    const out = composeAxisWeights({
      axes: ['direct', 'indirect'],
      competenceByAxisUid: new Map([['direct', 1], ['indirect', INDIRECT_FACTOR]]),
      jurisdictionSalienceByAxisUid: new Map([['direct', 0.5], ['indirect', 0.5]]),
      voterSalienceByAxisUid: new Map([['direct', 1], ['indirect', 1]]),
    });
    // raw: direct = 0.5, indirect = 0.5*INDIRECT_FACTOR. With 0.5 factor:
    // direct = 0.5, indirect = 0.25, sum 0.75 -> direct = 2/3, indirect = 1/3.
    expect(out.get('direct')! / out.get('indirect')!).toBeCloseTo(1 / INDIRECT_FACTOR, 6);
  });

  it('DROPS competence==0 axes before weighting', () => {
    const out = composeAxisWeights({
      axes: ['keep', 'masked'],
      competenceByAxisUid: new Map([['keep', 1], ['masked', 0]]),
      jurisdictionSalienceByAxisUid: new Map([['keep', 0.5], ['masked', 0.95]]),
      voterSalienceByAxisUid: new Map([['keep', 1], ['masked', 1]]),
    });
    expect(out.has('masked')).toBe(false);
    // The single survivor normalizes to exactly 1.0 (see single-survivor test).
    expect(out.get('keep')).toBeCloseTo(1.0, 10);
  });

  it('normalizes a SINGLE surviving axis to exactly 1.0', () => {
    const out = composeAxisWeights({
      axes: ['only'],
      competenceByAxisUid: new Map([['only', 1]]),
      jurisdictionSalienceByAxisUid: new Map([['only', 0.3]]),
      voterSalienceByAxisUid: new Map([['only', 0.7]]),
    });
    expect(out.size).toBe(1);
    expect(out.get('only')).toBeCloseTo(1.0, 10);
  });

  it('hits the M4 sum==0 guard: all competence 0 returns an EMPTY map', () => {
    const out = composeAxisWeights({
      axes: ['a', 'b'],
      competenceByAxisUid: new Map([['a', 0], ['b', 0]]),
      jurisdictionSalienceByAxisUid: new Map([['a', 0.9], ['b', 0.9]]),
      voterSalienceByAxisUid: new Map([['a', 1], ['b', 1]]),
    });
    expect(out.size).toBe(0);
  });

  it('hits the M4 sum<=epsilon guard: all-zero salience returns an EMPTY map', () => {
    // Surviving axes (competence 1) but jurisdiction salience and voter salience
    // both 0 -> raw sum 0 -> empty (insufficient), never a divide-by-zero.
    const out = composeAxisWeights({
      axes: ['a', 'b'],
      competenceByAxisUid: new Map([['a', 1], ['b', 1]]),
      jurisdictionSalienceByAxisUid: new Map([['a', 0], ['b', 0]]),
      voterSalienceByAxisUid: new Map([['a', 1], ['b', 1]]),
    });
    expect(out.size).toBe(0);
  });

  it('defaults missing inputs sensibly (competence 1, jurisdiction 0.5, voter 1)', () => {
    const out = composeAxisWeights({
      axes: ['a', 'b'],
      competenceByAxisUid: new Map(), // both default to 1
      jurisdictionSalienceByAxisUid: new Map(), // both default to 0.5
      voterSalienceByAxisUid: new Map(), // both default to 1
    });
    // Equal raw weights -> 0.5 each.
    expect(out.get('a')).toBeCloseTo(0.5, 6);
    expect(out.get('b')).toBeCloseTo(0.5, 6);
  });

  it('keeps the survivor sum at 1.0 after the epsilon floor on a near-zero weight', () => {
    const out = composeAxisWeights({
      axes: ['big', 'tiny'],
      competenceByAxisUid: new Map([['big', 1], ['tiny', 1]]),
      // tiny gets a genuinely tiny but non-zero jurisdiction salience.
      jurisdictionSalienceByAxisUid: new Map([['big', 1], ['tiny', WEIGHT_EPSILON / 10]]),
      voterSalienceByAxisUid: new Map([['big', 1], ['tiny', 1]]),
    });
    const sum = [...out.values()].reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1.0, 6);
    // Both survive (tiny's competence is 1, so it is not dropped), and big dominates.
    expect(out.get('big')!).toBeGreaterThan(out.get('tiny')!);
  });
});

// ---------------------------------------------------------------------------
// toUspsCode: state-code normalization for the cluster membership test
// ---------------------------------------------------------------------------

describe('toUspsCode', () => {
  it('passes a USPS code through, uppercased', () => {
    expect(toUspsCode('ut')).toBe('UT');
    expect(toUspsCode('UT')).toBe('UT');
  });

  it('maps a FIPS code to USPS (49 -> UT)', () => {
    expect(toUspsCode('49')).toBe('UT');
    expect(toUspsCode('06')).toBe('CA');
    expect(toUspsCode('6')).toBe('CA'); // single-digit FIPS is zero-padded
  });

  it('returns null for empty/unknown input (safe degrade to baseline salience)', () => {
    expect(toUspsCode(null)).toBeNull();
    expect(toUspsCode('')).toBeNull();
    expect(toUspsCode('99')).toBeNull();
    expect(toUspsCode('garbage')).toBeNull();
  });
});
