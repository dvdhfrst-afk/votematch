/**
 * Template: municipal_legislative — city councils, town councils,
 * and multi-judge municipal courts.
 *
 * Bodies covered: city_council, city_commission, town_council, municipal_court
 *
 * Per-city charter variance is the central concern. Council size varies
 * (3-50+), terms vary (2-4 years), partisan vs nonpartisan varies, and
 * whether mayor is a separate office or sits on the council varies.
 */
import type { TemplateSpec } from '../types';

export const municipalLegislative: TemplateSpec = {
  slug: 'municipal_legislative',

  matches: (input) =>
    ['city_council', 'city_commission', 'town_council', 'municipal_court'].includes(input.chamber_type) &&
    input.jurisdiction_type === 'municipality',

  suggestedSources: (input) => {
    const slug = input.jurisdiction_name.toLowerCase()
      .replace(/^(city|town|village|borough) of /i, '')
      .replace(/^the /i, '')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/ /g, '');
    return [
      `https://en.wikipedia.org/wiki/${input.jurisdiction_name.replace(/ /g, '_')}`,
      `https://${slug}.gov`,
      `https://${slug}.org`,
      `https://cityof${slug}.org`,
    ];
  },

  buildPrompt: (input) => {
    const isCourt = input.chamber_type === 'municipal_court';
    return `You are a civic-research agent for Havesay. Your task: extract structured data about ${isCourt ? `the municipal court of ${input.jurisdiction_name}` : `the legislative body of ${input.jurisdiction_name}`} and its current members from primary sources.

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: ${input.chamber_type}
- jurisdiction: ${input.jurisdiction_name}
- fips_state: ${input.fips_state ?? '(unknown)'}
- attached offices in our catalog: ${input.attached_offices.length}

# Critical: per-city charter variance is HIGH
- Council size varies 3-50+; the catalog often defaults to a state-rule guess (5 or 7) which is frequently wrong
- Election partisanship: most U.S. city councils are nonpartisan; some larger cities are partisan (Chicago, Philadelphia, NYC for some seats)
- Term length: usually 4 years, some 2 years
- Selection: at-large vs district vs mixed (e.g., 4 district + 3 at-large)
- Mayor: may sit on council (small towns), may be separate (most cities)
${isCourt ? '- Municipal court: typically 1-5 elected or appointed judges. Verify selection method per city charter.' : ''}

# Source allowlist
- en.wikipedia.org
- Any .gov / .us hostname for the city, county, or state
- openstates.org

FORBIDDEN: ballotpedia.org, ncsl.org, social media.

# Fetch sequence
1. WebSearch "${input.jurisdiction_name} city council Wikipedia" (or "town council" / "municipal court" as appropriate)
2. smart_fetch the Wikipedia page — form of government, council size, term length, partisanship
3. WebSearch for the city's official .gov page; fetch its "government" or "city council" page
4. Verify current members + their districts/seats

# Output schema (use url / relevant_snippet)
{
  "body": {
    "canonical_name": "<verified — e.g., 'Boise City Council', 'Salt Lake City Council', 'New York City Council'>",
    "short_name": "<short>",
    "size_total": <int>,
    "seat_structure": [{ "count": <N>, "designation_kind": "at_large"|"district"|"mixed", "term_length_years": <2|4>, "stagger_offset_years": <varies> }],
    "selection_method": "elected_partisan"|"elected_nonpartisan",
    "primary_required": <bool>,
    "on_cycle_pattern": "<odd years | even years | every 2 years staggered>",
    "description": "<2-4 sentences>",
    "powers_summary": "<municipal legislative powers: ordinances, zoning, budget, etc.>",
    "vacancy_appointment_authority": "<typically council appointment>",
    "vacancy_triggers_special": ["death","resignation","removal"],
    "special_election_timing_rule": "<per city charter>",
    "voter_qualifications_summary": "US citizen, 18+, registered ${input.jurisdiction_name} resident (district resident if district-based)",
    "salary_usd": <int or null>,
    "form_of_government": "mayor_council"|"council_manager"|"commission"|"town_meeting"|"other"
  },
  "seats": [{ "seat_designation": "...", "current_officeholder": { "person_name": "...", "party": "...", "term_end": "..." } }],
  "citations": [{ "url": "...", "title": "...", "kind": "wikipedia"|"gov_municipal", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" }],
  "authoritative": <true if city.gov confirms structure>,
  "notes": "<form_of_government; mayor-on-council; partisan vs nonpartisan; etc.>"
}

# Write the result to: \${RESULT_PATH}

# Rules
- DO NOT trust catalog defaults. Verify against city charter via .gov source.
- If the city has no findable .gov website, use Wikipedia only and set authoritative=false.
- If mayor sits as a voting council member, mention in notes (catalog might double-count if mayor is also a separate standalone office row).
- ${isCourt ? 'For municipal_court: include judges with their term lengths + selection method.' : ''}
`;
  },
};
