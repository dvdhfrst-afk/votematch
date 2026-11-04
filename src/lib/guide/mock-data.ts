/**
 * Mock data for the guide UX layer.
 *
 * Ships realistic Utah-2026 shaped scenarios so the drill-down can be
 * iterated end-to-end without hitting the DB. Deliberately mixes:
 *   - a federal race (US Senate) — most issues apply
 *   - a state race (UT Governor) — most issues apply with state framing
 *   - a local race (Salt Lake County Council) — many issues excluded by scope
 * …so the office-scope logic has actual data to act on.
 */

import type {
  Candidate,
  Issue,
  Race,
  VoterProfile,
} from './contract';

// ---------------------------------------------------------------------------
// Issues — the full taxonomy slice the mock uses
// ---------------------------------------------------------------------------

export const MOCK_ISSUES: Issue[] = [
  {
    id: 'iss_taxes',
    name: 'Tax policy',
    domain: 'economy',
    spectrum: { low: 'Lower taxes, smaller government', high: 'Higher taxes, larger programs' },
    description: 'How much revenue government should collect and who should pay.',
  },
  {
    id: 'iss_housing',
    name: 'Housing affordability',
    domain: 'economy',
    spectrum: { low: 'Private market drives supply', high: 'Public investment in housing' },
    description: 'Role of government in building, subsidising, or regulating housing.',
  },
  {
    id: 'iss_wages',
    name: 'Minimum wage',
    domain: 'economy',
    spectrum: { low: 'Keep wage floor low or remove it', high: 'Raise the minimum wage' },
  },
  {
    id: 'iss_healthcare_access',
    name: 'Healthcare access',
    domain: 'healthcare',
    spectrum: { low: 'Private insurance, market pricing', high: 'Single, public system' },
  },
  {
    id: 'iss_reproductive',
    name: 'Reproductive rights',
    domain: 'healthcare',
    spectrum: { low: 'Strict restrictions', high: 'Broad legal access' },
  },
  {
    id: 'iss_public_schools',
    name: 'Public school funding',
    domain: 'education',
    spectrum: { low: 'More school choice, vouchers', high: 'Fund public schools as primary' },
  },
  {
    id: 'iss_higher_ed',
    name: 'Higher education cost',
    domain: 'education',
    spectrum: { low: 'Market-based tuition', high: 'Public subsidy of college' },
  },
  {
    id: 'iss_climate',
    name: 'Climate action',
    domain: 'environment',
    spectrum: { low: 'Keep producing fossil fuels', high: 'Rapid shift to clean energy' },
  },
  {
    id: 'iss_public_lands',
    name: 'Public lands',
    domain: 'environment',
    spectrum: { low: 'Shift land to state/private', high: 'Expand federal protections' },
  },
  {
    id: 'iss_water',
    name: 'Water policy',
    domain: 'environment',
    spectrum: { low: 'Protect current water rights', high: 'Reallocate for conservation' },
  },
  {
    id: 'iss_immigration',
    name: 'Immigration policy',
    domain: 'social',
    spectrum: { low: 'Tighter limits, more enforcement', high: 'Broader pathways to citizenship' },
  },
  {
    id: 'iss_guns',
    name: 'Gun policy',
    domain: 'public_safety',
    spectrum: { low: 'Few restrictions', high: 'Broader regulation' },
  },
  {
    id: 'iss_policing',
    name: 'Policing approach',
    domain: 'public_safety',
    spectrum: { low: 'Fund and expand police', high: 'Reform and community investment' },
  },
  {
    id: 'iss_elections',
    name: 'Election administration',
    domain: 'governance',
    spectrum: { low: 'Tighter voter ID and rolls', high: 'Expand access and registration' },
  },
  {
    id: 'iss_transit',
    name: 'Public transit',
    domain: 'infrastructure',
    spectrum: { low: 'Car-first, road spending', high: 'Invest in buses, rail, bike' },
  },
  {
    id: 'iss_zoning',
    name: 'Zoning and density',
    domain: 'infrastructure',
    spectrum: { low: 'Preserve single-family zoning', high: 'Upzone for density' },
  },
];

// Office-scope: which issues count, which are context, which are hidden
// per office level. Mirrors what scope_applicability does in the DB.
type ScopeMap = Partial<Record<string, 'counts' | 'context_only' | 'not_applicable'>>;

export const SCOPE_BY_OFFICE: Record<Race['officeLevel'], ScopeMap> = {
  federal: {
    iss_taxes: 'counts',
    iss_housing: 'context_only',
    iss_wages: 'counts',
    iss_healthcare_access: 'counts',
    iss_reproductive: 'counts',
    iss_public_schools: 'context_only',
    iss_higher_ed: 'counts',
    iss_climate: 'counts',
    iss_public_lands: 'counts',
    iss_water: 'context_only',
    iss_immigration: 'counts',
    iss_guns: 'counts',
    iss_policing: 'context_only',
    iss_elections: 'counts',
    iss_transit: 'context_only',
    iss_zoning: 'not_applicable',
  },
  state: {
    iss_taxes: 'counts',
    iss_housing: 'counts',
    iss_wages: 'counts',
    iss_healthcare_access: 'counts',
    iss_reproductive: 'counts',
    iss_public_schools: 'counts',
    iss_higher_ed: 'counts',
    iss_climate: 'counts',
    iss_public_lands: 'counts',
    iss_water: 'counts',
    iss_immigration: 'context_only',
    iss_guns: 'counts',
    iss_policing: 'counts',
    iss_elections: 'counts',
    iss_transit: 'counts',
    iss_zoning: 'counts',
  },
  county: {
    iss_taxes: 'context_only',
    iss_housing: 'counts',
    iss_wages: 'not_applicable',
    iss_healthcare_access: 'not_applicable',
    iss_reproductive: 'not_applicable',
    iss_public_schools: 'context_only',
    iss_higher_ed: 'not_applicable',
    iss_climate: 'context_only',
    iss_public_lands: 'counts',
    iss_water: 'counts',
    iss_immigration: 'not_applicable',
    iss_guns: 'context_only',
    iss_policing: 'counts',
    iss_elections: 'counts',
    iss_transit: 'counts',
    iss_zoning: 'counts',
  },
  municipal: {
    iss_housing: 'counts',
    iss_public_schools: 'context_only',
    iss_public_lands: 'context_only',
    iss_water: 'counts',
    iss_policing: 'counts',
    iss_elections: 'context_only',
    iss_transit: 'counts',
    iss_zoning: 'counts',
  },
  judicial: {
    iss_reproductive: 'context_only',
    iss_elections: 'context_only',
    iss_guns: 'context_only',
  },
  school_board: {
    iss_public_schools: 'counts',
    iss_higher_ed: 'context_only',
  },
  special_district: {
    iss_water: 'counts',
    iss_transit: 'counts',
  },
};

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

const CAND_SEN_A: Candidate = {
  id: 'cand_sen_a',
  name: 'Alex Rivera',
  party: 'Democratic',
  photoUrl: null,
  bio: 'Former state legislator. Focus on healthcare access and public lands.',
  websiteUrl: 'https://example.org/rivera',
  coverageTier: 'A',
  stances: [
    { candidateId: 'cand_sen_a', issueId: 'iss_taxes', score: 0.75, confidence: 'high', summary: 'Supports progressive tax reform and closing corporate loopholes.', sources: [{ url: 'https://example.org/rivera/econ', title: 'Rivera economic plan', tier: 'primary' }] },
    { candidateId: 'cand_sen_a', issueId: 'iss_wages', score: 0.82, confidence: 'high', summary: 'Supports raising federal minimum wage to $17/hr phased over 4 years.', sources: [{ url: 'https://example.org/rivera/wages', title: 'Minimum wage position', tier: 'primary' }] },
    { candidateId: 'cand_sen_a', issueId: 'iss_healthcare_access', score: 0.78, confidence: 'high', summary: 'Supports public option, opposes full single-payer.', sources: [{ url: 'https://example.org/rivera/health', title: 'Health plan', tier: 'primary' }] },
    { candidateId: 'cand_sen_a', issueId: 'iss_reproductive', score: 0.88, confidence: 'high', summary: 'Supports codifying reproductive access at the federal level.', sources: [] },
    { candidateId: 'cand_sen_a', issueId: 'iss_higher_ed', score: 0.7, confidence: 'medium', summary: 'Supports expanding Pell grants and income-driven repayment.', sources: [] },
    { candidateId: 'cand_sen_a', issueId: 'iss_climate', score: 0.85, confidence: 'high', summary: 'Backs aggressive clean-energy investment, phase-out of coal by 2035.', sources: [{ url: 'https://example.org/rivera/climate', title: 'Climate platform', tier: 'primary' }] },
    { candidateId: 'cand_sen_a', issueId: 'iss_public_lands', score: 0.8, confidence: 'high', summary: 'Supports Bears Ears expansion, opposes transfer to state control.', sources: [] },
    { candidateId: 'cand_sen_a', issueId: 'iss_immigration', score: 0.72, confidence: 'medium', summary: 'Supports path to citizenship for long-term residents, keeps border security funding.', sources: [] },
    { candidateId: 'cand_sen_a', issueId: 'iss_guns', score: 0.68, confidence: 'medium', summary: 'Supports universal background checks and red-flag laws. No assault-weapon ban.', sources: [] },
    { candidateId: 'cand_sen_a', issueId: 'iss_elections', score: 0.8, confidence: 'high', summary: 'Supports automatic voter registration and same-day registration.', sources: [] },
  ],
};

const CAND_SEN_B: Candidate = {
  id: 'cand_sen_b',
  name: 'Morgan Chen',
  party: 'Republican',
  photoUrl: null,
  bio: 'Small-business owner. Emphasis on fiscal restraint and local control.',
  websiteUrl: 'https://example.org/chen',
  coverageTier: 'A',
  stances: [
    { candidateId: 'cand_sen_b', issueId: 'iss_taxes', score: 0.2, confidence: 'high', summary: 'Supports making the 2017 tax cuts permanent, opposes new tax increases.', sources: [] },
    { candidateId: 'cand_sen_b', issueId: 'iss_wages', score: 0.25, confidence: 'medium', summary: 'Opposes federal minimum wage hikes; defers to state standards.', sources: [] },
    { candidateId: 'cand_sen_b', issueId: 'iss_healthcare_access', score: 0.22, confidence: 'high', summary: 'Supports HSAs, market-based insurance, repealing ACA mandates.', sources: [] },
    { candidateId: 'cand_sen_b', issueId: 'iss_reproductive', score: 0.15, confidence: 'high', summary: 'Supports federal 15-week limit; returns remainder to states.', sources: [] },
    { candidateId: 'cand_sen_b', issueId: 'iss_higher_ed', score: 0.3, confidence: 'medium', summary: 'Opposes broad loan forgiveness; supports workforce training grants.', sources: [] },
    { candidateId: 'cand_sen_b', issueId: 'iss_climate', score: 0.25, confidence: 'high', summary: 'Supports all-of-the-above energy; opposes federal mandates on fossil fuels.', sources: [] },
    { candidateId: 'cand_sen_b', issueId: 'iss_public_lands', score: 0.3, confidence: 'medium', summary: 'Supports greater state control over federal lands in Utah.', sources: [] },
    { candidateId: 'cand_sen_b', issueId: 'iss_immigration', score: 0.2, confidence: 'high', summary: 'Supports tighter border enforcement, opposes broad citizenship pathways.', sources: [] },
    { candidateId: 'cand_sen_b', issueId: 'iss_guns', score: 0.2, confidence: 'high', summary: 'Opposes new firearm restrictions; supports concealed-carry reciprocity.', sources: [] },
    { candidateId: 'cand_sen_b', issueId: 'iss_elections', score: 0.3, confidence: 'high', summary: 'Supports stronger voter ID; opposes federal election standards.', sources: [] },
  ],
};

const CAND_GOV_A: Candidate = {
  id: 'cand_gov_a',
  name: 'Jamie Park',
  party: 'Republican',
  photoUrl: null,
  bio: 'Two-term state legislator. Education and fiscal policy focus.',
  websiteUrl: 'https://example.org/park',
  coverageTier: 'B',
  stances: [
    { candidateId: 'cand_gov_a', issueId: 'iss_taxes', score: 0.3, confidence: 'high', summary: 'Supports further income-tax reduction.', sources: [] },
    { candidateId: 'cand_gov_a', issueId: 'iss_housing', score: 0.4, confidence: 'medium', summary: 'Backs zoning reform incentives, opposes state-level rent controls.', sources: [] },
    { candidateId: 'cand_gov_a', issueId: 'iss_public_schools', score: 0.35, confidence: 'high', summary: 'Supports expanding voucher-like scholarship programs.', sources: [] },
    { candidateId: 'cand_gov_a', issueId: 'iss_water', score: 0.55, confidence: 'medium', summary: 'Supports Great Salt Lake conservation while preserving agricultural rights.', sources: [] },
    { candidateId: 'cand_gov_a', issueId: 'iss_climate', score: 0.35, confidence: 'medium', summary: 'Favors market solutions; opposes emissions caps.', sources: [] },
    { candidateId: 'cand_gov_a', issueId: 'iss_public_lands', score: 0.3, confidence: 'medium', summary: 'Supports state management of federal lands.', sources: [] },
    { candidateId: 'cand_gov_a', issueId: 'iss_guns', score: 0.25, confidence: 'high', summary: 'Opposes new state gun restrictions.', sources: [] },
    { candidateId: 'cand_gov_a', issueId: 'iss_transit', score: 0.4, confidence: 'low', summary: 'Limited public statements on transit funding.', sources: [] },
    { candidateId: 'cand_gov_a', issueId: 'iss_zoning', score: 0.5, confidence: 'medium', summary: 'Supports local control of zoning but backs state incentives for density near transit.', sources: [] },
    { candidateId: 'cand_gov_a', issueId: 'iss_elections', score: 0.35, confidence: 'medium', summary: 'Supports current Utah election framework, including mail-in ballots.', sources: [] },
  ],
};

const CAND_GOV_B: Candidate = {
  id: 'cand_gov_b',
  name: 'Taylor Nguyen',
  party: 'Democratic',
  photoUrl: null,
  bio: 'Former county mayor. Water, housing, and infrastructure focus.',
  websiteUrl: 'https://example.org/nguyen',
  coverageTier: 'A',
  stances: [
    { candidateId: 'cand_gov_b', issueId: 'iss_taxes', score: 0.65, confidence: 'high', summary: 'Supports restoring prior income-tax rates to fund education.', sources: [] },
    { candidateId: 'cand_gov_b', issueId: 'iss_housing', score: 0.75, confidence: 'high', summary: 'Proposes statewide affordability trust fund and upzoning along transit.', sources: [] },
    { candidateId: 'cand_gov_b', issueId: 'iss_public_schools', score: 0.78, confidence: 'high', summary: 'Opposes voucher expansion; supports teacher pay raises.', sources: [] },
    { candidateId: 'cand_gov_b', issueId: 'iss_water', score: 0.8, confidence: 'high', summary: 'Supports mandatory conservation targets and reallocation from irrigation.', sources: [] },
    { candidateId: 'cand_gov_b', issueId: 'iss_climate', score: 0.75, confidence: 'high', summary: 'Supports state clean-energy standard and emissions reporting.', sources: [] },
    { candidateId: 'cand_gov_b', issueId: 'iss_public_lands', score: 0.7, confidence: 'medium', summary: 'Supports federal land protections; opposes transfer.', sources: [] },
    { candidateId: 'cand_gov_b', issueId: 'iss_guns', score: 0.6, confidence: 'medium', summary: 'Supports red-flag laws and storage requirements.', sources: [] },
    { candidateId: 'cand_gov_b', issueId: 'iss_transit', score: 0.82, confidence: 'high', summary: 'Backs expanded Trax and Frontrunner funding, more bus service in rural counties.', sources: [] },
    { candidateId: 'cand_gov_b', issueId: 'iss_zoning', score: 0.72, confidence: 'high', summary: 'Supports statewide upzoning minimums near transit and job centers.', sources: [] },
    { candidateId: 'cand_gov_b', issueId: 'iss_elections', score: 0.72, confidence: 'medium', summary: 'Supports automatic voter registration.', sources: [] },
  ],
};

const CAND_COUNTY_A: Candidate = {
  id: 'cand_county_a',
  name: 'Pat Okafor',
  party: 'Democratic',
  photoUrl: null,
  bio: 'Current council member seeking re-election. Housing and transit focus.',
  websiteUrl: null,
  coverageTier: 'B',
  stances: [
    { candidateId: 'cand_county_a', issueId: 'iss_housing', score: 0.78, confidence: 'high', summary: 'Supports county-level affordable-housing bond, inclusionary zoning.', sources: [] },
    { candidateId: 'cand_county_a', issueId: 'iss_transit', score: 0.85, confidence: 'high', summary: 'Voted yes on Trax Green Line extension funding.', sources: [] },
    { candidateId: 'cand_county_a', issueId: 'iss_zoning', score: 0.7, confidence: 'medium', summary: 'Supports allowing duplexes/triplexes in single-family zones near transit.', sources: [] },
    { candidateId: 'cand_county_a', issueId: 'iss_water', score: 0.72, confidence: 'medium', summary: 'Supports county water-efficiency mandates for landscaping.', sources: [] },
    { candidateId: 'cand_county_a', issueId: 'iss_policing', score: 0.65, confidence: 'medium', summary: 'Supports co-responder mental-health teams with existing police funding.', sources: [] },
    { candidateId: 'cand_county_a', issueId: 'iss_elections', score: 0.7, confidence: 'medium', summary: 'Supports current mail-in system and drop-box expansion.', sources: [] },
  ],
};

const CAND_COUNTY_B: Candidate = {
  id: 'cand_county_b',
  name: 'Sam Hollister',
  party: 'Republican',
  photoUrl: null,
  bio: 'Real-estate attorney. Property rights and fiscal responsibility.',
  websiteUrl: null,
  coverageTier: 'B',
  stances: [
    { candidateId: 'cand_county_b', issueId: 'iss_housing', score: 0.35, confidence: 'medium', summary: 'Opposes inclusionary zoning mandates; supports streamlining permits.', sources: [] },
    { candidateId: 'cand_county_b', issueId: 'iss_transit', score: 0.3, confidence: 'medium', summary: 'Prioritises road capacity over transit expansion.', sources: [] },
    { candidateId: 'cand_county_b', issueId: 'iss_zoning', score: 0.25, confidence: 'high', summary: 'Supports single-family zoning; opposes countywide upzoning.', sources: [] },
    { candidateId: 'cand_county_b', issueId: 'iss_water', score: 0.5, confidence: 'low', summary: 'Few public statements; opposes new mandates.', sources: [] },
    { candidateId: 'cand_county_b', issueId: 'iss_policing', score: 0.3, confidence: 'medium', summary: 'Supports increased police funding.', sources: [] },
    { candidateId: 'cand_county_b', issueId: 'iss_elections', score: 0.35, confidence: 'medium', summary: 'Supports stricter voter-ID requirements.', sources: [] },
  ],
};

// ---------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------

export const MOCK_RACES: Race[] = [
  {
    id: 'race_ussenate',
    name: 'US Senate — Utah',
    officeLevel: 'federal',
    district: null,
    electionDate: '2026-11-03',
    officeResponsibilities:
      'Votes on federal laws, confirms judges, ratifies treaties. Can affect federal taxes, healthcare, immigration, public-land policy.',
    candidates: [CAND_SEN_A, CAND_SEN_B],
  },
  {
    id: 'race_utgov',
    name: 'Utah Governor',
    officeLevel: 'state',
    district: null,
    electionDate: '2026-11-03',
    officeResponsibilities:
      'Enforces state law, sets budget priorities, appoints agency heads. Can affect state taxes, education funding, water policy, housing rules.',
    candidates: [CAND_GOV_A, CAND_GOV_B],
  },
  {
    id: 'race_slco_council',
    name: 'Salt Lake County Council — District 3',
    officeLevel: 'county',
    district: '3',
    electionDate: '2026-11-03',
    officeResponsibilities:
      'Sets county budget and zoning, oversees local transit, water conservancy, elections administration. Cannot set federal or state tax rates.',
    candidates: [CAND_COUNTY_A, CAND_COUNTY_B],
  },
];

// ---------------------------------------------------------------------------
// Voter profile — demo "me"
// ---------------------------------------------------------------------------

export const MOCK_VOTER_PROFILE: VoterProfile = {
  id: 'voter_demo',
  source: 'manual',
  updatedAt: new Date().toISOString(),
  domainWeights: {
    environment: 0.9,
    healthcare: 0.8,
    education: 0.7,
    economy: 0.5,
    social: 0.5,
    public_safety: 0.4,
    governance: 0.5,
    infrastructure: 0.6,
  },
  stances: [
    { issueId: 'iss_taxes', score: 0.6, confidence: 'high', summary: null, sources: [] },
    { issueId: 'iss_housing', score: 0.7, confidence: 'high', summary: null, sources: [] },
    { issueId: 'iss_wages', score: 0.75, confidence: 'high', summary: null, sources: [] },
    { issueId: 'iss_healthcare_access', score: 0.7, confidence: 'high', summary: null, sources: [] },
    { issueId: 'iss_reproductive', score: 0.8, confidence: 'high', summary: null, sources: [] },
    { issueId: 'iss_public_schools', score: 0.75, confidence: 'high', summary: null, sources: [] },
    { issueId: 'iss_higher_ed', score: 0.65, confidence: 'medium', summary: null, sources: [] },
    { issueId: 'iss_climate', score: 0.85, confidence: 'high', summary: null, sources: [] },
    { issueId: 'iss_public_lands', score: 0.8, confidence: 'high', summary: null, sources: [] },
    { issueId: 'iss_water', score: 0.75, confidence: 'high', summary: null, sources: [] },
    { issueId: 'iss_immigration', score: 0.65, confidence: 'medium', summary: null, sources: [] },
    { issueId: 'iss_guns', score: 0.55, confidence: 'medium', summary: null, sources: [] },
    { issueId: 'iss_policing', score: 0.6, confidence: 'medium', summary: null, sources: [] },
    { issueId: 'iss_elections', score: 0.75, confidence: 'high', summary: null, sources: [] },
    { issueId: 'iss_transit', score: 0.8, confidence: 'high', summary: null, sources: [] },
    { issueId: 'iss_zoning', score: 0.7, confidence: 'medium', summary: null, sources: [] },
  ],
};
