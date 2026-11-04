import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getAxisQuestions } from '@/lib/matching/voter-axis';
import {
  loadRaceOfficeDimensions,
  respectOfficeDimsEnabled,
} from '@/lib/matching/office-dims';

/**
 * GET /api/axis-questions
 *
 * The data feed for the voter-facing multivariable axis Q&A (Question and
 * Answer) flow. For a set of issues (sub_dimensions) it returns the askable
 * axes per issue, each with everything the UI (User Interface) needs to render
 * one continuous 0-1 slider: axis_uid, label, spectrum_low (pole at 0.0),
 * spectrum_high (pole at 1.0), and the axis_kind so the page can order primary
 * first, then backbone, then propositions (doc 09 Part 4.1; doc 07 section 2.8
 * prefers a continuous slider over a discrete Likert).
 *
 * Two ways to name the issues, checked in order:
 *
 *   1. ?sub_dimension_ids=<uuid>,<uuid>  (the primary contract; matches
 *      getAxisQuestions(sb, subDimensionIds) exactly)
 *   2. ?race_id=<uuid>                   (convenience: resolve the office's
 *      relevant_dimensions for that race, then ask those issues)
 *
 * Read-only. No session and no SPI (Sensitive Personal Information) consent is
 * required to READ the question set; consent is enforced later, on the write
 * path (submitAxisAnswers), exactly as quick-match does. Issues that resolve to
 * no axes come back with an empty `axes` array rather than being dropped, so the
 * client can tell "asked and empty" from "never asked".
 *
 * Acronyms, spelled out on first use: UID (unique identifier), UUID (universally
 * unique identifier), UI (user interface), DB (database).
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const rawIds = sp.get('sub_dimension_ids');
  const raceId = sp.get('race_id');

  try {
    const supabase = await createClient();

    // Resolve the list of issue (sub_dimension) ids to ask.
    let subDimensionIds: string[] = [];

    if (rawIds && rawIds.trim().length > 0) {
      subDimensionIds = rawIds
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (raceId) {
      subDimensionIds = await resolveRaceSubDimensions(supabase, raceId);
    } else {
      return NextResponse.json(
        { error: 'Provide sub_dimension_ids or race_id.' },
        { status: 400 },
      );
    }

    if (subDimensionIds.length === 0) {
      // Nothing to ask (e.g. a race with no resolvable office dimensions). An
      // empty array is a valid answer, not an error. The UI shows an empty
      // state and lets the voter skip to results.
      return NextResponse.json({ issues: [] });
    }

    const issues = await getAxisQuestions(supabase, subDimensionIds);
    return NextResponse.json({ issues });
  } catch (err) {
    console.error('axis-questions route error:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred while loading axis questions.' },
      { status: 500 },
    );
  }
}

/**
 * Resolve the issue (sub_dimension) ids to ask for a given race via the office's
 * relevant_dimensions (the same tiered lookup the matcher uses, behind
 * MATCHING_RESPECT_OFFICE_DIMS). Falls back to an empty list when office dims
 * are unavailable so the caller can show an empty state rather than crash.
 *
 * relevant_dimensions can hold sub_dimension ids OR sub_dimension names
 * (matching the matcher's `officeDims.has(sd.id) || officeDims.has(sd.name)`
 * tolerance in algorithm.ts). We normalize to ids by looking up the
 * sub_dimensions table, so getAxisQuestions always receives real ids.
 */
async function resolveRaceSubDimensions(
  supabase: Awaited<ReturnType<typeof createClient>>,
  raceId: string,
): Promise<string[]> {
  if (!respectOfficeDimsEnabled()) {
    // When office-dim filtering is off there is no per-race issue set to ask;
    // the caller should pass sub_dimension_ids explicitly instead.
    return [];
  }

  // Bridge race → election so loadRaceOfficeDimensions can walk to the office.
  // Legacy races carry races.election_id; new-graph races have race.id IS the
  // election id. Try the legacy row first, then fall back to the id itself.
  let electionId: string | null = null;
  const { data: raceRow } = await supabase
    .from('races')
    .select('id, election_id')
    .eq('id', raceId)
    .maybeSingle();
  electionId =
    (raceRow as { election_id: string | null } | null)?.election_id ?? raceId;

  const dimsByRace = await loadRaceOfficeDimensions(supabase, [
    { race_id: raceId, election_id: electionId },
  ]);
  const dims = dimsByRace.get(raceId) ?? [];
  if (dims.length === 0) return [];

  // Normalize id-or-name entries to canonical ids. Match by id first, then name.
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

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const d of dims) {
    const id = byId.has(d) ? d : idByName.get(d);
    if (id && !seen.has(id)) {
      seen.add(id);
      resolved.push(id);
    }
  }
  return resolved;
}
