/**
 * Nebraska statewide-measure adapter.
 *
 * Source: NE SoS Current Petitions in Circulation. Historical URL
 * `sos.nebraska.gov/elections/initiatives-and-referendums` 404s — the
 * Drupal-10 redesign moved the page to `current-petitions-circulation`,
 * which now lists every active 2026 petition (petition title, sponsor,
 * signatures collected). Verified 200 / 42KB on 2026-04-26 by team-url-rot.
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL =
  'https://sos.nebraska.gov/current-petitions-circulation';

export function nebraskaBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '31',
    stateAbbr: 'NE',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'NE SoS Initiatives & Referendums — petition title, sponsor, signatures collected.',
    ...overrides,
  });
}
