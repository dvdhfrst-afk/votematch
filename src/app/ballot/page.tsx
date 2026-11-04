import Link from "next/link";
import { redirect } from "next/navigation";
import type { RaceLevel } from "@/types/database";
import RaceCard from "@/components/ballot/RaceCard";
import { isGuideProviderReady } from "@/lib/guide/provider";
import { getSessionUser } from "@/lib/session";
import {
  loadBallot,
  loadBallotForAddress,
  type BallotRace,
} from "@/lib/ballot-lookup/ballot-loader";

// The address/precinct → BallotRace[] pipeline (v_voter_* reads, legacy↔graph
// bridge, dedup, nearest-upcoming collapse, data-quality + well-documented
// computation, BALLOT_CACHE_VERSION cache keying) lives in the shared
// `ballot-loader` module so `/ballot` and the live `/guide` provider resolve
// the SAME ballot for an address. This page only renders it.
export type { BallotRace } from "@/lib/ballot-lookup/ballot-loader";

// All six ballot levels, in the order they appear top-to-bottom on a real
// ballot (Phase 3 criterion #2). Races at any level present in the precinct's
// data now get their own section instead of being coerced into "County".
const LEVEL_ORDER: RaceLevel[] = [
  "federal",
  "state",
  "county",
  "municipal",
  "school",
  "special",
  "judicial",
];

const LEVEL_LABELS: Record<RaceLevel, string> = {
  federal: "Federal Races",
  state: "State Races",
  county: "County Races",
  municipal: "City & Town Races",
  school: "School Board Races",
  special: "Special District Races",
  judicial: "Judicial Retention",
};

export default async function BallotPage({
  searchParams,
}: {
  searchParams: Promise<{ address?: string }>;
}) {
  // A1 canonical swap (REDESIGN-MAP): /guide is the canonical voter path once
  // the live provider is wired. Redirect legacy /ballot to its guide equivalent
  // when the guide is backed by real data. This page stays intact below the gate
  // as the fallback for the mock/disabled case (do not delete it).
  if (isGuideProviderReady()) redirect("/guide");

  const params = await searchParams;
  const user = await getSessionUser();
  const address = params.address ?? user?.address_text ?? "";

  // We can render a ballot from EITHER a resolved precinct (Utah's loaded
  // precincts, which also supply precinct-level local races) OR, for any other
  // address, from the district path (point-in-polygon against
  // political_districts -> statewide + district offices). So the gate only
  // requires an address; precinct is no longer mandatory.
  if (!address) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold text-[var(--color-primary)] mb-4">
            Enter your address to see your ballot
          </h1>
          <p className="text-[var(--color-text-secondary)] mb-6 leading-relaxed">
            We use your street address to find the exact races on your ballot.
            We do not store it unless you choose to save it.
          </p>
          <Link
            href="/"
            className="civic-btn-primary inline-flex min-h-[44px] items-center justify-center px-6"
          >
            Look up my address
          </Link>
        </div>
      </main>
    );
  }

  // Precinct path (Utah early-validation coverage) when we have one; otherwise
  // the state-generic district path keyed off the address. The precinct path
  // stays authoritative where it exists because it carries precinct-level local
  // races the district path can't resolve.
  const loaded = user?.precinct_id
    ? await loadBallot(user.precinct_id)
    : await loadBallotForAddress(address);
  const races: BallotRace[] | undefined = loaded?.races;
  const quality = loaded?.quality;

  if (!races || races.length === 0) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold text-[var(--color-primary)] mb-4">
            We couldn&apos;t find races for that address
          </h1>
          <p className="text-[var(--color-text-secondary)] mb-3 leading-relaxed">
            A couple of things to try:
          </p>
          <ul className="text-left text-[var(--color-text-secondary)] mb-6 space-y-2 leading-relaxed mx-auto max-w-xs">
            <li>
              Re-enter your full street address (house number, street, city,
              and ZIP code).
            </li>
            <li>
              Use your home address, not a P.O. box or a workplace.
            </li>
          </ul>
          <p className="text-sm text-[var(--color-text-muted)] mb-6 leading-relaxed">
            If the address is correct, we may not have loaded race data for your
            area yet. We are adding jurisdictions over time. See the{" "}
            <Link href="/methodology" className="underline">
              data freshness note
            </Link>{" "}
            for where coverage stands.
          </p>
          <Link
            href="/"
            className="civic-btn-primary inline-flex min-h-[44px] items-center justify-center px-6"
          >
            Try a different address
          </Link>
        </div>
      </main>
    );
  }

  const groupedRaces = LEVEL_ORDER.map((level) => ({
    level,
    races: races.filter((r) => r.level === level),
  })).filter((g) => g.races.length > 0);

  // Council #43 (2026-05-09, time perspective): per-state countdown chip.
  // Voters landing on /ballot today see no urgency framing. ID primary
  // is 10 days out; NJ 32 days. Reuse election_date already on each race.
  const todayMs = new Date().getTime();
  const upcoming = races
    .filter((r) => r.election_date && new Date(r.election_date).getTime() >= todayMs)
    .sort((a, b) => a.election_date.localeCompare(b.election_date))[0];
  // Parse election_date as a LOCAL date. `new Date('2026-07-21')` is UTC
  // midnight, which is the previous day in US timezones — the countdown and
  // label would both show July 20 for a July 21 election.
  const electionDayLocal = upcoming
    ? new Date(`${upcoming.election_date.slice(0, 10)}T00:00:00`)
    : null;
  const daysOut = electionDayLocal
    ? Math.ceil((electionDayLocal.getTime() - todayMs) / 86_400_000)
    : null;
  const electionLabel = upcoming?.election_type === 'primary' ? 'primary' : 'election';
  const countdownClass = daysOut !== null && daysOut <= 14
    ? 'bg-red-50 text-red-900 border-red-200'
    : daysOut !== null && daysOut <= 30
      ? 'bg-amber-50 text-amber-900 border-amber-200'
      : 'bg-blue-50 text-blue-900 border-blue-200';

  return (
    <main className="min-h-screen bg-[var(--color-bg-alt)]">
      {/* Header */}
      <header className="bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="civic-container py-4 flex items-center gap-4">
          <Link
            href="/"
            className="text-xl font-bold text-[var(--color-primary)]"
          >
            Havesay
          </Link>
        </div>
      </header>

      <div className="civic-container py-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-extrabold text-[var(--color-primary)] mb-2">
            Your Ballot
          </h1>
          <p className="text-[var(--color-text-secondary)] mb-8">
            {decodeURIComponent(address)}
          </p>

          {daysOut !== null && daysOut <= 60 && upcoming && (
            <div className={`rounded-lg px-4 py-3 mb-6 text-sm font-medium border ${countdownClass}`}>
              Your next {electionLabel}: <strong>{daysOut} {daysOut === 1 ? 'day' : 'days'} away</strong>
              {' '}({(electionDayLocal as Date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}).
              Review your races before then.
              {/* Council #44 (trust): election dates are seeded best-effort and
                  may be wrong. Surface a verify-with-SoS link + corrections path
                  so the countdown is auditable, not load-bearing-on-faith. */}
              {(() => {
                const sos: Record<string, [string, string]> = {
                  '06': ['CA', 'https://www.sos.ca.gov/elections'],
                  '30': ['MT', 'https://sosmt.gov/elections/'],
                  '34': ['NJ', 'https://www.nj.gov/state/elections/'],
                  '35': ['NM', 'https://www.sos.nm.gov/voting-and-elections/'],
                  '46': ['SD', 'https://sdsos.gov/elections-voting/'],
                  '23': ['ME', 'https://www.maine.gov/sos/cec/elec/'],
                  '32': ['NV', 'https://www.nvsos.gov/sos/elections'],
                };
                const hit = upcoming.state_fips ? sos[upcoming.state_fips] : null;
                return (
                  <div className="mt-1 text-xs font-normal opacity-80">
                    Verify date with{' '}
                    {hit ? (
                      <a href={hit[1]} target="_blank" rel="noopener" className="underline">
                        {hit[0]} Secretary of State
                      </a>
                    ) : 'your state election office'}
                    {' · '}
                    <Link href="/corrections" className="underline">Report a wrong date</Link>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Council #49 (2026-05-10, voter perspective): data-state disclosure.
              Audit found candidate detail pages have a "No cited positions on
              file yet" empty state but the ballot LIST shows all candidates as
              identical rows regardless of classification status — a voter
              scanning their ballot has no signal which candidates have data.
              Per project memory: "every coverage gap becomes a voter CTA, not
              a hidden weakness." Static disclosure, no per-row queries. */}
          <div className="rounded-lg px-4 py-3 mb-6 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-secondary)]">
            <p>
              <span className="font-medium text-[var(--color-text)]">Heads up:</span>{' '}
              we&apos;re building this from scratch and many candidates are still
              being researched. Click any candidate to see what we have on file.{' '}
              <Link href="/corrections" className="underline text-[var(--color-primary)]">
                Spot a candidate that&apos;s missing or wrong? Tell us →
              </Link>
            </p>
          </div>

          {/* Race groups */}
          <div className="space-y-6">
            {groupedRaces.map(({ level, races }) => (
              <div key={level} className="space-y-4">
                <h2 className="text-lg font-bold text-[var(--color-text)]">
                  {LEVEL_LABELS[level]}
                </h2>
                {races.map((race) => (
                  <RaceCard
                    key={race.id}
                    race={race}
                    dataQuality={quality?.get(race.id)}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* CTA */}
          <div className="mt-10 text-center">
            <Link href="/quick-match" className="civic-btn-primary text-lg px-8 py-4">
              Get Personalized Matches
            </Link>
            <p className="text-[var(--color-text-muted)] text-sm mt-3">
              Answer a few quick questions. Takes about a minute.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
