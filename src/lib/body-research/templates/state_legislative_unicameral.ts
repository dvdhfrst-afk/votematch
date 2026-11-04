/**
 * Template: state_legislative_unicameral — Nebraska's single-chamber
 * legislature (the only unicameral state legislature in the US).
 * 49 nonpartisan senators.
 */
import type { TemplateSpec } from '../types';

export const stateLegislativeUnicameral: TemplateSpec = {
  slug: 'state_legislative_unicameral',

  matches: (input) =>
    input.chamber_type === 'legislative_unicameral' &&
    (input.jurisdiction_type === 'state' || input.jurisdiction_type === 'federal_district' || input.jurisdiction_type === 'territory'),

  suggestedSources: () => [
    'https://en.wikipedia.org/wiki/Nebraska_Legislature',
    'https://nebraskalegislature.gov',
  ],

  buildPrompt: (input) => `You are a civic-research agent for Havesay. Your task: extract structured data about the ${input.jurisdiction_name} Legislature (the body) and its current senators from primary sources.

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: legislative_unicameral
- jurisdiction: ${input.jurisdiction_name}
- attached offices in our catalog: ${input.attached_offices.length}

# Special: Nebraska is the only US state with a unicameral legislature
- 49 members, called "senators" (NOT representatives, NOT assembly members)
- Officially NONPARTISAN — senators run without party labels on the ballot
- 4-year staggered terms (half elected every 2 years)
- Term-limited to two consecutive 4-year terms

# Source allowlist
- en.wikipedia.org
- nebraskalegislature.gov, ne.gov, sos.ne.gov, .gov, .us domains
- openstates.org

FORBIDDEN: ballotpedia.org, ncsl.org, social media.

# Fetch sequence
1. smart_fetch(url="https://en.wikipedia.org/wiki/Nebraska_Legislature") — body structure, history, salary, presiding officer (Lt Governor)
2. smart_fetch(url="https://nebraskalegislature.gov") — current senator roster + districts
3. Cross-check size; should be 49

# Output schema (use "url" not "source_url"; "relevant_snippet" not "verbatim_snippet")
{
  "body": {
    "canonical_name": "Nebraska Legislature",
    "short_name": "NE Legislature",
    "size_total": 49,
    "seat_structure": [
      { "count": 49, "designation_kind": "district", "term_length_years": 4, "stagger_offset_years": 2 }
    ],
    "selection_method": "elected_nonpartisan",
    "primary_required": true,
    "on_cycle_pattern": "every 2 years (even years); half-stagger",
    "description": "<2-4 sentences>",
    "powers_summary": "<1 paragraph>",
    "vacancy_appointment_authority": "Governor appoints",
    "vacancy_triggers_special": ["death","resignation","expulsion"],
    "special_election_timing_rule": "Next regular general election",
    "voter_qualifications_summary": "US citizen, 18+, registered resident of the district",
    "salary_usd": <int or null>,
    "current_officers": { "speaker": {...}, "president": {...} }
  },
  "seats": [{ "seat_designation": "District 1", "current_officeholder": { "person_name": "...", "term_end": "..." } }, ...],
  "citations": [{ "url": "...", "title": "...", "kind": "wikipedia"|"gov_state", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" }],
  "authoritative": true,
  "notes": "..."
}

# Write the result to: \${RESULT_PATH}

# Rules
- Term-limit note: 2 consecutive 4-year terms. Mention in description.
- Senators are officially nonpartisan but may caucus informally.
- If size ≠ 49, set authoritative=false; that means Wikipedia/.gov disagrees with reality.
`,
};
