import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/session';
import { resolveSessionRaceIds } from '@/lib/ballot-lookup/ballot-loader';
import { resolveMatchCandidates } from '@/lib/matching/resolve-match-candidates';
import { sanitizeDisplayName } from '@/lib/text/sanitize-display';
import {
  ballotKeyFromRaceIds,
  dailyPromptSeed,
  rankDailyPromptCandidates,
  DAILY_PROMPT_LIST_SIZE,
  type RankableQuestion,
} from '@/lib/device/daily-prompt';
import type {
  DailyPromptOption,
  DailyPromptQuestion,
  DailyPromptResponse,
} from '@/types/daily-prompt';

/**
 * GET /api/daily-prompt  (work-order Phase 2A - question-of-the-day)
 *
 * THE SERVER-BLIND DESIGN, in two sentences: this returns a small
 * deterministic-per-day RANKED LIST of candidate questions, weighted toward the
 * sub_dimensions that matter for THIS ballot's races (resolved from the
 * address-derived ballot only, never any opinion), and the DEVICE alone decides
 * which one to surface (first unanswered, else the oldest-answered for a
 * refresh). Because the client tells the server nothing about its profile, the
 * server can never learn what the voter has or has not answered - it sees only
 * the public ballot, exactly like /api/positions-bundle.
 *
 * IN:  only the existing anonymous session cookie, used purely to resolve WHICH
 *      races are on the ballot (the voter's address). No opinion read or accepted.
 * OUT: ranked public question content (prompt, options, sub_dimension label) +
 *      an onBallot flag per question. No voter data.
 *
 * Cacheable per-day: the response is stable for a given (UTC day, ballot).
 */

/** UTC calendar day, stable for cache-keying. */
function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

type QuestionRow = {
  id: string;
  sub_dimension_id: string;
  prompt: string;
  priority: number | null;
  options: unknown;
  sub_dimensions:
    | { domain: string; name: string; active: boolean }
    | { domain: string; name: string; active: boolean }[]
    | null;
};

function normOptions(raw: unknown): DailyPromptOption[] {
  if (!Array.isArray(raw)) return [];
  const out: DailyPromptOption[] = [];
  for (const o of raw) {
    if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      const label = typeof rec.label === 'string' ? rec.label : '';
      const description =
        typeof rec.description === 'string' ? rec.description : '';
      const score = typeof rec.score === 'number' ? rec.score : NaN;
      if (label && Number.isFinite(score)) {
        out.push({ label, description, score });
      }
    }
  }
  return out;
}

/**
 * Resolve the set of sub_dimension IDS that are relevant to this ballot's races,
 * so the ranker can weight on-ballot questions ahead of off-ballot ones. Reuses
 * the SAME office-dims resolution the matcher uses (resolveMatchCandidates ->
 * officeDimsByRace), then normalizes id-or-name entries to canonical ids (the
 * matcher tolerates both; axis-questions does the same normalization). Returns
 * an empty set when office dims are unavailable, in which case every question is
 * treated as off-ballot and the day-rotation alone orders the list.
 */
async function resolveBallotSubDimensionIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  raceIds: string[],
): Promise<Set<string>> {
  if (raceIds.length === 0) return new Set();
  let officeDimsByRace: Map<string, string[]>;
  try {
    const resolved = await resolveMatchCandidates(supabase, raceIds);
    officeDimsByRace = resolved.officeDimsByRace;
  } catch {
    return new Set();
  }

  const raw = new Set<string>();
  for (const dims of officeDimsByRace.values()) {
    for (const d of dims) raw.add(d);
  }
  if (raw.size === 0) return new Set();

  // Normalize id-or-name to canonical ids.
  const { data: sds } = await supabase
    .from('sub_dimensions')
    .select('id, name')
    .eq('active', true);
  const byId = new Set<string>();
  const idByName = new Map<string, string>();
  for (const sd of (sds ?? []) as Array<{ id: string; name: string }>) {
    byId.add(sd.id);
    idByName.set(sd.name, sd.id);
  }

  const out = new Set<string>();
  for (const d of raw) {
    const id = byId.has(d) ? d : idByName.get(d);
    if (id) out.add(id);
  }
  return out;
}

export async function GET() {
  const day = utcDay();
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { error: 'No active session. Please look up your ballot first.' },
        { status: 401 },
      );
    }

    const supabase = await createClient();

    // 1. Resolve the ballot race id set (public, address-derived). Same path as
    //    /api/positions-bundle. An empty set is an honest "no ballot yet" state.
    const raceIds = await resolveSessionRaceIds(user);

    // 2. Load the active voter question bank (public). Sub_dimension join gives
    //    the label + domain for the card and confirms the dimension is active.
    const { data: qData, error: qErr } = await supabase
      .from('questions')
      .select(
        'id, sub_dimension_id, prompt, priority, options, sub_dimensions!inner(domain, name, active)',
      )
      .eq('kind', 'voter')
      .eq('active', true)
      .eq('sub_dimensions.active', true);

    if (qErr || !qData) {
      return NextResponse.json(
        { error: 'Failed to load question bank.' },
        { status: 500 },
      );
    }

    const rows = qData as unknown as QuestionRow[];
    if (rows.length === 0) {
      const empty: DailyPromptResponse = { day, questions: [], noBallot: raceIds.length === 0 };
      return NextResponse.json(empty, {
        headers: { 'Cache-Control': 'private, max-age=300' },
      });
    }

    // 3. Ballot-relevant sub_dimension ids (public, no opinion). Empty when the
    //    session has no ballot, so nothing is on-ballot and rotation alone ranks.
    const ballotSubDimensionIds =
      raceIds.length > 0
        ? await resolveBallotSubDimensionIds(supabase, raceIds)
        : new Set<string>();

    // 4. Rank server-blind: on-ballot first, then a day-seeded rotation, then
    //    author priority. No profile is consulted here (that is the device's job).
    const rankable: RankableQuestion[] = rows.map((r) => ({
      id: r.id,
      subDimensionId: r.sub_dimension_id,
      priority: r.priority ?? 0,
    }));
    const seed = dailyPromptSeed(day, ballotKeyFromRaceIds(raceIds));
    const ranked = rankDailyPromptCandidates({
      questions: rankable,
      ballotSubDimensionIds,
      seed,
      limit: DAILY_PROMPT_LIST_SIZE,
    });

    // 5. Enrich the ranked candidates with renderable content, preserving order.
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const questions: DailyPromptQuestion[] = [];
    for (const c of ranked) {
      const r = rowById.get(c.questionId);
      if (!r) continue;
      const rel = r.sub_dimensions;
      const sd = Array.isArray(rel) ? (rel[0] ?? null) : rel;
      questions.push({
        questionId: c.questionId,
        subDimensionId: c.subDimensionId,
        onBallot: c.onBallot,
        prompt: r.prompt,
        subDimensionName: sd?.name ? sanitizeDisplayName(sd.name) : null,
        domain: sd?.domain ?? null,
        options: normOptions(r.options),
      });
    }

    const body: DailyPromptResponse = {
      day,
      questions,
      noBallot: raceIds.length === 0,
    };

    return NextResponse.json(body, {
      headers: {
        // Stable per (UTC day, ballot). Private because the ballot is
        // session-derived, but it carries no opinion. Short SWR keeps the
        // rotation crisp at the UTC day boundary.
        'Cache-Control': 'private, max-age=1800, stale-while-revalidate=3600',
      },
    });
  } catch (err) {
    console.error('daily-prompt route error:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred building the daily prompt.' },
      { status: 500 },
    );
  }
}
