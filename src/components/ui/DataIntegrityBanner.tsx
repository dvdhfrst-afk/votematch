/**
 * Site-wide banner that shows the current data-coverage state to voters.
 *
 * Rewritten 2026-04-25 to query the **office-centric schema**
 * (`candidacies` × `elections` × `people` × `office_tenures`) instead of the
 * legacy `candidates`/`positions` tables. The legacy query returned ~0
 * coverage in 49 states because almost every candidate row in the new world
 * lives in `people`+`candidacies`, not `candidates`. That made the banner
 * read "no candidates loaded yet" while the DB held 7K incumbents and 12K
 * candidacies.
 *
 * Definitions:
 *   - **Total** = candidacies attached to an upcoming election
 *     (`elections.election_date >= today`). If there are no upcoming
 *     elections at all (early in a cycle), fall back to the count of
 *     current officeholders (`office_tenures` where `ended_on IS NULL`)
 *     so the banner still has a meaningful denominator.
 *   - **Covered** = candidacies whose person has at least ONE voter-facing
 *     signal:
 *       (a) current officeholder tenure — incumbent's record is queryable
 *       (b) federal voting record — `people.meta.bioguide_id` is set, which
 *           means we have roll-call positions in `federal_vote_positions`
 *           (subset of (a) for federal members, but cheap to confirm)
 *       (c) classified positions — legacy `candidacies.legacy_candidate_id`
 *           appears in `positions` rows with confidence high or medium
 *
 * Strategy:
 *   1. Page distinct legacy candidate_ids from positions (high/med).
 *   2. Page distinct person_ids from current `office_tenures`.
 *   3. Page candidacies in upcoming elections, locally tally total + covered
 *      by checking each row against the two sets above (and the bioguide
 *      flag, which is read off the joined `people.meta`).
 *
 * All paging uses id-cursor (1000-row pages). PostgREST returns the
 * 1000-row default cap when you ask for a long list; trying to chunk an
 * `.in()` list of 4374 IDs silently returns 0 once the URL gets long
 * enough — that bug is exactly what burned the previous version of this
 * banner. We deliberately avoid `.in()` over large lists.
 *
 * Runs on every page render with `noStore()` (continuous-ingest progress —
 * caching defeats the point). Total budget on a warm Postgres ~1.5s for
 * the current ~12K candidacy footprint.
 *
 * Banner cases:
 *   - Total == 0: "Coming soon"
 *   - Covered == 0: "Analysis in progress"
 *   - pct < 50: "Limited coverage: N of M"
 *   - else: hidden
 */
import { unstable_noStore as noStore } from 'next/cache';
import { cookies } from 'next/headers';
import { createServiceClient } from '@/lib/supabase/server';

const PAGE_SIZE = 1000;
const MAX_PAGES = 100; // hard ceiling — protects against unbounded loops

/**
 * Council #30: when computing "today" for the upcoming-elections filter,
 * fall back to the latest US TZ (Pacific/Pago_Pago) so we never under-count
 * an election as past before its calendar date has rolled over for any
 * voter. If the user's session cookie carries a state, we use that state's
 * TZ instead.
 */
const FALLBACK_TZ_BANNER = 'Pacific/Pago_Pago';

function todayInTz(tz: string | null | undefined): string {
  const zone = tz && tz.length > 0 ? tz : FALLBACK_TZ_BANNER;
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Postal → FIPS state map. We use it to resolve the session-cookie state
 * (a 2-letter postal code) to a `jurisdictions.fips_state` value for the
 * iana_tz lookup. Includes US territories (PR/GU/VI/AS/MP) so a session
 * cookie set in Puerto Rico still picks up its TZ correctly.
 */
const POSTAL_TO_FIPS: Record<string, string> = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09',
  DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17',
  IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24',
  MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31',
  NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38',
  OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46',
  TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54',
  WI: '55', WY: '56',
  AS: '60', GU: '66', MP: '69', PR: '72', VI: '78',
};

/**
 * Read the session-cookie state (a 2-letter postal code stamped by the
 * proxy when we know the voter's location) and look up its IANA tz from
 * `jurisdictions`. Returns FALLBACK_TZ_BANNER when the cookie isn't set or
 * the row isn't loaded.
 */
async function getSessionTz(): Promise<string> {
  try {
    const cookieStore = await cookies();
    const stateCookie = cookieStore.get('bb_session_state')?.value;
    if (!stateCookie) return FALLBACK_TZ_BANNER;
    const fips = POSTAL_TO_FIPS[stateCookie.toUpperCase()];
    if (!fips) return FALLBACK_TZ_BANNER;
    const supabase = await createServiceClient();
    const { data } = await supabase
      .from('jurisdictions')
      .select('iana_tz')
      .eq('fips_state', fips)
      .not('iana_tz', 'is', null)
      .limit(1)
      .maybeSingle();
    return (data?.iana_tz as string | undefined) ?? FALLBACK_TZ_BANNER;
  } catch {
    return FALLBACK_TZ_BANNER;
  }
}

async function loadCoverage(): Promise<{ total: number; covered: number } | null> {
  // Opt out of Next.js segment cache so every page render re-queries the DB.
  // Banner reflects continuous-ingest progress; stale numbers defeat the point.
  noStore();
  try {
    // Service client bypasses RLS — banner is aggregate public info, and we
    // explicitly want the count across all candidacies regardless of session.
    // Also avoids a session-token handshake per page render.
    const supabase = await createServiceClient();
    // Council #30: compute "today" using the session-cookie state's TZ when
    // known; else default to the latest US TZ so we don't filter out an
    // election whose calendar date hasn't rolled over yet for some voters.
    const sessionTz = await getSessionTz();
    const today = todayInTz(sessionTz);

    // Step 1: distinct legacy candidate_ids with high/medium confidence
    // positions. ~250-300 rows in current DB — one or two pages.
    const positionCandidateIds = new Set<string>();
    {
      let lastId: string | null = null;
      for (let i = 0; i < MAX_PAGES; i += 1) {
        let q = supabase
          .from('positions')
          .select('id, candidate_id')
          .in('confidence', ['high', 'medium'])
          .order('id', { ascending: true })
          .limit(PAGE_SIZE);
        if (lastId) q = q.gt('id', lastId);
        const { data, error } = await q;
        if (error) break;
        const rows = (data ?? []) as Array<{ id: string; candidate_id: string }>;
        if (rows.length === 0) break;
        for (const r of rows) positionCandidateIds.add(r.candidate_id);
        lastId = rows[rows.length - 1].id;
        if (rows.length < PAGE_SIZE) break;
      }
    }

    // Step 2: people with a current officeholder tenure (incumbents).
    // ~7K rows — paged in ~7 round-trips.
    const tenuredPeople = new Set<string>();
    {
      let lastId: string | null = null;
      for (let i = 0; i < MAX_PAGES; i += 1) {
        let q = supabase
          .from('office_tenures')
          .select('id, person_id')
          .is('ended_on', null)
          .order('id', { ascending: true })
          .limit(PAGE_SIZE);
        if (lastId) q = q.gt('id', lastId);
        const { data, error } = await q;
        if (error) break;
        const rows = (data ?? []) as Array<{ id: string; person_id: string }>;
        if (rows.length === 0) break;
        for (const r of rows) tenuredPeople.add(r.person_id);
        lastId = rows[rows.length - 1].id;
        if (rows.length < PAGE_SIZE) break;
      }
    }

    // Step 3: page candidacies in upcoming elections, tally total + covered.
    // Inner-join on elections lets PostgREST push the date filter into the
    // query plan; people.meta is fetched in the same row to read bioguide.
    let total = 0;
    let covered = 0;
    {
      let lastId: string | null = null;
      for (let i = 0; i < MAX_PAGES; i += 1) {
        let q = supabase
          .from('candidacies')
          .select(
            'id, person_id, legacy_candidate_id, election:elections!inner(election_date), person:people!inner(meta)',
          )
          .gte('election.election_date', today)
          .order('id', { ascending: true })
          .limit(PAGE_SIZE);
        if (lastId) q = q.gt('id', lastId);
        const { data, error } = await q;
        if (error) break;
        const rows = (data ?? []) as Array<{
          id: string;
          person_id: string;
          legacy_candidate_id: string | null;
          person?: { meta?: { bioguide_id?: string | null } | null } | null;
        }>;
        if (rows.length === 0) break;
        for (const r of rows) {
          total += 1;
          const hasTenure = tenuredPeople.has(r.person_id);
          const hasPosition =
            r.legacy_candidate_id != null &&
            positionCandidateIds.has(r.legacy_candidate_id);
          const hasBioguide =
            r.person?.meta?.bioguide_id != null && r.person.meta.bioguide_id !== '';
          if (hasTenure || hasPosition || hasBioguide) covered += 1;
        }
        lastId = rows[rows.length - 1].id;
        if (rows.length < PAGE_SIZE) break;
      }
    }

    // Fallback: no upcoming elections yet (very early in a cycle). Use the
    // total incumbent count as the denominator so the banner has something
    // truthful to report instead of "0 candidates loaded".
    if (total === 0) {
      const { count: incumbentCount } = await supabase
        .from('office_tenures')
        .select('*', { count: 'exact', head: true })
        .is('ended_on', null);
      return {
        total: incumbentCount ?? 0,
        covered: incumbentCount ?? 0, // every incumbent has a tenure signal
      };
    }

    return { total, covered };
  } catch {
    // If the DB probe fails, signal failure so the banner can show defensively.
    return null;
  }
}

export default async function DataIntegrityBanner() {
  const coverage = await loadCoverage();
  // Failed probe → show banner defensively
  if (!coverage) {
    return (
      <DevNoticeBanner
        tag="Data status unavailable"
        text="Coverage data could not be loaded. Treat positions as provisional until this is resolved."
      />
    );
  }

  // No data at all → coming soon
  if (coverage.total === 0) {
    return (
      <DevNoticeBanner
        tag="Coming soon"
        text="Havesay has no candidates loaded yet. Check back before the 2026 primary."
      />
    );
  }
  if (coverage.covered === 0) {
    return (
      <DevNoticeBanner
        tag="Analysis in progress"
        text={`${coverage.total.toLocaleString()} candidacies loaded for upcoming elections. Position analysis has not yet started; candidate pages will show "has not stated a public position" until we ingest and classify source material.`}
      />
    );
  }
  const pct = Math.round((coverage.covered / coverage.total) * 100);
  if (pct < 50) {
    return (
      <DevNoticeBanner
        tag={`Limited coverage: ${coverage.covered.toLocaleString()} of ${coverage.total.toLocaleString()} candidacies`}
        text={`Only ${coverage.covered.toLocaleString()} (${pct}%) of candidacies in upcoming elections have a voter-facing signal (officeholder voting record, federal roll-call history, or classified positions). The remainder show "has not stated a public position"; we're still gathering source material. Verify our methodology before using matching results for voting decisions.`}
      />
    );
  }
  // Coverage is above 50%; no banner needed
  return null;
}

function DevNoticeBanner({ tag, text }: { tag: string; text: string }) {
  return (
    <div className="bg-amber-50 border-b-2 border-amber-400 text-amber-900">
      <div className="civic-container py-2 px-4 text-xs sm:text-sm flex items-start sm:items-center gap-2">
        <svg
          aria-hidden="true"
          className="w-4 h-4 shrink-0 mt-0.5 sm:mt-0"
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
        <span className="leading-snug">
          <strong>{tag}:</strong> {text}{' '}
          <a href="/methodology" className="underline font-medium whitespace-nowrap">
            Methodology
          </a>
        </span>
      </div>
    </div>
  );
}
