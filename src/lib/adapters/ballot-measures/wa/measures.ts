/**
 * Washington statewide-measure adapter.
 *
 * Source: WA SoS — Proposed Ballot Measure Information. The historical
 * `voter-guide.aspx` slug now 404s (79x over 6h on 2026-04-25). The new
 * canonical page is `proposed-ballot-measure-information`, which carries
 * ballot titles, explanatory statements, fiscal impact statements, and
 * public investment impact disclosures. Initiative & referendum drilldowns
 * remain at `apps.sos.wa.gov/elections/initiatives/`. Verified 200 / 174KB
 * on 2026-04-26 by team-url-rot.
 */

import type { SourceAdapter } from '../../types';
import {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from '../base';

const DEFAULT_SOURCE_URL =
  'https://www.sos.wa.gov/elections/voters/proposed-ballot-measure-information';

export function washingtonBallotMeasuresAdapter(
  overrides?: Partial<CreateBallotMeasuresAdapterOptions>,
): SourceAdapter<BallotMeasureRow> {
  return createBallotMeasuresAdapter({
    stateFips: '53',
    stateAbbr: 'WA',
    sourceUrl: overrides?.sourceUrl ?? DEFAULT_SOURCE_URL,
    parseHint:
      'WA Voters Guide — Initiatives, Referendums, Advisory Votes with full text + fiscal impact.',
    ...overrides,
  });
}
