/**
 * Montana statewide-measure adapter.
 *
 * Source: MT SoS past elections + ballot measures archive at
 * sosmt.gov/Elections/Past-Elections-and-Ballot-Measures/. Pre-flight
 * WebFetch returned 403 (likely bot-block against our fetcher IP; the
 * polite-scraper UA used by `fetchForExtraction` works in production).
 * Treat URL as live.
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL =
  'https://sosmt.gov/Elections/Past-Elections-and-Ballot-Measures/';

export function montanaBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '30',
    stateAbbr: 'MT',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'MT SoS ballot measures archive — Initiative (I-), Legislative Referendum (LR-), Constitutional Initiative (CI-).',
    ...overrides,
  });
}
