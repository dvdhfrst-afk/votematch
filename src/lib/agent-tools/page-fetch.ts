/**
 * page-fetch: a single-tier web fetch used by ingestion code and exposed to
 * the body-research agent through the Claude Agent SDK's MCP server mechanism.
 *
 * It does one plain HTTP GET through `politeFetch` (identifying User-Agent,
 * per-host spacing, SSRF guard), converts HTML to compact markdown in-house,
 * and caps the size. There is no JavaScript rendering, no third-party reader
 * and no browser. A page that needs a browser, or a host that refuses this
 * client, comes back as a failure and the caller treats the source as
 * unavailable.
 *
 * Output contract (kept stable because several parsers read it): on success
 * `content[0].text` is a banner line
 *   `<!-- smart_fetch: tier=plain status=200 elapsed=123ms bytes=4567 -->`
 * followed by the content. The tool and banner keep the `smart_fetch` name so
 * existing prompt templates and banner parsers continue to work.
 */

import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { politeFetch } from '../adapters/fetch-polite';

// Cap on returned content. Env-tunable (BB_FETCH_MAX_CHARS); floor of 10K.
const MAX_RESPONSE_CHARS = (() => {
  const n = parseInt(process.env.BB_FETCH_MAX_CHARS ?? '', 10);
  return Number.isFinite(n) && n > 10_000 ? n : 200_000;
})();

function isBinaryUrl(url: string, contentType: string): boolean {
  if (/\.(pdf|xlsx?|docx?|pptx?|zip|csv)(\?|$)/i.test(url)) return true;
  if (/application\/(pdf|vnd\.ms-|vnd\.openxml|zip)/i.test(contentType)) return true;
  if (/^text\/csv/i.test(contentType)) return true;
  return false;
}

/** Remove style/script blocks and CSS rules that bloat SPA pages. */
function stripCssNoise(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/@(?:-[a-z]+-)?(?:keyframes|font-face|media|import|charset|supports|page|namespace|document)\s*[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gi, '')
    .replace(/\.[a-z][a-zA-Z0-9_-]*(?:\s+\.[a-z][a-zA-Z0-9_-]*)*\s*\{[^}]*\}/g, '');
}

/** Remove non-content site chrome (scripts, nav, footer, comments, meta). */
function stripBoilerplate(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|template|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:link|meta)\b[^>]*>/gi, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&rsquo;|&lsquo;/gi, "'").replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&mdash;|&ndash;/gi, '-').replace(/&hellip;/gi, '...')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } });
}

function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Dependency-free HTML to markdown: headings, lists, tables, links, emphasis. */
export function htmlToMarkdown(html: string): string {
  let s = stripBoilerplate(html);
  s = s
    .replace(/<(head|select|option|button|form|label|figure|figcaption)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(img|input|hr)\b[^>]*\/?>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row: string) => {
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => inlineText(m[1])).filter(Boolean);
    return cells.length ? `\n${cells.join(' | ')}` : '\n';
  });
  s = s
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, t) => `\n${'#'.repeat(Number(lvl))} ${inlineText(t)}\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `\n- ${inlineText(t)}`)
    .replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => { const x = inlineText(t); return x ? `[${x}](${href})` : ''; })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, t) => `**${inlineText(t)}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, t) => `*${inlineText(t)}*`);
  s = s.replace(/<\/(p|div|section|article|table|ul|ol|h[1-6]|main|td|th)>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return decodeEntities(s)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(content: string, max = MAX_RESPONSE_CHARS): { content: string; truncated: boolean } {
  const deboiled = stripBoilerplate(content);
  if (deboiled.length <= max) return { content: deboiled, truncated: false };
  const stripped = stripCssNoise(deboiled);
  if (stripped.length <= max) {
    return { content: stripped + `\n\n[CHROME+CSS STRIPPED; original was ${content.length} chars]`, truncated: true };
  }
  return {
    content: stripped.slice(0, max) + `\n\n[TRUNCATED at ${max} chars; original was ${content.length} chars]`,
    truncated: true,
  };
}

export type PageFetchResult = {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  _meta?: Record<string, unknown>;
};

export const PAGE_FETCH_TOOL_DESCRIPTION = `Fetch a URL with a plain HTTP GET and return its text as compact markdown.

The request identifies itself with a bot User-Agent. Pages that need JavaScript
or that refuse automated clients return an error; treat those sources as
unavailable and move on.`;

/** Fetch one URL. Pure handler shared by direct callers and the MCP tool. */
export async function runPageFetch(args: { url: string }): Promise<PageFetchResult> {
  const { url } = args;
  const t0 = Date.now();
  let ok = false;
  let status = 0;
  let body = '';
  let contentType = '';
  let finalUrl = url;
  let errorMessage: string | undefined;
  try {
    const res = await politeFetch(url);
    ok = res.ok;
    status = res.status;
    contentType = res.headers.get('content-type') ?? '';
    finalUrl = res.url || url;
    body = await res.text();
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
  }
  const elapsed = Date.now() - t0;
  const rendered = ok && !isBinaryUrl(url, contentType) ? htmlToMarkdown(body) : body;
  const shaped = truncate(rendered);
  const meta = {
    fetch_method: 'plain',
    final_url: finalUrl,
    status,
    content_type: contentType,
    content_length: shaped.content.length,
    raw_length: body.length,
    truncated: shaped.truncated,
    total_elapsed_ms: elapsed,
  };
  if (!ok) {
    return {
      isError: true,
      _meta: meta,
      content: [{
        type: 'text',
        text: `smart_fetch FAILED for ${url}\n${JSON.stringify(meta, null, 2)}` +
          (errorMessage ? `\n\nLast error: ${errorMessage}` : ''),
      }],
    };
  }
  return {
    _meta: meta,
    content: [{
      type: 'text',
      text: `<!-- smart_fetch: tier=plain status=${status} elapsed=${elapsed}ms bytes=${body.length}${shaped.truncated ? ' truncated' : ''} -->\n` +
        shaped.content,
    }],
  };
}

// ---------------------------------------------------------------------------
// MCP server export (in-process, for Claude Agent SDK callers)
// ---------------------------------------------------------------------------

/** Server and tool name kept as `smart_fetch` for prompt compatibility. */
export const PAGE_FETCH_SERVER_NAME = 'smart_fetch' as const;

const pageFetchTool = tool(
  'smart_fetch',
  PAGE_FETCH_TOOL_DESCRIPTION,
  { url: z.string().url().describe('Absolute URL to fetch. http or https only.') },
  async ({ url }) => runPageFetch({ url }),
);

export const pageFetchMcpServer = createSdkMcpServer({
  name: PAGE_FETCH_SERVER_NAME,
  version: '2.0.0',
  tools: [pageFetchTool],
  alwaysLoad: true,
});
