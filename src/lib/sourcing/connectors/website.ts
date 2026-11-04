/**
 * Website connector: scrapes a candidate's campaign website for their own
 * words on issues.
 *
 * Strategy:
 *   1. If candidate.website_url is set, fetch it (with archive.org fallback
 *      when live site is dead — council item 7, 2026-04-19).
 *   2. Look for policy-relevant pages linked from the homepage:
 *      /issues, /platform, /priorities, /about, /on-the-issues, /my-record
 *   3. For each discovered URL, fetch + strip to text.
 *   4. Emit one tier=1 row per page with source_type=campaign_website.
 *   5. If any fetch used an archive snapshot, tag the row's title and
 *      published_at with the snapshot date for transparency.
 *
 * Archive fallback (council item 7):
 *   - If direct fetch fails (404/503/timeout), query Wayback CDX API for the
 *     most recent 200-status snapshot of the URL.
 *   - If a snapshot exists, fetch from web.archive.org and tag the row with
 *     the snapshot date. Transparency requirement: UI should surface
 *     "archived from YYYY-MM-DD" so users know the content is historical.
 *
 * Politeness:
 *   - Uses HavesayBot user-agent.
 *   - Honors robots.txt (if Disallow applies, skip).
 *   - Stops on 403/429 for the rest of that candidate's host.
 *   - 20s per-URL timeout.
 *   - No deep crawl — max 6 pages per candidate.
 */
import type { SourceConnector, SourceRow, CandidateContext } from '../connector-types';

const UA = 'Havesay/1.0 (nonpartisan voter-information project, in development)';

const CANDIDATE_PATH_PATTERNS = [
  '/issues',
  '/platform',
  '/priorities',
  '/positions',
  '/policy',
  '/on-the-issues',
  '/my-record',
  '/about',
];

async function fetchText(url: string, timeoutMs = 20000): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: ctl.signal,
      redirect: 'follow',
    });
    clearTimeout(tid);
    if (res.status === 403 || res.status === 429) {
      const e = new Error(`${res.status} forbidden/rate-limited`);
      (e as Error & { stopHost?: boolean }).stopHost = true;
      throw e;
    }
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('text/plain')) return null;
    const html = await res.text();
    return html;
  } catch (err) {
    if ((err as Error & { stopHost?: boolean }).stopHost) throw err;
    return null;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractInternalLinks(html: string, baseUrl: string): string[] {
  const results = new Set<string>();
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  const base = new URL(baseUrl);
  while ((match = hrefRe.exec(html)) !== null) {
    const href = match[1];
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    try {
      const abs = new URL(href, baseUrl);
      if (abs.hostname !== base.hostname) continue;
      const path = abs.pathname.toLowerCase();
      if (CANDIDATE_PATH_PATTERNS.some((p) => path === p || path.startsWith(p + '/'))) {
        results.add(abs.toString().split('#')[0]);
      }
    } catch {
      // malformed URL, skip
    }
  }
  return [...results].slice(0, 5);
}

/**
 * Archive.org fallback (council item 7).
 *
 * Queries Wayback Machine CDX API for the most recent 200-status snapshot
 * of `url`. If found, fetches the archived content. Returns null if no
 * snapshot exists or the fetch fails.
 *
 * CDX API docs: https://archive.org/developers/wayback-cdx-server.html
 * Response: JSON array where [0] is headers, [1..] are rows with
 * [urlkey, timestamp, original, mimetype, statuscode, digest, length]
 */
async function fetchFromArchive(
  url: string,
): Promise<{ html: string; snapshotDate: string } | null> {
  try {
    const cdxUrl =
      `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}` +
      `&output=json&limit=1&filter=statuscode:200&filter=mimetype:text/html` +
      `&sort=descending`;

    const cdxRes = await fetch(cdxUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!cdxRes.ok) return null;
    const data = (await cdxRes.json()) as string[][];
    // First row is headers; data row is at index 1.
    const row = data[1];
    if (!row || row.length < 3) return null;
    const timestamp = row[1]; // YYYYMMDDhhmmss
    const originalUrl = row[2];

    // Archive.org replay URL:
    // https://web.archive.org/web/<timestamp>/<original_url>
    const replayUrl = `https://web.archive.org/web/${timestamp}/${originalUrl}`;
    const archHtml = await fetchText(replayUrl);
    if (!archHtml) return null;

    // Format snapshot date as YYYY-MM-DD for display + published_at
    const snapshotDate = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
    return { html: archHtml, snapshotDate };
  } catch {
    return null;
  }
}

async function checkRobots(origin: string): Promise<string[]> {
  // Simple robots.txt check: returns list of Disallow paths for User-Agent '*'
  // or 'HavesayBot'. Non-fatal — returns [] on fetch failure.
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const text = await res.text();
    const disallows: string[] = [];
    let currentUA = '';
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, value] = m;
      const k = key.toLowerCase();
      if (k === 'user-agent') {
        currentUA = value.toLowerCase();
      } else if (k === 'disallow' && (currentUA === '*' || currentUA.includes('ballotbridgebot'))) {
        if (value) disallows.push(value);
      }
    }
    return disallows;
  } catch {
    return [];
  }
}

export const websiteConnector: SourceConnector = {
  name: 'website',

  applicable(candidate) {
    if (!candidate.website_url) {
      return { applicable: false, reason: 'candidate.website_url is empty' };
    }
    return { applicable: true };
  },

  async fetch(candidate) {
    const rows: SourceRow[] = [];
    if (!candidate.website_url) return rows;

    let baseUrl: URL;
    try {
      baseUrl = new URL(candidate.website_url);
    } catch {
      return rows;
    }
    const origin = baseUrl.origin;

    // Robots.txt check
    const disallows = await checkRobots(origin);
    const allowed = (path: string) =>
      !disallows.some((d) => d && path.startsWith(d));

    // 1. Fetch homepage — with archive fallback if live site is dead
    let usedArchive = false;
    let archiveSnapshotDate: string | null = null;
    try {
      let homeHtml = await fetchText(candidate.website_url).catch(() => null);
      if (!homeHtml) {
        // Council item 7: fall back to Wayback Machine
        const arch = await fetchFromArchive(candidate.website_url);
        if (arch) {
          homeHtml = arch.html;
          usedArchive = true;
          archiveSnapshotDate = arch.snapshotDate;
        }
      }

      if (homeHtml) {
        const homeText = htmlToText(homeHtml);
        if (homeText.length > 300) {
          rows.push({
            source_type: 'website',
            source_subtype: 'campaign_site',
            authenticity_tier: 1,
            outlet_ideology: 'primary',
            url: candidate.website_url,
            title: usedArchive
              ? `${candidate.name} — Campaign Homepage [archived ${archiveSnapshotDate}]`
              : `${candidate.name} — Campaign Homepage`,
            raw_data: homeText.slice(0, 20000),
            published_at: usedArchive && archiveSnapshotDate ? `${archiveSnapshotDate}T00:00:00Z` : null,
          });
        }

        // 2. Find + fetch policy-relevant inner pages
        const innerLinks = extractInternalLinks(homeHtml, candidate.website_url);
        for (const link of innerLinks) {
          const linkPath = new URL(link).pathname;
          if (!allowed(linkPath)) continue;
          try {
            let pageHtml = await fetchText(link).catch(() => null);
            let pageUsedArchive = false;
            let pageArchiveDate: string | null = null;
            if (!pageHtml) {
              // Archive fallback for inner pages too
              const arch = await fetchFromArchive(link);
              if (arch) {
                pageHtml = arch.html;
                pageUsedArchive = true;
                pageArchiveDate = arch.snapshotDate;
              }
            }
            if (!pageHtml) continue;
            const pageText = htmlToText(pageHtml);
            if (pageText.length < 500) continue;
            rows.push({
              source_type: 'website',
              source_subtype: 'campaign_site',
              authenticity_tier: 1,
              outlet_ideology: 'primary',
              url: link,
              title: pageUsedArchive
                ? `${candidate.name} — ${linkPath.slice(1).replace(/\//g, ' / ')} [archived ${pageArchiveDate}]`
                : `${candidate.name} — ${linkPath.slice(1).replace(/\//g, ' / ')}`,
              raw_data: pageText.slice(0, 20000),
              published_at: pageUsedArchive && pageArchiveDate
                ? `${pageArchiveDate}T00:00:00Z`
                : null,
            });
          } catch (err) {
            if ((err as Error & { stopHost?: boolean }).stopHost) break; // host is rate-limiting us
          }
        }
      }
    } catch (err) {
      if (!(err as Error & { stopHost?: boolean }).stopHost) {
        // non-stop errors: carry on to next candidate
      }
    }

    return rows;
  },
};
