/**
 * Shared types for body-research agents.
 */

export type ChamberType =
  | 'legislative_upper' | 'legislative_lower' | 'legislative_unicameral'
  | 'city_council' | 'city_commission' | 'town_council' | 'township_board'
  | 'selectboard' | 'county_commission' | 'county_council' | 'school_board'
  | 'special_district_board' | 'state_supreme_court' | 'appellate_court'
  | 'municipal_court' | 'state_board_of_education'
  | 'public_service_commission' | 'state_board_of_regents'
  | 'federal_supreme_court' | 'other';

export type SelectionMethod =
  | 'elected_partisan' | 'elected_nonpartisan' | 'appointed'
  | 'retention_election' | 'merit_selection' | 'mixed';

export type DesignationKind =
  | 'at_large' | 'district' | 'state_pair' | 'unknown';

export interface SeatGroup {
  count: number;
  designation_kind: DesignationKind;
  term_length_years: number | null;
  stagger_offset_years?: number | null;
  classes?: number[];                 // e.g., US Senate classes [1, 2, 3]
}

export interface Citation {
  url: string;
  title: string;
  kind: 'wikipedia' | 'gov_federal' | 'gov_state' | 'gov_county' | 'gov_municipal' | 'gov_other' | 'openstates' | 'census' | 'other';
  accessed_at: string;                // ISO date
  relevant_snippet?: string;          // verbatim ≤ 280 chars
}

// ── Office-scope vocabulary v1 (council-approved 2026-05-26) ─────────────
// Must match the policy_authority_domain_t enum in the DB.
export type PolicyAuthorityDomainV1 =
  | 'land_use_housing'
  | 'transportation_infrastructure'
  | 'public_safety'
  | 'justice'
  | 'utilities'
  | 'education'
  | 'health_environment'
  | 'parks_culture'
  | 'fiscal'
  | 'economic_regulation'
  | 'elections_governance'
  | 'social_services';

export type AuthorityMode =
  | 'legislative'
  | 'executive'
  | 'quasi_judicial'
  | 'advisory'
  | 'confirming';

export interface DomainOverride {
  added: PolicyAuthorityDomainV1[];      // domains the body has that the default doesn't
  removed: PolicyAuthorityDomainV1[];    // domains the default has that this body doesn't
  citations: Array<{                     // primary-source citations supporting the override
    url: string;
    kind?: string;                       // 'statute' / 'charter' / 'gov_state' / etc.
    snippet?: string;                    // verbatim ≤280 chars
  }>;
  reviewed_by?: string | null;
}

export interface VoterFacingScope {
  one_liner: string;                     // ≤160 chars, agent-written prose
  statute_url?: string | null;           // primary citation supporting the one_liner
  charter_url?: string | null;           // primary citation supporting the one_liner
  locale?: string;                       // 'en' default
  citation_ref?: number | null;          // index into result.citations[] backing this
}

export interface ExtractedBody {
  canonical_name?: string;            // optional override (catalog value usually right)
  short_name?: string;
  size_total: number;
  seat_structure: SeatGroup[];
  selection_method?: SelectionMethod;
  primary_required?: boolean;
  runoff_rules?: { threshold: string; format: string } | null;
  on_cycle_pattern?: string;
  description?: string;                // 2-4 sentences
  powers_summary?: string;             // 1 paragraph
  meeting_schedule?: string;
  vacancy_appointment_authority?: string;
  vacancy_triggers_special?: string[];
  special_election_timing_rule?: string;
  voter_qualifications_summary?: string;
  // ── Office scope (v1, 2026-05-26) ─────────────────────────────────────
  // Optional. Agent may omit any/all of these; the writer fills with
  // chamber_type_defaults. Per-body domain deviations only accepted if
  // accompanied by primary-source citations (DomainOverride.citations).
  domain_overrides?: DomainOverride;
  authority_mode?: AuthorityMode;
  voter_facing_scope?: VoterFacingScope;
  statute_url?: string;
  charter_url?: string;
}

export interface ExtractedOfficeholder {
  person_name: string;
  party?: string;
  term_start?: string;                // ISO date
  term_end?: string;
  contact_url?: string;
}

export interface ExtractedSeat {
  seat_designation: string;            // "Senior Seat" / "District 5" / "Position 1"
  canonical_name_hint?: string;        // for matching to existing offices
  current_officeholder?: ExtractedOfficeholder;
}

export interface AgentResult {
  body: ExtractedBody;
  seats: ExtractedSeat[];
  citations: Citation[];
  // True if the agent considers its extraction high-confidence for
  // size_authoritative=true. False if there's substantive uncertainty.
  authoritative: boolean;
  notes?: string;
}

export interface AgentInput {
  body_id: string;
  canonical_name: string;
  chamber_type: ChamberType;
  jurisdiction_name: string;
  jurisdiction_type: string;
  fips_state: string | null;
  // Existing attached offices, for matching extracted seats to records
  attached_offices: Array<{
    id: string;
    canonical_name: string;
    seat_designation: string | null;
  }>;
}

export interface TemplateSpec {
  slug: string;
  // Predicate: does this template apply to the given body?
  matches: (input: AgentInput) => boolean;
  // Build the agent prompt for this body
  buildPrompt: (input: AgentInput) => string;
  // Suggested source URLs for the prompt (used as hints)
  suggestedSources: (input: AgentInput) => string[];
}
