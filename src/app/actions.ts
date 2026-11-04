'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { geocodeAddress, lookupPrecinct } from '@/lib/ballot-lookup';
import { resolveDistrictBallotElectionIds } from '@/lib/ballot-lookup/district-lookup';
import { resolveSessionRaceIds } from '@/lib/ballot-lookup/ballot-loader';
import { getOrCreateSession, getSessionUser, setSessionCookie } from '@/lib/session';
import { isGuideProviderReady } from '@/lib/guide/provider';
import type { VoterAxisAnswer } from '@/lib/matching/voter-axis';
import type {
  QuickMatchAnswers,
  VisibilityLevel,
} from '@/types/database';

// ---------------------------------------------------------------------------
// Coverage helpers (module-private — a 'use server' file can only EXPORT async
// server actions, but non-exported helpers are fine).
// ---------------------------------------------------------------------------

/**
 * True when at least one of the given v_voter_races ids has an UPCOMING election
 * (election_date >= today) — the SAME filter renderBallotFromIds / the guide /
 * /ballot apply. "Precinct found" alone is NOT coverage: a precinct can hold
 * only past elections, which would render an empty ballot. Checking the upcoming
 * set here lets lookupBallotAction surface an honest no-coverage message instead
 * of redirecting into a silently empty guide.
 *
 * Uses the service client: v_voter_races is public-read and this runs in a
 * server action. Fails OPEN (returns true) on a query error so an infra blip
 * doesn't wrongly tell a real voter they have no ballot — the downstream render
 * still shows its own empty state if truly empty.
 */
async function hasUpcomingRace(ids: string[]): Promise<boolean> {
  const unique = [...new Set(ids.filter((x) => typeof x === 'string' && x))];
  if (unique.length === 0) return false;
  try {
    const supabase = await createServiceClient();
    const todayIso = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from('v_voter_races')
      .select('id')
      .in('id', unique)
      .gte('election_date', todayIso)
      .limit(1);
    if (error) {
      console.warn('hasUpcomingRace query failed (failing open):', error.message);
      return true;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    console.warn('hasUpcomingRace threw (failing open):', err);
    return true;
  }
}

/** Postgres "column does not exist" (undefined_column, SQLSTATE 42703). */
function isMissingColumnError(err: { code?: string; message?: string }): boolean {
  if (err?.code === '42703') return true;
  const m = (err?.message ?? '').toLowerCase();
  return (
    m.includes('resolved_election_ids') &&
    (m.includes('does not exist') || m.includes('could not find') || m.includes('column'))
  );
}

// ---------------------------------------------------------------------------
// lookupBallotAction — called from landing page form
// ---------------------------------------------------------------------------

export async function lookupBallotAction(formData: FormData) {
  const address = formData.get('address') as string | null;

  if (!address || address.trim().length === 0) {
    return { error: 'Please enter your address.' };
  }

  try {
    const supabase = await createClient();

    // Geocode
    const coords = await geocodeAddress(address);
    if (!coords) {
      return { error: 'Could not find that address. Please check the address and try again.' };
    }
    if ('error' in coords) {
      // Territory address — Census Geocoder doesn't cover PR/VI/GU/MP/AS;
      // surface a structured error so the UI can route to a county /
      // jurisdiction selector (council #9).
      return {
        error:
          'Territory addresses are not yet supported by automated lookup. Please pick your jurisdiction manually below.',
        territory: coords.abbr,
        state_fips: coords.state_fips,
      };
    }

    // Look up precinct (Utah early-validation coverage). If we find one, use
    // it — it carries precinct-level local races the district path can't.
    const precinct = await lookupPrecinct(coords.lat, coords.lng, supabase);

    // District path (state-generic): when there's no precinct for this point,
    // resolve the ballot from the geocoded point via point-in-polygon against
    // political_districts. This is what makes non-Utah addresses work. We keep
    // the full resolved result: the election ids we persist (PRIVACY: so we
    // never re-geocode a stored plaintext address later) and the districts we
    // snapshot state/CD from below.
    let districtResult: Awaited<
      ReturnType<typeof resolveDistrictBallotElectionIds>
    > | null = null;
    if (!precinct) {
      try {
        districtResult = await resolveDistrictBallotElectionIds(
          coords.lat,
          coords.lng,
          supabase,
        );
      } catch (districtErr) {
        console.warn('District ballot resolution failed (non-fatal):', districtErr);
      }
    }

    // Resolve the id set the ballot will ACTUALLY render (precinct ids or the
    // district election ids) and confirm at least one has an UPCOMING election.
    // This is the fix for the silent-empty-guide bug: a precinct can exist yet
    // hold only PAST elections (e.g. Utah's June 30 primary once it's behind
    // us), so "precinct found" is NOT the same as "the voter has a ballot".
    // Checking the upcoming set here — the same v_voter_races election_date >=
    // today filter /guide + /ballot apply — means we surface an honest
    // no-coverage message instead of redirecting into an empty guide.
    const resolvedIds: string[] = precinct
      ? await resolveSessionRaceIds({
          precinct_id: precinct.id,
          address_text: null,
          resolved_election_ids: null,
        })
      : districtResult?.electionIds ?? [];

    const hasUpcomingCoverage = await hasUpcomingRace(resolvedIds);

    if (!hasUpcomingCoverage) {
      // Either we found no coverage for this point (no precinct + no district
      // match), OR we matched geography but none of its races has an upcoming
      // election. Both are coverage gaps, NOT bad addresses. Say so honestly so
      // the UI shows the no-coverage message rather than a silent empty guide.
      return {
        error:
          "We found your address, but we don't have any upcoming races for your area yet. We're adding coverage across all 50 states over time. Check back closer to your next election.",
        no_coverage: true,
      };
    }

    // Ensure session exists
    const { user, token, isNew } = await getOrCreateSession();

    if (isNew) {
      await setSessionCookie(token);
    }

    // PRIVACY: persist ONLY resolved geography, never the raw address. The
    // precinct path stores precinct_id; the district path stores the resolved
    // election ids (so the ballot re-renders WITHOUT re-geocoding a stored
    // address). We write resolved_election_ids defensively: if the column does
    // not exist yet (pre-migration), the write silently no-ops via the fallback
    // below, and the pre-migration read path in resolveSessionRaceIds keeps
    // working. We NEVER write address_text.
    const baseUpdate: Record<string, unknown> = {
      precinct_id: precinct?.id ?? null,
    };
    if (!precinct) {
      baseUpdate.resolved_election_ids = resolvedIds;
    } else {
      // Precinct sessions resolve from precinct_id; clear any stale district ids.
      baseUpdate.resolved_election_ids = null;
    }

    const { error: updateErr } = await supabase
      .from('users')
      .update(baseUpdate)
      .eq('id', user.id);

    if (updateErr && isMissingColumnError(updateErr)) {
      // Pre-migration fallback: the resolved_election_ids column isn't there
      // yet. Retry writing just precinct_id so the precinct (Utah) path still
      // works. The district path degrades to the pre-migration address re-geocode
      // in resolveSessionRaceIds — but ONLY if an address is present, and we no
      // longer store one, so to keep non-Utah lookups working before the operator
      // applies the migration we write address_text as a LAST-RESORT bridge here
      // and nowhere else. Once the migration runs this branch never fires.
      await supabase
        .from('users')
        .update(
          precinct
            ? { precinct_id: precinct.id }
            : { precinct_id: null, address_text: address },
        )
        .eq('id', user.id);
    } else if (updateErr) {
      console.warn('users geography update failed (non-fatal):', updateErr.message);
    }

    // Resolve + cache (state, congressional_district) so participation-rank
    // queries (migration 20260502000002_voter_invites.sql) don't have to join
    // through precincts → political_districts on every render. Idempotent:
    // only UPDATEs when the resolved values differ from what's already on the
    // row. Failure is non-fatal — a missing district join just leaves the
    // snapshot unchanged and the district-level rank is hidden in the UI.
    //
    // Only runs on the precinct path — the RPC takes a precinct_id. The
    // district path snapshots state/CD from its own point-in-polygon result
    // below.
    if (precinct) try {
      const { data: resolved, error: resolveErr } = await supabase.rpc(
        'resolve_user_state_district',
        { p_precinct_id: precinct.id },
      );

      if (resolveErr) {
        console.warn(
          'resolve_user_state_district RPC failed:',
          resolveErr.message,
        );
      } else {
        const row = Array.isArray(resolved) ? resolved[0] : resolved;
        const newState = (row?.state as string | null | undefined) ?? null;
        const newDistrict =
          (row?.congressional_district as string | null | undefined) ?? null;

        if (!row || (newState === null && newDistrict === null)) {
          console.warn(
            `No us_congressional district intersects precinct ${precinct.id}; ` +
              'leaving users.state / congressional_district untouched.',
          );
        } else if (
          newState !== (user.state ?? null) ||
          newDistrict !== (user.congressional_district ?? null)
        ) {
          await supabase
            .from('users')
            .update({
              state: newState,
              congressional_district: newDistrict,
            })
            .eq('id', user.id);
        }
      }
    } catch (snapshotErr) {
      console.warn(
        'state/congressional_district snapshot failed (non-fatal):',
        snapshotErr,
      );
    }

    // District-path state/CD snapshot: when there's no precinct, derive
    // users.state + congressional_district straight from the point-in-polygon
    // districts so participation-rank surfaces still work for non-Utah voters.
    // Non-fatal; a missing us_congressional shape just leaves the snapshot
    // untouched.
    if (!precinct && districtResult) try {
      const { districts } = districtResult;
      const cd = districts.find((d) => d.district_type === 'us_congressional');
      const FIPS_TO_CODE: Record<string, string> = {
        '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL',
        '13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME',
        '24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH',
        '34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI',
        '45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY',
      };
      const newState = cd?.state_fips ? FIPS_TO_CODE[cd.state_fips] ?? null : null;
      // Store CD as an unpadded number string (e.g. "5") to match the
      // precinct-path convention.
      const newDistrict = cd?.district_number
        ? String(parseInt(cd.district_number.replace(/\D/g, ''), 10))
        : null;
      if (
        (newState !== null || newDistrict !== null) &&
        (newState !== (user.state ?? null) ||
          newDistrict !== (user.congressional_district ?? null))
      ) {
        await supabase
          .from('users')
          .update({ state: newState, congressional_district: newDistrict })
          .eq('id', user.id);
      }
    } catch (districtSnapErr) {
      console.warn(
        'district state/CD snapshot failed (non-fatal):',
        districtSnapErr,
      );
    }
  } catch (err) {
    console.error('Ballot lookup action error:', err);
    return { error: 'An unexpected error occurred. Please try again.' };
  }

  // A1 canonical swap (REDESIGN-MAP): /guide is the canonical voter path once
  // the live provider is wired. When the guide is NOT backed by real data
  // (mock/disabled), fall back to the legacy /ballot so the funnel still works.
  // redirect() throws NEXT_REDIRECT, so it MUST stay outside the try/catch above
  // (the catch must not swallow it — see actions.test.ts).
  redirect(isGuideProviderReady() ? '/guide' : '/ballot');
}

// ---------------------------------------------------------------------------
// submitQuickMatchAction — process quick match answers
// ---------------------------------------------------------------------------

export async function submitQuickMatchAction(_answers: QuickMatchAnswers) {
  const user = await getSessionUser();
  if (!user) {
    return { error: 'No active session. Please look up your ballot first.' };
  }

  // SPI consent gate. Political preferences are Sensitive Personal
  // Information in 15+ states. This is still a legal gate even though we no
  // longer persist anything server-side: if the voter has not consented, the
  // flow must not proceed. Mirrors the gate in submitAxisAnswers below.
  // See migration 20260420000003_user_spi_consent and Legal Lens #4.
  if (!user.spi_consent_at) {
    return { error: 'spi_consent_required' };
  }

  // Opinions now live only on the device (work-order 1B). This action no
  // longer persists answers/weights or computes matches; the client writes to
  // IndexedDB and scores via the positions bundle (src/lib/device/*, fed by
  // /api/positions-bundle). We keep this as a thin no-op so any server-action
  // caller does not break, and so the SPI-consent gate above still runs. The
  // old server-side writes (users.quick_match_answers, users.weights, the
  // `matches` table, match_result_snapshots, first_match_completed_at, and the
  // inngest 'match/quick-match.completed' send) are all removed — they derived
  // from persisting the voter's opinions, which the on-device architecture
  // forbids (memory: voter-data-architecture-ondevice).
  return { success: true };
}

// ---------------------------------------------------------------------------
// submitAxisAnswers: process multivariable per-axis answers (doc 09 Part 4.1)
// ---------------------------------------------------------------------------
// The write path for the voter-facing axis Q&A (Question and Answer) flow. It
// is the multivariable sibling of submitQuickMatchAction:
//
//   1. buildVoterAxisVector turns the voter's per-axis answers into
//      axis_uid-keyed PositionVector[] (the SAME keys the candidate side uses
//      via v_axis_positions, so the two vectors overlap inside the matcher).
//   2. Those positions are written into users.quick_match_answers.positions,
//      the exact slot the existing match path reads (computeMatchesForUser reads
//      user.quick_match_answers.positions). So the rest of matching is untouched.
//   3. The voter's domains (and therefore their derived domain weights) are
//      PRESERVED from the existing quick_match_answers; we only swap the
//      positions array. If the voter has no prior domains (axis-first entry),
//      domains stays [] and deriveWeights produces the flat baseline, which is
//      the honest default until they pick priorities.
//
// We deliberately do NOT route through /api/match: that route's Zod schema
// strips unknown keys, which would drop axis_uid off every position. Writing the
// JSONB here keeps the axis keys intact end to end.
//
// match_view is carried through unchanged. Per-axis weighting (competence +
// jurisdiction salience + voter salience, doc 09 Part 3.4) is composed on the
// request path and passed to the matcher there; this action only produces the
// correctly-keyed voter vector, exactly like quick-match only produces answers.
// ---------------------------------------------------------------------------

export async function submitAxisAnswers(_answers: VoterAxisAnswer[]) {
  // NEUTRALIZED (red-team finding, 2026-07-05). This was the LAST server-side
  // opinion-write path: it persisted the voter's axis positions into
  // users.quick_match_answers.positions and the matches table. That contradicts
  // the on-device architecture (memory: voter-data-architecture-ondevice) that
  // the Phase-1 audit relies on, and it left a live server opinion-write that the
  // privacy story claimed did not exist. Matching now runs ON DEVICE via the
  // positions bundle + client matcher (src/lib/device/*, /api/positions-bundle),
  // exactly like /api/match (which is 410 Gone) and submitQuickMatchAction (a
  // no-op). We return a 'gone' marker so the legacy /axis-match page can route the
  // voter to the on-device guide instead of writing opinions to the server.
  //
  // Do NOT reintroduce the server-side write. If /axis-match needs axis Q&A, it
  // must feed answers into the device store and score in-browser, not here.
  return { error: 'gone', message: 'Axis matching moved on-device. Use the guide flow.' } as const;
}

// ---------------------------------------------------------------------------
// setVisibilityLevelAction — persist the voter's position-visibility level
// ---------------------------------------------------------------------------
// Brief B (Voter Portal). The visibility level governs which provenance tiers
// the voter SEES (stated-only / +verified / all); it never changes what is
// stored or scored. It lives inside users.quick_match_answers.visibility_level
// alongside match_view, so no migration is needed.
//
// This is a display preference, not new political data, so it does not itself
// require fresh SPI consent. We only merge it into an EXISTING
// quick_match_answers object — if the voter hasn't answered/consented yet there
// is nothing to attach it to, and the control simply stays at its default.
// ---------------------------------------------------------------------------

export async function setVisibilityLevelAction(level: VisibilityLevel) {
  if (level !== 'stated' && level !== 'verified' && level !== 'all') {
    return { error: 'Invalid visibility level.' };
  }

  const user = await getSessionUser();
  if (!user) {
    return { error: 'No active session.' };
  }

  // No prior answers means no SPI-consented JSONB to merge into. Don't create
  // one here (that would persist the political-prefs object without the consent
  // gate the other write paths enforce); just succeed and let the UI default.
  const existing = user.quick_match_answers;
  if (!existing) {
    return { success: true, persisted: false as const };
  }

  try {
    const supabase = await createClient();
    const merged: QuickMatchAnswers = { ...existing, visibility_level: level };
    const { error } = await supabase
      .from('users')
      .update({ quick_match_answers: merged })
      .eq('id', user.id);

    if (error) {
      console.error('Failed to persist visibility level:', error);
      return { error: 'Failed to save your visibility setting.' };
    }

    // Re-render the surfaces that apply the level server-side.
    revalidatePath('/results');
    revalidatePath('/guide');
    return { success: true, persisted: true as const };
  } catch (err) {
    console.error('Visibility level action error:', err);
    return { error: 'An unexpected error occurred.' };
  }
}

// ---------------------------------------------------------------------------
// submitCorrectionAction — submit a correction
// ---------------------------------------------------------------------------

export async function submitCorrectionAction(data: {
  candidate_id: string;
  position_id: string;
  submitted_by: string;
  evidence?: string | null;
}) {
  if (!data.candidate_id || !data.position_id || !data.submitted_by) {
    return { error: 'Missing required fields.' };
  }

  try {
    const supabase = await createClient();

    const { data: correction, error } = await supabase
      .from('corrections')
      .insert({
        candidate_id: data.candidate_id,
        position_id: data.position_id,
        submitted_by: data.submitted_by,
        evidence: data.evidence ?? null,
        status: 'submitted',
      })
      .select()
      .single();

    if (error) {
      console.error('Failed to insert correction:', error);
      return { error: 'Failed to submit correction.' };
    }

    return { success: true, correction };
  } catch (err) {
    console.error('Correction action error:', err);
    return { error: 'An unexpected error occurred.' };
  }
}

// ---------------------------------------------------------------------------
// submitEmailOptinAction — opt in for notifications
// ---------------------------------------------------------------------------

export async function submitEmailOptinAction(email: string) {
  if (!email || !email.includes('@')) {
    return { error: 'Please provide a valid email address.' };
  }

  try {
    const user = await getSessionUser();
    const supabase = await createClient();

    const { error } = await supabase.from('email_optins').upsert(
      {
        email,
        precinct_id: user?.precinct_id ?? null,
      },
      { onConflict: 'email' },
    );

    if (error) {
      console.error('Failed to save email opt-in:', error);
      return { error: 'Failed to save your email. Please try again.' };
    }

    // Also save email to user record if session exists
    if (user) {
      await supabase.from('users').update({ email }).eq('id', user.id);
    }

    return { success: true };
  } catch (err) {
    console.error('Email opt-in action error:', err);
    return { error: 'An unexpected error occurred.' };
  }
}

// ---------------------------------------------------------------------------
// submitFeedbackAction — submit post-election feedback
// ---------------------------------------------------------------------------

export async function submitFeedbackAction(data: {
  did_vote: boolean;
  changed_vote: 'yes' | 'no' | 'not_sure';
  races_changed?: number | null;
}) {
  const user = await getSessionUser();
  if (!user) {
    return { error: 'No active session.' };
  }

  // SPI consent gate. did_vote / changed_vote are inferences about the
  // user's political behavior — same SPI category as quick_match_answers.
  // Refuse to persist without explicit opt-in. Matches /api/match
  // (route.ts:47-56) and submitQuickMatchAction above.
  if (!user.spi_consent_at) {
    return { error: 'spi_consent_required' };
  }

  try {
    const supabase = await createClient();

    const { error } = await supabase.from('feedback_responses').insert({
      user_id: user.id,
      did_vote: data.did_vote,
      changed_vote: data.changed_vote,
      races_changed: data.races_changed ?? null,
    });

    if (error) {
      console.error('Failed to insert feedback:', error);
      return { error: 'Failed to submit feedback.' };
    }

    return { success: true };
  } catch (err) {
    console.error('Feedback action error:', err);
    return { error: 'An unexpected error occurred.' };
  }
}
