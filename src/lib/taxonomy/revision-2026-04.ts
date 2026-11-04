/**
 * Taxonomy revision proposals — 2026-04-18 batch.
 *
 * Derived from comparative research (see 12-positioning-engine/research-taxonomy-comparative.md)
 * and decisions on the synthesis proposal (see 12-positioning-engine/01-taxonomy-revision-proposal.md).
 *
 * The operator's decisions on 2026-04-18: D1 yes (both Foreign Policy + Technology),
 * D2 moderate-phased (~25-28 in Phase A, grow to 38 for Phase B), D3 defer 3-tier,
 * D4 all 6 renames with anchor audits contingent on voter panel, D5 3 Utah dims
 * in Phase A, D6 yes run the $500 voter panel.
 *
 * This file is the input spec; scripts/seed-taxonomy-proposals.ts reads it and
 * inserts rows into the taxonomy_proposals table as drafts. Every proposal
 * includes:
 *   - A rationale (stored in DB for transparency)
 *   - A counter-argument comment (documentation, not in DB)
 *   - A payload conforming to the proposal_type's expected shape
 *
 * Phase A ship target: ~25-28 active dims, drawn from this spec.
 * Phase B activations: deferred Utah dims (tribal, cannabis, silicon_slopes,
 * wasatch) plus any research-recommended dims we hold back from Phase A to
 * reduce source-gathering burden (minimum_wage, public_health, municipal_water).
 */
import type {
  ScopeApplicability,
  TaxonomyProposalType,
} from '@/types/database';

export interface RevisionProposal {
  proposal_type: TaxonomyProposalType;
  /** For retire/rename/reword/change-* proposals: name of the existing dim to look up */
  target_name?: string;
  rationale: string;
  payload: Record<string, unknown>;
  /** Documentation only; not written to DB. Should be present on every material change. */
  counter_argument?: string;
  /** Group tag for organizing approvals; e.g., "reframe:religious_liberty" */
  batch_tag?: string;
}

// ---------------------------------------------------------------------------
// Scope-applicability presets (reused across proposals)
// ---------------------------------------------------------------------------

const SCOPE_FEDERAL_ONLY: ScopeApplicability = {
  federal: 'matching',
  state: 'not_applicable',
  county: 'not_applicable',
  municipal: 'not_applicable',
};

const SCOPE_FEDERAL_PRIMARY_STATE_INFO: ScopeApplicability = {
  federal: 'matching',
  state: 'informational',
  county: 'not_applicable',
};

const SCOPE_FED_STATE_MATCHING_LOCAL_INFO: ScopeApplicability = {
  federal: 'matching',
  state: 'matching',
  county: 'informational',
  municipal: 'informational',
};

const SCOPE_STATE_LOCAL_PRIMARY: ScopeApplicability = {
  federal: 'informational',
  state: 'matching',
  county: 'matching',
  municipal: 'matching',
  school_board: 'matching',
};

const SCOPE_ALL_LEVELS: ScopeApplicability = {
  federal: 'matching',
  state: 'matching',
  county: 'matching',
  municipal: 'matching',
};

// ---------------------------------------------------------------------------
// Region presets
// ---------------------------------------------------------------------------

const REGION_US = ['US'];
const REGION_UT = ['US-UT']; // Utah-specific extensions

// ---------------------------------------------------------------------------
// 1. FAIRNESS REFRAMES — 4 dims with non-neutral current framing
// ---------------------------------------------------------------------------
// Each is a retire+new pair: retire the current dim (soft-delete) and create a
// replacement with symmetric anchors. Existing positions on the retired dim
// remain historically valid; new classifications target the replacement.
// ---------------------------------------------------------------------------

const FAIRNESS_REFRAMES: RevisionProposal[] = [
  // --- religious_liberty → religious_exemption_policy ---
  {
    proposal_type: 'retire_dim',
    target_name: 'religious_liberty',
    rationale:
      'Fairness audit flagged "religious liberty" as a conservative-coded frame that implicitly presumes the asymmetric version of "religious exemptions from anti-discrimination law." Progressive framings call this "license to discriminate." Replaced by religious_exemption_policy with symmetric anchors.',
    payload: {
      reason: 'framing-neutrality reframe',
      successor_dims: ['religious_exemption_policy'],
    },
    counter_argument:
      '"Religious liberty" is the phrase used in U.S. Supreme Court jurisprudence and is widely recognized by voters. Renaming may reduce discoverability. Accepted: anchor symmetry is more important than term-recognition for matching accuracy.',
    batch_tag: 'reframe:religious_liberty',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Fairness-neutral reframing of religious_liberty. Both anchors describe specific policy positions on religious exemptions from generally-applicable civil-rights laws, without using "liberty" (presumes right as baseline) or "license to discriminate" (presumes anti-discrimination as baseline).',
    payload: {
      domain: 'social',
      name: 'religious_exemption_policy',
      spectrum_low: 'Broad religious exemptions from anti-discrimination and civil-rights laws',
      spectrum_high: 'Narrow or no religious exemptions when they conflict with civil-rights laws',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 6,
    },
    counter_argument:
      'Anchors are legal-sounding and may read as technical. Voter-panel test (D6) will verify both sides see their position represented.',
    batch_tag: 'reframe:religious_liberty',
  },

  // --- school_choice → voucher_charter_policy ---
  {
    proposal_type: 'retire_dim',
    target_name: 'school_choice',
    rationale:
      'Fairness audit: "school choice" is a conservative success-frame. "Choice" is rhetorically positive but pre-frames expansion as the default move. Replaced by voucher_charter_policy with symmetric policy-description anchors.',
    payload: {
      reason: 'framing-neutrality reframe',
      successor_dims: ['voucher_charter_policy'],
    },
    counter_argument:
      '"School choice" is a universally-recognized voter term. "Voucher_charter_policy" is jargon. Accepted: research consensus on neutrality weighed against familiarity.',
    batch_tag: 'reframe:school_choice',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Fairness-neutral reframing of school_choice. Anchors describe the funding-flow policy directly, without "choice" framing.',
    payload: {
      domain: 'education',
      name: 'voucher_charter_policy',
      spectrum_low: 'Public education funds restricted to public schools',
      spectrum_high: 'Public education funds follow students to any school, including private or charter',
      scope_applicability: SCOPE_STATE_LOCAL_PRIMARY,
      applicable_regions: REGION_US,
      display_order: 9,
    },
    counter_argument:
      'Anchors read as technical. Panel test needed.',
    batch_tag: 'reframe:school_choice',
  },

  // --- reproductive_rights → abortion_policy ---
  {
    proposal_type: 'retire_dim',
    target_name: 'reproductive_rights',
    rationale:
      'Fairness audit: "reproductive rights" is pro-legal-access-coded. Wahl-O-Mat and Kieskompas use "abortion law" or "abortion regulation" instead. Replaced by abortion_policy with anchors describing legal restriction levels, not "rights."',
    payload: {
      reason: 'framing-neutrality reframe',
      successor_dims: ['abortion_policy'],
    },
    counter_argument:
      '"Reproductive rights" is a widely-used term with established legal meaning. Switching may read as pulling away from the rights framing, which itself is a political signal. Accepted: symmetry with peer-VAA conventions overrides; anchors describe the same underlying policy axis.',
    batch_tag: 'reframe:reproductive_rights',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Fairness-neutral reframing of reproductive_rights. Anchors describe abortion legal-restriction levels without "rights" framing.',
    payload: {
      domain: 'healthcare',
      name: 'abortion_policy',
      spectrum_low: 'Substantial legal restrictions on abortion access',
      spectrum_high: 'Broad legal access to abortion throughout pregnancy',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 8,
    },
    counter_argument:
      '"Broad legal access throughout pregnancy" overstates where most pro-access positions actually are (most accept some third-trimester restriction). Panel test to verify both sides see their position.',
    batch_tag: 'reframe:reproductive_rights',
  },

  // --- election_reform → voting_access_vs_integrity ---
  {
    proposal_type: 'retire_dim',
    target_name: 'election_reform',
    rationale:
      'Fairness audit: "election reform" implies change-from-current as the intended action (asymmetric). Replaced by voting_access_vs_integrity, which names the actual two-sided policy axis.',
    payload: {
      reason: 'framing-neutrality reframe',
      successor_dims: ['voting_access_vs_integrity'],
    },
    counter_argument:
      '"Voting access vs integrity" may read as taking a position (the phrasing "access vs integrity" presupposes they are in tension). Alternative: "election_law" — more neutral but less descriptive. Chose descriptive name; panel test will validate.',
    batch_tag: 'reframe:election_reform',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Fairness-neutral reframing of election_reform. Anchors name the actual tension: access-expanding policies (mail-in, automatic registration, ranked choice) vs integrity-tightening policies (voter ID, roll cleaning, in-person requirements).',
    payload: {
      domain: 'governance',
      name: 'voting_access_vs_integrity',
      spectrum_low: 'Tighter voter-verification requirements and in-person emphasis (ID laws, in-person voting, roll cleaning)',
      spectrum_high: 'Broader access mechanisms (mail-in voting, automatic/same-day registration, ranked-choice)',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 14,
    },
    counter_argument:
      'Anchors pair "integrity" with restriction and "access" with expansion — both sides may feel represented, but the implicit "integrity vs access" tension is itself a contested frame. Panel test needed.',
    batch_tag: 'reframe:election_reform',
  },
];

// ---------------------------------------------------------------------------
// 2. SPLITS — 6 dims → 16 replacement dims
// ---------------------------------------------------------------------------

const SPLITS: RevisionProposal[] = [
  // --- civil_rights → racial_justice + lgbtq_equality + trans_rights + disability_rights ---
  {
    proposal_type: 'retire_dim',
    target_name: 'civil_rights',
    rationale:
      'Catch-all that conflates racial-justice policy, LGBTQ+ equality, transgender rights, and disability rights. 2024-2025 polling (Pew, PRRI, Gallup) shows these load on different factors; candidates now stake separate positions.',
    payload: {
      reason: 'split into 4 more-specific dims',
      successor_dims: ['racial_justice', 'lgbtq_equality', 'trans_rights', 'disability_rights'],
    },
    counter_argument:
      'Splitting may signal to users that these are separate from each other rather than related civil-rights concerns. Accepted: L1-distance matching benefits from the granularity; related dims will correlate naturally in the data.',
    batch_tag: 'split:civil_rights',
  },
  {
    proposal_type: 'new_dim',
    rationale: 'Split from civil_rights: racial-justice policy axis.',
    payload: {
      domain: 'social',
      name: 'racial_justice',
      spectrum_low: 'Skeptical of systemic-discrimination framing; oppose race-conscious policies',
      spectrum_high: 'Support race-conscious policies to remedy systemic discrimination',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 5,
    },
    counter_argument:
      '"Race-conscious policies" is broad; affirmative action in employment, college admissions, contracting each have separate political coalitions. Phase B may require further splitting.',
    batch_tag: 'split:civil_rights',
  },
  {
    proposal_type: 'new_dim',
    rationale: 'Split from civil_rights: LGBTQ+ (non-trans) equality.',
    payload: {
      domain: 'social',
      name: 'lgbtq_equality',
      spectrum_low: 'Prioritize traditional definitions in marriage, adoption, and public-accommodation policy',
      spectrum_high: 'Expand legal protections for LGBTQ+ individuals in marriage, adoption, employment, and public accommodations',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 41,
    },
    counter_argument:
      'Most post-Obergefell Americans support same-sex marriage (~70%+) but gap widens on related policies (adoption, religious-exemption conflicts). Low voter differentiation among general-election candidates, high among primary-contested races.',
    batch_tag: 'split:civil_rights',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Split from civil_rights: transgender-specific rights. Distinct axis from broader LGBTQ+ policy per 2025 polling (59% support gender-affirming care for adults; only 43% for youth; 67% prefer birth-sex IDs per Gallup).',
    payload: {
      domain: 'social',
      name: 'trans_rights',
      spectrum_low: 'Limit transgender-specific legal protections and accommodations (birth-sex IDs, birth-sex athletic categories, restrict youth medical treatment)',
      spectrum_high: 'Broad transgender-specific legal protections (self-ID, athletic participation by gender identity, access to gender-affirming care including for minors)',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 42,
    },
    counter_argument:
      'Single dim covers medical policy + sports policy + ID policy, which voters treat differently. Phase B may split further. Also risks reading as partisan-loaded; anchor language worked hard to describe specific policies without using contested framings like "affirming" or "protecting."',
    batch_tag: 'split:civil_rights',
  },
  {
    proposal_type: 'new_dim',
    rationale: 'Split from civil_rights: disability rights and accessibility policy.',
    payload: {
      domain: 'social',
      name: 'disability_rights',
      spectrum_low: 'Limit federal mandates on accessibility and accommodation requirements',
      spectrum_high: 'Expand disability-rights protections and accessibility requirements',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 43,
    },
    counter_argument:
      'Low 2026 candidate differentiation — most endorse ADA framework; real policy differences are in funding + enforcement. May be a low-signal dim.',
    batch_tag: 'split:civil_rights',
  },

  // --- immigration → immigration_pathways + border_enforcement ---
  {
    proposal_type: 'retire_dim',
    target_name: 'immigration',
    rationale:
      'Fox 2025 polling shows 7-pt approval gap between "immigration" (45%) and "border security" (52%) framings. Pew typology treats as separate factors. Splitting captures signal lost in the collapse.',
    payload: {
      reason: 'split for separately-salient policy axes',
      successor_dims: ['immigration_pathways', 'border_enforcement'],
    },
    counter_argument:
      'Most candidates have correlated positions on both — splitting creates redundant dims in practice. Accepted: correlation isn\'t identity, and the ~30% of candidates with non-aligned positions are exactly the interesting differentiators.',
    batch_tag: 'split:immigration',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Split from immigration: legal pathway / visa / citizenship policy.',
    payload: {
      domain: 'social',
      name: 'immigration_pathways',
      spectrum_low: 'Restrict legal immigration volume; tighten visa and citizenship pathways',
      spectrum_high: 'Expand legal immigration volume and create additional pathways to citizenship',
      scope_applicability: SCOPE_FEDERAL_PRIMARY_STATE_INFO,
      applicable_regions: REGION_US,
      display_order: 4,
    },
    counter_argument:
      '"Volume" conflates family-based, employment-based, asylum, and refugee pathways. Phase B may split further.',
    batch_tag: 'split:immigration',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Split from immigration: border enforcement and interior enforcement policy.',
    payload: {
      domain: 'social',
      name: 'border_enforcement',
      spectrum_low: 'Minimal physical enforcement and interior enforcement; expand sanctuary policies',
      spectrum_high: 'Strong physical border enforcement and interior enforcement (wall, ICE expansion, E-Verify)',
      scope_applicability: SCOPE_FEDERAL_PRIMARY_STATE_INFO,
      applicable_regions: REGION_US,
      display_order: 44,
    },
    counter_argument:
      'Border + interior enforcement are distinct axes themselves; consolidating creates a broad dim. Acceptable for MVP; Phase B review.',
    batch_tag: 'split:immigration',
  },

  // --- public_lands → federal_lands_control + public_lands_access ---
  {
    proposal_type: 'retire_dim',
    target_name: 'public_lands',
    rationale:
      'Single axis collides two real ones: federal-vs-state control (political-jurisdiction question) and conservation-vs-access (use question). Utah 2025 polling: 71% support Bears Ears federal monument AND majority support more state control over federal lands. Need both axes.',
    payload: {
      reason: 'split to separate control axis from use axis',
      successor_dims: ['federal_lands_control', 'public_lands_access'],
    },
    counter_argument:
      'Two dims on public lands may exceed patience in a 38-dim taxonomy. Accepted: election-defining Utah issue warrants granularity.',
    batch_tag: 'split:public_lands',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Split from public_lands: federal-vs-state/local control of federal public lands (monument designations, transfer proposals).',
    payload: {
      domain: 'environment',
      name: 'federal_lands_control',
      spectrum_low: 'Transfer federal lands to state or local control; reduce monument protections',
      spectrum_high: 'Maintain or expand federal stewardship and monument designations',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 12,
    },
    counter_argument:
      'Utah is the paradigm case. Wyoming/Montana/Nevada/Idaho voters treat this similarly; California/Oregon voters differently. US-wide may have low differentiation but Utah-MVP value is high.',
    batch_tag: 'split:public_lands',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Split from public_lands: access vs conservation (recreation, extraction, grazing permits, protected-status tightening).',
    payload: {
      domain: 'environment',
      name: 'public_lands_access',
      spectrum_low: 'Maximize access for recreation, grazing, and resource extraction',
      spectrum_high: 'Prioritize conservation and protected-status expansion over multiple-use',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 45,
    },
    counter_argument:
      'Multi-use doctrine already requires balance — anchors oversimplify. Phase B may re-evaluate.',
    batch_tag: 'split:public_lands',
  },

  // --- water_rights → great_salt_lake_policy + colorado_river_allocation ---
  // NOTE: municipal_water deferred to Phase B per decision to limit Phase A scope
  {
    proposal_type: 'retire_dim',
    target_name: 'water_rights',
    rationale:
      'Single "water_rights" dim conflates election-defining Utah issues that have separate coalitions: Great Salt Lake crisis (emergency-response axis) and Colorado River allocation (interstate compact + Upper Basin Compact expiring end-2026).',
    payload: {
      reason: 'split for Utah-specific water coalitions',
      successor_dims: ['great_salt_lake_policy', 'colorado_river_allocation'],
    },
    counter_argument:
      'Splitting for Utah adds two US-UT-scoped dims that are noise for non-Utah voters. Accepted: this is Utah MVP; US-wide later is separate concern.',
    batch_tag: 'split:water_rights',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Split from water_rights: Great Salt Lake policy. Emergency-level salience in Utah; distinct coalition from agricultural / interstate water use.',
    payload: {
      domain: 'environment',
      name: 'great_salt_lake_policy',
      spectrum_low: 'Market-based allocation and agricultural water-use priority',
      spectrum_high: 'Mandatory conservation, agricultural-use reductions, and inflow guarantees to restore lake levels',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_UT,
      display_order: 46,
    },
    counter_argument:
      'Deeply Utah-specific; not reusable internationally. Phase A value is high for Utah MVP; Phase B for internationalization can deprecate or scope further.',
    batch_tag: 'split:water_rights',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Split from water_rights: Colorado River allocation policy. Upper Basin Compact negotiations expire end-2026; Utah has 23% Upper Basin share. Major Utah 2026 federal/state issue.',
    payload: {
      domain: 'environment',
      name: 'colorado_river_allocation',
      spectrum_low: 'Defend current upper-basin allocations; resist interstate compact modifications that reduce Utah share',
      spectrum_high: 'Accept allocation reductions and adopt regional demand-management approach',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_UT,
      display_order: 47,
    },
    counter_argument:
      '"Defend current allocation" vs "accept reductions" may frame conservatives as zero-sum; some conservatives support compact-modification for long-term security. Panel test.',
    batch_tag: 'split:water_rights',
  },

  // --- criminal_justice → policing + sentencing_reform + drug_enforcement ---
  {
    proposal_type: 'retire_dim',
    target_name: 'criminal_justice',
    rationale:
      'Catch-all with three separate coalitions: policing (budgets, tactics, accountability), sentencing (length, mandatory minimums, cash bail), drug enforcement (criminalization, harm reduction). "Defund" and "decriminalize" are different movements with different supporters.',
    payload: {
      reason: 'split into policing / sentencing / drug-enforcement axes',
      successor_dims: ['policing', 'sentencing_reform', 'drug_enforcement'],
    },
    counter_argument:
      'Three dims on criminal justice may exceed patience. Compromise: could ship only "policing" and "sentencing_reform" in Phase A; defer drug_enforcement.',
    batch_tag: 'split:criminal_justice',
  },
  {
    proposal_type: 'new_dim',
    rationale: 'Split from criminal_justice: policing policy axis.',
    payload: {
      domain: 'public_safety',
      name: 'policing',
      spectrum_low: 'Increase police funding and expand law-enforcement authority',
      spectrum_high: 'Reduce police budgets in favor of community-based alternatives; expand oversight and accountability mechanisms',
      scope_applicability: SCOPE_ALL_LEVELS,
      applicable_regions: REGION_US,
      display_order: 17,
    },
    counter_argument:
      'Anchors imply police-funding monotonicity; many "community-alternatives" proposals also increase police training/accountability funding. Panel test.',
    batch_tag: 'split:criminal_justice',
  },
  {
    proposal_type: 'new_dim',
    rationale: 'Split from criminal_justice: sentencing length + mandatory minimums + bail reform.',
    payload: {
      domain: 'public_safety',
      name: 'sentencing_reform',
      spectrum_low: 'Maintain or lengthen prison sentences; preserve mandatory minimums and cash bail',
      spectrum_high: 'Reduce sentence length; eliminate mandatory minimums and cash bail in favor of alternatives',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 48,
    },
    counter_argument:
      'Cash bail is a separate sub-axis from sentencing length; some bail-reform advocates want longer sentences and vice versa. Conflating may lose signal.',
    batch_tag: 'split:criminal_justice',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Split from criminal_justice: drug criminalization axis. Separate from drug_policy (healthcare-framed) — this is specifically about criminal-enforcement approach.',
    payload: {
      domain: 'public_safety',
      name: 'drug_enforcement',
      spectrum_low: 'Maintain criminal enforcement of drug-possession and distribution laws',
      spectrum_high: 'Decriminalize possession and shift to harm-reduction / public-health responses',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 49,
    },
    counter_argument:
      'Overlaps with drug_policy (healthcare). Kept distinct because criminal-enforcement axis can align differently from medical-access axis (e.g., someone may support medical cannabis + strict cocaine enforcement).',
    batch_tag: 'split:criminal_justice',
  },

  // --- housing → zoning_density + housing_affordability ---
  {
    proposal_type: 'retire_dim',
    target_name: 'housing',
    rationale:
      'YIMBY-vs-NIMBY (zoning/density) is a distinct axis from tenant-protection/affordability (subsidies, rent control). Utah HB 476 (2024) zoning reform demonstrates local salience; splitting preserves signal.',
    payload: {
      reason: 'split into zoning-density and affordability axes',
      successor_dims: ['zoning_density', 'housing_affordability'],
    },
    counter_argument:
      'In most state/local races, candidates vote a housing "package" and the two axes correlate. Accepted: where they diverge (urban YIMBY liberals vs rent-control progressives) the signal matters.',
    batch_tag: 'split:housing',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Split from housing: zoning and density. YIMBY vs NIMBY axis.',
    payload: {
      domain: 'infrastructure',
      name: 'zoning_density',
      spectrum_low: 'Preserve single-family zoning and local neighborhood character',
      spectrum_high: 'Upzone for higher density, accessory dwelling units, and missing-middle housing',
      scope_applicability: SCOPE_STATE_LOCAL_PRIMARY,
      applicable_regions: REGION_US,
      display_order: 18,
    },
    counter_argument:
      'Preservation advocates span left-right (urban progressives often oppose upzoning near their neighborhoods); anchors don\'t capture that cleanly. Acceptable for MVP.',
    batch_tag: 'split:housing',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Split from housing: tenant protections, subsidies, rent control, affordable-housing mandates.',
    payload: {
      domain: 'infrastructure',
      name: 'housing_affordability',
      spectrum_low: 'Let market determine rents and housing prices; minimal subsidy and tenant-protection intervention',
      spectrum_high: 'Strong tenant protections, rent stabilization, and public-subsidy programs for affordable housing',
      scope_applicability: SCOPE_STATE_LOCAL_PRIMARY,
      applicable_regions: REGION_US,
      display_order: 50,
    },
    counter_argument: 'Rent control specifically is contested even among housing advocates; the dim averages across housing-policy approaches.',
    batch_tag: 'split:housing',
  },
];

// ---------------------------------------------------------------------------
// 3. PURE RENAMES (cosmetic clarity, no anchor change)
// ---------------------------------------------------------------------------

const PURE_RENAMES: RevisionProposal[] = [
  {
    proposal_type: 'rename_dim',
    target_name: 'public_school_funding',
    rationale:
      'Clarity rename: "k12_funding" more directly names the scope and distinguishes from higher_ed_policy (new dim).',
    payload: { name: 'k12_funding' },
    counter_argument: 'Name change may confuse historical lookups; the old name is descriptive.',
    batch_tag: 'rename:public_school_funding',
  },
];

// ---------------------------------------------------------------------------
// 4. ANCHOR REWORDS (no rename, just spectrum text adjustment)
// ---------------------------------------------------------------------------

const ANCHOR_REWORDS: RevisionProposal[] = [
  {
    proposal_type: 'reword_spectrum',
    target_name: 'gun_policy',
    rationale:
      'Current anchors likely use "gun control" (asymmetric term implying restriction as the action) or "gun rights" (implying right as baseline). Panel test recommended for neutrality; anchor replacement below describes the axis using "regulation level" language on both sides.',
    payload: {
      spectrum_low: 'Minimal firearm regulation; broad legal access',
      spectrum_high: 'Stricter firearm regulation (background checks, assault-weapon restrictions, red-flag laws, magazine limits)',
    },
    counter_argument:
      'Low end may be hard for conservatives to see as their position ("broad legal access" is accurate but not self-framing). Panel test.',
    batch_tag: 'reword:gun_policy',
  },
];

// ---------------------------------------------------------------------------
// 5. NEW DIMS — Economy (3)
// ---------------------------------------------------------------------------

const NEW_ECONOMY: RevisionProposal[] = [
  {
    proposal_type: 'new_dim',
    rationale:
      'Missing dim entirely. 68% US union approval (Gallup 2025); 40-pt partisan gap. Distinct axis from business_regulation.',
    payload: {
      domain: 'economy',
      name: 'labor_unions',
      spectrum_low: 'Reduce union authority; support right-to-work laws',
      spectrum_high: 'Expand union authority; restrict right-to-work laws; support card-check and PRO Act-style reforms',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 51,
    },
    counter_argument:
      'Utah is R-dominated and right-to-work state; low candidate differentiation expected. But precisely the few pro-labor Rs become distinguishable.',
    batch_tag: 'new:labor_unions',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Tariff policy is now a primary US economic issue (2025 tariff actions under current admin). Doesn\'t fit business_regulation — axis of free-trade-vs-protectionism has distinct post-2016 GOP realignment.',
    payload: {
      domain: 'economy',
      name: 'trade_tariffs',
      spectrum_low: 'Reduce tariffs and expand free-trade agreements',
      spectrum_high: 'Expand tariffs and restrict imports to protect domestic production',
      scope_applicability: SCOPE_FEDERAL_PRIMARY_STATE_INFO,
      applicable_regions: REGION_US,
      display_order: 52,
    },
    counter_argument: 'State-level candidates have limited direct authority; scope-gated to federal-primary.',
    batch_tag: 'new:trade_tariffs',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Minimum-wage policy is a distinct axis from labor_unions and government_spending. Many pro-union-positions voters split on whether minimum wage should be raised (employment effect debate).',
    payload: {
      domain: 'economy',
      name: 'minimum_wage',
      spectrum_low: 'Maintain current minimum wage or eliminate federal floor',
      spectrum_high: 'Substantially raise minimum wage (e.g., $15+, with indexing)',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 53,
    },
    counter_argument:
      'Low differentiation in Utah where minimum wage closely tracks federal. Candidate positions often aligned with labor_unions; redundancy risk. Consider Phase B activation only.',
    batch_tag: 'new:minimum_wage',
  },
];

// ---------------------------------------------------------------------------
// 6. NEW DIMS — Social (1)
// ---------------------------------------------------------------------------

const NEW_SOCIAL: RevisionProposal[] = [
  {
    proposal_type: 'new_dim',
    rationale:
      'Section 230 reform is live 2026 issue (FCC push in April 2025). Campus-speech and social-media-moderation policy has distinctive horseshoe-geometry political coalitions.',
    payload: {
      domain: 'social',
      name: 'speech_content_moderation',
      spectrum_low: 'Restrict online speech regulation; preserve broad Section 230 immunity for platforms',
      spectrum_high: 'Regulate online platforms to enforce content moderation standards; reform Section 230',
      scope_applicability: SCOPE_FEDERAL_PRIMARY_STATE_INFO,
      applicable_regions: REGION_US,
      display_order: 54,
    },
    counter_argument:
      'Anchors frame high-end as "content moderation regulation"; but some Section 230 reforms are aimed at the opposite (preventing platforms from moderating). This axis is genuinely horseshoe and anchors may not capture it.',
    batch_tag: 'new:speech_content_moderation',
  },
];

// ---------------------------------------------------------------------------
// 7. NEW DIMS — Healthcare (1; public_health deferred to Phase B)
// ---------------------------------------------------------------------------

const NEW_HEALTHCARE: RevisionProposal[] = [
  {
    proposal_type: 'new_dim',
    rationale:
      'Cannabis + psychedelics + harm reduction + opioid policy don\'t fit insurance_coverage. 53% Utahn support for recreational cannabis (Deseret/Hinckley 2025) creates distinct salience.',
    payload: {
      domain: 'healthcare',
      name: 'drug_policy',
      spectrum_low: 'Prohibitionist / criminal-enforcement approach to drug use',
      spectrum_high: 'Decriminalize and emphasize harm-reduction, medical-use expansion, regulated markets',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 55,
    },
    counter_argument:
      'Overlaps with drug_enforcement (public_safety split). Kept distinct because healthcare framing is about treatment access + medical use + harm reduction, while drug_enforcement is about criminal-justice approach.',
    batch_tag: 'new:drug_policy',
  },
];

// ---------------------------------------------------------------------------
// 8. NEW DIMS — Education (2)
// ---------------------------------------------------------------------------

const NEW_EDUCATION: RevisionProposal[] = [
  {
    proposal_type: 'new_dim',
    rationale:
      'Student debt, college affordability, higher-ed governance ("wokeness" debates, accreditation) are distinct from K-12. Federal-primary axis.',
    payload: {
      domain: 'education',
      name: 'higher_ed_policy',
      spectrum_low: 'Minimal federal subsidy for higher education; limit DEI and curriculum mandates',
      spectrum_high: 'Expand federal higher-education subsidies (student-debt relief, tuition-free programs); maintain or expand DEI and accessibility mandates',
      scope_applicability: SCOPE_FEDERAL_PRIMARY_STATE_INFO,
      applicable_regions: REGION_US,
      display_order: 56,
    },
    counter_argument:
      'Bundles two separate axes (affordability + governance). Many conservatives support Pell expansion; many progressives oppose specific DEI mandates. Phase B review for splitting.',
    batch_tag: 'new:higher_ed_policy',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'CRT, DEI-in-schools, book bans, sex-ed, parental-rights — active 2024-2026 culture-war axis distinct from funding. Utah HB 234 (2024) book-ban context makes this locally salient.',
    payload: {
      domain: 'education',
      name: 'curriculum_standards',
      spectrum_low: 'Restrict DEI / racial-history / gender-identity content in public-school curriculum; expand parental-review rights',
      spectrum_high: 'Include diverse historical and cultural content in curriculum; limit parental-veto authority over curriculum',
      scope_applicability: SCOPE_STATE_LOCAL_PRIMARY,
      applicable_regions: REGION_US,
      display_order: 57,
    },
    counter_argument:
      'Anchor language is partisan-charged; alternative framings ("age-appropriate content" vs "diversity education") may be equally fraught. Panel test essential.',
    batch_tag: 'new:curriculum_standards',
  },
];

// ---------------------------------------------------------------------------
// 9. NEW DIMS — Environment (1)
// ---------------------------------------------------------------------------

const NEW_ENVIRONMENT: RevisionProposal[] = [
  {
    proposal_type: 'new_dim',
    rationale:
      'Distinct from energy_policy: energy_policy is "what we use"; climate_action is "should we reduce emissions." MARPOR treats as distinct. Utah\'s Great Salt Lake crisis is partly climate-adaptation.',
    payload: {
      domain: 'environment',
      name: 'climate_action',
      spectrum_low: 'Skeptical of aggressive emissions-reduction policy; prioritize economic / energy-cost concerns',
      spectrum_high: 'Support aggressive emissions-reduction policies (carbon pricing, emission caps, Paris-aligned commitments)',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 58,
    },
    counter_argument:
      'Some conservatives accept climate-science but reject specific policies; anchor "skeptical of emissions-reduction policy" may not capture that nuance. Panel test.',
    batch_tag: 'new:climate_action',
  },
];

// ---------------------------------------------------------------------------
// 10. NEW DIMS — Governance (2)
// ---------------------------------------------------------------------------

const NEW_GOVERNANCE: RevisionProposal[] = [
  {
    proposal_type: 'new_dim',
    rationale:
      'Citizens United, super-PACs, corporate donations, small-donor matching are a live issue axis distinct from voting-access (election law) and transparency (disclosure).',
    payload: {
      domain: 'governance',
      name: 'campaign_finance',
      spectrum_low: 'Preserve current campaign-finance rules; limited regulation of independent expenditure',
      spectrum_high: 'Tighten campaign-finance limits; reverse Citizens United; expand public-financing and small-donor matching',
      scope_applicability: SCOPE_FED_STATE_MATCHING_LOCAL_INFO,
      applicable_regions: REGION_US,
      display_order: 59,
    },
    counter_argument: 'Overlaps with government_transparency; partial consolidation defensible. Kept distinct because campaign finance is a specific regulation regime.',
    batch_tag: 'new:campaign_finance',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Court-packing, judicial appointments, Supreme Court ethics, federal-judiciary jurisdiction-stripping. Federal-scope only (Senate confirmation authority).',
    payload: {
      domain: 'governance',
      name: 'court_reform',
      spectrum_low: 'Preserve current federal judiciary structure and appointment practices',
      spectrum_high: 'Support structural court reform (expansion, term limits, ethics code, jurisdiction adjustments)',
      scope_applicability: SCOPE_FEDERAL_ONLY,
      applicable_regions: REGION_US,
      display_order: 60,
    },
    counter_argument:
      'Court reform is coded as a Democratic issue post-2020; anchors try to describe mechanisms without partisan framing but may still read as loaded. Panel test.',
    batch_tag: 'new:court_reform',
  },
];

// ---------------------------------------------------------------------------
// 11. NEW DIMS — Foreign Policy & National Security (new domain, 6 dims)
// ---------------------------------------------------------------------------
// All scope_applicability: federal-only (state/local have no direct authority)

const NEW_FOREIGN_POLICY: RevisionProposal[] = [
  {
    proposal_type: 'new_dim',
    rationale:
      'New domain: Foreign Policy & National Security. Universal VAA dim; no current home in Havesay taxonomy.',
    payload: {
      domain: 'foreign_policy',
      name: 'military_spending',
      spectrum_low: 'Reduce military spending and constrain defense-budget growth',
      spectrum_high: 'Maintain or increase military spending; prioritize defense over domestic spending',
      scope_applicability: SCOPE_FEDERAL_ONLY,
      applicable_regions: REGION_US,
      display_order: 61,
    },
    counter_argument:
      'Military spending bundles active-duty funding + procurement + veteran benefits + R&D — different coalitions within. Phase B review for splitting.',
    batch_tag: 'new:military_spending',
  },
  {
    proposal_type: 'new_dim',
    rationale: 'NATO and multilateral alliance commitment. Distinct from military spending.',
    payload: {
      domain: 'foreign_policy',
      name: 'alliances_nato',
      spectrum_low: 'Reduce US commitments to multilateral alliances (NATO, bilateral defense treaties)',
      spectrum_high: 'Maintain or deepen US commitments to NATO and multilateral alliances',
      scope_applicability: SCOPE_FEDERAL_ONLY,
      applicable_regions: REGION_US,
      display_order: 62,
    },
    counter_argument: 'Alliance-commitment axis has shifted post-2016; anchors describe the axis accurately but terminology may date quickly.',
    batch_tag: 'new:alliances_nato',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Top-5 voter concern 2025 (Chicago Council). Bipartisan China hostility but partisan split on specific policy (Chinese students, trade, Taiwan).',
    payload: {
      domain: 'foreign_policy',
      name: 'china_policy',
      spectrum_low: 'Accommodationist stance on China: preserve trade ties, diplomatic engagement',
      spectrum_high: 'Confrontational stance on China: expand tariffs, decoupling, military readiness for Taiwan defense',
      scope_applicability: SCOPE_FEDERAL_ONLY,
      applicable_regions: REGION_US,
      display_order: 63,
    },
    counter_argument: '"Accommodationist" is a loaded term used pejoratively. Panel test; may need rephrasing to "engagement-focused" vs "confrontation-focused."',
    batch_tag: 'new:china_policy',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Israel-Hamas conflict approval dropped from 50% (Jan 2024) to 32% (July 2025) per polling. Major 2025-2026 voter-concern shift.',
    payload: {
      domain: 'foreign_policy',
      name: 'israel_palestine',
      spectrum_low: 'Reduce US military and diplomatic support for Israel; support Palestinian statehood and aid',
      spectrum_high: 'Maintain or expand US military and diplomatic support for Israel; condition Palestinian aid',
      scope_applicability: SCOPE_FEDERAL_ONLY,
      applicable_regions: REGION_US,
      display_order: 64,
    },
    counter_argument:
      'Any anchor on this issue will be deeply contested. Risk of appearing to endorse one side through framing. Panel test with voters of multiple religious and ethnic backgrounds.',
    batch_tag: 'new:israel_palestine',
  },
  {
    proposal_type: 'new_dim',
    rationale: 'Top-5 voter concern; ongoing conflict with implications for NATO, alliances, and US-Russia posture.',
    payload: {
      domain: 'foreign_policy',
      name: 'ukraine_russia',
      spectrum_low: 'Reduce US military aid to Ukraine; pursue negotiated settlement',
      spectrum_high: 'Continue or expand US military and economic support for Ukraine; maintain sanctions on Russia',
      scope_applicability: SCOPE_FEDERAL_ONLY,
      applicable_regions: REGION_US,
      display_order: 65,
    },
    counter_argument: 'Conflict-specific dims may become stale if resolution occurs; accept Phase B review.',
    batch_tag: 'new:ukraine_russia',
  },
  {
    proposal_type: 'new_dim',
    rationale: 'Non-military foreign aid (humanitarian, development, climate). Distinct axis from military-aid or alliance commitments.',
    payload: {
      domain: 'foreign_policy',
      name: 'foreign_aid',
      spectrum_low: 'Reduce foreign-aid spending; condition aid on US interests',
      spectrum_high: 'Maintain or expand foreign-aid commitments for development, humanitarian, and climate programs',
      scope_applicability: SCOPE_FEDERAL_ONLY,
      applicable_regions: REGION_US,
      display_order: 66,
    },
    counter_argument: 'Foreign aid has low salience in most elections (<1% of federal budget); dim may be low-signal.',
    batch_tag: 'new:foreign_aid',
  },
];

// ---------------------------------------------------------------------------
// 12. NEW DIMS — Technology & Digital (new domain, 4 dims)
// ---------------------------------------------------------------------------

const NEW_TECHNOLOGY: RevisionProposal[] = [
  {
    proposal_type: 'new_dim',
    rationale:
      'Dec 2025 federal AI executive order; 38 states enacted AI legislation in 2025. Active federal preemption debate. Critical 2026 federal issue.',
    payload: {
      domain: 'technology',
      name: 'ai_regulation',
      spectrum_low: 'Minimal federal AI regulation; prioritize innovation and avoid state-level patchwork',
      spectrum_high: 'Strong federal AI regulation (safety standards, transparency requirements, liability frameworks)',
      scope_applicability: SCOPE_FEDERAL_PRIMARY_STATE_INFO,
      applicable_regions: REGION_US,
      display_order: 67,
    },
    counter_argument:
      'Preemption-vs-state-rights is itself a separate axis some voters care about; bundled here with content-regulation intensity.',
    batch_tag: 'new:ai_regulation',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Universal modern concern; GDPR-analog legislation debates; distinct from AI and content moderation.',
    payload: {
      domain: 'technology',
      name: 'data_privacy',
      spectrum_low: 'Minimal federal data-privacy regulation; market self-regulation',
      spectrum_high: 'Strong federal privacy regulation (GDPR-style consent, data-minimization, right-to-delete)',
      scope_applicability: SCOPE_FEDERAL_PRIMARY_STATE_INFO,
      applicable_regions: REGION_US,
      display_order: 68,
    },
    counter_argument: 'California CCPA already exists; US-wide baseline may reduce preemption debates.',
    batch_tag: 'new:data_privacy',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'Distinct from speech_content_moderation (social dim) — this is the federal regulatory posture toward platforms, not the speech-freedom axis per se.',
    payload: {
      domain: 'technology',
      name: 'content_moderation',
      spectrum_low: 'Preserve broad Section 230 immunity; federal restraint on platform-regulation',
      spectrum_high: 'Reform Section 230; impose federal content-moderation requirements',
      scope_applicability: SCOPE_FEDERAL_PRIMARY_STATE_INFO,
      applicable_regions: REGION_US,
      display_order: 69,
    },
    counter_argument:
      'Near-duplicate of speech_content_moderation. Will merge in Phase B review if overlap is too high. For MVP, keep in both places: social-domain dim frames as civil-rights question, technology-domain dim frames as regulatory question.',
    batch_tag: 'new:content_moderation',
  },
  {
    proposal_type: 'new_dim',
    rationale:
      'GENIUS Act signed July 2025 (68-30 Senate). CLARITY Act, Anti-CBDC Act moving. First major federal crypto framework.',
    payload: {
      domain: 'technology',
      name: 'crypto_policy',
      spectrum_low: 'Minimal crypto regulation; prioritize innovation; oppose CBDC',
      spectrum_high: 'Strong crypto regulation (CFTC/SEC enforcement, stablecoin oversight); open to CBDC',
      scope_applicability: SCOPE_FEDERAL_PRIMARY_STATE_INFO,
      applicable_regions: REGION_US,
      display_order: 70,
    },
    counter_argument: 'Pro-crypto libertarian and pro-regulation progressive positions may share anti-CBDC stance for different reasons; anchors may not capture.',
    batch_tag: 'new:crypto_policy',
  },
];

// ---------------------------------------------------------------------------
// Export the full batch
// ---------------------------------------------------------------------------

export const REVISION_BATCH_2026_04: RevisionProposal[] = [
  ...FAIRNESS_REFRAMES,
  ...SPLITS,
  ...PURE_RENAMES,
  ...ANCHOR_REWORDS,
  ...NEW_ECONOMY,
  ...NEW_SOCIAL,
  ...NEW_HEALTHCARE,
  ...NEW_EDUCATION,
  ...NEW_ENVIRONMENT,
  ...NEW_GOVERNANCE,
  ...NEW_FOREIGN_POLICY,
  ...NEW_TECHNOLOGY,
];

export const REVISION_BATCH_METADATA = {
  batch_id: '2026-04-18-taxonomy-revision',
  proposer: 'maintainer',
  description:
    'Major taxonomy revision following comparative research (research-taxonomy-comparative.md) ' +
    'and decisions on 2026-04-18. Adds 2 top-level domains (Foreign Policy, Technology), ' +
    'splits 6 catch-all dims into 16 specific ones, reframes 4 dims for anchor fairness, ' +
    'reworded 1 dim\'s anchors, and adds 17 new dims across 8 domains. Does not include ' +
    'Utah Phase B extensions (tribal_sovereignty, cannabis_recreational, silicon_slopes, wasatch) — ' +
    'those ship in a separate batch ahead of Phase B activation.',
  phase_a_active_dims_target: 28, // we\'ll activate ~28 of ~38 for Phase A ship
  // Dims to hold inactive for Phase B (approve + apply but immediately retire):
  phase_b_deferred_dims: [
    'minimum_wage', // redundant with labor_unions in Phase A
    'foreign_aid', // low 2026 salience
    'disability_rights', // low candidate differentiation
    'public_health', // not included in this batch at all; add Phase B
    'municipal_water', // not included; add Phase B
    'tribal_sovereignty', // not included; add Phase B as Utah extension
    'cannabis_recreational', // not included; add Phase B
    'silicon_slopes_incentives', // not included
    'wasatch_front_transit', // not included
  ],
};
