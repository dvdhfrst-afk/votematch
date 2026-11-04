/**
 * Google News RSS connector: pulls recent articles mentioning the candidate.
 *
 * Strategy:
 *   1. Query Google News RSS with the candidate's name scoped to their state
 *      AND (council item 3) a secondary district-scoped query. Merge results
 *      (dedup by URL); district-scoped hits surface narrower articles.
 *   2. Parse up to 10 recent items across both queries.
 *   3. Use title + RSS description as the source text (Google News redirect
 *      URLs don't resolve with plain fetch; title + description gives us
 *      enough signal).
 *   4. **Relevance score per item (council item 1):** count mentions of
 *      target candidate vs. other candidates in the same race.
 *      - If target_ratio < 0.10 → drop the row (article is mostly about
 *        someone else; not the target's signal).
 *      - If target_ratio < 0.30 → keep but downgrade tier to 3.
 *      - Otherwise keep at computed tier.
 *   5. Emit tier=2 (reported with direct quote) when the description
 *      contains a quote marker AND relevance is good; otherwise tier=3.
 *
 * Outlet ideology is not inferred here (requires a domain → ideology table
 * we don't maintain). Left null for admin-side classification later.
 *
 * Cross-candidate dedup (shared_race_coverage flag, council item 2) happens
 * downstream in the orchestrator — this connector only does per-article
 * relevance scoring.
 *
 * See also: scripts/news-ingestion-poc.ts — the original proof of concept.
 */
import type { SourceConnector, SourceRow } from '../connector-types';

const UA = 'Havesay/1.0 (nonpartisan voter-information project, in development)';

/**
 * 2-char FIPS state code → state name. Used to scope the Google News query
 * to the candidate's actual state (formerly hard-coded to 'Utah' from the
 * Utah-MVP era; corrected 2026-05-08 council #26 after observing 0 hits
 * across 60 non-Utah candidates in two consecutive sourcing ticks).
 *
 * Includes 50 states + DC + 5 territories (AS, GU, MP, PR, VI).
 */
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

interface RssItem {
  title: string;
  link: string;
  pub_date: string;
  source: string;
  description: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchRss(query: string, maxItems = 10): Promise<RssItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const xml = await res.text();
  const items: RssItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null && items.length < maxItems) {
    const block = match[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? '';
    const link = /<link>([\s\S]*?)<\/link>/.exec(block)?.[1] ?? '';
    const pubDate = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1] ?? '';
    const source = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block)?.[1] ?? '';
    const description = /<description>([\s\S]*?)<\/description>/.exec(block)?.[1] ?? '';
    const descText = decodeEntities(
      description
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    items.push({
      title: decodeEntities(title.replace(/<!\[CDATA\[|\]\]>/g, '').trim()),
      link: link.trim(),
      pub_date: pubDate.trim(),
      source: decodeEntities(source.replace(/<!\[CDATA\[|\]\]>/g, '').trim()),
      description: descText,
    });
  }
  return items;
}

/**
 * Compute relevance ratio: fraction of candidate-name mentions in `text`
 * that refer to the target candidate vs. other candidates in the same race.
 * Returns 1.0 if no other candidates are named (only target appears).
 * Returns 0.0 if target isn't mentioned at all.
 *
 * Case-insensitive substring match. Uses last-name or full-name heuristic.
 */
function computeRelevance(
  text: string,
  targetName: string,
  otherNames: string[],
): number {
  const lower = text.toLowerCase();
  const targetLast = targetName.trim().split(/\s+/).pop()!.toLowerCase();
  const targetFull = targetName.trim().toLowerCase();

  // Count target hits: either full name or distinctive last name
  const targetCount =
    countOccurrences(lower, targetFull) ||
    countOccurrences(lower, targetLast);
  if (targetCount === 0) return 0.0;

  let otherCount = 0;
  for (const other of otherNames) {
    if (!other) continue;
    const otherLast = other.trim().split(/\s+/).pop()!.toLowerCase();
    const otherFull = other.trim().toLowerCase();
    if (otherFull === targetFull) continue; // same person (duplicate entry)
    // To avoid false positives on common last names, require full-name match OR
    // a last name that's distinct from target's last name.
    const contrib =
      countOccurrences(lower, otherFull) ||
      (otherLast !== targetLast ? countOccurrences(lower, otherLast) : 0);
    otherCount += contrib;
  }
  if (targetCount + otherCount === 0) return 0.0;
  return targetCount / (targetCount + otherCount);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle || needle.length < 2) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count += 1;
    pos += needle.length;
  }
  return count;
}

/**
 * Extract a district/office phrase from a race_name like "State House
 * District 58 — Utah (2026 primary)" → "House District 58". Used for the
 * secondary district-scoped query (council item 3).
 *
 * Returns null if no district phrase is found.
 */
function extractDistrictPhrase(raceName: string | undefined): string | null {
  if (!raceName) return null;
  // Match "District N" or "House District N" or "Senate District N"
  const m = raceName.match(/((?:House|Senate|Congressional|School Board|Commission)\s+District\s+\d+\w?)/i);
  return m?.[1] ?? null;
}

export const googleNewsConnector: SourceConnector = {
  name: 'google_news',

  applicable() {
    // Always tries; returns [] if nothing found. Query is state-scoped via
    // the candidate's stateFips (see fetch()) so cross-state noise is low.
    return { applicable: true };
  },

  async fetch(candidate) {
    // State-scoped query; trims off titles/honorifics in candidate.name
    const baseName = candidate.name
      .replace(/^(Sen\.|Rep\.|Dr\.|Mr\.|Ms\.|Mrs\.)\s+/i, '')
      .replace(/\s+(Jr\.|Sr\.|II|III|IV)$/i, '');

    // Primary query: name + state. Broad net for any mention.
    // Council #26 (2026-05-08): query was hardcoded 'Utah' from the Utah-MVP
    // era, returning 0 hits for the entire 13k non-Utah unsourced pool. Now
    // resolved from candidate.stateFips. Falls back to bare name if FIPS is
    // unknown (still better than the wrong-state qualifier).
    const stateName = FIPS_TO_STATE_NAME[candidate.stateFips ?? ''] ?? '';
    const broadQuery = stateName ? `"${baseName}" "${stateName}"` : `"${baseName}"`;

    // Secondary query (council item 3): name + district scope. Narrower.
    // Merged with broad by URL dedup; shouldn't reduce recall but improves
    // signal for per-race context.
    const district = extractDistrictPhrase(candidate.race_name);
    const districtQuery = district ? `"${baseName}" "${district}"` : null;

    const queries = [broadQuery, districtQuery].filter((q): q is string => q !== null);

    let allItems: RssItem[] = [];
    try {
      for (const q of queries) {
        const items = await fetchRss(q, 10);
        allItems = allItems.concat(items);
      }
    } catch {
      return [];
    }

    // URL-dedup (prefer first-seen which is the broad-query result)
    const seen = new Set<string>();
    const items: RssItem[] = [];
    for (const it of allItems) {
      const key = it.link || `${it.source}:${it.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }

    const rows: SourceRow[] = [];
    for (const item of items) {
      if (!item.title && !item.description) continue;
      const text = [
        `Source: ${item.source}`,
        `Published: ${item.pub_date}`,
        `Title: ${item.title}`,
        '',
        item.description,
      ].join('\n');

      // Council item 1: relevance scoring against other candidates in race.
      const relevance = computeRelevance(
        text,
        baseName,
        candidate.other_race_candidates ?? [],
      );

      // Drop articles that are mostly about other candidates.
      if (relevance < 0.10) continue;

      // Heuristic: quote marker → tier 2; else tier 3.
      const hasQuote =
        /["\u201C][\s\S]+?["\u201D]/.test(item.description) ||
        /[""][\s\S]+?[""]/.test(item.description);
      let tier: 1 | 2 | 3 = hasQuote ? 2 : 3;

      // Low-relevance hits stay but get pinned to tier 3.
      if (relevance < 0.30) tier = 3;

      rows.push({
        source_type: 'news',
        authenticity_tier: tier,
        outlet_ideology: null, // left for admin classification
        url: item.link,
        title: `${item.source}: ${item.title.slice(0, 120)}`,
        raw_data: text,
        published_at: item.pub_date ? new Date(item.pub_date).toISOString() : null,
        relevance_score: relevance,
      });
    }
    return rows;
  },
};
