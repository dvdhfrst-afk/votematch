/**
 * Barrel for the 14-state ballot-measure adapter collection + the factory.
 *
 * Each per-state export returns a runnable {@link SourceAdapter} keyed on
 * `ballot-measures-<abbr>`. Hand these to `runAdapter()` from
 * `src/lib/adapters/run.ts`, or dispatch via `scripts/ingest-ballot-measures.ts`.
 */

export {
  createBallotMeasuresAdapter,
  type BallotMeasureRow,
  type CreateBallotMeasuresAdapterOptions,
} from './base';

export { californiaBallotMeasuresAdapter } from './ca/measures';
export { coloradoBallotMeasuresAdapter } from './co/measures';
export { oregonBallotMeasuresAdapter } from './or/measures';
export { washingtonBallotMeasuresAdapter } from './wa/measures';
export { missouriBallotMeasuresAdapter } from './mo/measures';
export { arizonaBallotMeasuresAdapter } from './az/measures';
export { oklahomaBallotMeasuresAdapter } from './ok/measures';
export { northDakotaBallotMeasuresAdapter } from './nd/measures';
export { southDakotaBallotMeasuresAdapter } from './sd/measures';
export { montanaBallotMeasuresAdapter } from './mt/measures';
export { nebraskaBallotMeasuresAdapter } from './ne/measures';
export { michiganBallotMeasuresAdapter } from './mi/measures';
export { ohioBallotMeasuresAdapter } from './oh/measures';
export { floridaBallotMeasuresAdapter } from './fl/measures';

import type { SourceAdapter } from '../types';
import type { BallotMeasureRow } from './base';
import { californiaBallotMeasuresAdapter } from './ca/measures';
import { coloradoBallotMeasuresAdapter } from './co/measures';
import { oregonBallotMeasuresAdapter } from './or/measures';
import { washingtonBallotMeasuresAdapter } from './wa/measures';
import { missouriBallotMeasuresAdapter } from './mo/measures';
import { arizonaBallotMeasuresAdapter } from './az/measures';
import { oklahomaBallotMeasuresAdapter } from './ok/measures';
import { northDakotaBallotMeasuresAdapter } from './nd/measures';
import { southDakotaBallotMeasuresAdapter } from './sd/measures';
import { montanaBallotMeasuresAdapter } from './mt/measures';
import { nebraskaBallotMeasuresAdapter } from './ne/measures';
import { michiganBallotMeasuresAdapter } from './mi/measures';
import { ohioBallotMeasuresAdapter } from './oh/measures';
import { floridaBallotMeasuresAdapter } from './fl/measures';

/** Registry keyed by two-letter postal code. Used by the CLI dispatcher. */
export const BALLOT_MEASURES_ADAPTERS: Record<
  string,
  () => SourceAdapter<BallotMeasureRow>
> = {
  CA: californiaBallotMeasuresAdapter,
  CO: coloradoBallotMeasuresAdapter,
  OR: oregonBallotMeasuresAdapter,
  WA: washingtonBallotMeasuresAdapter,
  MO: missouriBallotMeasuresAdapter,
  AZ: arizonaBallotMeasuresAdapter,
  OK: oklahomaBallotMeasuresAdapter,
  ND: northDakotaBallotMeasuresAdapter,
  SD: southDakotaBallotMeasuresAdapter,
  MT: montanaBallotMeasuresAdapter,
  NE: nebraskaBallotMeasuresAdapter,
  MI: michiganBallotMeasuresAdapter,
  OH: ohioBallotMeasuresAdapter,
  FL: floridaBallotMeasuresAdapter,
};
