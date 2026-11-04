/**
 * Template: federal_legislative_upper — the United States Senate.
 * Single body at the nation jurisdiction.
 *
 * Primary sources:
 *  - https://en.wikipedia.org/wiki/United_States_Senate (CC BY-SA)
 *  - https://www.senate.gov/senators/SenateSalariesSince1789.htm (public domain)
 *  - https://www.senate.gov/general/contact_information/senators_cfm.cfm (public domain — current 100 senators with party + state)
 */
import type { AgentInput, TemplateSpec } from '../types';

export const federalLegislativeUpper: TemplateSpec = {
  slug: 'federal_legislative_upper',

  matches: (input) =>
    input.chamber_type === 'legislative_upper' &&
    input.jurisdiction_type === 'nation',

  suggestedSources: () => [
    'https://en.wikipedia.org/wiki/United_States_Senate',
    'https://www.senate.gov/senators/SenateSalariesSince1789.htm',
    'https://www.senate.gov/general/contact_information/senators_cfm.cfm',
  ],

  buildPrompt: (input) => `You are a civic-research agent for Havesay. Your task: verify the BODY-LEVEL structure of the United States Senate from primary sources. DO NOT enumerate individual senators in this phase — per-seat enrichment is Phase 1.5 (handled by a separate office-tenures pipeline).

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: legislative_upper
- jurisdiction: ${input.jurisdiction_name}
- attached offices in our catalog: ${input.attached_offices.length}

# CRITICAL SCOPE NOTE (changed 2026-05-28, task #128)
Earlier versions of this template asked you to extract all 100 senators with names/party/term_end. That enumeration was hanging plan-auth runs for 20+ minutes on a body that only needed body-level verification. Per the current scope:
- IN-SCOPE for this run: body-level structure (size_total=100, seat_structure shape, selection method, election cycle, powers summary, vacancy rules)
- OUT-OF-SCOPE for this run: individual senator names, parties, term end dates, biographies. Leave the "seats" array EMPTY ([]). Do not fetch any individual senator's bio page.

# Source allowlist (ONLY fetch URLs whose host matches; never anything else)
- en.wikipedia.org (CC BY-SA — attribute properly)
- senate.gov, house.gov, congress.gov, bioguide.congress.gov (US government public domain)
- whitehouse.gov, supremecourt.gov, census.gov, fec.gov

FORBIDDEN sources (commercial-use prohibited per their TOS):
- ballotpedia.org, ncsl.org, brennancenter.org / statecourtreport.org
- Social media platforms
- Subscription / proprietary databases

# Suggested fetch sequence (KEEP THIS SHORT — body-level only)
1. smart_fetch(url="https://en.wikipedia.org/wiki/United_States_Senate") — extract body structure, powers, salary, history.
2. smart_fetch(url="https://www.senate.gov/senators/") — verify the body exists at this canonical URL and that the page lists ~100 senators (you do NOT need to extract their names, just confirm the page is the official Senate roster and the count of entries matches size_total=100).

That's it. Two fetches max. Don't pull per-senator pages.

# What to extract
Emit a JSON document conforming to this schema:

\`\`\`json
{
  "body": {
    "canonical_name": "United States Senate",
    "short_name": "US Senate",
    "size_total": 100,
    "seat_structure": [
      { "count": 100, "designation_kind": "state_pair", "term_length_years": 6, "stagger_offset_years": 2, "classes": [1, 2, 3] }
    ],
    "selection_method": "elected_partisan",
    "primary_required": true,
    "on_cycle_pattern": "even years, with ~1/3 of seats up every 2 years rotating Class I → II → III",
    "description": "2-4 sentence neutral summary of the body's role and composition",
    "powers_summary": "1 paragraph covering enumerated powers (legislation, advice & consent, treaty ratification, impeachment trials, etc.)",
    "vacancy_appointment_authority": "Governor of the senator's state appoints a temporary replacement under most state laws; specific rules vary by state",
    "vacancy_triggers_special": ["death", "resignation", "expulsion", "incapacitation"],
    "special_election_timing_rule": "Varies by state; typically at the next regular general election"
  },
  "seats": [],
  "citations": [
    { "url": "https://en.wikipedia.org/wiki/United_States_Senate", "title": "United States Senate — Wikipedia", "kind": "wikipedia", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars verbatim from page>" },
    { "url": "https://www.senate.gov/senators/", "title": "Senators of the 119th Congress", "kind": "gov_federal", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars verbatim from page>" }
  ],
  "authoritative": true,
  "notes": "Body-structure verification only. Per-senator extraction deferred to office-tenures pipeline (Phase 1.5)."
}
\`\`\`

# Write the result to
Use the Write tool to save the JSON to: \${RESULT_PATH}

# Rules
- ONLY fetch URLs whose host is on the allowlist above. Reject any other URL with an error note.
- Citations must include a verbatim snippet (≤280 chars) from each source.
- Set authoritative=true if you verified size_total=100 + seat structure + the existence of the roster page. Don't downgrade because you didn't extract per-senator names — that's not in scope here.
- Do not invent data. Better to skip a field with null than guess.
- Two fetches is plenty for body-level verification. Don't fan out to per-state or per-senator pages.
`,
};
