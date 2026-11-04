/**
 * Oklahoma statewide-measure adapter.
 *
 * Source: OK State Election Board — State Questions index. The historical
 * URL `oklahoma.gov/elections/statewide-ballot-measures.html` 404s; the
 * canonical replacement is `state-question-info.html` under
 * `elections/elections-results/`, which lists all qualified state questions
 * (e.g. SQ 832 on the 2026 ballot) with full ballot title text. Verified
 * 200 / 130KB on 2026-04-26 by team-url-rot.
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL =
  'https://oklahoma.gov/elections/elections-results/state-question-info.html';

export function oklahomaBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '40',
    stateAbbr: 'OK',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'OK SoS — SQ (State Question) numbered index with ballot title + gist.',
    ...overrides,
  });
}
