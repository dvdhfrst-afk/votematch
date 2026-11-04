/**
 * Oregon statewide-measure adapter.
 *
 * Source: Oregon SoS Voters' Pamphlet. OR's historical URL has been
 * `sos.oregon.gov/elections/Pages/votersguide.aspx` but the SoS site
 * redesigned post-2024; the pre-flight WebFetch on that URL returned a
 * 404 ("That Trail's Gone Cold!") on 2026-04-23.
 *
 * TODO before live run: update `sourceUrl` to the active-cycle index,
 * typically under `sos.oregon.gov/elections/Pages/voters-guide-2026.aspx`
 * (exact slug changes every cycle).
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL =
  'https://sos.oregon.gov/elections/Pages/votersguide.aspx';

export function oregonBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '41',
    stateAbbr: 'OR',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'OR Voters Pamphlet — measure title, ballot title, summary, impartial analysis, fiscal impact.',
    ...overrides,
  });
}
