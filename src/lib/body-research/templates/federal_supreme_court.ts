/**
 * Template: federal_supreme_court — the Supreme Court of the United States.
 * Single body at the nation jurisdiction.
 *
 * Body-structure verification only per task #128 — does NOT enumerate the
 * 9 justices in this phase. Per-justice extraction is Phase 1.5 (office
 * tenures pipeline).
 *
 * Primary sources:
 *  - https://www.supremecourt.gov/about/biographies.aspx (current roster)
 *  - https://www.supremecourt.gov/about/justices.aspx (alternate roster)
 *  - https://en.wikipedia.org/wiki/Supreme_Court_of_the_United_States (body context)
 */
import type { TemplateSpec } from '../types';

export const federalSupremeCourt: TemplateSpec = {
  slug: 'federal_supreme_court',

  matches: (input) =>
    input.chamber_type === 'federal_supreme_court' &&
    input.jurisdiction_type === 'nation',

  suggestedSources: () => [
    'https://www.supremecourt.gov/about/biographies.aspx',
    'https://www.supremecourt.gov/about/justices.aspx',
    'https://en.wikipedia.org/wiki/Supreme_Court_of_the_United_States',
  ],

  buildPrompt: (input) => `You are a civic-research agent for Havesay. Your task: verify the BODY-LEVEL structure of the Supreme Court of the United States from primary sources. DO NOT enumerate individual justices in this phase — per-seat enrichment is Phase 1.5 (handled by a separate office-tenures pipeline).

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: federal_supreme_court
- jurisdiction: ${input.jurisdiction_name}

# Scope (per task #128)
- IN-SCOPE: body-level structure (size_total=9, seat structure, selection method=appointed, life tenure rules, original + appellate jurisdiction scope, opinion-issuance norms)
- OUT-OF-SCOPE: individual justice names, biographies, ideological lean, individual opinions. Leave "seats" array EMPTY ([]).

# Source allowlist
- en.wikipedia.org (CC BY-SA — attribute properly)
- supremecourt.gov, congress.gov (US government public domain)
- law.cornell.edu (Article III of the Constitution)

FORBIDDEN sources:
- ballotpedia.org, ncsl.org, brennancenter.org, statecourtreport.org
- Social media, subscription databases

# Suggested fetch sequence (TWO fetches, body-level only)
1. smart_fetch(url="https://www.supremecourt.gov/about/biographies.aspx") — verify the body exists at this canonical URL and the page lists 9 justices.
2. smart_fetch(url="https://en.wikipedia.org/wiki/Supreme_Court_of_the_United_States") — extract body-level fields: powers, jurisdiction, history, term-start convention.

# What to extract

\`\`\`json
{
  "body": {
    "canonical_name": "Supreme Court of the United States",
    "short_name": "US Supreme Court",
    "size_total": 9,
    "seat_structure": [
      { "count": 1, "designation_kind": "at_large", "term_length_years": null, "notes": "Chief Justice — distinct designation but counted within the 9" },
      { "count": 8, "designation_kind": "at_large", "term_length_years": null, "notes": "Associate Justices — life tenure during good behavior, no fixed term" }
    ],
    "selection_method": "appointed",
    "primary_required": false,
    "on_cycle_pattern": "none — justices serve life tenure during good behavior; vacancies filled by presidential nomination + Senate confirmation as they arise",
    "description": "2-4 sentence neutral summary of SCOTUS's role and composition",
    "powers_summary": "1 paragraph covering enumerated powers (original + appellate jurisdiction per Article III; judicial review per Marbury v. Madison; final interpreter of federal law and the US Constitution)",
    "vacancy_appointment_authority": "President nominates; Senate confirms by majority vote",
    "vacancy_triggers_special": ["death", "resignation", "retirement", "impeachment removal"],
    "special_election_timing_rule": "Not applicable — justices are not elected. Vacancies remain open until a successor is confirmed by the Senate."
  },
  "seats": [],
  "citations": [
    { "url": "https://www.supremecourt.gov/about/biographies.aspx", "title": "Current Members | Supreme Court of the United States", "kind": "gov_federal", "accessed_at": "2026-05-28", "relevant_snippet": "<≤280 chars verbatim from page>" },
    { "url": "https://en.wikipedia.org/wiki/Supreme_Court_of_the_United_States", "title": "Supreme Court of the United States — Wikipedia", "kind": "wikipedia", "accessed_at": "2026-05-28", "relevant_snippet": "<≤280 chars verbatim from page>" }
  ],
  "authoritative": true,
  "notes": "Body-structure verification only. Per-justice extraction deferred to office-tenures pipeline (Phase 1.5)."
}
\`\`\`

# Write the result to
Use the Write tool to save the JSON to: \${RESULT_PATH}

# Rules
- ONLY fetch URLs whose host is on the allowlist above.
- Citations must include a verbatim snippet (≤280 chars) from each source.
- Set authoritative=true if you verified size_total=9 + the canonical roster page exists.
- Do not invent data. Better to skip a field with null than guess.
- Two fetches is plenty.
`,
};
