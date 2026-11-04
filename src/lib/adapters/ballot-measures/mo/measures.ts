/**
 * Missouri statewide-measure adapter.
 *
 * Source: MO SoS elections portal. Pre-flight WebFetch on 2026-04-23 hit a
 * SQL-backend error page on the root (`sos.mo.gov/elections`) — the path
 * is technically live but the dynamic content pane was broken that day.
 *
 * TODO before live run: confirm the stable endpoint. MO typically
 * publishes measures at
 * `sos.mo.gov/elections/petitions/approved` (approved-for-circulation)
 * and `sos.mo.gov/elections/petitions/ballot_measures` for qualified ones.
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL = 'https://www.sos.mo.gov/elections/petitions';

export function missouriBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '29',
    stateAbbr: 'MO',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'MO SoS initiative/referendum petitions and qualified statewide ballot measures.',
    ...overrides,
  });
}
