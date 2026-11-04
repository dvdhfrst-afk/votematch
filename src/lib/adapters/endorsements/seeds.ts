/**
 * Seed list of newspaper editorial boards for the endorsements adapter.
 *
 * Each entry points at an editorial RSS feed and/or an endorsement index URL.
 * The adapter iterates these, fetches content, and hands candidate articles to
 * `extractEndorsements()`.
 *
 * The entries below are fictional placeholders on example.org so the adapter
 * can be exercised without contacting real publishers. Supply real seeds in a
 * deployment by replacing this list.
 *
 * Paywall policy:
 *   - `paywall: 'none'` or `'soft'`: fetch the page directly.
 *   - `paywall: 'hard'`: do not fetch directly; use an archived snapshot of
 *     `endorsement_index_url` instead.
 */

export type NewspaperPaywall = 'none' | 'soft' | 'hard';

export type NewspaperEndorsementSeed = {
  /** Kebab-case identifier, stable for logs, ingestion_runs, URLs. */
  slug: string;
  /** Display name of the paper. */
  name: string;
  /** Two-character FIPS code of the state whose endorsements this paper drives. */
  state_fips: string;
  /** Editorial-section RSS URL if the paper publishes one. */
  rss_url?: string;
  /** Landing page listing this paper's endorsements. */
  endorsement_index_url?: string;
  /** How aggressively this paper gates content. Drives the archive fallback. */
  paywall: NewspaperPaywall;
  /** True if the URL/RSS was confirmed live; false means unverified. */
  verified: boolean;
  /** Optional one-line note on unusual behavior. */
  notes?: string;
};

export const NEWSPAPER_ENDORSEMENT_SEEDS: readonly NewspaperEndorsementSeed[] = [
  {
    slug: 'example-valley-gazette',
    name: 'The Example Valley Gazette',
    state_fips: '49',
    rss_url: 'https://gazette.example.org/opinion/feed.xml',
    endorsement_index_url: 'https://gazette.example.org/opinion/endorsements',
    paywall: 'none',
    verified: false,
    notes: 'Fictional placeholder.',
  },
  {
    slug: 'sample-city-tribune',
    name: 'Sample City Tribune',
    state_fips: '08',
    rss_url: 'https://tribune.example.org/editorials/rss',
    paywall: 'soft',
    verified: false,
    notes: 'Fictional placeholder.',
  },
  {
    slug: 'placeholder-daily-record',
    name: 'Placeholder Daily Record',
    state_fips: '36',
    endorsement_index_url: 'https://record.example.org/endorsements',
    paywall: 'hard',
    verified: false,
    notes: 'Fictional placeholder; hard paywall exercises the archive path.',
  },
];

/** Filter seeds by state FIPS; pass-through when no filter is supplied. */
export function filterSeedsByState(
  seeds: readonly NewspaperEndorsementSeed[],
  stateFips: string | undefined,
): readonly NewspaperEndorsementSeed[] {
  if (!stateFips) return seeds;
  return seeds.filter((s) => s.state_fips === stateFips);
}

/** Quick count by state for diagnostic output. */
export function seedCoverageByState(
  seeds: readonly NewspaperEndorsementSeed[] = NEWSPAPER_ENDORSEMENT_SEEDS,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of seeds) {
    out[s.state_fips] = (out[s.state_fips] ?? 0) + 1;
  }
  return out;
}
