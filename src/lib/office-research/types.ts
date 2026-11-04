/**
 * Shared types for standalone-office research agents (parallel to
 * body-research/types.ts).
 *
 * Standalone offices: governors, mayors, sheriffs, DAs, clerks,
 * assessors, etc. — anything that's a single-seat executive or
 * administrative position with governing_body_id = NULL.
 */
import type { Citation } from '../body-research/types';

export type StandaloneLevel =
  | 'federal' | 'state' | 'county' | 'municipal' | 'judicial' | 'special' | 'school';

export interface OfficeInput {
  office_id: string;
  canonical_name: string;
  office_type_slug: string;
  level: StandaloneLevel;
  jurisdiction_id: string;
  jurisdiction_name: string;
  jurisdiction_type: string;
  fips_state: string | null;
}

export interface ExtractedOffice {
  canonical_name?: string;
  short_name?: string;
  description?: string;             // 2-4 sentence summary
  powers_summary?: string;          // 1 paragraph
  term_length_years?: number | null;
  term_start_month?: number | null;
  max_consecutive_terms?: number | null;
  selection_method?: 'elected_partisan' | 'elected_nonpartisan' | 'appointed' | 'retention_election' | 'merit_selection' | 'mixed';
  primary_required?: boolean;
  on_cycle_pattern?: string;        // "presidential cycle" / "midterm cycle" / "odd years" / etc.
  next_regular_election_date?: string | null;
  workload?: 'full_time' | 'part_time' | 'volunteer' | 'hybrid';
  salary_annual_usd?: number | null;
  salary_year?: number | null;
  vacancy_appointment_authority?: string;
  vacancy_triggers_special?: string[];
  special_election_timing_rule?: string;
  voter_qualifications_summary?: string;
  /** Optional link to a body this office presides over (Lt Gov → State Senate; VP → US Senate) */
  presides_over_body_canonical_name?: string;
}

export interface ExtractedOfficeholder {
  person_name: string;
  party?: string;
  term_start?: string;              // ISO date
  term_end?: string;
  bioguide_id?: string;
  contact_url?: string;
  note?: string;
}

export interface OfficeAgentResult {
  office: ExtractedOffice;
  current_officeholder?: ExtractedOfficeholder;
  citations: Citation[];
  authoritative: boolean;
  /** Terminal classification: elected_verified | appointed | nonexistent |
   *  unconfirmed. appointed/nonexistent are resolved (not retried/escalated). */
  disposition?: 'elected_verified' | 'appointed' | 'nonexistent' | 'unconfirmed';
  notes?: string;
}

export interface OfficeTemplateSpec {
  slug: string;
  matches: (input: OfficeInput) => boolean;
  buildPrompt: (input: OfficeInput) => string;
  suggestedSources: (input: OfficeInput) => string[];
}
