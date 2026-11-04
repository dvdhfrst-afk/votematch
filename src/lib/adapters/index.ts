/**
 * Barrel export for the source-adapter framework.
 *
 * Usage:
 *   import { runAdapter, type SourceAdapter, createTokenBucket } from '@/lib/adapters';
 */

export * from './types';
export { runAdapter, zeroStats } from './run';
export { createTokenBucket } from './rate-limit';
export type { TokenBucket, TokenBucketOptions } from './rate-limit';
