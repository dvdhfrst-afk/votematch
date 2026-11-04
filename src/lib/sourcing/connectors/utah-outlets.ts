/**
 * Direct-RSS connector for Utah news outlets. Produces tier-2 or tier-3 source
 * rows for news articles that mention a candidate by name.
 *
 * Counter to google_news connector (which uses Google's redirect URLs and
 * sees the whole Google News index), this connector subscribes to each
 * outlet's own RSS feed. Benefits:
 *   - Full article URLs that actually resolve (no redirect chain)
 *   - Full RSS descriptions / summaries (not snippets)
 *   - Outlet ideology attributable (we know which outlet published)
 *   - Predictable cron-friendly ingestion
 *
 * The feeds:
 *   - Deseret News (politics) — center-right
 *   - Salt Lake Tribune (politics) — center-left
 *   - KSL (Politics section) — center-right
 *   - KUER (Utah) — center-left
 *   - Utah Policy — center-right
 *   - Utah News Dispatch — nonprofit, lean-left
 *
 * Feed URLs are best-effort as of 2026-04-18 — if a feed moves, update here.
 * The connector tolerates individual feed failures (returns rows from the
 * feeds that did succeed).
 *
 * This connector is candidate-by-candidate at fetch-time. For daily-cron
 * ingestion that processes the full feed and attributes mentions across all
 * candidates, see scripts/cron-utah-news-ingestion.ts.
 */
import type { SourceConnector, SourceRow } from '../connector-types';
import type { OutletIdeology } from '@/types/database';

const UA = 'Havesay/1.0 (nonpartisan voter-information project, in development)';

interface Outlet {
  name: string;
  feed_url: string;
  ideology: OutletIdeology;
}

export const UTAH_OUTLETS: Outlet[] = [
  {
    name: 'Deseret News',
    feed_url: 'https://www.deseret.com/arc/outboundfeeds/rss/category/utah/',
    ideology: 'center-right',
  },
  {
    name: 'Salt Lake Tribune',
    feed_url: 'https://www.sltrib.com/news/politics/rss/',
    ideology: 'center-left',
  },
  {
    name: 'KSL',
    feed_url: 'https://www.ksl.com/rss/news/politics',
    ideology: 'center-right',
  },
  {
    name: 'KUER',
    feed_url: 'https://www.kuer.org/rss.xml',
    ideology: 'center-left',
  },
  {
    name: 'Utah News Dispatch',
    feed_url: 'https://utahnewsdispatch.com/feed/',
    ideology: 'center-left',
  },
  {
    name: 'Utah Policy',
    feed_url: 'https://utahpolicy.com/feed/',
    ideology: 'center-right',
  },
];

interface RssItem {
  title: string;
  link: string;
  pub_date: string;
  description: string;
  guid?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchFeed(url: string, maxItems = 40): Promise<RssItem[]> {
  let xml: string;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    xml = await res.text();
  } catch {
    return [];
  }
  const items: RssItem[] = [];
  // Handles both RSS <item> and Atom <entry>
  const itemRe = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && items.length < maxItems) {
    const block = m[1];
    const title =
      /<title[^>]*>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? '';
    let link = /<link[^>]*>([\s\S]*?)<\/link>/.exec(block)?.[1] ?? '';
    if (!link) {
      // Atom: <link href="..." />
      const atomLink = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
      if (atomLink) link = atomLink[1];
    }
    const pubDate =
      /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1] ??
      /<updated>([\s\S]*?)<\/updated>/.exec(block)?.[1] ??
      /<published>([\s\S]*?)<\/published>/.exec(block)?.[1] ??
      '';
    const description =
      /<description>([\s\S]*?)<\/description>/.exec(block)?.[1] ??
      /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(block)?.[1] ??
      /<content[^>]*>([\s\S]*?)<\/content>/.exec(block)?.[1] ??
      '';
    const guid = /<guid[^>]*>([\s\S]*?)<\/guid>/.exec(block)?.[1];
    const descText = decodeEntities(
      description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    );
    items.push({
      title: decodeEntities(title.trim()),
      link: link.trim(),
      pub_date: pubDate.trim(),
      description: descText,
      guid: guid?.trim(),
    });
  }
  return items;
}

function mentionsCandidate(item: RssItem, fullName: string): boolean {
  const haystack = `${item.title} ${item.description}`.toLowerCase();
  const needle = fullName.toLowerCase();
  if (haystack.includes(needle)) return true;
  // Also try last-name-only to catch "Rep. Lastname" style refs
  const parts = fullName.split(/\s+/).filter((p) => p.length > 2);
  const last = parts[parts.length - 1];
  if (last && haystack.includes(last.toLowerCase())) {
    // Only trust last-name if at least the candidate's first initial is in the title
    const first = parts[0];
    if (first && (haystack.includes(first.toLowerCase()) || haystack.includes(` ${first[0].toLowerCase()}.`))) {
      return true;
    }
  }
  return false;
}

export const utahOutletsConnector: SourceConnector = {
  name: 'utah_outlets_rss',

  /**
   * State-gated (council F17, 2026-04-23). Only applicable to candidates
   * whose office jurisdiction resolves to Utah (stateFips='49'). For all
   * other states, returns a skip with a human-readable reason that the
   * orchestrator logs to `ingestion_runs` — silent-gap prevention.
   *
   * Prior to F17, this returned `true` unconditionally, meaning e.g. an NJ
   * candidate would get Utah-RSS feed scans that either returned empty or
   * risked matching unrelated names. With the registry in the orchestrator,
   * this connector is only considered when the state matches; the guard
   * below is defence-in-depth in case someone calls it directly.
   */
  applicable(candidate) {
    if (candidate.stateFips !== '49') {
      return {
        applicable: false,
        reason: `utah_outlets_rss requires stateFips=49; got ${candidate.stateFips ?? '(unknown)'}`,
      };
    }
    return { applicable: true };
  },

  async fetch(candidate) {
    const rows: SourceRow[] = [];
    const baseName = candidate.name
      .replace(/^(Sen\.|Rep\.|Dr\.|Mr\.|Ms\.|Mrs\.)\s+/i, '')
      .replace(/\s+(Jr\.|Sr\.|II|III|IV)$/i, '');

    for (const outlet of UTAH_OUTLETS) {
      const items = await fetchFeed(outlet.feed_url);
      for (const item of items) {
        if (!mentionsCandidate(item, baseName)) continue;
        const hasQuote =
          /["\u201C][\s\S]+?["\u201D]/.test(item.description) ||
          /[""][\s\S]+?[""]/.test(item.description);
        const tier: 1 | 2 | 3 = hasQuote ? 2 : 3;
        const text = [
          `Source: ${outlet.name}`,
          `Published: ${item.pub_date || 'unknown'}`,
          `Title: ${item.title}`,
          '',
          item.description,
        ].join('\n');
        rows.push({
          source_type: 'news',
          authenticity_tier: tier,
          outlet_ideology: outlet.ideology,
          url: item.link || null,
          title: `${outlet.name}: ${item.title.slice(0, 120)}`,
          raw_data: text,
          published_at: item.pub_date ? (() => {
            const d = new Date(item.pub_date);
            return isNaN(d.getTime()) ? null : d.toISOString();
          })() : null,
        });
      }
    }
    return rows;
  },
};
