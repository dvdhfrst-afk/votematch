/**
 * National fallback for ballot lookup.
 *
 * When PostGIS precinct lookup returns null (i.e. we don't have loaded precincts
 * for this state yet — currently everywhere outside Utah), we fall back to the
 * office-centric graph and return a state-level ballot: federal + statewide +
 * state legislature races for the address's state.
 *
 * Resolution: we reverse-geocode the lat/lng to a state FIPS via Census, then
 * query office-graph tables (offices + elections + candidacies + people) to
 * synthesize a ballot. Not precinct-accurate, but covers all 50 states day one
 * for voters outside precinct coverage.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type StateLevelRace = {
  office_id: string;
  office_name: string;
  level: string;
  election_date: string;
  candidates: Array<{
    candidacy_id: string;
    person_id: string;
    canonical_name: string;
    party: string | null;
    legacy_candidate_id: string | null;
  }>;
};

export type StateLevelBallot = {
  mode: 'state-level';
  state_fips: string;
  state_code: string;
  races: StateLevelRace[];
};

const FIPS_TO_CODE: Record<string, string> = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL',
  '13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME',
  '24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH',
  '34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI',
  '45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI',
  '56':'WY','60':'AS','66':'GU','69':'MP','72':'PR','78':'VI',
};

/**
 * Reverse-geocode lat/lng to a state FIPS code using the Census Geographies API.
 * The `current` dataset returns nested geographies including 'States' for any
 * CONUS/AK/HI/territory point. Returns null on outage or off-map point.
 */
export async function resolveStateFipsFromCoords(
  lat: number,
  lng: number,
): Promise<string | null> {
  const url =
    `https://geocoding.geo.census.gov/geocoder/geographies/coordinates` +
    `?x=${lng}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&layers=States&format=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      result?: { geographies?: { States?: Array<{ STATE?: string }> } };
    };
    const fips = data.result?.geographies?.States?.[0]?.STATE;
    return fips ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch the state-level ballot for a given FIPS code. Returns federal + state
 * races with 2026 election_date and at least one candidate. Uses service role
 * to bypass RLS on office-graph tables (public-read in practice but safer).
 */
export async function getStateLevelBallot(
  stateFips: string,
  supabase: SupabaseClient,
  options: { electionYear?: number } = {},
): Promise<StateLevelBallot | null> {
  const year = options.electionYear ?? new Date().getUTCFullYear();
  const stateCode = FIPS_TO_CODE[stateFips];
  if (!stateCode) return null;

  // Pull candidacies joined through to the containing state, limited to
  // federal + state levels (county/municipal need precinct resolution).
  const { data: cands, error } = await supabase
    .from('candidacies')
    .select(`
      id,
      person_id,
      party,
      legacy_candidate_id,
      election:elections!inner (
        id,
        election_date,
        office:offices!inner (
          id,
          canonical_name,
          level,
          jurisdiction:jurisdictions!inner ( fips_state )
        )
      ),
      person:people!inner ( canonical_name )
    `)
    .gte('election.election_date', `${year}-01-01`)
    .lte('election.election_date', `${year}-12-31`)
    .eq('election.office.jurisdiction.fips_state', stateFips)
    .in('election.office.level', ['federal', 'state']);

  if (error || !cands) return null;

  // Group candidates by office_id, keep the earliest election date per office.
  const byOffice = new Map<string, StateLevelRace>();
  for (const c of cands as unknown as Array<{
    id: string;
    person_id: string;
    party: string | null;
    legacy_candidate_id: string | null;
    election: {
      id: string;
      election_date: string;
      office: { id: string; canonical_name: string; level: string };
    };
    person: { canonical_name: string };
  }>) {
    const office = c.election.office;
    let race = byOffice.get(office.id);
    if (!race) {
      race = {
        office_id: office.id,
        office_name: office.canonical_name,
        level: office.level,
        election_date: c.election.election_date,
        candidates: [],
      };
      byOffice.set(office.id, race);
    }
    race.candidates.push({
      candidacy_id: c.id,
      person_id: c.person_id,
      canonical_name: c.person.canonical_name,
      party: c.party,
      legacy_candidate_id: c.legacy_candidate_id,
    });
  }

  // Sort: federal before state; within level, by office name.
  const races = Array.from(byOffice.values())
    .sort((a, b) => {
      if (a.level !== b.level) return a.level === 'federal' ? -1 : 1;
      return a.office_name.localeCompare(b.office_name);
    });

  return { mode: 'state-level', state_fips: stateFips, state_code: stateCode, races };
}
