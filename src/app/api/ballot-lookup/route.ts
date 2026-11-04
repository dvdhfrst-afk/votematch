import { NextRequest, NextResponse } from 'next/server';
import { lookupBallot } from '@/lib/ballot-lookup';
import { createClient } from '@/lib/supabase/server';
import { getOrCreateSession, setSessionCookieOnResponse } from '@/lib/session';

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address');

  if (!address || address.trim().length === 0) {
    return NextResponse.json(
      { error: 'Missing required query parameter: address' },
      { status: 400 },
    );
  }

  try {
    const supabase = await createClient();

    // Look up full ballot (geocode → precinct → races + candidates)
    // lookupBallot handles geocoding, precinct lookup, and caching internally
    const ballotResult = await lookupBallot(address, supabase);
    if (!ballotResult) {
      return NextResponse.json(
        { error: 'Could not find ballot data for that address. Please check the address and try again.' },
        { status: 404 },
      );
    }
    if ('error' in ballotResult) {
      // Territory address (council #9): Census Geocoder + Nominatim both
      // failed for PR/VI/GU/MP/AS. Return a 422-style structured error
      // the UI can route on to a jurisdiction-selector flow.
      return NextResponse.json(
        {
          error: 'territory_address_unsupported',
          state_fips: ballotResult.state_fips,
          territory: ballotResult.abbr,
          message:
            'Automatic ballot lookup is not yet available for this territory. Please choose your jurisdiction manually.',
        },
        { status: 422 },
      );
    }

    // Create or update user session
    const { user, token, isNew } = await getOrCreateSession();

    // PRIVACY: persist ONLY the resolved precinct (geography), never the raw
    // address. "Your address is not stored on our servers" + the on-device
    // architecture forbid writing address_text. This endpoint only ever resolves
    // a precinct (lookupBallot is precinct-only), so precinct_id is sufficient
    // for the ballot to re-render.
    await supabase
      .from('users')
      .update({ precinct_id: ballotResult.precinct_id })
      .eq('id', user.id);

    // Build response
    const response = NextResponse.json(ballotResult);

    if (isNew) {
      setSessionCookieOnResponse(response, token);
    }

    return response;
  } catch (err) {
    console.error('Ballot lookup error:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.' },
      { status: 500 },
    );
  }
}
