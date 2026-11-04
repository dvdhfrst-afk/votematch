/**
 * Device-side signal-pool CONTRIBUTION payload builder (work-order Phase 3B,
 * part 2). The pseudonymous-slot half of the pipeline.
 *
 * WHAT THIS IS: given the on-device voter profile answers and a COARSE ballot
 * geography (state + congressional district), this derives (a) the epoch SLOT
 * PSEUDONYM the device contributes under, and (b) the minimal, privacy-hardened
 * contribution PAYLOAD that would be sent to the pool. It is the device's entire
 * view of "what would I share": nothing here reads or transmits a raw score, a
 * fine-grained timestamp, or any device/session identifier.
 *
 * THE PRIVACY ALLOWLIST (the regression guard PART 5 tests):
 *   A contribution payload carries EXACTLY these fields and nothing else:
 *     - v            : payload schema version (a constant, not voter data)
 *     - state        : USPS 2-letter state of the ballot (coarse geography)
 *     - cd           : congressional district id (coarse geography, the product)
 *     - stances[]    : per-sub_dimension { subDimensionId, bucket, freshnessEpoch }
 *   NO raw scores. NO answeredAt timestamps (only a derived freshness EPOCH, week
 *   granularity). NO localId / session token / credential / device fingerprint.
 *   NO nonce, NO nullifier (those live on the TokenPresentation, not the payload).
 *
 * SLOT PSEUDONYM: derived from the credential secret via HKDF-like domain-
 * separated derivation, keyed by epoch, so it rotates every epoch (matching the
 * architecture memo's rotating-pseudonym design, D3). It uses a DISTINCT domain
 * label from the spend nullifier (crypto.deriveTokenNullifier), so a slot id and
 * a spend nullifier for the same (secret, epoch) can never collide or cross-link.
 *
 * SSR-SAFE: pure crypto over WebCrypto + inputs the caller supplies. Nothing
 * here runs at import time; nothing here touches the network (the submission
 * client in ./pool-submission.ts does the POST, with jitter).
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import {
  b64uToBytes,
  bytesToB64u,
  utf8ToBytes,
  toArrayBuffer,
  webcrypto,
} from '@/lib/signal-pool/crypto';
import { currentEpochId, epochLengthMs, EPOCH_ANCHOR_MS } from '@/lib/signal-pool/epochs';
import type { DeviceAnswer } from './types';

// ---------------------------------------------------------------------------
// Payload schema + allowlist
// ---------------------------------------------------------------------------

/**
 * Contribution payload schema version. Bump when the payload SHAPE changes so a
 * recompute can reject/upgrade older slot rows. A constant, never voter data.
 */
export const CONTRIBUTION_PAYLOAD_VERSION = 1 as const;

/**
 * Number of quantization buckets for a stance. Five buckets is the v1 design's
 * surviving display protection: a raw 0.0..1.0 score is coarsened to one of
 * {0,1,2,3,4} so the pool never holds a voter's exact position, only which
 * fifth of the spectrum they sit in. Buckets are the ONLY stance value that
 * leaves the device.
 */
export const STANCE_BUCKET_COUNT = 5 as const;

/**
 * RANDOM-SUBSET CONTRIBUTION cap (red-team finding 4 fix, 2026-07-05). A single
 * contribution carries AT MOST this many stances, a RANDOM subset of the voter's
 * answered dimensions, NOT the whole ~20-dim vector. Sending the full bucketed
 * vector into a sparse (state, cd) cell was itself a near-unique content
 * fingerprint that re-linked a device across epochs independent of pseudonym
 * rotation. A small rotating subset carries no re-linkable full-vector signature;
 * the pool still fills over time because each epoch's contribution rotates which
 * dims it covers (the daily loop + weekly epochs accumulate coverage).
 *
 * Default 4; overridable via SIGNAL_POOL_SUBSET_MAX (clamped to [1, 8]). The cap
 * is enforced in code (assertPayloadAllowlisted) so a regression that widens it
 * fails loudly at the network boundary.
 */
export const DEFAULT_SUBSET_MAX = 4 as const;
export const SUBSET_MAX_HARD_CEILING = 8 as const;

export function configuredSubsetMax(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SIGNAL_POOL_SUBSET_MAX;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) {
      return Math.min(n, SUBSET_MAX_HARD_CEILING);
    }
  }
  return DEFAULT_SUBSET_MAX;
}

/**
 * The EXACT set of top-level keys a contribution payload may contain. PART 5's
 * no-PII allowlist test asserts a built payload has precisely these keys, so a
 * future field that leaks raw data cannot slip through unnoticed. Keep this in
 * lockstep with ContributionPayload below.
 */
export const CONTRIBUTION_PAYLOAD_KEYS = ['v', 'state', 'cd', 'stances'] as const;

/** The EXACT set of keys a single stance entry may contain. */
export const CONTRIBUTION_STANCE_KEYS = [
  'subDimensionId',
  'bucket',
  'freshnessEpoch',
] as const;

/**
 * One bucketed stance in a contribution. `bucket` is in [0, STANCE_BUCKET_COUNT);
 * `freshnessEpoch` is the epoch id derived from the answer's answeredAt (week
 * granularity), so staleness decay in the recompute is epoch-vs-epoch, never a
 * fine timestamp comparison.
 */
export interface ContributionStance {
  subDimensionId: string;
  bucket: number;
  freshnessEpoch: number;
}

/**
 * The literal payload the device would send. This object IS what the opt-in
 * preview renders, byte for byte (PART 2 preview-matches-payload guarantee).
 */
export interface ContributionPayload {
  v: number;
  /** USPS 2-letter state (uppercased). Coarse geography. */
  state: string;
  /** Congressional district id for the ballot (coarse geography, the product). */
  cd: string;
  /** Per-sub_dimension bucketed stances, sorted by subDimensionId for determinism. */
  stances: ContributionStance[];
}

/** Coarse ballot geography the caller resolves from the session ballot. */
export interface CoarseGeography {
  /** USPS 2-letter state code. */
  state: string;
  /**
   * Congressional district id. The product's fidelity target. For at-large
   * states this is the at-large marker the caller supplies (e.g. 'AL' district
   * '00' or 'AL'); this module does not invent it.
   */
  cd: string;
}

// ---------------------------------------------------------------------------
// Bucketing + freshness
// ---------------------------------------------------------------------------

/**
 * Quantize a raw 0.0..1.0 score into one of STANCE_BUCKET_COUNT equal-width
 * buckets. 1.0 maps to the top bucket (not an out-of-range 5). Values are
 * clamped defensively so a malformed score can never produce a bucket outside
 * [0, STANCE_BUCKET_COUNT).
 */
export function quantizeStance(score: number): number {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));
  const bucket = Math.floor(clamped * STANCE_BUCKET_COUNT);
  return Math.min(bucket, STANCE_BUCKET_COUNT - 1);
}

/**
 * Derive the freshness EPOCH id for an answer from its ISO answeredAt. Uses the
 * same epoch anchor + length as the redemption epochs so freshness and rotation
 * share one clock. A missing/invalid timestamp yields epoch 0 (treated as
 * maximally stale by the recompute), which is the safe direction.
 */
export function freshnessEpochFor(
  answeredAt: string,
  env: Record<string, string | undefined> = process.env,
): number {
  const ms = Date.parse(answeredAt);
  if (!Number.isFinite(ms)) return 0;
  return currentEpochId(ms, epochLengthMs(env));
}

// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

/**
 * A tiny deterministic PRNG (mulberry32) so a given `subsetSeed` always selects
 * the SAME subset. This keeps the preview-matches-payload invariant intact: the
 * PoolOptIn preview and the scheduled send both call buildContributionPayload
 * with the SAME seed and get byte-identical output, while DIFFERENT seeds (a
 * fresh contribution) rotate which dims go. Not cryptographic; it only chooses
 * WHICH allowlisted dims to include, never any secret.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically pick up to `max` items from a sorted list using `seed`.
 * Fisher-Yates over a copy driven by the seeded PRNG, then re-sort the winners
 * for stable output. Same (items, max, seed) -> same subset every time.
 */
function seededSubset<T>(items: T[], max: number, seed: number): T[] {
  if (items.length <= max) return items;
  const arr = items.slice();
  const rand = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, max);
}

/**
 * Build the contribution payload from device answers + coarse geography. This is
 * the single source of truth for "what would be shared": the preview renders the
 * return value of THIS function, and the submission client sends the return value
 * of THIS function. There is no second, divergent serialization.
 *
 * RANDOM-SUBSET (finding 4 fix): the payload carries at most configuredSubsetMax
 * stances, a subset selected deterministically from `subsetSeed` so the preview
 * and the send agree byte-for-byte. Omit `subsetSeed` (or pass undefined) to get
 * the FULL vector, which is used only by tests / internal callers that need the
 * whole set; the scheduler ALWAYS passes a seed so no real contribution ever
 * ships the full vector. Enforcement lives in assertPayloadAllowlisted.
 *
 * Determinism: stances are sorted by subDimensionId so the same profile + seed
 * always produce byte-identical JSON (preview-matches-payload + idempotent
 * within-epoch overwrites).
 */
export function buildContributionPayload(params: {
  answers: Record<string, DeviceAnswer>;
  geography: CoarseGeography;
  env?: Record<string, string | undefined>;
  /** When set, ship only a deterministic subset (finding 4). Omit for the full set. */
  subsetSeed?: number;
  /** Override the subset cap (defaults to configuredSubsetMax). */
  subsetMax?: number;
}): ContributionPayload {
  const env = params.env ?? process.env;
  const all: ContributionStance[] = Object.values(params.answers)
    .map((a) => ({
      subDimensionId: a.subDimensionId,
      bucket: quantizeStance(a.score),
      freshnessEpoch: freshnessEpochFor(a.answeredAt, env),
    }))
    .sort((x, y) => (x.subDimensionId < y.subDimensionId ? -1 : x.subDimensionId > y.subDimensionId ? 1 : 0));

  let stances = all;
  if (params.subsetSeed !== undefined) {
    const max = params.subsetMax ?? configuredSubsetMax(env);
    stances = seededSubset(all, max, params.subsetSeed).sort((x, y) =>
      x.subDimensionId < y.subDimensionId ? -1 : x.subDimensionId > y.subDimensionId ? 1 : 0,
    );
  }

  return {
    v: CONTRIBUTION_PAYLOAD_VERSION,
    state: (params.geography.state ?? '').toUpperCase(),
    cd: params.geography.cd ?? '',
    stances,
  };
}

/** A fresh random subset seed (isomorphic CSPRNG, 32-bit). */
export function newSubsetSeed(): number {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return buf[0];
  }
  return Math.floor(Math.random() * 0xffffffff);
}

/**
 * Assert (in code, not just in tests) that a payload contains ONLY allowlisted
 * keys. Returns the payload unchanged when clean; throws when a stray key is
 * present. The submission client calls this right before it serializes, so a
 * regression that adds a leaky field fails loudly at the network boundary rather
 * than silently shipping PII. Idempotent + pure.
 */
export function assertPayloadAllowlisted(
  payload: ContributionPayload,
  env: Record<string, string | undefined> = process.env,
): ContributionPayload {
  const topKeys = Object.keys(payload);
  for (const k of topKeys) {
    if (!(CONTRIBUTION_PAYLOAD_KEYS as readonly string[]).includes(k)) {
      throw new Error(`contribution payload has non-allowlisted key: ${k}`);
    }
  }
  for (const s of payload.stances) {
    for (const k of Object.keys(s)) {
      if (!(CONTRIBUTION_STANCE_KEYS as readonly string[]).includes(k)) {
        throw new Error(`contribution stance has non-allowlisted key: ${k}`);
      }
    }
  }
  // RANDOM-SUBSET CAP (finding 4): a real contribution never carries the full
  // ~20-dim vector. Enforce the subset cap at the network boundary so a
  // regression that ships the whole vector fails loudly rather than silently
  // shipping a re-linkable content fingerprint.
  const cap = configuredSubsetMax(env);
  if (payload.stances.length > cap) {
    throw new Error(
      `contribution carries ${payload.stances.length} stances, exceeding the ` +
        `random-subset cap of ${cap}; refusing to ship a full-vector fingerprint.`,
    );
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Slot pseudonym derivation (distinct from the spend nullifier)
// ---------------------------------------------------------------------------

/**
 * Domain-separation label for the slot pseudonym. DISTINCT from the nullifier
 * label so a slot id and a spend nullifier derived from the SAME epoch token
 * signature are cryptographically independent and can never collide.
 */
export const SLOT_PSEUDONYM_LABEL = 'havesay-signal-pool-slot:v2:';

/**
 * The per-epoch slot pseudonym, derived FROM the epoch token signature via HKDF
 * (2026-07-05 unlinkable-redemption rework). It is NO LONGER derived from a
 * device secret: the old secret-based derivation let a server that received the
 * secret re-compute every epoch's pseudonym. The token signature is per-epoch,
 * independently blind-signed, and revealed only for its own epoch, so a
 * pseudonym derived from it rotates per epoch and is unlinkable across epochs by
 * construction. The server can recompute this from the presented signature, so
 * it never has to trust a device-supplied pseudonym.
 *
 * Distinct HKDF `info` label from the spend nullifier (which is a plain SHA-256
 * over a different label) so the slot id and the nullifier for one token can
 * never coincide.
 */
export async function deriveSlotPseudonymFromSig(
  tokenSignatureB64u: string,
): Promise<string> {
  const subtle = webcrypto().subtle;
  const ikm = toArrayBuffer(b64uToBytes(tokenSignatureB64u));
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const info = utf8ToBytes(SLOT_PSEUDONYM_LABEL);
  const salt = utf8ToBytes('havesay-signal-pool-slot-salt:v2');
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(info),
    },
    key,
    256,
  );
  return bytesToB64u(new Uint8Array(bits));
}

// Re-exported so callers importing this module have the anchor for display copy
// (e.g. "epochs are weekly windows anchored at ...") without a second import.
export { EPOCH_ANCHOR_MS };
