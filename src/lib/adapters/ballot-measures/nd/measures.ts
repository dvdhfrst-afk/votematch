/**
 * North Dakota statewide-measure adapter.
 *
 * Source: ND Voter Information Portal (vip.sos.nd.gov). Hosts the
 * statewide-measure list per election. Live (YES) on WebFetch 2026-04-23.
 *
 * ND-specific: the measures page is often an ASP.NET POSTback page; the
 * shared extractor's HTML-strip pipeline still pulls out the title +
 * summary text blocks reliably.
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL = 'https://vip.sos.nd.gov/';

export function northDakotaBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '38',
    stateAbbr: 'ND',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'ND VIP — measure number, title, one-sentence summary, election date.',
    ...overrides,
  });
}
