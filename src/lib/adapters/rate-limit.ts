/**
 * In-memory token bucket rate limiter.
 *
 * Used by {@link SourceAdapter.run} implementations to throttle outbound
 * requests (SoS portals, geocoders, FEC, etc.). The runner does NOT
 * auto-wrap adapter.run() — it's a helper that adapters opt into so they
 * can pick where to await between fetches.
 *
 * Why in-memory: adapters run inside a single process. Fleet-wide rate
 * limiting (across multiple workers hitting the same endpoint) is handled
 * at the infrastructure layer (Inngest concurrency, per-adapter pg
 * advisory lock) — this is just a local smoothing layer to avoid burst
 * 429s on a single run.
 */

export type TokenBucketOptions = {
  /** Requests per second sustained rate (tokens added per second). */
  rps: number;
  /** Maximum bucket depth; bursts up to this many before throttling. */
  burst: number;
};

export type TokenBucket = {
  /** Resolves when a token is available and reserved. */
  acquire(): Promise<void>;
  /** Inspect remaining tokens without consuming (for logging). */
  available(): number;
};

/**
 * Build a token bucket. Tokens regenerate at {@link TokenBucketOptions.rps}
 * per second up to {@link TokenBucketOptions.burst}; acquire() waits the
 * exact fractional-second delay needed to reach 1 token when the bucket is
 * empty, so there is no polling loop.
 *
 * Example:
 *   const bucket = createTokenBucket({ rps: 5, burst: 10 });
 *   for (const url of urls) {
 *     await bucket.acquire();
 *     await fetch(url);
 *   }
 */
export function createTokenBucket(opts: TokenBucketOptions): TokenBucket {
  if (opts.rps <= 0) throw new Error('rps must be > 0');
  if (opts.burst <= 0) throw new Error('burst must be > 0');

  let tokens = opts.burst;
  let lastRefill = Date.now();

  // Single-reader queue so concurrent acquire() calls are serialised and
  // each sees a deterministic wait time. Without the queue, two callers
  // could both observe tokens=0, both compute the same wait, and both
  // wake to find only one token.
  let chain: Promise<void> = Promise.resolve();

  const refill = () => {
    const now = Date.now();
    const elapsedSec = (now - lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    const add = elapsedSec * opts.rps;
    tokens = Math.min(opts.burst, tokens + add);
    lastRefill = now;
  };

  return {
    async acquire() {
      const next = chain.then(async () => {
        refill();
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        // Need (1 - tokens) tokens worth of time.
        const deficit = 1 - tokens;
        const waitMs = Math.ceil((deficit / opts.rps) * 1000);
        await new Promise((r) => setTimeout(r, waitMs));
        refill();
        // After waiting, consume. Floor at 0 for float-safety.
        tokens = Math.max(0, tokens - 1);
      });
      chain = next.catch(() => undefined);
      return next;
    },
    available() {
      refill();
      return tokens;
    },
  };
}
