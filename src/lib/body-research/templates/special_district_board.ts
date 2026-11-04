/**
 * Template: special_district_board — catch-all for water boards, fire
 * boards, library boards, cemetery boards, hospital boards, drainage
 * boards, irrigation boards, flood control boards, soil & water
 * conservation boards.
 *
 * Highly variable: size 3-15, term length 2-6 years, elected vs
 * appointed, single-purpose authority. The district's own .gov / .org
 * page is usually the only useful source — many don't have Wikipedia
 * entries.
 */
import type { TemplateSpec } from '../types';

export const specialDistrictBoard: TemplateSpec = {
  slug: 'special_district_board',

  matches: (input) =>
    input.chamber_type === 'special_district_board' &&
    (input.jurisdiction_type === 'special_district' || input.jurisdiction_type === 'judicial_district'),

  suggestedSources: (input) => {
    const slug = input.jurisdiction_name.toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/ /g, '');
    return [
      `https://www.${slug}.org`,
      `https://${slug}.us`,
    ];
  },

  buildPrompt: (input) => `You are a civic-research agent for Havesay. Your task: extract structured data about the ${input.jurisdiction_name} board (a special-purpose district) and its current members from primary sources.

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: special_district_board
- jurisdiction: ${input.jurisdiction_name}
- jurisdiction_type: ${input.jurisdiction_type}
- fips_state: ${input.fips_state ?? '(unknown)'}
- attached offices in our catalog: ${input.attached_offices.length}

# What kind of district is this?
The jurisdiction name should tell you. Common types:
- "Fire Protection District" / "Fire District" — fire services
- "Water District" / "Water Conservancy District" / "Metropolitan Water District" — water supply
- "Library District" — library services
- "Cemetery District" — cemetery management
- "Hospital District" — public hospitals
- "Drainage District" — agricultural/storm drainage
- "Irrigation District" — agricultural irrigation
- "Flood Control District" — flood mitigation infrastructure
- "Soil and Water Conservation District" — agricultural soil/water programs
- "Mosquito Abatement District" — pest control
- "Park District" — parks + recreation
- "Sanitary District" — sewage/wastewater
- "Transit District" — transit / bus / rail
- "Port District" — ports/airports
- "Community Services District" / "Municipal Utility District" — general purpose
- "Public Utility District" (PUD) — utilities (often electric)

# Critical: per-district + per-state variance
- Selection: most are elected nonpartisan; some appointed by county / state
- Size: usually 5 (most common), sometimes 3, 7, 9
- Term length: 4 years standard; 2 or 6 in some
- Authority limited to the district's enumerated purpose (don't claim broader powers)

# Source allowlist
- en.wikipedia.org (rare for districts; usually only larger ones)
- Any .gov / .us hostname (the district's website if any; the host county's directory page)
- openstates.org (rare for districts)

FORBIDDEN: ballotpedia.org, ncsl.org, social media.

# Fetch sequence
1. WebSearch for the district's official site — often *.org or *.<state>.us
2. smart_fetch the district's "board of directors" or "trustees" page if available
3. If no district site, search for the host county's special-district directory page
4. As a last resort, cite the state's special-district enabling statute (e.g., California Special Districts Act, Utah Code Title 17B, etc.)

# Output schema (url / relevant_snippet)
{
  "body": {
    "canonical_name": "${input.jurisdiction_name} Board" (or "Board of Directors" / "Board of Trustees"),
    "short_name": "<short>",
    "size_total": <int>,
    "seat_structure": [{ "count": <N>, "designation_kind": "at_large"|"district"|"division", "term_length_years": <2|4|6>, "stagger_offset_years": <varies> }],
    "selection_method": "elected_nonpartisan"|"elected_partisan"|"appointed",
    "primary_required": false,
    "on_cycle_pattern": "<varies — often consolidated with county general or with school board elections>",
    "description": "<2-4 sentences about the district's purpose>",
    "powers_summary": "<the SPECIFIC enumerated authority — water rates, fire-protection levy, library funding, etc. — narrow to what this district does>",
    "vacancy_appointment_authority": "<usually the board itself or county commission>",
    "vacancy_triggers_special": ["death","resignation","removal","absence"],
    "special_election_timing_rule": "...",
    "voter_qualifications_summary": "US citizen, 18+, registered resident of the district (or property owner in some districts — e.g., irrigation/drainage)",
    "salary_usd": <int — often $0 or per-meeting>,
    "district_type": "<fire|water|library|cemetery|hospital|etc.>"
  },
  "seats": [{ "seat_designation": "Director Seat 1", "current_officeholder": { "person_name": "...", "term_end": "..." } }],
  "citations": [{ "url": "...", "title": "...", "kind": "gov_state"|"gov_other"|"wikipedia", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" }],
  "authoritative": <true if district source confirms>,
  "notes": "<voter eligibility (resident vs property-owner); election cycle pattern; assessment-based vs taxation authority>"
}

# Write the result to: \${RESULT_PATH}

# Rules
- Special districts have NARROW authority — only the powers granted by state enabling statute + district charter. Don't claim broad municipal-style authority.
- Some "voters" are property OWNERS, not residents (irrigation/drainage/flood districts often). Note this in voter_qualifications_summary.
- Most special districts have no Wikipedia entry. The district's own website or its host county's special-district directory are the canonical sources.
- If no source can be verified at all, set authoritative=false and cite the state's special-district enabling statute as the structural authority.
`,
};
