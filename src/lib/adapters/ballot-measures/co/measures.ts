/**
 * Colorado statewide-measure adapter.
 *
 * Source: Colorado Legislative Council Blue Book. CO publishes a single
 * "fiscal note reports" index per cycle at content.leg.colorado.gov.
 * The URL structure is `publications/fiscal-note-reports-<YEAR>/`.
 *
 * Live (YES) on WebFetch verification 2026-04-23 for the 2024 cycle index.
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL =
  'https://content.leg.colorado.gov/publications/fiscal-note-reports-2024/';

export function coloradoBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '08',
    stateAbbr: 'CO',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'CO Legislative Council Blue Book — proposition titles, summaries, fiscal notes.',
    ...overrides,
  });
}
