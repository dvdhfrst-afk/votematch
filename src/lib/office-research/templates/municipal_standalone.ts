/**
 * Template: municipal_standalone — city/town mayors, clerks, treasurers,
 * controllers, tax collectors, city attorneys.
 *
 * Mayor is the most-researched office type. Per-city charter variance
 * is high — strong vs weak mayor, council member vs separate, etc.
 */
import type { OfficeTemplateSpec } from '../types';

const MUNICIPAL_STANDALONE_SLUGS = new Set([
  'mayor', 'city_clerk', 'city_treasurer', 'controller',
  'tax_collector', 'city_attorney',
]);

const FRIENDLY_NAMES: Record<string, string> = {
  mayor: 'Mayor',
  city_clerk: 'City Clerk',
  city_treasurer: 'City Treasurer',
  controller: 'Controller',
  tax_collector: 'Tax Collector',
  city_attorney: 'City Attorney',
};

export const municipalStandalone: OfficeTemplateSpec = {
  slug: 'municipal_standalone',

  matches: (input) =>
    input.level === 'municipal' &&
    input.jurisdiction_type === 'municipality' &&
    MUNICIPAL_STANDALONE_SLUGS.has(input.office_type_slug),

  suggestedSources: (input) => {
    const slug = input.jurisdiction_name.toLowerCase()
      .replace(/^(city|town|village|borough) of /i, '')
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
    const friendly = FRIENDLY_NAMES[input.office_type_slug] ?? input.office_type_slug;
    return `You are a civic-research agent for Havesay. Extract structured data about the ${friendly} of ${input.jurisdiction_name} (a municipal standalone office, not a body member) and the current officeholder.

# Office context
- office_id: ${input.office_id}
- canonical_name: ${input.canonical_name}
- office_type_slug: ${input.office_type_slug}
- level: municipal
- jurisdiction: ${input.jurisdiction_name}
- fips_state: ${input.fips_state ?? '(unknown)'}

# Per-city + per-state variance
- Mayor:
  - Strong mayor (executive + veto + appoint): NYC, LA, Chicago, etc.
  - Weak mayor (mostly ceremonial, council holds executive): many small cities
  - Council-manager form: mayor is ceremonial + a voting council member; city manager runs day-to-day
  - Mayor-on-council: in small towns, mayor IS the council chair, votes only on ties
- City Clerk: usually elected (sometimes appointed). Manages records, elections, council meeting minutes.
- City Treasurer: usually elected in older cities; appointed in modern council-manager cities.
- City Attorney: often appointed by council/mayor; some cities elect.
- Term length: usually 4 years; some 2-year mayoral terms in smaller cities; some 3-year cycles.
- Election cycle: many cities have ODD-year cycles (e.g., 2025/2027 for cities of size X) to separate from federal/state.

# Source allowlist
- en.wikipedia.org
- Any .gov / .us hostname (city .gov, county .gov, state .gov)

FORBIDDEN: ballotpedia.org, ncsl.org, social media, news outlets.

# Fetch sequence
1. WebSearch for the city's official .gov / .org site
2. WebFetch the "mayor" / "city clerk" / etc. page — current officeholder + bio + term
3. WebFetch Wikipedia for the city if more context needed
4. Note the form of government in the description

# Output schema (url / relevant_snippet field names)
{
  "office": {
    "canonical_name": "${friendly} of ${input.jurisdiction_name}",
    "short_name": "<short>",
    "description": "<2-4 sentences>",
    "powers_summary": "<actual statutory + charter authority — be specific>",
    "term_length_years": <int>,
    "term_start_month": <int>,
    "max_consecutive_terms": <int or null>,
    "selection_method": "elected_partisan"|"elected_nonpartisan"|"appointed",
    "primary_required": <bool>,
    "on_cycle_pattern": "<odd years | even years | every 4 years>",
    "next_regular_election_date": "<ISO date>",
    "workload": "full_time"|"part_time",
    "salary_annual_usd": <int or null>,
    "salary_year": 2026,
    "vacancy_appointment_authority": "<typically the council>",
    "vacancy_triggers_special": ["death","resignation","removal"],
    "special_election_timing_rule": "<per city charter — sometimes mandates special if > X months remain>",
    "voter_qualifications_summary": "US citizen, 18+, registered ${input.jurisdiction_name} resident",
    "form_of_government": "<mayor_council|council_manager|commission|town_meeting>"
  },
  "current_officeholder": {
    "person_name": "...",
    "party": "<R/D/I/nonpartisan>",
    "term_start": "<ISO date>",
    "term_end": "<ISO date>"
  },
  "citations": [
    { "url": "https://....gov/...", "title": "...", "kind": "gov_municipal", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" },
    { "url": "https://en.wikipedia.org/wiki/...", "title": "...", "kind": "wikipedia", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" }
  ],
  "disposition": "elected_verified" | "appointed" | "nonexistent" | "unconfirmed",
  "authoritative": <true ONLY when disposition === "elected_verified" (.gov source confirms current officeholder)>,
  "notes": "<form of government; strong/weak mayor; council-manager nuances; whether mayor votes on council>"
}

# Write the result to: \${RESULT_PATH}

# Rules
- Form of government is THE KEY structural fact — get it right or set authoritative=false.
- Strong-mayor cities have very different mayoral powers than weak-mayor or council-manager cities. Powers_summary should reflect the specific city, not a generic statement.
- If the city has no .gov website + no Wikipedia entry, the office is not verifiable — set authoritative=false and cite the state's municipal-government enabling statute as the structural authority.
`;
  },
};
