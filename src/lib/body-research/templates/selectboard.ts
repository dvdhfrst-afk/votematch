/**
 * Template: selectboard — New England-style town government.
 *
 * The selectboard (also "Board of Selectmen" historically, now mostly
 * gender-neutralized to "Selectboard" or "Select Board") is the
 * executive body of a New England town. Typically 3 or 5 members.
 *
 * States: VT, NH, ME, MA, RI, CT. Each has its own statutory framing.
 * - VT, NH: "Selectboard" or "Board of Selectmen", 3-5 members, 2-3yr terms
 * - ME: "Board of Selectmen" or "Select Board", 3-5 members, 1-3yr terms
 * - MA: "Select Board" (or "Board of Selectmen" pre-2018 modernization)
 * - CT: "First Selectman" + "Board of Selectmen" — note that First
 *   Selectman is also a standalone executive office; the body is the
 *   full selectboard including the chair
 * - RI: less common; some towns use them, others use council form
 */
import type { TemplateSpec } from '../types';

export const selectboard: TemplateSpec = {
  slug: 'selectboard',

  matches: (input) =>
    input.chamber_type === 'selectboard' &&
    (input.jurisdiction_type === 'municipality' || input.jurisdiction_type === 'township'),

  suggestedSources: (input) => {
    const slug = input.jurisdiction_name.toLowerCase()
      .replace(/^town of /i, '')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/ /g, '');
    return [
      `https://en.wikipedia.org/wiki/${input.jurisdiction_name.replace(/ /g, '_')}`,
      `https://www.${slug}.org`,
      `https://www.${slug}vt.us`,
      `https://www.${slug}nh.us`,
      `https://www.${slug}ma.us`,
    ];
  },

  buildPrompt: (input) => `You are a civic-research agent for Havesay. Your task: extract structured data about the ${input.jurisdiction_name} selectboard / board of selectmen and its current members from primary sources.

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: selectboard
- jurisdiction: ${input.jurisdiction_name}
- fips_state: ${input.fips_state ?? '(unknown)'}
- attached offices in our catalog: ${input.attached_offices.length}

# Critical: per-state New England selectboard structure
- Vermont: "Selectboard", 3 or 5 members, 2-3 year terms. Annual Town Meeting Day elects members.
- New Hampshire: "Board of Selectmen", 3 or 5 members. Town Meeting elects.
- Maine: "Board of Selectmen" or "Select Board", 3-5 members, 1-3 year terms. Annual town meeting.
- Massachusetts: "Select Board" (modernized from "Board of Selectmen" in 2018), 3 or 5 members, 3-year staggered terms typical.
- Rhode Island: less common — used in some towns; called "Town Council" in others.
- Connecticut: "Board of Selectmen" with a "First Selectman" as chief executive. First Selectman runs separately from the rest of the board (often opposite-party "minority selectman" included by charter).
- Members serve in legislative AND quasi-executive capacity (the town manager or town administrator handles day-to-day execution).
- Terms typically 2-3 years; CT often 2; MA often 3; VT often 3.

# Source allowlist
- en.wikipedia.org
- Any .gov / .us hostname (town's website, often *.org or *.<state>.us)

FORBIDDEN: ballotpedia.org, ncsl.org, social media.

# Fetch sequence
1. smart_fetch the town's official site if available
2. smart_fetch the town's Wikipedia page (most New England towns have basic Wikipedia entries)
3. Cite the relevant state statute (e.g., Mass. Gen. Laws Ch. 41, VT 24 V.S.A. Ch. 31) for the legal framework

# Output schema (url / relevant_snippet)
{
  "body": {
    "canonical_name": "${input.jurisdiction_name} Selectboard" or "Board of Selectmen",
    "short_name": "<short>",
    "size_total": <int — usually 3 or 5>,
    "seat_structure": [{ "count": <N>, "designation_kind": "at_large", "term_length_years": <1|2|3>, "stagger_offset_years": <varies> }],
    "selection_method": "elected_nonpartisan",
    "primary_required": false,
    "on_cycle_pattern": "<usually annual town meeting day — March in VT/NH, varies elsewhere>",
    "description": "<2-4 sentences about selectboard role in this state>",
    "powers_summary": "<executive + legislative duties for the town: budget recommendation, hiring of town administrator, signing warrants, holding public hearings>",
    "vacancy_appointment_authority": "<remaining selectboard appoints replacement until next town meeting>",
    "vacancy_triggers_special": ["death","resignation","removal"],
    "special_election_timing_rule": "Next town meeting (annual)",
    "voter_qualifications_summary": "US citizen, 18+, registered resident of the town",
    "salary_usd": <int — often $1,000-5,000 stipend>,
    "form_of_government": "selectboard_town_meeting"|"selectboard_town_administrator"|"first_selectman_form"
  },
  "seats": [{ "seat_designation": "Selectperson Seat 1" or "Chair" or "First Selectman", "current_officeholder": { "person_name": "...", "term_end": "..." } }],
  "citations": [{ "url": "...", "title": "...", "kind": "wikipedia"|"gov_other", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" }],
  "authoritative": <true if town source confirms>,
  "notes": "<form_of_government variations; CT First Selectman special role; whether town meeting is open or representative>"
}

# Write the result to: \${RESULT_PATH}

# Rules
- Selectboards are NONPARTISAN in nearly all cases (verify per state).
- Distinguish "open town meeting" (all voters legislate directly) from "representative town meeting" (elected representatives).
- For CT towns specifically: the First Selectman is a standalone executive office in our catalog AND chairs the Board of Selectmen. Mention in notes so reviewer can verify the standalone office linkage.
- If the town has no online presence, cite the state statute and set authoritative=false.
`,
};
