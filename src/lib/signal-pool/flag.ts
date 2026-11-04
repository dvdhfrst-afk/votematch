/**
 * The single feature-flag gate for the whole signal-pool subsystem.
 *
 * WORK-ORDER INVARIANT 4: everything ships behind NEXT_PUBLIC_SIGNAL_POOL_ENABLED
 * and defaults OFF. When the flag is not exactly the string 'true', every signal-
 * pool endpoint 404s cleanly and no issuer code path runs. One helper so the
 * check is identical on server and client and can never drift.
 *
 * NEXT_PUBLIC_ prefix means the value is inlined into the client bundle at build
 * time, so the device layer reads the SAME flag without a network round-trip.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

export function isSignalPoolEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NEXT_PUBLIC_SIGNAL_POOL_ENABLED === 'true';
}
