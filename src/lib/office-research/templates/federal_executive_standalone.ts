/**
 * Template: federal_executive_standalone — POTUS, VPOTUS.
 *
 * Two offices only, both at nation jurisdiction. Sources are
 * comprehensive (Wikipedia + whitehouse.gov + Constitution).
 */
import type { OfficeTemplateSpec } from '../types';

const FEDERAL_EXECUTIVE_SLUGS = new Set(['us_president', 'us_vice_president']);

export const federalExecutiveStandalone: OfficeTemplateSpec = {
  slug: 'federal_executive_standalone',

  matches: (input) =>
    input.level === 'federal' &&
    input.jurisdiction_type === 'nation' &&
    FEDERAL_EXECUTIVE_SLUGS.has(input.office_type_slug),

  suggestedSources: (input) => {
    if (input.office_type_slug === 'us_president') {
      return [
        'https://en.wikipedia.org/wiki/President_of_the_United_States',
        'https://www.whitehouse.gov/administration/president',
      ];
    }
    return [
      'https://en.wikipedia.org/wiki/Vice_President_of_the_United_States',
      'https://www.whitehouse.gov/administration/vice-president',
    ];
  },

  buildPrompt: (input) => {
    const isPres = input.office_type_slug === 'us_president';
    const title = isPres ? 'President of the United States' : 'Vice President of the United States';
    return `You are a civic-research agent for Havesay. Extract structured editorial + structural data about the ${title} (a standalone executive office, not a body) and the current officeholder.

# Office context
- office_id: ${input.office_id}
- canonical_name: ${input.canonical_name}
- office_type_slug: ${input.office_type_slug}
- level: federal
- jurisdiction: ${input.jurisdiction_name} (nation)

# Source allowlist
- en.wikipedia.org (CC BY-SA — attribute)
- whitehouse.gov, congress.gov, senate.gov, house.gov, supremecourt.gov,
  census.gov, fec.gov, gpo.gov (US Government public domain)

FORBIDDEN: ballotpedia.org, ncsl.org, social media, news outlets.

# Fetch sequence
1. WebFetch the Wikipedia page for the office — description, powers, term length, history, salary, current officeholder
2. WebFetch the whitehouse.gov page for the office — confirm current officeholder + party + start date

# Output schema (url / relevant_snippet field names)
{
  "office": {
    "canonical_name": "${title}",
    "short_name": "${isPres ? 'President' : 'Vice President'}",
    "description": "<2-4 sentence neutral summary>",
    "powers_summary": "<1 paragraph covering enumerated powers>",
    "term_length_years": 4,
    "term_start_month": 1,
    "max_consecutive_terms": ${isPres ? 2 : null},
    "selection_method": "elected_partisan",
    "primary_required": true,
    "on_cycle_pattern": "presidential cycle (every 4 years; 2024, 2028, 2032, ...)",
    "next_regular_election_date": "<ISO date>",
    "workload": "full_time",
    "salary_annual_usd": ${isPres ? 400000 : 235100},
    "salary_year": 2026,
    "vacancy_appointment_authority": "<succession rule per 25th Amendment>",
    "vacancy_triggers_special": ["death","resignation","removal_by_impeachment","incapacitation"],
    "special_election_timing_rule": "<succession only; no special election>",
    "voter_qualifications_summary": "US citizen, 18+, registered in the state where voting; Electoral College via state-level vote",
    "presides_over_body_canonical_name": ${isPres ? 'null' : '"United States Senate"'}
  },
  "current_officeholder": {
    "person_name": "<current name>",
    "party": "<R/D/I>",
    "term_start": "<ISO date>",
    "term_end": "<ISO date>"
  },
  "citations": [
    { "url": "https://en.wikipedia.org/wiki/...", "title": "...", "kind": "wikipedia", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars verbatim>" },
    { "url": "https://www.whitehouse.gov/...", "title": "...", "kind": "gov_federal", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars verbatim>" }
  ],
  "disposition": "elected_verified",
  "authoritative": true,
  "notes": "<caveats or ongoing transitions>"
}

# Write the result to: \${RESULT_PATH}

# Rules
- Cite ≥1 .gov source for the current officeholder (Wikipedia alone can lag for transitions).
- Use field names "url" and "relevant_snippet" (NOT source_url / verbatim_snippet).
- If current officeholder data is contested (e.g., between an outgoing and incoming admin during transition), use the most recent inauguration date as the authoritative.
- POTUS: include 22nd Amendment term limit (2 consecutive terms or 10 years total if completed a partial term).
- VP: no term limit as VP; presides over US Senate; first in line of presidential succession.
`;
  },
};
