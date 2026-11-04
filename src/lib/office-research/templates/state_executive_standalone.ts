/**
 * Template: state_executive_standalone — governors, lt governors,
 * attorneys general, secretaries of state, treasurers, auditors,
 * comptrollers, agriculture commissioners, etc.
 *
 * Per-state variance is meaningful: some states elect a Comptroller
 * vs a Controller; some have a Treasurer + Auditor; some merge them;
 * some elect a Lt Gov on a separate ticket vs joint; etc.
 */
import type { OfficeTemplateSpec } from '../types';

const STATE_EXECUTIVE_SLUGS = new Set([
  'governor', 'lieutenant_governor', 'state_attorney_general',
  'secretary_of_state', 'state_treasurer', 'state_auditor',
  'state_comptroller', 'state_controller', 'state_superintendent',
  'state_labor_commissioner', 'state_agriculture_commissioner',
  'commissioner_of_public_lands', 'state_tax_commissioner',
  'public_service_commissioner',  // some states have elected PSC chairs
]);

const FRIENDLY_NAMES: Record<string, string> = {
  governor: 'Governor',
  lieutenant_governor: 'Lieutenant Governor',
  state_attorney_general: 'Attorney General',
  secretary_of_state: 'Secretary of State',
  state_treasurer: 'State Treasurer',
  state_auditor: 'State Auditor',
  state_comptroller: 'State Comptroller',
  state_controller: 'State Controller',
  state_superintendent: 'Superintendent of Public Instruction',
  state_labor_commissioner: 'Labor Commissioner',
  state_agriculture_commissioner: 'Commissioner of Agriculture',
  commissioner_of_public_lands: 'Commissioner of Public Lands',
  state_tax_commissioner: 'State Tax Commissioner',
};

export const stateExecutiveStandalone: OfficeTemplateSpec = {
  slug: 'state_executive_standalone',

  // Territories (US Virgin Islands, Guam, Puerto Rico, American Samoa, Northern
  // Mariana Islands) elect governors / lt governors / AGs that are functionally
  // state-level executives — their offices carry level='state' but
  // jurisdiction_type='territory'. Match those too, otherwise every territory
  // executive falls through to "no template" and fails instantly (VI run,
  // 2026-06-02). DC executives are municipal (mayor/council), handled elsewhere.
  matches: (input) =>
    input.level === 'state' &&
    (input.jurisdiction_type === 'state' || input.jurisdiction_type === 'territory') &&
    STATE_EXECUTIVE_SLUGS.has(input.office_type_slug),

  suggestedSources: (input) => {
    const friendly = FRIENDLY_NAMES[input.office_type_slug] ?? input.office_type_slug;
    const slug = input.jurisdiction_name.toLowerCase().replace(/ /g, '_');
    return [
      `https://en.wikipedia.org/wiki/${friendly.replace(/ /g, '_')}_of_${input.jurisdiction_name.replace(/ /g, '_')}`,
      `https://${slug}.gov`,
    ];
  },

  buildPrompt: (input) => {
    const friendly = FRIENDLY_NAMES[input.office_type_slug] ?? input.office_type_slug;
    return `You are a civic-research agent for Havesay. Extract structured editorial + structural data about the ${friendly} of ${input.jurisdiction_name} (a standalone state executive office, not a body) and the current officeholder.

# Office context
- office_id: ${input.office_id}
- canonical_name: ${input.canonical_name}
- office_type_slug: ${input.office_type_slug}
- level: state
- jurisdiction: ${input.jurisdiction_name}

# Per-state variance to verify
- Term length: usually 4, sometimes 2 (NH, VT for some offices)
- Selection: elected_partisan in most states; some are elected_nonpartisan; a few are appointed (e.g., several states appoint their treasurer or auditor)
- Term limits: vary widely (some 2 consecutive 4-year terms, some unlimited, some lifetime caps)
- Joint ticket: governor + lt gov on joint ticket in some states (VA, MD, OH, NM, PA, etc.); separate in others (FL, GA, MS, NC, TX in primary then joint general)
- Some offices don't exist in every state (e.g., comptroller, public service commissioner, agriculture commissioner)

# Source allowlist
- en.wikipedia.org (CC BY-SA)
- Any .gov / .us hostname (the state's own .gov, sos.<state>.gov, etc.)
- openstates.org

FORBIDDEN: ballotpedia.org, ncsl.org, social media, news outlets.

# Fetch sequence
1. WebFetch Wikipedia for "${friendly} of ${input.jurisdiction_name}" — description, powers, term length, salary, term limits, current officeholder
2. WebSearch for "${friendly} of ${input.jurisdiction_name} site:.gov" — official state .gov page
3. WebFetch the official page — confirm current officeholder + party + term dates

# Output schema (url / relevant_snippet field names)
{
  "office": {
    "canonical_name": "${friendly} of ${input.jurisdiction_name}",
    "short_name": "<short>",
    "description": "<2-4 sentence summary>",
    "powers_summary": "<1 paragraph covering the office's actual authority>",
    "term_length_years": <4 typically>,
    "term_start_month": <1 typically>,
    "max_consecutive_terms": <int or null>,
    "selection_method": "elected_partisan"|"elected_nonpartisan"|"appointed",
    "primary_required": <bool>,
    "on_cycle_pattern": "<presidential cycle | midterm cycle | etc.>",
    "next_regular_election_date": "<ISO date>",
    "workload": "full_time",
    "salary_annual_usd": <int or null>,
    "salary_year": 2026,
    "vacancy_appointment_authority": "<state-specific>",
    "vacancy_triggers_special": ["death","resignation","removal","incapacitation"],
    "special_election_timing_rule": "<state-specific>",
    "voter_qualifications_summary": "US citizen, 18+, registered ${input.jurisdiction_name} voter",
    "presides_over_body_canonical_name": <e.g., "${input.jurisdiction_name} State Senate" for lt_governor; null otherwise>
  },
  "current_officeholder": {
    "person_name": "...",
    "party": "...",
    "term_start": "<ISO date>",
    "term_end": "<ISO date>"
  },
  "citations": [
    { "url": "https://en.wikipedia.org/wiki/...", "title": "...", "kind": "wikipedia", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" },
    { "url": "https://<state>.gov/...", "title": "...", "kind": "gov_state", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" }
  ],
  "disposition": "elected_verified" | "appointed" | "nonexistent" | "unconfirmed",
  "authoritative": <true ONLY when disposition === "elected_verified" (≥1 .gov source + Wikipedia agree)>,
  "notes": "<term-limit details; joint ticket vs separate; whether office is elected vs appointed>"
}

# Write the result to: \${RESULT_PATH}

# Rules
- VERIFY per state. Don't assume the office exists in every state.
- Lt Governor specifically:
  - 4 states have NO Lt Gov (AZ, ME, NH, NJ, OR, TN, WV, WY — wait that's more — verify per state).
  - Some states elect on joint ticket with Governor (modern practice); some elect separately.
  - Lt Gov often presides over State Senate — set presides_over_body_canonical_name accordingly.
- Use field names "url" and "relevant_snippet".
- If office doesn't exist in this state, set authoritative=false and explain.
`;
  },
};
