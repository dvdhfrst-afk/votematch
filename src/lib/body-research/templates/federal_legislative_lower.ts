/**
 * Template: federal_legislative_lower — the United States House of Representatives.
 * Single body at the nation jurisdiction.
 *
 * Rewritten 2026-05-26: previous version deferred per-member extraction to a
 * separate Congress.gov pipeline ("DO NOT enumerate the 435 members"). That
 * split the architectural responsibilities awkwardly — the Senate template
 * already bundles body fields + all 100 members in one agent run (A+B
 * pattern), and the House should mirror that. This rewrite extracts all
 * 435 voting members + 6 non-voting delegates inline.
 *
 * Primary sources:
 *  - https://www.house.gov/representatives (current roster — all 441 in one page)
 *  - https://en.wikipedia.org/wiki/United_States_House_of_Representatives (CC BY-SA — body fields)
 *  - https://bioguide.congress.gov (for individual member lookups if needed)
 *
 * Scope note: the House has 435 voting members + 6 non-voting delegates
 * (DC + 4 territories + Puerto Rico's Resident Commissioner). They're all
 * catalogued as separate offices attached to this body.
 */
import type { TemplateSpec } from '../types';

export const federalLegislativeLower: TemplateSpec = {
  slug: 'federal_legislative_lower',

  matches: (input) =>
    input.chamber_type === 'legislative_lower' &&
    input.jurisdiction_type === 'nation',

  suggestedSources: () => [
    'https://www.house.gov/representatives',
    'https://en.wikipedia.org/wiki/United_States_House_of_Representatives',
    'https://bioguide.congress.gov',
  ],

  buildPrompt: (input) => `You are a civic-research agent for Havesay. Your task: verify the BODY-LEVEL structure of the United States House of Representatives from primary sources. DO NOT enumerate individual representatives in this phase — per-seat enrichment is Phase 1.5 (handled by a separate office-tenures pipeline).

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: legislative_lower
- jurisdiction: ${input.jurisdiction_name}
- attached offices in our catalog: ${input.attached_offices.length} (435 voting + 6 non-voting delegates/commissioner)

# CRITICAL SCOPE NOTE (changed 2026-05-28, task #128)
Earlier versions of this template asked you to extract all 441 House members with names/party/district/term_end. That enumeration hung plan-auth runs. Per current scope:
- IN-SCOPE: body-level structure (size_total=435, seat_structure shape, selection method, election cycle, powers summary, vacancy rules, current officer titles like "Speaker" but you do NOT need their names)
- OUT-OF-SCOPE: individual representative names, parties, district incumbents, biographies. Leave "seats" array EMPTY ([]). Do not fetch per-state or per-member pages.

# Source allowlist (ONLY fetch URLs whose host matches; never anything else)
- en.wikipedia.org (CC BY-SA — attribute properly)
- house.gov, congress.gov, senate.gov, bioguide.congress.gov (US government public domain)
- whitehouse.gov, supremecourt.gov, census.gov, fec.gov

FORBIDDEN sources (commercial-use prohibited per their TOS):
- ballotpedia.org, ncsl.org, brennancenter.org / statecourtreport.org
- Social media platforms
- Subscription / proprietary databases

# Suggested fetch sequence (KEEP THIS SHORT — body-level only, two fetches max)
1. smart_fetch(url="https://en.wikipedia.org/wiki/United_States_House_of_Representatives") — extract body-level fields: powers, salary, history, party-balance summary, congress number.
2. smart_fetch(url="https://www.house.gov/representatives") — verify the body exists at this canonical URL and that the page lists ~441 entries (you do NOT need to extract their names, just confirm the page is the official House roster).

That's it. Don't fan out to bioguide.congress.gov or per-state pages.

# What to extract
Emit a JSON document conforming to this schema:

\`\`\`json
{
  "body": {
    "canonical_name": "United States House of Representatives",
    "short_name": "US House",
    "size_total": 435,
    "seat_structure": [
      { "count": 435, "designation_kind": "district", "term_length_years": 2, "stagger_offset_years": 0 },
      { "count": 6, "designation_kind": "at_large", "term_length_years": 2, "stagger_offset_years": 0, "notes": "Non-voting delegates: DC + American Samoa + Guam + Northern Mariana Islands + Puerto Rico Resident Commissioner + US Virgin Islands. Catalogued as separate offices but institutionally part of the House." }
    ],
    "selection_method": "elected_partisan",
    "primary_required": true,
    "on_cycle_pattern": "every 2 years (even years); all 435 voting seats up every cycle (no staggering)",
    "description": "2-4 sentence neutral summary of the body's role and composition",
    "powers_summary": "1 paragraph covering enumerated powers (originating revenue bills, initiating impeachment, electing the President when no electoral majority, etc.)",
    "vacancy_appointment_authority": "None — vacancies are filled by special election only. The Speaker of the House issues a writ to the governor of the affected state, who then calls a special election under state law.",
    "vacancy_triggers_special": ["death", "resignation", "expulsion", "incapacitation"],
    "special_election_timing_rule": "State law sets the date; varies by state. Some states require expedited special elections within a few months; others schedule for the next regular general election.",
    "current_officers": { "speaker": { "name": "...", "party": "...", "since": "..." }, "majority_leader": { "name": "...", "party": "..." }, "minority_leader": { "name": "...", "party": "..." }, "majority_whip": { "name": "...", "party": "..." }, "minority_whip": { "name": "...", "party": "..." } },
    "congress_number": 119,
    "salary_usd": 174000
  },
  "seats": [],
  "citations": [
    { "url": "https://www.house.gov/representatives", "title": "Representatives | house.gov", "kind": "gov_federal", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars verbatim from page>" },
    { "url": "https://en.wikipedia.org/wiki/United_States_House_of_Representatives", "title": "United States House of Representatives — Wikipedia", "kind": "wikipedia", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars verbatim from page>" }
  ],
  "authoritative": true,
  "notes": "Body-structure verification only. Per-member extraction deferred to office-tenures pipeline (Phase 1.5)."
}
\`\`\`

# Write the result to
Use the Write tool to save the JSON to: \${RESULT_PATH}

# Rules
- ONLY fetch URLs whose host is on the allowlist above. Reject any other URL with an error note.
- Citations must include a verbatim snippet (≤280 chars) from each source.
- Set authoritative=true if you verified size_total=435 + seat structure + the existence of the roster page. Don't downgrade because you didn't extract per-member names — that's not in scope here.
- Do not invent data. Better to skip a field with null than guess.
- Two fetches is plenty for body-level verification. Don't fan out to per-state or per-member pages.
`,
};
