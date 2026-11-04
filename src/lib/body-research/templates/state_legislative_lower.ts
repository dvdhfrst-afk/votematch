/**
 * Template: state_legislative_lower — a state House / Assembly.
 * One body per state (except Nebraska, which has unicameral legislature
 * handled separately).
 *
 * Some states call it different things: New Jersey "General Assembly",
 * California "Assembly", Maryland "House of Delegates", Virginia
 * "House of Delegates", Wisconsin "Assembly", etc. Wikipedia URL
 * naming varies — the agent searches to find the canonical page.
 */
import type { TemplateSpec } from '../types';

export const stateLegislativeLower: TemplateSpec = {
  slug: 'state_legislative_lower',

  matches: (input) =>
    input.chamber_type === 'legislative_lower' &&
    (input.jurisdiction_type === 'state' || input.jurisdiction_type === 'federal_district' || input.jurisdiction_type === 'territory'),

  suggestedSources: (input) => {
    const slug = input.jurisdiction_name.toLowerCase().replace(/ /g, '_');
    return [
      `https://en.wikipedia.org/wiki/${input.jurisdiction_name.replace(/ /g, '_')}_House_of_Representatives`,
      `https://house.${slug}.gov`,
      `https://le.${slug}.gov`,
      `https://openstates.org/${slug}/legislators/`,
    ];
  },

  buildPrompt: (input) => {
    const enumerateMembers = input.attached_offices.length <= 150;
    return `You are a civic-research agent for Havesay. Your task: extract structured data about ${input.canonical_name} (the body) ${enumerateMembers ? 'and its current members' : '(body-level facts only — DO NOT enumerate per-member rosters; that data comes from OpenStates ingestion separately)'} from primary sources. The chamber may be called "House of Representatives", "General Assembly", "Assembly", or "House of Delegates" depending on the state.

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: legislative_lower
- jurisdiction: ${input.jurisdiction_name} (${input.jurisdiction_type})
- attached offices in our catalog: ${input.attached_offices.length}
${input.jurisdiction_type === 'federal_district' ? `
# Important: federal-district / territorial body
This is NOT a US state. Our catalog labels it as "${input.canonical_name}" but the body's actual name may differ:
- District of Columbia: the Council of the District of Columbia (single 13-member body — DC is unicameral; if our catalog has a separate "House" entry, treat this entry as the Council and note the mislabeling)
- Guam: the Guam Legislature (15-member unicameral; same caveat)
- US Virgin Islands: the Legislature of the Virgin Islands (15-member unicameral; same caveat)
- Puerto Rico: the House of Representatives of Puerto Rico (51-member lower chamber of bicameral Legislative Assembly)
- American Samoa: the House of Representatives (21-member lower chamber of bicameral Fono)
- Northern Mariana Islands: the House of Representatives (20-member lower chamber of bicameral Commonwealth Legislature)
Use the real local name when searching .gov sources. Record the real name + your assessment of whether the catalog's bicameral split is correct in the notes field.
` : ''}

# Source allowlist
- en.wikipedia.org
- Any .gov or .us hostname
- openstates.org

FORBIDDEN: ballotpedia.org, ncsl.org, social media, subscription sources.

# Fetch sequence
1. WebSearch "${input.jurisdiction_name} House of Representatives wikipedia" OR "${input.jurisdiction_name} Assembly wikipedia" to find the right page
2. smart_fetch the Wikipedia page — body size, term length, salary, current officers (Speaker, Majority/Minority Leaders)
3. WebSearch for the official .gov roster, fetch it, extract members
4. Note any naming quirk: e.g., Wisconsin "Assembly", Virginia "House of Delegates", Maryland "House of Delegates", Nebraska is UNICAMERAL — no lower chamber

# What to extract
\`\`\`json
{
  "body": {
    "canonical_name": "<official name, e.g., 'Virginia House of Delegates' / 'Wisconsin State Assembly'>",
    "short_name": "<short>",
    "size_total": <integer>,
    "seat_structure": [
      { "count": <N>, "designation_kind": "district", "term_length_years": <usually 2>, "stagger_offset_years": 0 }
    ],
    "selection_method": "elected_partisan" | "elected_nonpartisan",
    "primary_required": <bool>,
    "on_cycle_pattern": "<every 2 years (even) | annual | etc.>",
    "description": "<2-4 sentences>",
    "powers_summary": "<1 paragraph>",
    "vacancy_appointment_authority": "<state rule>",
    "vacancy_triggers_special": [...],
    "special_election_timing_rule": "...",
    "voter_qualifications_summary": "...",
    "salary_usd": <or null>,
    "current_officers": { "speaker": {...}, "majority_leader": {...}, "minority_leader": {...} }
  },
  "seats": [
    { "seat_designation": "District 1", "current_officeholder": { "person_name": "...", "party": "...", "term_end": "..." } },
    ...
  ],
  "citations": [
    { "url": "<wiki>", "title": "...", "kind": "wikipedia", "accessed_at": "2026-05-25", "relevant_snippet": "..." },
    { "url": "<gov roster>", "title": "...", "kind": "gov_state", "accessed_at": "2026-05-25", "relevant_snippet": "..." }
  ],
  "authoritative": <true if 2+ sources agree on size, else false>,
  "notes": "<caveats — multi-member districts, naming, etc.>"
}
\`\`\`

# Write the result to: \${RESULT_PATH}

# Critical notes per state (do not assume!)
- Multi-member-district states (AZ, ID, MD, NJ, ND, SD, WA): 2-3 reps per district. seat_structure should reflect.
- New Hampshire: 400 reps in mixed-size districts with floterial overlays. complex.
- Vermont: 150 reps in 104 districts, mix of single + dual-member.
- Nebraska: NO lower chamber (unicameral). Skip if this jurisdiction is Nebraska — write authoritative=false and explain.
- Iowa/Hawaii/etc: single-member; standard.

Do not just confirm our catalog count — verify from sources.

# Size mode for this run
- attached_offices.length = ${input.attached_offices.length}
- mode = ${enumerateMembers ? 'enumerate per-seat (small body)' : 'body-level only (large body; per-member data via OpenStates)'}
`;
  },
};
