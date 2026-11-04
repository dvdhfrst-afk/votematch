/**
 * Michigan statewide-measure adapter.
 *
 * Source: MI SoS Board of State Canvassers (BSC) — the BSC is the body
 * responsible for canvassing state-level ballot proposal petitions and
 * adopting ballot language. The historical
 * `michigan.gov/sos/elections/ballot-measures` slug 404s in production
 * (37x over 6h on 2026-04-25). The BSC page indexes upcoming proposals,
 * petition status, and 2026 measure activity. Verified 200 / 370KB on
 * 2026-04-26 by team-url-rot.
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL =
  'https://www.michigan.gov/sos/elections/bsc';

export function michiganBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '26',
    stateAbbr: 'MI',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'MI SoS ballot-measures index — Proposal number, title, 100-word summary.',
    ...overrides,
  });
}
