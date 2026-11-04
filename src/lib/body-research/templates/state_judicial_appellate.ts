/**
 * Template: state_judicial_appellate — intermediate appellate courts
 * (between trial courts and the state supreme court). Not every state
 * has one — small-population states often skip this layer and have
 * appeals go directly to the state supreme court.
 *
 * States with appellate courts (varies by name): California (Courts
 * of Appeal), New York (Appellate Division of the Supreme Court),
 * Texas (Courts of Appeals), Florida (District Courts of Appeal),
 * etc.
 */
import type { TemplateSpec } from '../types';

export const stateJudicialAppellate: TemplateSpec = {
  slug: 'state_judicial_appellate',

  matches: (input) =>
    input.chamber_type === 'appellate_court' &&
    input.jurisdiction_type === 'state',

  suggestedSources: (input) => {
    const slug = input.jurisdiction_name.toLowerCase().replace(/ /g, '_');
    return [
      `https://en.wikipedia.org/wiki/${input.jurisdiction_name.replace(/ /g, '_')}_Court_of_Appeals`,
      `https://courts.${slug}.gov`,
    ];
  },

  buildPrompt: (input) => `You are a civic-research agent for Havesay. Your task: extract structured data about an intermediate appellate court in ${input.jurisdiction_name} (between trial courts and the state supreme court) and its current judges from primary sources.

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: appellate_court
- jurisdiction: ${input.jurisdiction_name}
- attached offices in our catalog: ${input.attached_offices.length}

# Per-state naming variance — verify before assuming
- California: "Courts of Appeal" (6 districts, 105+ justices)
- New York: "Appellate Division of the Supreme Court"
- Texas: "Courts of Appeals" (14 courts, 80 justices)
- Florida: "District Courts of Appeal" (6 districts)
- Ohio: "Courts of Appeals" (12 districts)
- Massachusetts: "Appeals Court"
- Some states (smaller) have no intermediate appellate court — appeals go directly to supreme court

# Source allowlist
- en.wikipedia.org
- Any .gov / .us hostname (courts.${input.jurisdiction_name.toLowerCase().replace(/ /g, '')}.gov, ${input.jurisdiction_name.toLowerCase().replace(/ /g, '')}courts.gov)
- openstates.org

FORBIDDEN: ballotpedia.org, ncsl.org, statecourtreport.org, social media.

# Fetch sequence
1. WebSearch "${input.jurisdiction_name} appellate court Wikipedia"
2. smart_fetch the most relevant Wikipedia page — court structure, selection method, term length
3. smart_fetch the state court's .gov directory page for current judges

# Output schema (use field names: url / relevant_snippet)
{
  "body": {
    "canonical_name": "<verified per state>",
    "short_name": "<short>",
    "size_total": <int>,
    "seat_structure": [{ "count": <N>, "designation_kind": "district"|"at_large", "term_length_years": <6|8|10|12>, "stagger_offset_years": <varies> }],
    "selection_method": "elected_partisan"|"elected_nonpartisan"|"appointed"|"retention_election"|"merit_selection",
    "primary_required": <bool>,
    "on_cycle_pattern": "<retention every N years | partisan every N years | appointment + senate confirm>",
    "description": "<2-4 sentences>",
    "powers_summary": "<jurisdiction: appellate review of trial court decisions in civil + criminal matters>",
    "vacancy_appointment_authority": "<governor / nominating commission / etc.>",
    "vacancy_triggers_special": ["death","retirement","resignation","removal"],
    "special_election_timing_rule": "<state-specific>",
    "voter_qualifications_summary": "...",
    "salary_usd": <int or null>,
    "current_officers": { "chief_judge": { "name": "...", "since": "..." } }
  },
  "seats": [{ "seat_designation": "...", "current_officeholder": { "person_name": "...", "appointed_by": "...", "term_end": "..." } }],
  "citations": [{ "url": "...", "title": "...", "kind": "wikipedia"|"gov_state", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" }],
  "authoritative": <true if ≥2 sources agree>,
  "notes": "..."
}

# Write the result to: \${RESULT_PATH}

# Rules
- If ${input.jurisdiction_name} does NOT have an intermediate appellate court (e.g., this body might be misnamed), set authoritative=false and explain in notes. Don't invent.
- Selection method varies; verify per state.
- Term lengths range 6-12 years; some states have life tenure.
`,
};
