/**
 * Florida legislator-votes adapter (FIPS 12).
 *
 * Source: flsenate.gov (Senate) + flhouse.gov / myfloridahouse.gov (House)
 *
 * Florida does not publish a comprehensive bulk XML feed for roll calls.
 * The Senate and House each publish per-bill vote detail pages in HTML.
 * The Senate's Public Records page (flsenate.gov/Reference/PublicRecords)
 * documents ad-hoc record requests but no live API.
 *
 * Status: TODO — skeleton parser returns [] for now. We'll circle back when
 * the per-bill HTML structure is reverse-engineered, or when a third-party
 * aggregator (LegiScan) becomes the interim source.
 *
 * This skeleton still composes a runnable adapter so the CLI dispatcher can
 * include FL without skipping — it will simply emit zero rows and the run
 * classifies as 'partial' (but expectedMinRows=0 so it remains 'success').
 */

import {
  createStateVotesAdapter,
  type StateLegVoteRow,
  type StateVotesFetchResult,
} from '../base';
import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';

export const FL_STATE_FIPS = '12';
export const FL_STATE_ABBR = 'FL';

const DEFAULT_URL = 'https://www.flsenate.gov/';

// ---------------------------------------------------------------------------
// Parser — skeleton
// ---------------------------------------------------------------------------

/**
 * Placeholder — returns []. Real implementation needs to walk the per-bill
 * vote detail page from flsenate.gov and flhouse.gov.
 *
 * When implemented, the signature should take a bill identifier + chamber
 * similar to the Ohio adapter so the caller can walk bills in a manifest.
 */
export function parseFloridaLegVotes(_body: string): StateLegVoteRow[] {
  // TODO(state-votes-fl): flesh out parser against real fixture.
  return [];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type FlVotesAdapterOptions = {
  sourceUrl?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateVotesFetchResult>;
};

export function createFlVotesAdapter(opts: FlVotesAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateVotesAdapter({
    stateFips: FL_STATE_FIPS,
    stateAbbrev: FL_STATE_ABBR,
    sourceName: 'fl-leg-votes',
    sourceUrl: url,
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    fetch:
      opts.fetchImpl ??
      (async () => {
        const res = await politeFetch(url, {
          headers: { Accept: 'text/html' },
        });
        if (!res.ok) {
          throw new Error(`fl-leg-votes: HTTP ${res.status} for ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) => parseFloridaLegVotes(body),
  });
}
