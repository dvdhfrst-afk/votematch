/**
 * Wikipedia connector — fetches the candidate's Wikipedia page summary if
 * one exists, with conservative disambiguation.
 *
 * Most U.S. elected officials and notable challengers have Wikipedia pages
 * with biographical info, position summaries, and electoral history.
 * Wikipedia's MediaWiki API is free, has no auth, and returns clean
 * structured text — perfect for tier-2 sourcing.
 *
 * Disambiguation strategy:
 *   1. Search by exact name + state context (`"<name>" politician <state>`)
 *      via the OpenSearch endpoint (returns up to 3 candidate page titles).
 *   2. For each result, fetch the page summary via the REST API.
 *   3. Verify the summary text mentions politician/senator/representative/
 *      governor/etc. AND the candidate's state (or party). If neither,
 *      drop — likely wrong person.
 *   4. Stop at the first verified hit. Skip disambiguation pages outright.
 *
 * Source emitted:
 *   - source_type: 'news' (encyclopedia coverage; closest existing enum value)
 *   - source_subtype: 'wikipedia' (granular for filtering / analytics)
 *   - authenticity_tier: 2 (verifiable but not the candidate's own words)
 *   - raw_data: page extract (intro paragraphs, ~500-1500 chars)
 *
 * Politeness:
 *   - User-Agent identifies HavesayBot per Wikipedia API guidelines
 *   - 8s timeout per request; gracefully returns [] on any failure
 *   - One opensearch + one summary fetch per candidate (no follow-on pages)
 */
import type { SourceConnector, SourceRow } from '../connector-types';

const UA = 'Havesay/1.0 (nonpartisan voter-information project, in development)';
const OPENSEARCH = 'https://en.wikipedia.org/w/api.php';
const SUMMARY_API = 'https://en.wikipedia.org/api/rest_v1/page/summary';

// Council #26 (2026-05-08): added 5 territories so territory candidates
// (AS, GU, MP, PR, VI) can pass Wikipedia's strict state-match guard.
// Without these, the guard rejected every territory candidate as
// disambiguation-fail (page extract didn't contain a state name we knew).
const FIPS_TO_STATE_NAME: Record<string, string> = {
  '01': 'Alabama','02': 'Alaska','04': 'Arizona','05': 'Arkansas','06': 'California',
  '08': 'Colorado','09': 'Connecticut','10': 'Delaware','11': 'District of Columbia',
  '12': 'Florida','13': 'Georgia','15': 'Hawaii','16': 'Idaho','17': 'Illinois',
  '18': 'Indiana','19': 'Iowa','20': 'Kansas','21': 'Kentucky','22': 'Louisiana',
  '23': 'Maine','24': 'Maryland','25': 'Massachusetts','26': 'Michigan','27': 'Minnesota',
  '28': 'Mississippi','29': 'Missouri','30': 'Montana','31': 'Nebraska','32': 'Nevada',
  '33': 'New Hampshire','34': 'New Jersey','35': 'New Mexico','36': 'New York',
  '37': 'North Carolina','38': 'North Dakota','39': 'Ohio','40': 'Oklahoma','41': 'Oregon',
  '42': 'Pennsylvania','44': 'Rhode Island','45': 'South Carolina','46': 'South Dakota',
  '47': 'Tennessee','48': 'Texas','49': 'Utah','50': 'Vermont','51': 'Virginia',
  '53': 'Washington','54': 'West Virginia','55': 'Wisconsin','56': 'Wyoming',
  '60': 'American Samoa','66': 'Guam','69': 'Northern Mariana Islands',
  '72': 'Puerto Rico','78': 'U.S. Virgin Islands',
};

/** Words that indicate a Wikipedia page is about a politician (case-insensitive). */
const POLITICIAN_KEYWORDS = [
  'politician', 'senator', 'representative', 'governor', 'mayor',
  'congressman', 'congresswoman', 'state legislator', 'attorney general',
  'lieutenant governor', 'secretary of state', 'state senator',
  'state representative', 'assemblyman', 'assemblywoman', 'councilmember',
  'commissioner', 'judge', 'justice', 'sheriff', 'auditor', 'treasurer',
];

interface OpenSearchResponse {
  // [searchTerm, [titles], [descriptions], [urls]]
  0: string;
  1: string[];
  2: string[];
  3: string[];
}

interface SummaryResponse {
  type?: string; // 'standard' | 'disambiguation' | etc.
  title?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
  description?: string;
}

async function searchTitles(query: string): Promise<string[]> {
  const url = `${OPENSEARCH}?action=opensearch&search=${encodeURIComponent(query)}&limit=3&format=json&namespace=0`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as OpenSearchResponse;
    return Array.isArray(data?.[1]) ? data[1] : [];
  } catch {
    return [];
  }
}

async function fetchSummary(title: string): Promise<SummaryResponse | null> {
  const url = `${SUMMARY_API}/${encodeURIComponent(title)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()) as SummaryResponse;
  } catch {
    return null;
  }
}

function isPoliticianPage(summary: SummaryResponse, ctx: { stateName?: string; party?: string | null }): boolean {
  if (summary.type === 'disambiguation') return false;
  const text = `${summary.extract ?? ''} ${summary.description ?? ''}`.toLowerCase();
  if (!text) return false;
  // Must mention at least one politician keyword
  const isPolitical = POLITICIAN_KEYWORDS.some((k) => text.includes(k));
  if (!isPolitical) return false;
  // STRICT state-match guard: same-last-name precedent. If we know
  // the candidate's state, the Wikipedia page must mention it. Without this
  // gate, a search for a Nevada politician returned the page of a Maryland
  // politician with the same name (smoke test verified). Better to under-source than to
  // attribute a different person's positions.
  if (ctx.stateName && !text.includes(ctx.stateName.toLowerCase())) {
    return false;
  }
  // Era guard: skip historical figures (born in 18XX or earlier). Heuristic
  // catches "John Smith (New York politician, born 1752)" returning for
  // a 2026 challenger — the extract starts with their name + birth year.
  // Match "born in 18", "(1752–1808)", "(born 1810)", etc.
  const era = /\bborn[^0-9]{0,8}1[0-8]\d{2}\b|\(\s*1[0-8]\d{2}\s*[–\-]/i;
  if (era.test(text)) return false;
  return true;
}

export const wikipediaConnector: SourceConnector = {
  name: 'wikipedia',

  applicable(candidate) {
    if (!candidate.name || candidate.name.length < 3) {
      return { applicable: false, reason: 'wikipedia: candidate name missing or too short' };
    }
    return { applicable: true };
  },

  async fetch(candidate, _s) {
    const stateName = candidate.stateFips ? FIPS_TO_STATE_NAME[candidate.stateFips] : undefined;

    // Build search queries in priority order: name + state + politician → name + politician → bare name
    const queries = [
      stateName ? `"${candidate.name}" ${stateName} politician` : null,
      `"${candidate.name}" politician`,
      candidate.name,
    ].filter((q): q is string => q !== null);

    for (const q of queries) {
      const titles = await searchTitles(q);
      for (const title of titles) {
        const summary = await fetchSummary(title);
        if (!summary) continue;
        if (!isPoliticianPage(summary, { stateName, party: candidate.party })) continue;

        const url = summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
        const extract = (summary.extract ?? '').trim();
        if (extract.length < 100) continue; // stub pages aren't useful

        const row: SourceRow = {
          source_type: 'news',
          source_subtype: 'wikipedia',
          authenticity_tier: 2,
          url,
          title: summary.title ?? title,
          raw_data: extract,
          published_at: null, // Wikipedia pages are continuously edited; no single date
        };
        return [row];
      }
    }

    return [];
  },
};
