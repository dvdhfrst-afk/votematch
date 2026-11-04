/**
 * Newspaper editorial-endorsement source adapter.
 *
 * Consumes `extractEndorsements()` from
 * `src/lib/extractors/endorsements.ts` (injection-defended, verbatim-check,
 * never-auto-publish). Iterates a per-state seed list of editorial RSS feeds
 * and canonical endorsement-index URLs; for hard-paywall papers it falls
 * back to the Wayback Machine CDX so we never rehost gated content.
 *
 * ## Why we scrape papers at all
 *
 * Per-state newspaper editorial boards are the single largest signal in
 * voter-endorsement behavior, and no free aggregator exists. Council-approved
 * as the free path (vs. paid aggregator deals).
 *
 * ## Defamation safeguards (stacked)
 *
 *   1. The extractor performs a verbatim substring check on endorser +
 *      candidate names. We reject rows where BOTH flags are false
 *      (double-hallucination) via `validateRow`.
 *   2. Rows with any verbatim failure land `validation_status='flagged'`
 *      inside the extractor; we still write them to DB but with
 *      `published=FALSE` (default) so nothing surfaces to voters without
 *      human review.
 *   3. The schema trigger on `endorsements` enforces that `published=TRUE`
 *      requires `reviewed_by_user_id`, `reviewed_at`, and `endorsement_url`.
 *
 * ## Cost
 *
 * The extractor routes via the LLM router with riskClass='attributed_position':
 * ollama (phi4:14b, free) handles the first pass and Claude verifies only on
 * ollama failure. Adapter-level reservation therefore uses the
 * `interpretation-llm-ollama` cost-cap row at $0; the actual Claude spend is
 * metered by the router via cost_cap_check_and_consume('claude_api', est) at
 * call time. (Was previously `claude_api` + $0.10/seed, which double-reserved
 * against Claude's daily cap even when no Claude call ever happened.)
 *
 * ## Rate limits
 *
 *   - Per-seed fetch: token bucket { rps: 0.5, burst: 2 } — 2s between
 *     fetches per the polite-scraper target.
 *   - Wayback CDX: token bucket { rps: 0.8, burst: 2 } — free service
 *     but we keep the rate conservative.
 *
 * ## robots.txt / 403 / 429 handling
 *
 * The shared `fetchForExtraction` already sets
 * `Havesay/1.0 (nonpartisan voter-information project, in development)` as the UA and throws
 * on 403/429. We catch those per host and skip the rest of that host for
 * the current run (recorded in ingestion_errors via `error_type='rate_limit'`).
 */

import { createHash } from 'node:crypto';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../types';
import { createTokenBucket } from '../rate-limit';
import {
  extractEndorsements,
  type ExtractedEndorsement,
} from '@/lib/extractors/endorsements';
import { fetchForExtraction } from '@/lib/extractors/index';
import { politeFetch } from '../fetch-polite';
import {
  NEWSPAPER_ENDORSEMENT_SEEDS,
  filterSeedsByState,
  type NewspaperEndorsementSeed,
} from './seeds';

// ---------------------------------------------------------------------------
// Public row shape
// ---------------------------------------------------------------------------

/**
 * One row returned by `run()` = one extracted endorsement (or one flagged-
 * injection row) ready for validation + insert. Mirrors `ExtractedEndorsement`
 * but carries the per-run context (paper slug, source URL, archive URL,
 * confidence, validation_status) the insert step needs.
 */
export type EndorsementRow = {
  paper_slug: string;
  paper_name: string;
  state_fips: string;
  source_url: string;
  /** Wayback Machine snapshot URL when the content came from CDX. */
  archive_url: string | null;
  /** Extractor confidence (0..1). */
  extraction_confidence: number;
  /** 'pending' | 'flagged' (never 'auto_passed' for endorsements). */
  validation_status: 'pending' | 'flagged';
  validator_notes: string;
  /** Raw extractor output per endorsement, with verbatim flags. */
  extracted: ExtractedEndorsement;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type NewspaperEndorsementsAdapterOptions = {
  /** If set, only scrape papers with this FIPS. Otherwise scrape all seeds. */
  stateFips?: string;
  /**
   * Maximum candidate article URLs to extract per paper. Defaults to 10
   * (keeps cost bounded during ad-hoc runs).
   */
  maxArticlesPerPaper?: number;
  /**
   * Soft wallclock deadline in ms. The adapter checks this between seeds and
   * between articles, returning partial rows + a `partial_due_to_deadline`
   * flag instead of being SIGKILL'd by `continuous-ingest`'s 180s per-task
   * timeout. Defaults to 150_000 (150s) so we finish ~30s under the kill,
   * leaving room for the data_sources upsert + insert phase.
   *
   * 2026-04-26: added after the stuck-task janitor was reaping ~5/min
   * runs at >6 min in `running` state. The previous SIGTERM handler kept
   * the process from leaving zombie rows but couldn't actually publish
   * the partial data it had already extracted.
   */
  softDeadlineMs?: number;
  /** Override seed list for tests. */
  seeds?: readonly NewspaperEndorsementSeed[];
  /**
   * Test hook: allow tests to inject a fake fetcher. Defaults to the shared
   * `fetchForExtraction`. Must behave the same (return snippet + raw body).
   */
  fetchImpl?: typeof fetchForExtraction;
  /**
   * Test hook: inject a fake Wayback-CDX lookup. Returns the archived URL for
   * a given input URL, or null when no snapshot exists. Defaults to the
   * built-in implementation hitting archive.org/wayback/available.
   */
  waybackLookupImpl?: (url: string) => Promise<string | null>;
  /**
   * Test hook: inject a fake endorsements extractor. Must match the signature
   * of `extractEndorsements`. Defaults to the real one.
   */
  extractImpl?: typeof extractEndorsements;
};

// ---------------------------------------------------------------------------
// Wayback CDX helper
// ---------------------------------------------------------------------------

/**
 * Ask archive.org for the most recent successful snapshot of `url`.
 * Returns the archived URL or null when no snapshot exists.
 *
 * Uses the free `/wayback/available` endpoint. Rate-limit to ~0.8 rps per
 * the adapter's own token bucket.
 */
async function defaultWaybackLookup(url: string): Promise<string | null> {
  const encoded = encodeURIComponent(url);
  const api = `https://archive.org/wayback/available?url=${encoded}`;
  const res = await politeFetch(api, {
    headers: {
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    archived_snapshots?: { closest?: { available?: boolean; status?: string; url?: string } };
  };
  const snap = body.archived_snapshots?.closest;
  if (!snap || snap.available !== true) return null;
  // Only accept 200-status snapshots — paywalled / soft-404 snapshots are
  // worse than no snapshot.
  if (snap.status && snap.status !== '200') return null;
  return snap.url ?? null;
}

// ---------------------------------------------------------------------------
// Lightweight RSS / HTML link extraction (no external DOM dep)
// ---------------------------------------------------------------------------

/**
 * Parse an RSS-feed body. We take item `<title>` + `<link>` pairs where the
 * title mentions "endorse" / "endorsement" (case-insensitive). The shared
 * HTML cleaner in `fetchForExtraction` strips tags, so when the XML went
 * through that pipeline we only have the visible text. We therefore parse
 * the raw body separately here (fetching a second time in RSS mode).
 */
export function findEndorsementLinksInRss(rssXml: string): Array<{ title: string; link: string }> {
  const items: Array<{ title: string; link: string }> = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(rssXml)) !== null) {
    const body = m[1] ?? '';
    const titleMatch = /<title\b[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(body);
    const linkMatch = /<link\b[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(body);
    if (!titleMatch || !linkMatch) continue;
    const title = titleMatch[1]!.trim();
    const link = linkMatch[1]!.trim();
    if (!title || !link) continue;
    if (!/\bendors(e|ement|ing|ed|es)\b/i.test(title)) continue;
    items.push({ title, link });
  }
  return items;
}

/**
 * Scan the cleaned-text body of an index page for anchor-like fragments
 * mentioning endorsement. Because `fetchForExtraction` strips HTML, we can't
 * recover anchors reliably — we ask the extractor to extract endorsements
 * from the page directly in that case (see run()). This helper is exported
 * so tests can drive it explicitly.
 */
export function findEndorsementLinksInHtml(html: string, base: string): string[] {
  const links = new Set<string>();
  const hrefRegex = /<a\b[^>]*href="([^"#?]+)"[^>]*>([^<]+)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRegex.exec(html)) !== null) {
    const href = m[1] ?? '';
    const text = m[2] ?? '';
    if (!/\bendors(e|ement|ing|ed|es)\b/i.test(text) && !/\bendors/i.test(href)) continue;
    try {
      const resolved = new URL(href, base).toString();
      links.add(resolved);
    } catch {
      // ignore bad hrefs
    }
  }
  return [...links];
}

// ---------------------------------------------------------------------------
// Row truncation helper
// ---------------------------------------------------------------------------

const EXCERPT_MAX = 500;

function truncateExcerpt(s: string): string {
  if (s.length <= EXCERPT_MAX) return s;
  return s.slice(0, EXCERPT_MAX - 1).trimEnd() + '\u2026';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function newspaperEndorsementsAdapter(
  stateFips?: string,
  options: NewspaperEndorsementsAdapterOptions = {},
): SourceAdapter<EndorsementRow> {
  const seedsAll = options.seeds ?? NEWSPAPER_ENDORSEMENT_SEEDS;
  const seeds = filterSeedsByState(seedsAll, stateFips ?? options.stateFips);
  const maxArticlesPerPaper = options.maxArticlesPerPaper ?? 10;
  const fetchImpl = options.fetchImpl ?? fetchForExtraction;
  const waybackLookup = options.waybackLookupImpl ?? defaultWaybackLookup;
  const extractImpl = options.extractImpl ?? extractEndorsements;
  const softDeadlineMs = options.softDeadlineMs ?? 150_000;
  // Per-article extractor budget. Without this a stuck ollama call hangs the
  // whole run forever (the LLM router's fetch() to /api/chat has no
  // AbortSignal as of 2026-04-26). 30s is comfortably above ollama p99 for
  // phi4 on the dev box; tune via env if a slow model is in use.
  const PER_ARTICLE_TIMEOUT_MS = 30_000;

  // Per-run token buckets: polite-scraper for paper fetches, looser for Wayback.
  const paperBucket = createTokenBucket({ rps: 0.5, burst: 2 });
  const waybackBucket = createTokenBucket({ rps: 0.8, burst: 2 });

  // Track hosts that returned 403/429 so we skip the rest of that host for
  // the current run (and report via ingestion_errors).
  const blockedHosts = new Set<string>();

  function hostOf(u: string): string {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  }

  async function gatherArticleUrlsFromSeed(
    seed: NewspaperEndorsementSeed,
    ctx: AdapterContext,
  ): Promise<Array<{ url: string; archiveUrl: string | null }>> {
    const out: Array<{ url: string; archiveUrl: string | null }> = [];

    // Hard paywall → go straight to Wayback on the index URL.
    if (seed.paywall === 'hard') {
      if (!seed.endorsement_index_url) return out;
      await waybackBucket.acquire();
      try {
        const archived = await waybackLookup(seed.endorsement_index_url);
        if (archived) {
          out.push({ url: seed.endorsement_index_url, archiveUrl: archived });
        }
      } catch (err) {
        ctx.logger.warn('newspaper-endorsements: wayback lookup failed', {
          seed: seed.slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return out;
    }

    // RSS path
    if (seed.rss_url) {
      const host = hostOf(seed.rss_url);
      if (!blockedHosts.has(host)) {
        await paperBucket.acquire();
        try {
          const fetched = await fetchImpl(seed.rss_url);
          const items = findEndorsementLinksInRss(fetched.body);
          for (const item of items) {
            out.push({ url: item.link, archiveUrl: null });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/forbidden|429|rate limited/i.test(msg)) {
            blockedHosts.add(host);
            ctx.logger.warn('newspaper-endorsements: host blocked', { host, error: msg });
          } else {
            ctx.logger.warn('newspaper-endorsements: rss fetch failed', {
              seed: seed.slug,
              error: msg,
            });
          }
        }
      }
    }

    // Index-page path (either no RSS or RSS produced nothing)
    if (out.length === 0 && seed.endorsement_index_url) {
      const host = hostOf(seed.endorsement_index_url);
      if (!blockedHosts.has(host)) {
        await paperBucket.acquire();
        try {
          const fetched = await fetchImpl(seed.endorsement_index_url);
          // Try to recover anchors from the raw body (before HTML-strip).
          const linksFromRaw = findEndorsementLinksInHtml(
            fetched.body,
            seed.endorsement_index_url,
          );
          for (const url of linksFromRaw) {
            out.push({ url, archiveUrl: null });
          }
          // If we couldn't recover anchors, still let the extractor chew on
          // the index page itself — it may contain a full editorial inline.
          if (linksFromRaw.length === 0) {
            out.push({ url: seed.endorsement_index_url, archiveUrl: null });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/forbidden|429|rate limited/i.test(msg)) {
            blockedHosts.add(host);
            ctx.logger.warn('newspaper-endorsements: host blocked', { host, error: msg });
          } else {
            ctx.logger.warn('newspaper-endorsements: index fetch failed', {
              seed: seed.slug,
              error: msg,
            });
          }
        }
      }
    }

    return out.slice(0, maxArticlesPerPaper);
  }

  async function extractFromOneUrl(
    seed: NewspaperEndorsementSeed,
    candidateUrl: string,
    archiveUrl: string | null,
    ctx: AdapterContext,
  ): Promise<EndorsementRow[]> {
    // Fetch the article (via Wayback URL if we have one).
    const fetchUrl = archiveUrl ?? candidateUrl;
    const host = hostOf(fetchUrl);
    if (blockedHosts.has(host)) return [];

    await paperBucket.acquire();
    let snippet: string;
    try {
      const fetched = await fetchImpl(fetchUrl);
      snippet = fetched.snippet;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/forbidden|429|rate limited/i.test(msg)) {
        blockedHosts.add(host);
      }
      ctx.logger.warn('newspaper-endorsements: article fetch failed', {
        seed: seed.slug,
        url: fetchUrl,
        error: msg,
      });
      return [];
    }

    let extraction: Awaited<ReturnType<typeof extractEndorsements>>;
    try {
      // Race the extractor against a per-article timeout. The LLM router's
      // ollama fetch has no AbortSignal yet, so we time-bound at this layer
      // to keep one slow extraction from blowing the run's wallclock budget.
      const timeoutHandle: { id?: NodeJS.Timeout } = {};
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle.id = setTimeout(
          () =>
            reject(
              new Error(
                `extractor timeout after ${PER_ARTICLE_TIMEOUT_MS}ms (per-article budget)`,
              ),
            ),
          PER_ARTICLE_TIMEOUT_MS,
        );
      });
      try {
        extraction = await Promise.race([
          extractImpl({
            sourceUrl: candidateUrl,
            snippet,
            context: { state_fips: seed.state_fips },
          }),
          timeoutPromise,
        ]);
      } finally {
        if (timeoutHandle.id) clearTimeout(timeoutHandle.id);
      }
    } catch (err) {
      ctx.logger.warn('newspaper-endorsements: extractor failed', {
        seed: seed.slug,
        url: candidateUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const rows: EndorsementRow[] = [];
    for (const e of extraction.endorsements) {
      rows.push({
        paper_slug: seed.slug,
        paper_name: seed.name,
        state_fips: seed.state_fips,
        source_url: candidateUrl,
        archive_url: archiveUrl,
        extraction_confidence: extraction.confidence,
        validation_status: extraction.validation_status === 'flagged' ? 'flagged' : 'pending',
        validator_notes: extraction.validator_notes,
        extracted: {
          ...e,
          excerpt: truncateExcerpt(e.excerpt),
        },
      });
    }
    return rows;
  }

  // Lookup-or-create endorser row, keyed by (endorser_type, canonical_name, state_fips).
  async function resolveOrCreateEndorserId(
    supabase: AdapterContext['supabase'],
    canonicalName: string,
    stateFipsCode: string,
  ): Promise<string | null> {
    const { data, error } = await supabase
      .from('endorsers')
      .select('id')
      .eq('canonical_name', canonicalName)
      .eq('endorser_type', 'newspaper_editorial_board')
      .eq('state_fips', stateFipsCode)
      .limit(1)
      .maybeSingle();
    if (error) return null;
    if (data?.id) return String(data.id);

    const { data: inserted, error: insErr } = await supabase
      .from('endorsers')
      .insert({
        canonical_name: canonicalName,
        endorser_type: 'newspaper_editorial_board',
        state_fips: stateFipsCode,
      })
      .select('id')
      .single();
    if (insErr || !inserted) return null;
    return String(inserted.id);
  }

  // Fuzzy-match a candidate name to exactly one candidacy_id.
  async function resolveCandidacyId(
    supabase: AdapterContext['supabase'],
    candidateName: string,
    stateFipsCode: string,
  ): Promise<
    | { kind: 'ok'; id: string }
    | { kind: 'no_match' }
    | { kind: 'ambiguous'; count: number }
    | { kind: 'error'; message: string }
  > {
    // Two-step lookup: (1) find people by canonical_name, (2) find candidacies
    // whose election is scoped to this state. We avoid complex JOIN syntax in
    // the Supabase client by doing it in two queries.
    const { data: people, error: peopleErr } = await supabase
      .from('people')
      .select('id, canonical_name')
      .ilike('canonical_name', candidateName)
      .limit(5);
    if (peopleErr) {
      return { kind: 'error', message: peopleErr.message };
    }
    if (!people || people.length === 0) {
      return { kind: 'no_match' };
    }

    const personIds = people.map((p) => (p as { id: string }).id);

    // Narrow to candidacies for those people. Caller is expected to be running
    // in a context where `elections.state_fips` exists — but the candidacies
    // table doesn't carry state_fips directly, so we rely on person match
    // being state-appropriate. A second pass against election jurisdiction
    // happens at review time.
    const { data: cands, error: candErr } = await supabase
      .from('candidacies')
      .select('id, person_id')
      .in('person_id', personIds);
    if (candErr) {
      return { kind: 'error', message: candErr.message };
    }
    if (!cands || cands.length === 0) {
      return { kind: 'no_match' };
    }
    if (cands.length > 1) {
      // Ambiguous — the reviewer queue must resolve manually. We record the
      // attempted match in ingestion_errors rather than writing an orphan row.
      return { kind: 'ambiguous', count: cands.length };
    }
    return { kind: 'ok', id: String((cands[0] as { id: string }).id) };
  }

  return {
    name: 'newspaper-endorsements',
    stateFips: stateFips ?? options.stateFips,
    tokenBucket: { rps: 0.5, burst: 2 },
    // Routing: extractEndorsements() goes through the LLM router with
    // riskClass='attributed_position'; ollama (phi4:14b, free) takes the
    // first pass and Claude only fires as a verifier on ollama failure.
    // Reserve against the ollama-LLM cap here ($0/call); the router itself
    // calls cost_cap_check_and_consume('claude_api', est) when the Claude
    // fallback actually runs.
    costService: 'interpretation-llm-ollama',
    estimatedCostUsd: 0,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<EndorsementRow>> {
      const startedAt = Date.now();
      const deadlineAt = startedAt + softDeadlineMs;
      ctx.logger.info('newspaper-endorsements: starting fetch', {
        seeds: seeds.length,
        state_fips: stateFips ?? options.stateFips ?? '-',
        soft_deadline_ms: softDeadlineMs,
      });

      const rows: EndorsementRow[] = [];
      const sampleUrls: string[] = [];
      let partialDueToDeadline = false;
      let seedsProcessed = 0;

      seedLoop: for (const seed of seeds) {
        if (Date.now() >= deadlineAt) {
          partialDueToDeadline = true;
          ctx.logger.warn('newspaper-endorsements: soft deadline reached, returning partial', {
            seeds_processed: seedsProcessed,
            seeds_total: seeds.length,
            rows_so_far: rows.length,
          });
          break;
        }
        seedsProcessed += 1;
        const candidateUrls = await gatherArticleUrlsFromSeed(seed, ctx);
        if (candidateUrls.length === 0) {
          ctx.logger.info('newspaper-endorsements: no candidates', { seed: seed.slug });
          continue;
        }
        ctx.logger.info('newspaper-endorsements: candidates found', {
          seed: seed.slug,
          count: candidateUrls.length,
        });
        for (const { url, archiveUrl } of candidateUrls) {
          if (Date.now() >= deadlineAt) {
            partialDueToDeadline = true;
            ctx.logger.warn(
              'newspaper-endorsements: soft deadline reached mid-seed, returning partial',
              {
                seed: seed.slug,
                rows_so_far: rows.length,
              },
            );
            break seedLoop;
          }
          if (sampleUrls.length < 500) sampleUrls.push(url);
          const found = await extractFromOneUrl(seed, url, archiveUrl, ctx);
          rows.push(...found);
        }
      }

      ctx.logger.info('newspaper-endorsements: extraction complete', {
        rows: rows.length,
        blocked_hosts: [...blockedHosts],
      });

      const contentHash = createHash('sha256')
        .update(
          JSON.stringify({
            seeds: seeds.map((s) => s.slug),
            sampleUrls,
            rowCount: rows.length,
          }),
        )
        .digest('hex');

      // Pick a primary URL for the data_sources row: the first seed we scraped
      // (or a synthetic one if seeds was empty).
      const primary = seeds[0];
      const primaryUrl = primary?.endorsement_index_url ?? primary?.rss_url ?? 'https://ballotbridge.org/adapters/newspaper-endorsements';

      return {
        rows,
        // Endorsement runs are often empty off-cycle — a clean zero-row run
        // is legitimate. Floor of 0 keeps status classification sane.
        expectedMinRows: 0,
        source: {
          sourceType: 'newspaper_editorial',
          name: `Newspaper editorial endorsements (${seeds.length} papers${stateFips ? ', state=' + stateFips : ''})`,
          url: primaryUrl,
          contentHash,
          license: 'fair_use_excerpt',
          stateFips: stateFips ?? options.stateFips,
          meta: {
            seed_count: seeds.length,
            seeds_processed: seedsProcessed,
            state_scope: stateFips ?? options.stateFips ?? 'all',
            blocked_hosts: [...blockedHosts],
            soft_deadline_ms: softDeadlineMs,
            partial_due_to_deadline: partialDueToDeadline,
            elapsed_ms: Date.now() - startedAt,
          },
        },
      };
    },

    /**
     * Reject rows where BOTH verbatim flags are false (the double-
     * hallucination signal: the model fabricated both endorser and
     * candidate). Single-verbatim failures are kept but routed to flagged
     * on insert.
     */
    validateRow(row: EndorsementRow): string | null {
      const e = row.extracted;
      if (!e.verbatim_endorser_found_in_source && !e.verbatim_candidate_found_in_source) {
        return 'double_verbatim_failure: neither endorser nor candidate found verbatim';
      }
      return null;
    },

    async insert(
      rows: EndorsementRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      const stats: InsertStats = {
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        errors: [],
      };
      if (rows.length === 0) return stats;

      let skippedNoMatch = 0;
      let skippedVerbatimFail = 0; // kept for symmetry with spec; runner counts validation failures separately

      for (const row of rows) {
        // Resolve or create endorser.
        const endorserId = await resolveOrCreateEndorserId(
          ctx.supabase,
          row.paper_name,
          row.state_fips,
        );
        if (!endorserId) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: `endorser resolve/create failed for ${row.paper_name}`,
            rawInput: row,
          });
          continue;
        }

        // Resolve candidacy.
        const match = await resolveCandidacyId(
          ctx.supabase,
          row.extracted.candidate_name,
          row.state_fips,
        );
        if (match.kind === 'error') {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: `candidacy lookup error: ${match.message}`,
            rawInput: row,
          });
          continue;
        }
        if (match.kind === 'no_match' || match.kind === 'ambiguous') {
          skippedNoMatch += 1;
          stats.rowsSkipped += 1;
          // Log the attempt to ingestion_errors so the reviewer queue can see it.
          await ctx.supabase.from('ingestion_errors').insert({
            ingestion_run_id: refs.ingestionRunId,
            raw_input: row as unknown as Record<string, unknown>,
            error_type: 'validation',
            error_message:
              match.kind === 'no_match'
                ? `candidate_name='${row.extracted.candidate_name}' did not match any candidacy`
                : `candidate_name='${row.extracted.candidate_name}' matched ${match.count} candidacies (ambiguous)`,
          });
          continue;
        }

        // Write the endorsement row. published=FALSE always (schema default).
        const endorsementDate = row.extracted.endorsement_date ?? new Date().toISOString().slice(0, 10);

        // Use upsert with ignoreDuplicates so re-running the adapter on the
        // same (candidacy_id, endorser_id, endorsement_date) tuple is a no-op
        // instead of a hard error. The unique constraint
        // `endorsements_candidacy_id_endorser_id_endorsement_date_key` enforces
        // dedup at the DB level; the adapter just needs to express the
        // ON CONFLICT clause so PostgREST emits ON CONFLICT DO NOTHING.
        const { data: insData, error: insErr } = await ctx.supabase
          .from('endorsements')
          .upsert(
            {
              candidacy_id: match.id,
              endorser_id: endorserId,
              endorsement_date: endorsementDate,
              endorsement_type: row.extracted.endorsement_type,
              endorsement_url: row.source_url,
              archive_url: row.archive_url,
              excerpt: row.extracted.excerpt,
              supporting_quote: row.extracted.supporting_quote,
              extracted_by: 'ai_extraction_verified',
              extraction_confidence: row.extraction_confidence,
              data_source_id: refs.dataSourceId,
              published: false,
              meta: {
                validation_status: row.validation_status,
                validator_notes: row.validator_notes,
                ingestion_run_id: refs.ingestionRunId,
                paper_slug: row.paper_slug,
                verbatim_endorser: row.extracted.verbatim_endorser_found_in_source,
                verbatim_candidate: row.extracted.verbatim_candidate_found_in_source,
                verbatim_url: row.extracted.verbatim_url_found_in_source,
              },
            },
            {
              onConflict: 'candidacy_id,endorser_id,endorsement_date',
              ignoreDuplicates: true,
            },
          )
          .select('id');
        if (insErr) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: `endorsements insert failed: ${insErr.message}`,
            rawInput: row,
          });
          continue;
        }
        if (insData && insData.length > 0) {
          stats.rowsInserted += 1;
        } else {
          // Row already existed under the unique key — count as skipped.
          stats.rowsSkipped += 1;
        }
      }

      ctx.logger.info('newspaper-endorsements: insert summary', {
        inserted: stats.rowsInserted,
        updated: stats.rowsUpdated,
        skipped_no_match: skippedNoMatch,
        skipped_verbatim_fail: skippedVerbatimFail,
        failed: stats.rowsFailed,
      });

      return stats;
    },
  };
}

// Re-export for test ergonomics.
export { NEWSPAPER_ENDORSEMENT_SEEDS } from './seeds';
export type { NewspaperEndorsementSeed } from './seeds';
