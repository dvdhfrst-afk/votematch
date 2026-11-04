/**
 * Template: township_board — Midwest + NY township government.
 *
 * Township boards in the Midwest (MI, WI, MN, OH, IL, PA, IN) typically
 * consist of a Supervisor (chief executive), 2-4 Trustees, a Clerk, and
 * a Treasurer. NY uses "Town Supervisor" + Town Board (typically 5
 * including Supervisor).
 *
 * Per-state variance is meaningful — verify against state township
 * statute + the specific township's website (most townships have only
 * a basic *.org page or no online presence).
 */
import type { TemplateSpec } from '../types';

export const townshipBoard: TemplateSpec = {
  slug: 'township_board',

  matches: (input) =>
    input.chamber_type === 'township_board' &&
    (input.jurisdiction_type === 'township' || input.jurisdiction_type === 'municipality'),

  suggestedSources: (input) => {
    const slug = input.jurisdiction_name.toLowerCase()
      .replace(/ township$/i, '')
      .replace(/ town$/i, '')
      .replace(/ /g, '_');
    return [
      `https://en.wikipedia.org/wiki/${input.jurisdiction_name.replace(/ /g, '_')}`,
      `https://www.${slug}.org`,
      `https://www.${slug}township.org`,
    ];
  },

  buildPrompt: (input) => `You are a civic-research agent for Havesay. Your task: extract structured data about the ${input.jurisdiction_name} Township Board and its current members from primary sources.

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: township_board
- jurisdiction: ${input.jurisdiction_name}
- fips_state: ${input.fips_state ?? '(unknown)'}
- attached offices in our catalog: ${input.attached_offices.length}

# Critical: per-state township structure
- Michigan, Pennsylvania, Indiana, Ohio: Township Supervisor + 2-4 Trustees + Clerk + Treasurer (the "board"; sometimes Clerk + Treasurer are separate standalone offices in our catalog)
- New York: Town Supervisor + 2-4 Town Council Members (called the "Town Board"); Town Clerk + Town Justice usually separate
- Wisconsin: Town Chair + 2 Supervisors (3-person board)
- Minnesota: Town Board Chair + 2-4 Town Board Members
- Illinois: Township Supervisor + 4 Township Trustees + Township Clerk + Highway Commissioner + Assessor
- New England: NO townships in this sense — use selectboard template instead
- Term lengths: typically 2 or 4 years; some 6
- Selection: usually nonpartisan in MI/MN/WI; sometimes partisan in NY/PA/IN

# Source allowlist
- en.wikipedia.org
- Any .gov / .us hostname for the township
- openstates.org

FORBIDDEN: ballotpedia.org, ncsl.org, social media.

# Fetch sequence
1. smart_fetch the township's official site if available (many small townships have only a basic page)
2. smart_fetch Wikipedia for the township (rare for small townships) or for the state's township statute reference
3. If no .gov source, cite the state's township law (e.g., Michigan Constitution Art. VII, Michigan Township Association website if .gov)

# Output schema (url / relevant_snippet)
{
  "body": {
    "canonical_name": "${input.jurisdiction_name} Township Board",
    "short_name": "<short>",
    "size_total": <int>,
    "seat_structure": [
      { "count": 1, "designation_kind": "at_large", "term_length_years": <2|4>, "stagger_offset_years": <varies>, "office_role": "supervisor" },
      { "count": <N>, "designation_kind": "at_large", "term_length_years": <2|4>, "stagger_offset_years": <varies>, "office_role": "trustee" }
    ],
    "selection_method": "elected_partisan"|"elected_nonpartisan",
    "primary_required": <bool>,
    "on_cycle_pattern": "<varies — many townships have spring elections>",
    "description": "<2-4 sentences about township government in this state>",
    "powers_summary": "<township responsibilities: roads (often the largest budget item), assessments, cemeteries, fire protection in unincorporated areas, etc.>",
    "vacancy_appointment_authority": "<typically the board itself appoints; varies>",
    "vacancy_triggers_special": ["death","resignation","removal"],
    "special_election_timing_rule": "...",
    "voter_qualifications_summary": "US citizen, 18+, registered resident of the township",
    "salary_usd": <int or null — often $0 stipend or per-meeting>,
    "form_of_government": "township_supervisor"|"town_board"|"other"
  },
  "seats": [{ "seat_designation": "Supervisor"|"Trustee 1"|"Clerk", "current_officeholder": { "person_name": "...", "term_end": "..." } }],
  "citations": [{ "url": "...", "title": "...", "kind": "wikipedia"|"gov_state"|"gov_other", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" }],
  "authoritative": <true if .gov confirms>,
  "notes": "<state-specific structure variations; whether Clerk/Treasurer are board members or standalone>"
}

# Write the result to: \${RESULT_PATH}

# Rules
- DO NOT assume New England township structure for Midwest townships; they're entirely different. New England towns use selectboards (different template).
- Many small townships have no online presence; in that case, cite the STATE township statute (e.g., Michigan Constitution Art. VII + MCL Ch. 41, Pennsylvania Township Code, etc.) and set authoritative=false (no specific verification of this exact township).
- Township Clerk + Treasurer may be separate standalone offices in the catalog; don't double-count them in the body's seat_structure if they're modeled as standalone.
`,
};
