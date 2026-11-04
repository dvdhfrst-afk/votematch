/**
 * Florida statewide-measure adapter.
 *
 * Source: FL Div. of Elections constitutional amendments & initiatives
 * index. Historical URL
 * `dos.fl.gov/elections/laws-rules/constitutional-amendments-initiatives`
 * (with hyphen between "amendments" and "initiatives") returned 404 — FL
 * dropped the hyphen. Verified 200 / 31KB on 2026-04-26 by team-url-rot.
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL =
  'https://dos.fl.gov/elections/laws-rules/constitutional-amendmentsinitiatives/';

export function floridaBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '12',
    stateAbbr: 'FL',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'FL Div. of Elections constitutional amendments & initiatives index.',
    ...overrides,
  });
}
