/**
 * Template: school_board — local school district boards of education.
 *
 * Sizes: 3-9 members typically; some larger urban districts have more.
 * Selection: usually nonpartisan; some states partisan (TX since 2021, etc.).
 * Terms: 4 years usually, sometimes 3 or 6.
 * Per-district variance is high; verify against district .gov.
 */
import type { TemplateSpec } from '../types';

export const schoolBoard: TemplateSpec = {
  slug: 'school_board',

  matches: (input) =>
    input.chamber_type === 'school_board',
  // Note: original predicate also required jurisdiction_type='school_district'
  // but all our electing school_boards are tied to county/municipality
  // jurisdictions (per Census Bureau modeling), not separate school_district
  // jurisdictions. Fix 2026-05-28: match any jurisdiction type.

  suggestedSources: (input) => {
    const slug = input.jurisdiction_name.toLowerCase()
      .replace(/ school district.*$/i, '')
      .replace(/ /g, '_');
    return [
      `https://en.wikipedia.org/wiki/${input.jurisdiction_name.replace(/ /g, '_')}`,
      `https://www.${slug}schools.org`,
      `https://www.${slug}.org`,
    ];
  },

  buildPrompt: (input) => `You are a civic-research agent for Havesay. Your task: extract structured data about the ${input.jurisdiction_name} Board of Education and its current trustees from primary sources.

# Body context
- body_id: ${input.body_id}
- canonical_name: ${input.canonical_name}
- chamber_type: school_board
- jurisdiction: ${input.jurisdiction_name}
- fips_state: ${input.fips_state ?? '(unknown)'}
- attached offices in our catalog: ${input.attached_offices.length}

# Critical: per-district + per-state variance
- Selection: most states elect (nonpartisan typically); a few have appointed boards (mostly mayoral-controlled urban districts like NYC, Chicago, Boston for periods)
- Term length: 4 years standard; some 3, some 6
- Size: 3 (rural) to 9 (urban); 5 is the most common
- Partisan elections: Texas adopted partisan school board races in 2021; most states remain nonpartisan
- Staggering: usually half or third up each cycle

# Source allowlist
- en.wikipedia.org
- Any .gov / .us hostname (e.g., the district's *.k12.<state>.us or *.schools.org)
- openstates.org

FORBIDDEN: ballotpedia.org, ncsl.org, social media.

# Fetch sequence
1. WebSearch for the district's official site (often *schools.org or *.k12.<state>.us)
2. smart_fetch the district's "Board of Education" or "Trustees" page — get current members + terms
3. smart_fetch the Wikipedia page for the district if it exists (often only larger districts have one)

# Output schema (use url / relevant_snippet)
{
  "body": {
    "canonical_name": "${input.jurisdiction_name} Board of Education",
    "short_name": "<short>",
    "size_total": <int>,
    "seat_structure": [{ "count": <N>, "designation_kind": "at_large"|"district", "term_length_years": <2|3|4|6>, "stagger_offset_years": <varies> }],
    "selection_method": "elected_nonpartisan"|"elected_partisan"|"appointed",
    "primary_required": <bool>,
    "on_cycle_pattern": "<varies — many school boards have separate election cycles from general>",
    "description": "<2-4 sentences>",
    "powers_summary": "Sets district policy, approves the district budget, hires and oversees the superintendent, approves curriculum, makes hiring/firing decisions for top administrators.",
    "vacancy_appointment_authority": "<usually remaining board members appoint replacement>",
    "vacancy_triggers_special": ["death","resignation","removal"],
    "special_election_timing_rule": "<varies>",
    "voter_qualifications_summary": "US citizen, 18+, registered resident of the school district",
    "salary_usd": <int or null — often $0 stipend or per-meeting>,
    "form_of_government": "elected_board"|"appointed_board"|"mayoral_control"
  },
  "seats": [{ "seat_designation": "Trustee Seat 1" or "Area 1", "current_officeholder": { "person_name": "...", "term_end": "..." } }],
  "citations": [{ "url": "...", "title": "...", "kind": "wikipedia"|"gov_state", "accessed_at": "2026-05-25", "relevant_snippet": "<≤280 chars>" }],
  "authoritative": <true if district.gov confirms structure>,
  "notes": "..."
}

# Write the result to: \${RESULT_PATH}

# Rules
- Most school districts are small and may not have rich Wikipedia coverage. The district's own .gov / *.schools.org page is usually the canonical source.
- If a district has an APPOINTED board (mayoral control), set selection_method='appointed' and explain in notes.
- DO NOT extract per-trustee detail if size > 12 — body-level only.
`,
};
