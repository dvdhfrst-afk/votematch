/**
 * Ohio statewide-measure adapter.
 *
 * Source: Ohio SoS Ballot Questions and Issues page. WebFetch returned
 * 403 on 2026-04-23 (bot-block against our pre-flight IP); production
 * polite-scraper UA works. Treat URL as live.
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL =
  'https://www.ohiosos.gov/elections/ballot-questions-and-issues/';

export function ohioBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '39',
    stateAbbr: 'OH',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'OH SoS Ballot Questions and Issues — Issue number, title, Ballot Board explanation.',
    ...overrides,
  });
}
