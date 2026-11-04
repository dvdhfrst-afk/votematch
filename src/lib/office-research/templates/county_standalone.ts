/**
 * Template: county_standalone — county-level standalone offices.
 * Sheriff, DA / county attorney, clerk, treasurer, recorder,
 * assessor, auditor, surveyor, coroner / medical examiner,
 * public administrator.
 */
import type { OfficeTemplateSpec } from '../types';

const COUNTY_STANDALONE_SLUGS = new Set([
  'county_sheriff', 'county_treasurer', 'county_clerk', 'district_attorney',
  'county_coroner', 'county_recorder', 'county_assessor', 'county_auditor',
  'county_surveyor', 'public_administrator', 'county_mayor',
]);

const FRIENDLY_NAMES: Record<string, string> = {
  county_sheriff: 'Sheriff',
  county_treasurer: 'County Treasurer',
  county_clerk: 'County Clerk',
  district_attorney: 'District Attorney',
  county_coroner: 'County Coroner',
  county_recorder: 'County Recorder',
  county_assessor: 'County Assessor',
  county_auditor: 'County Auditor',
  county_surveyor: 'County Surveyor',
  public_administrator: 'Public Administrator',
  county_mayor: 'County Mayor',
};

export const countyStandalone: OfficeTemplateSpec = {
  slug: 'county_standalone',

  matches: (input) =>
    input.level === 'county' &&
    input.jurisdiction_type === 'county' &&
    COUNTY_STANDALONE_SLUGS.has(input.office_type_slug),

  suggestedSources: (input) => {
    const slug = input.jurisdiction_name.toLowerCase().replace(/ county/i, '').replace(/[^a-z0-9 ]/g, '').replace(/ /g, '');
    return [
      `https://en.wikipedia.org/wiki/${input.jurisdiction_name.replace(/ /g, '_')}`,
      `https://${slug}county.gov`,
      `https://${slug}county.org`,
    ];
  },

  buildPrompt: (input) => {
    const friendly = FRIENDLY_NAMES[input.office_type_slug] ?? input.office_type_slug;
    return `You are a civic-research agent for Havesay. Extract structured editorial + structural data about the ${friendly} of ${input.jurisdiction_name} (a county-level standalone office, not a body) and the current officeholder.

# Office context
- office_id: ${input.office_id}
- canonical_name: ${input.canonical_name}
- office_type_slug: ${input.office_type_slug}
- level: county
- jurisdiction: ${input.jurisdiction_name}
- fips_state: ${input.fips_state ?? '(unknown)'}

# Per-county + per-state variance
- Term length: usually 4, sometimes 2 (TX clerk = 4yr, CA sheriff = 4yr, etc.)
- Selection: usually elected_partisan (county), some elected_nonpartisan, some appointed
- Naming variance: "Sheriff" everywhere; "District Attorney" in most states but "County Attorney" in TX, IA, NE, MO, WI for some functions; "County Recorder" in some states is "Register of Deeds" or "Recorder of Deeds"; "Coroner" in some states is "Medical Examiner" (appointed in most modern systems)
- A few counties (e.g., AK, CT — no counties, RI — limited counties) have no county-level standalone offices in this sense

# Source allowlist
- en.wikipedia.org
- Any .gov / .us hostname (county .gov, state .gov)
- openstates.org

FORBIDDEN: ballotpedia.org, ncsl.org, social media, news outlets.

# Fetch sequence
1. WebSearch for the county's official .gov site — usually <name>county.gov / .org
2. WebFetch the county "elected officials" / "government" / "<office_type>" page
3. WebFetch Wikipedia for the county if needed for historical context
4. As a fallback, cite state statute (e.g., Utah Code 17-22 for Sheriff, Cal. Gov. Code §24000 for county offices)

# Output schema (url / relevant_snippet field names)
{
  "office": {
    "canonical_name": "${friendly} — ${input.jurisdiction_name}",
    "short_name": "<short>",
    "description": "<2-4 sentence summary of what this office does>",
    "powers_summary": "<the actual statutory authority>",
    "term_length_years": <int>,
    "term_start_month": <1 typically>,
    "max_consecutive_terms": <int or null>,
    "selection_method": "elected_partisan"|"elected_nonpartisan"|"appointed",
    "primary_required": <bool>,
    "on_cycle_pattern": "<midterm cycle | every 4 years | etc.>",
    "next_regular_election_date": "<ISO date>",
    "workload": "full_time"|"part_time",
    "salary_annual_usd": <int or null>,
    "salary_year": 2026,
    "vacancy_appointment_authority": "<typically the county commission/council or governor>",
    "vacancy_triggers_special": ["death","resignation","removal_for_cause"],
    "special_election_timing_rule": "...",
    "voter_qualifications_summary": "US citizen, 18+, registered ${input.jurisdiction_name} voter"
  },
  "current_officeholder": {
    "person_name": "...",
    "party": "...",
    "term_start": "<ISO date>",
    "term_end": "<ISO date>"
  },
  "citations": [
    { "url": "https://...gov", "title": "...", "kind": "gov_other", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" },
    { "url": "https://en.wikipedia.org/wiki/...", "title": "...", "kind": "wikipedia", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" }
  ],
  "disposition": "elected_verified" | "appointed" | "nonexistent" | "unconfirmed",
  "authoritative": <true ONLY when disposition === "elected_verified" (≥1 .gov source confirms current officeholder)>,
  "notes": "<naming differences; coroner vs ME; sheriff vs marshal in some western counties>"
}

# Write the result to: \${RESULT_PATH}

# Rules
- VERIFY this office exists in this specific county under state law. Some counties have no elected DA (handled by state AG); some have no elected coroner; etc.
- If office doesn't exist in this county, set authoritative=false and explain.
- For District Attorney: note if it's a multi-county DA district (the office covers multiple counties).
- Use "url" and "relevant_snippet".
`;
  },
};
