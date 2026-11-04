/**
 * Template: state_legislative_upper — a state Senate (49 of these
 * since Nebraska is unicameral). One body per state under that
 * state's jurisdiction.
 *
 * Primary sources (per-state):
 *  - en.wikipedia.org/wiki/<State>_State_Senate
 *  - <state>.gov (state senate official roster) — many states use
 *    senate.<state>.gov or le.<state>.gov or legis.state.<usps>.us
 *  - openstates.org/<state>/legislators (ODbL — fallback)
 */
import type { TemplateSpec } from '../types';

export const stateLegislativeUpper: TemplateSpec = {
  slug: 'state_legislative_upper',

  matches: (input) =>
    input.chamber_type === 'legislative_upper' &&
    (input.jurisdiction_type === 'state' || input.jurisdiction_type === 'federal_district' || input.jurisdiction_type === 'territory'),

  suggestedSources: (input) => {
    const state = input.jurisdiction_name;
    const slug = state.toLowerCase().replace(/ /g, '_');
    return [
      `https://en.wikipedia.org/wiki/${state.replace(/ /g, '_')}_State_Senate`,
      `https://senate.${slug}.gov`,
      `https://le.${slug}.gov`,
      `https://openstates.org/${slug}/legislators/`,
    ];
  },

  buildPrompt: (input) => `You are a civic-research agent for Havesay. Your task: extract structured data about ${input.canonical_name} (the body) and its current members from primary sources, and emit a single JSON document at the path provided below.

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: legislative_upper
- jurisdiction: ${input.jurisdiction_name} (${input.jurisdiction_type})
- attached offices in our catalog: ${input.attached_offices.length}
${input.jurisdiction_type === 'federal_district' ? `
# Important: federal-district / territorial body
This is NOT a US state. Our catalog labels it as "${input.canonical_name}" but the body's actual name may differ:
- District of Columbia: the Council of the District of Columbia (single 13-member body — DC is unicameral; if our catalog has separate upper/lower entries, treat this entry as the Council and note the mislabeling)
- Guam: the Guam Legislature (15-member unicameral; same caveat)
- US Virgin Islands: the Legislature of the Virgin Islands (15-member unicameral; same caveat)
- Puerto Rico: the Senate of Puerto Rico (27-member upper chamber of bicameral Legislative Assembly)
- American Samoa: the Senate of American Samoa (18-member upper chamber of bicameral Fono)
- Northern Mariana Islands: the Senate (9-member upper chamber of bicameral Commonwealth Legislature)
Use the real local name when searching .gov sources. Record the real name + your assessment of whether the catalog's bicameral split is correct in the notes field.
` : ''}

# Source allowlist (ONLY fetch URLs whose host matches; never anything else)
- en.wikipedia.org (CC BY-SA — attribute properly)
- Any .gov or .us hostname — e.g. ${input.jurisdiction_name.toLowerCase().replace(/ /g, '')}.gov, le.${input.jurisdiction_name.toLowerCase().replace(/ /g, '')}.gov, senate.${input.jurisdiction_name.toLowerCase().replace(/ /g, '')}.gov, legis.state.<usps>.us
- openstates.org (ODbL — attribute properly)

FORBIDDEN sources:
- ballotpedia.org, ncsl.org, brennancenter.org, statecourtreport.org
- Social media platforms
- Subscription / proprietary databases

# Suggested fetch sequence
1. WebSearch "${input.jurisdiction_name} State Senate site:wikipedia.org" — find the canonical Wikipedia URL (DISCOVERY ONLY — Wikipedia is corroborating, NEVER source of truth).
2. WebSearch "${input.jurisdiction_name} state senate roster site:.gov" — find the official .gov senate roster URL (THIS is the source of truth).
3. smart_fetch the .gov roster URL (via the shim with bb_run_id + bb_body_id) — extract current senator names + districts + party.
4. smart_fetch the Wikipedia URL via plain WebFetch (corroborating only) — cross-check body size, leadership, term length.
5. ALSO smart_fetch the relevant state constitution / statute article that defines this chamber (e.g. for Vermont: https://legislature.vermont.gov/statutes/section/02/001/00001). The statute URL becomes \`statute_url\` and is the receipt for the one_liner you'll write.

# What to extract
Emit a JSON document conforming to this schema:

\`\`\`json
{
  "body": {
    "canonical_name": "${input.jurisdiction_name} State Senate",
    "short_name": "${input.jurisdiction_name.split(' ').map(w => w[0]).join('')} Senate",
    "size_total": <integer>,
    "seat_structure": [
      { "count": <N>, "designation_kind": "district", "term_length_years": <2|4>, "stagger_offset_years": <0|2> }
    ],
    "selection_method": "elected_partisan" | "elected_nonpartisan",
    "primary_required": <bool>,
    "on_cycle_pattern": "<even years half-stagger | etc.>",
    "description": "<2-4 sentence neutral summary>",
    "powers_summary": "<1 paragraph>",
    "vacancy_appointment_authority": "<the state's rule per the state constitution>",
    "vacancy_triggers_special": ["death", "resignation", ...],
    "special_election_timing_rule": "<state-specific>",
    "voter_qualifications_summary": "US citizen, 18+, registered resident of the state senate district",
    "salary_usd": <integer or null>,
    "current_officers": { "president": {...}, "president_pro_tempore": {...}, "majority_leader": {...}, "minority_leader": {...} },

    // ── OFFICE SCOPE (council v1, 2026-05-26) ──────────────────────────
    // The body inherits chamber_type defaults (state-level legislative
    // domains: ALL 12). You only fill domain_overrides if you found a
    // citation-backed reason this specific chamber has a different scope
    // (rare for state legislatures). For state senates, just omit this
    // field — defaults are correct.
    // "domain_overrides": { "added": [...], "removed": [...], "citations": [...] },

    "authority_mode": "legislative",   // standard for state senates

    // voter_facing_scope.one_liner: ≤160-char prose summary for voters.
    // MUST be backed by statute_url or charter_url that you actually fetched.
    // Example: "Vermont's 30-member upper chamber of the General Assembly,
    //          passing state laws and confirming gubernatorial appointments."
    "voter_facing_scope": {
      "one_liner": "<≤160 char neutral summary, citing statute_url below>",
      "statute_url": "<URL of the state constitution / statute article you fetched, required>",
      "charter_url": null
    },

    "statute_url": "<the same statute URL>",
    "charter_url": null
  },
  "seats": [
    { "seat_designation": "District 1", "current_officeholder": { "person_name": "...", "party": "...", "term_end": "..." } },
    ... per-district ...
  ],
  "citations": [
    { "url": "<wiki url>", "title": "...", "kind": "wikipedia", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" },
    { "url": "<gov roster url>", "title": "...", "kind": "gov_state", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" }
  ],
  // authoritative=true REQUIRES:
  //   - the .gov roster URL above appears in the shim's per-run fetch log
  //     (you actually fetched it — not memorized)
  //   - at least one citation classified as primary (.gov / .us state-nested)
  //   - statute_url cited and fetched (for the voter_facing_scope receipt)
  // Wikipedia agreement alone does NOT satisfy authoritative=true.
  "authoritative": <true ONLY if you fetched the .gov roster AND a statute URL via the shim with bb_run_id + bb_body_id>,
  "notes": "<caveats / contested fields>"
}
\`\`\`

# Write the result to
Use the Write tool to save the JSON to: \${RESULT_PATH}

# Rules
- ONLY fetch URLs whose host is on the allowlist above.
- Citations must include a verbatim snippet (≤280 chars) per source.
- If you cannot verify the body's size against ≥2 sources, set authoritative=false.
- Do not invent senators. If the .gov page is unreachable, set authoritative=false and report in notes.
- ${input.jurisdiction_name} state senate is currently catalogued in our DB with ${input.attached_offices.length} seats — DO NOT just copy that number; verify from sources.
- TRUST POLICY: Wikipedia and OpenStates can corroborate or help you find the .gov URL. They are NEVER the source of truth on their own. authoritative=true requires you to have actually fetched at least one primary-tier .gov source through the shim with bb_run_id + bb_body_id correlation params. The writer cross-checks your citation URLs against the shim's fetch log and rejects authoritative=true if your primary citations were never actually fetched.
- voter_facing_scope.one_liner must be ≤160 chars and backed by a statute_url or charter_url you actually fetched. Length and citation-presence both verified by the writer.
`,
};
