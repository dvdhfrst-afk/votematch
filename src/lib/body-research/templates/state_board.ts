/**
 * Template: state_board — state boards of education, public service
 * commissions, boards of regents, etc. Each state has one of each
 * (when they exist). Body sizes are small (5-15 members typically).
 *
 * Chamber types covered:
 *  - state_board_of_education
 *  - public_service_commission
 *  - state_board_of_regents
 */
import type { TemplateSpec, ChamberType } from '../types';

const CHAMBER_TYPE_NAMES: Record<string, string> = {
  state_board_of_education: 'State Board of Education',
  public_service_commission: 'Public Service Commission',
  state_board_of_regents: 'Board of Regents',
};

export const stateBoard: TemplateSpec = {
  slug: 'state_board',

  matches: (input) =>
    ['state_board_of_education', 'public_service_commission', 'state_board_of_regents'].includes(input.chamber_type) &&
    input.jurisdiction_type === 'state',

  suggestedSources: (input) => {
    const friendly = CHAMBER_TYPE_NAMES[input.chamber_type] ?? input.chamber_type;
    const slug = input.jurisdiction_name.toLowerCase().replace(/ /g, '_');
    return [
      `https://en.wikipedia.org/wiki/${input.jurisdiction_name.replace(/ /g, '_')}_${friendly.replace(/ /g, '_')}`,
      `https://${slug}.gov`,
    ];
  },

  buildPrompt: (input) => {
    const friendly = CHAMBER_TYPE_NAMES[input.chamber_type] ?? input.chamber_type;
    return `You are a civic-research agent for Havesay. Your task: extract structured data about the ${input.jurisdiction_name} ${friendly} (the body) and its current members from primary sources.

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: ${input.chamber_type}
- jurisdiction: ${input.jurisdiction_name}
- attached offices in our catalog: ${input.attached_offices.length}

# Source allowlist
- en.wikipedia.org
- Any .gov or .us hostname (e.g., schools.${input.jurisdiction_name.toLowerCase().replace(/ /g, '')}.gov, psc.${input.jurisdiction_name.toLowerCase().replace(/ /g, '')}.gov)
- openstates.org

FORBIDDEN: ballotpedia.org, ncsl.org, brennancenter.org, social media.

# Fetch sequence
1. WebSearch "${input.jurisdiction_name} ${friendly} wikipedia" — find the Wikipedia page
2. smart_fetch the Wikipedia page — body size, selection method, term length, current chair, recent membership
3. WebSearch for the official .gov board page, fetch, extract members + appointment dates

# What to extract
A JSON document with:
- body: canonical_name, short_name, size_total, seat_structure, selection_method (often "appointed" or "mixed" for these boards), primary_required (often false), on_cycle_pattern, description, powers_summary, vacancy rules, voter_qualifications_summary, current_officers (chair, vice chair)
- seats: per-member with seat_designation (often by district or position), current_officeholder { person_name, appointed_by, appointed_year, term_end }
- citations: each with verbatim snippet (≤280 chars)
- authoritative: true if ≥2 sources agree on size, else false
- notes: caveats — selection-method variation, ex-officio members, etc.

# Write the result to: \${RESULT_PATH}

# Critical: selection_method varies widely
- State Board of Education: some states elect (e.g., Utah, Texas, Michigan), some appoint (e.g., CA, NJ).
- Public Service Commission: often elected in southern states, appointed in northern.
- Board of Regents: typically appointed by governor; some states have ex-officio members.
- DO NOT assume — verify from sources.

# Critical: ex-officio members
Many of these boards have non-voting or ex-officio members (e.g., the State Superintendent of Public Instruction often sits ex-officio on the State Board of Education). Include them in seats but tag with "ex_officio": true and "non_voting": true.
`;
  },
};
