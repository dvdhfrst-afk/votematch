/**
 * Template: county_legislative — county commission OR county council.
 *
 * Two forms of government catalogued in our chamber_type enum:
 *   - county_commission: traditional 3-5 member commissioner form
 *   - county_council: mayor-council form (modern, less common — Salt
 *     Lake County, Cuyahoga County, etc.)
 *
 * Body sizes are small (3-9 members) so per-seat extraction is fine.
 * Per-county charter variance is HIGH — don't assume; verify against
 * the actual county .gov.
 */
import type { TemplateSpec } from '../types';

export const countyLegislative: TemplateSpec = {
  slug: 'county_legislative',

  matches: (input) =>
    (input.chamber_type === 'county_commission' || input.chamber_type === 'county_council') &&
    input.jurisdiction_type === 'county',

  suggestedSources: (input) => {
    const slug = input.jurisdiction_name.toLowerCase()
      .replace(/ county/gi, '')
      .replace(/ /g, '');
    return [
      `https://en.wikipedia.org/wiki/${input.jurisdiction_name.replace(/ /g, '_')},_${input.fips_state ? '' : ''}`,
      `https://${slug}county.gov`,
      `https://${slug}county.org`,
    ];
  },

  buildPrompt: (input) => {
    const form = input.chamber_type === 'county_commission' ? 'county commission' : 'county council';
    const expectedSize = input.attached_offices.length;
    return `You are a civic-research agent for Havesay. Your task: extract structured data about the ${input.jurisdiction_name} ${form} (the body) and its current members from primary sources.

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: ${input.chamber_type}
- jurisdiction: ${input.jurisdiction_name}
- fips_state: ${input.fips_state ?? '(unknown)'}
- attached offices in our catalog: ${expectedSize}

# Critical: per-county charter variance is HIGH
- ${input.chamber_type === 'county_commission'
        ? 'Traditional commission form: 3-5 elected commissioners. They function as the legislative AND executive body.'
        : 'Mayor-council form: an elected County Mayor (separate office) + 5-9 elected council members. The mayor is EXECUTIVE and standalone; the council is legislative.'}
- DO NOT assume the catalog's size is right. Verify against the county's actual charter.
- If you find a mayor-council form when the catalog says commission, set authoritative=false and explain — that's a form-of-government error in the catalog (Salt Lake County had this problem; ~10-30 other counties may too).

# Source allowlist
- en.wikipedia.org
- Any .gov / .us hostname for the county or its state
- openstates.org

FORBIDDEN: ballotpedia.org, ncsl.org, social media.

# Fetch sequence
1. WebSearch "${input.jurisdiction_name} ${input.fips_state ? 'Utah' : ''} government Wikipedia" — find the county Wikipedia page
2. smart_fetch the Wikipedia page — form of government, council/commission size, term length, salary
3. WebSearch for the county's official .gov page; fetch its "government" or "elected officials" page; verify members
4. Look specifically for whether it's commission form vs mayor-council form

# Output schema (use field names: url / relevant_snippet)
{
  "body": {
    "canonical_name": "<verified — e.g., 'Salt Lake County Council' or 'Wayne County Commission'>",
    "short_name": "<short>",
    "size_total": <int>,
    "seat_structure": [
      { "count": <N>, "designation_kind": "at_large"|"district", "term_length_years": <2|4|6>, "stagger_offset_years": <varies> }
    ],
    "selection_method": "elected_partisan"|"elected_nonpartisan",
    "primary_required": <bool>,
    "on_cycle_pattern": "<even years | every 4 years staggered | etc.>",
    "description": "<2-4 sentences>",
    "powers_summary": "<county legislative powers: ordinances, budget, intergovt agreements, etc.>",
    "vacancy_appointment_authority": "<typically the body itself or the county mayor / governor>",
    "vacancy_triggers_special": ["death","resignation","removal_by_charter"],
    "special_election_timing_rule": "...",
    "voter_qualifications_summary": "US citizen, 18+, registered ${input.jurisdiction_name} voter (district resident if district-based)",
    "salary_usd": <int or null>,
    "form_of_government": "commission"|"mayor_council"|"council_administrator"|"other"
  },
  "seats": [{ "seat_designation": "...", "current_officeholder": { "person_name": "...", "party": "...", "term_end": "..." } }],
  "citations": [{ "url": "...", "title": "...", "kind": "wikipedia"|"gov_other", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" }],
  "authoritative": <true if county.gov confirms structure>,
  "notes": "<form_of_government mismatch with catalog; at-large vs district mix; term length stagger; etc.>"
}

# Write the result to: \${RESULT_PATH}

# Rules — DO NOT make assumptions:
- Verify form of government for this specific county. The catalog defaults to generic state rules and is often wrong for charter counties.
- Verify seat count + term length per the actual charter, not state default.
- Mention if there's a separate elected County Mayor in the notes (so reviewer can ensure that standalone office is catalogued).
`;
  },
};
