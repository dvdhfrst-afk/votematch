/**
 * California statewide-measure adapter.
 *
 * Source: California Official Voter Information Guide. Each proposition
 * ships with title, official summary, and a Legislative Analyst's Office
 * fiscal analysis. The extractor pulls all three text blocks out of the
 * SoS voter-guide (HTML; a PDF mirror exists at the same origin but we
 * prefer HTML so the shared extractor's cleaner runs).
 *
 * NOTE (2026-04-23): voterguide.sos.ca.gov is currently returning a 404
 * during our pre-flight WebFetch — the surface changes every cycle as the
 * SoS re-publishes guides per election. TODO before live run: verify and
 * update `sourceUrl` to the active-cycle index, typically something like
 * `voterguide.sos.ca.gov/propositions/` or
 * `https://www.sos.ca.gov/elections/ballot-measures/<cycle>`.
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL = 'https://voterguide.sos.ca.gov/';

export function californiaBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '06',
    stateAbbr: 'CA',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'CA Official Voter Information Guide — proposition titles, official summaries, and LAO fiscal analyses.',
    ...overrides,
  });
}
