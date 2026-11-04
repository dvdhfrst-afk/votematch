/**
 * Template: state_judicial_supreme — a state supreme court. Each state
 * has exactly one, with 5-9 justices typically.
 *
 * Selection methods vary widely:
 *  - Partisan election (e.g., Texas, Alabama)
 *  - Nonpartisan election (e.g., Wisconsin, Nevada)
 *  - Merit selection / retention (e.g., Utah, Arizona, Alaska)
 *  - Gubernatorial appointment (e.g., New Jersey, Hawaii)
 *  - Legislative election (Virginia, South Carolina)
 * The template asks the agent to identify which one.
 */
import type { TemplateSpec } from '../types';

export const stateJudicialSupreme: TemplateSpec = {
  slug: 'state_judicial_supreme',

  matches: (input) =>
    input.chamber_type === 'state_supreme_court' &&
    input.jurisdiction_type === 'state',

  suggestedSources: (input) => {
    const slug = input.jurisdiction_name.toLowerCase().replace(/ /g, '_');
    return [
      `https://en.wikipedia.org/wiki/${input.jurisdiction_name.replace(/ /g, '_')}_Supreme_Court`,
      `https://courts.${slug}.gov`,
      `https://${slug}courts.gov`,
    ];
  },

  buildPrompt: (input) => `You are a civic-research agent for Havesay. Your task: extract structured data about the ${input.jurisdiction_name} Supreme Court and its current justices from primary sources.

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: state_supreme_court
- jurisdiction: ${input.jurisdiction_name}
- attached offices in our catalog: ${input.attached_offices.length}

# Source allowlist
- en.wikipedia.org
- Any .gov or .us hostname (e.g., courts.${input.jurisdiction_name.toLowerCase().replace(/ /g, '')}.gov)

FORBIDDEN: ballotpedia.org, ncsl.org, statecourtreport.org, social media.

# Fetch sequence
1. smart_fetch(url="https://en.wikipedia.org/wiki/${input.jurisdiction_name.replace(/ /g, '_')}_Supreme_Court") — court structure, selection method, term length, current chief justice + associate justices
2. WebSearch "${input.jurisdiction_name} Supreme Court justices site:.gov" for the official court roster
3. smart_fetch the official .gov page — extract current justices with appointment date / term end

# What to extract
\`\`\`json
{
  "body": {
    "canonical_name": "${input.jurisdiction_name} Supreme Court",
    "short_name": "${input.jurisdiction_name.split(' ').map(w => w[0]).join('')} Supreme Court",
    "size_total": <5/7/9 etc.>,
    "seat_structure": [
      { "count": <N>, "designation_kind": "at_large", "term_length_years": <6|8|10|12|life>, "stagger_offset_years": <varies> }
    ],
    "selection_method": "elected_partisan" | "elected_nonpartisan" | "appointed" | "retention_election" | "merit_selection",
    "primary_required": <bool>,
    "on_cycle_pattern": "<retention every N years | partisan every N years | gubernatorial appointment + senate confirmation>",
    "description": "<2-4 sentences>",
    "powers_summary": "<jurisdiction: state law interpretation, constitutional review, appellate review, lawyer discipline, rule-making>",
    "vacancy_appointment_authority": "<governor / nominating commission / legislature>",
    "vacancy_triggers_special": ["death", "retirement", "resignation", "removal"],
    "special_election_timing_rule": "<usually appointment then retention at next general>",
    "voter_qualifications_summary": "...",
    "salary_usd": <NCSC justice salary if findable>,
    "current_officers": { "chief_justice": { "name": "...", "since": "..." } }
  },
  "seats": [
    { "seat_designation": "Chief Justice", "current_officeholder": { "person_name": "...", "term_end": "...", "appointed_by": "...", "appointed_year": <int> } },
    { "seat_designation": "Associate Justice — Seat 1", "current_officeholder": {...} },
    ... per seat ...
  ],
  "citations": [
    { "url": "<wiki>", "title": "...", "kind": "wikipedia", "accessed_at": "2026-05-25", "relevant_snippet": "..." },
    { "url": "<courts.gov>", "title": "...", "kind": "gov_state", "accessed_at": "2026-05-25", "relevant_snippet": "..." }
  ],
  "authoritative": <true if 2+ sources agree, else false>,
  "notes": "<term-length variations; selection-method nuances>"
}
\`\`\`

# Write the result to: \${RESULT_PATH}

# Critical: selection_method is state-specific
- DO NOT assume "elected" — verify whether it's appointment / merit / retention / partisan / nonpartisan
- term_length_years varies: 6 (TX) / 8 (NC) / 10 (UT, MD, IL) / 12 (CA, NY, AK) / life-tenure-pending-impeachment (RI, MA, NH)
- Some states have chief justice rotation; others have a designated permanent chief
`,
};
