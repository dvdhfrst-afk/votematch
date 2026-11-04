/**
 * South Dakota statewide-measure adapter.
 *
 * Source: SD SoS elections + voting index. Live (YES) on WebFetch 2026-04-23.
 * SD LRC publishes an Attorney General's Explanation document per measure;
 * the extractor picks up title + summary from the index and can follow the
 * linked AG Explanation URL on a later pass (currently one URL per run).
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL = 'https://sdsos.gov/elections-voting/';

export function southDakotaBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '46',
    stateAbbr: 'SD',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'SD SoS elections-voting — measure number, title, AG explanation link.',
    ...overrides,
  });
}
