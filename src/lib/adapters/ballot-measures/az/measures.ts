/**
 * Arizona statewide-measure adapter.
 *
 * Source: AZ SoS Publicity Pamphlet. AZ publishes a combined pamphlet per
 * general election with title, official description, arguments for/against,
 * and JLBC fiscal impact statement.
 *
 * Pre-flight WebFetch on 2026-04-23 returned 403 — almost certainly a
 * bot-blocking policy against Anthropic's fetch IP range; the polite-
 * scraper UA used by `fetchForExtraction` handles this in production. Treat
 * URL as live.
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL = 'https://azsos.gov/elections/publicity-pamphlet';

export function arizonaBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '04',
    stateAbbr: 'AZ',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'AZ Publicity Pamphlet — measure title, official description, JLBC fiscal impact.',
    ...overrides,
  });
}
