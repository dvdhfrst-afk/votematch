/**
 * On-device VoterProfile types — the durable, browser-resident record of a
 * voter's opinions, weights, picks, and plan (work-order 1A).
 *
 * INVARIANT (memory: voter-data-architecture-ondevice, work-order invariants
 * 1 + 3): every field in this file lives ONLY in device storage (IndexedDB).
 * None of it is ever written to the operational DB in the voter flow. The
 * server keeps public civic/candidate data + an anonymous session for ballot
 * address resolution, and nothing derived from opinions except the Phase-3
 * opt-in aggregates (built elsewhere, feature-flagged OFF).
 *
 * Shapes here are deliberately close to the existing server contracts so the
 * client match engine (match-client.ts) can reuse the pure matcher modules
 * without a translation layer:
 *   - `DeviceAnswer.subDimensionId` + `.score` map 1:1 onto
 *     `QuickMatchAnswers.positions[].{sub_dimension_id, score}`.
 *   - `chosenDomains` + derived weights map onto `deriveWeights()` input.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import type { Domain, MatchView } from '@/types/database';

/**
 * Where an answer came from. Drives future "is this still you?" nudges and the
 * Phase-2 prompt-loop streak accounting. 'quick-match' = the onboarding flow;
 * 'daily-prompt' = the question-of-the-day loop (Phase 2A).
 */
export type AnswerSource = 'quick-match' | 'daily-prompt';

/**
 * One stance the voter has taken on a sub-dimension. Keyed by
 * `subDimensionId` so the client matcher can feed it straight into
 * `weightedL1Score` as a PositionVector.
 */
export interface DeviceAnswer {
  /** sub_dimensions.id — the issue this stance is on. */
  subDimensionId: string;
  /** 0.0 (spectrum low) .. 1.0 (spectrum high). */
  score: number;
  /** ISO timestamp when the voter last set this answer. */
  answeredAt: string;
  /** How the voter arrived at this answer. */
  source: AnswerSource;
}

/**
 * The voter's own domain priority + resolved per-domain weight. `chosenDomains`
 * is the ordered top-3 (as picked in quick-match); `domainWeights` is the
 * normalized 8-domain vector that `deriveWeights()` produces from them. We
 * persist BOTH so the store is self-describing without re-running derivation,
 * but `domainWeights` is always recomputed from `chosenDomains` on save so the
 * two never drift.
 */
export interface DeviceEmphasis {
  /** Ordered top-3 domains the voter prioritized (index 0 = highest). */
  chosenDomains: Domain[];
  /** Normalized weight per domain, summing to ~1.0. Derived from chosenDomains. */
  domainWeights: Record<string, number>;
}

/**
 * A per-race candidate pick the voter has committed to (their ballot plan).
 * `candidateId` null = explicitly undecided ("decide at the booth"). Distinct
 * from "not yet visited" (no Pick row at all).
 */
export interface DevicePick {
  raceId: string;
  candidateId: string | null;
  /** ISO timestamp of the pick. */
  pickedAt: string;
  /** Optional voter note attached to this race (stays on device). */
  note?: string;
}

/**
 * Plan-level state that is not per-race: whether the voter has marked their
 * plan "ready", and any free-text booth notes. Kept small; per-race picks live
 * in `picks`.
 */
export interface DevicePlanState {
  /** Voter marked their whole plan reviewed / ready to take to the booth. */
  ready: boolean;
  /** ISO timestamp the plan was last touched. */
  updatedAt: string;
  /** Optional free-text note for the whole plan. */
  note?: string;
}

/**
 * One prompt-question the voter has seen (Phase 2A history). Persisted so the
 * daily-prompt loop never re-asks a question, can compute a streak, and can
 * weight future questions toward dims that sharpen the ballot. `answered`
 * false = shown but skipped.
 */
export interface DevicePromptHistoryEntry {
  questionId: string;
  /** The sub_dimension the question targets (for gap-weighting). */
  subDimensionId: string | null;
  /** ISO timestamp the question was shown. */
  shownAt: string;
  /** True when the voter answered it (as opposed to skipping). */
  answered: boolean;
  /** The score the voter gave, when answered. */
  score?: number;
}

/**
 * One single-show, per-epoch RFC 9474 token in the credential stockpile
 * (2026-07-05 unlinkable-redemption rework). `signature` is the finalized
 * RSA-PSS signature over the PUBLIC message epochTokenMessage(epochId, nonce).
 * The device presents ONLY this signature for its epoch; it is independent of
 * every other epoch's token and of issuance, so nothing links them.
 */
export interface EpochToken {
  /** The epoch this token authorizes exactly one contribution in. */
  epochId: number;
  /** The nonce (in [0, RATE_LIMIT_PER_EPOCH)); names the public message. */
  nonce: number;
  /**
   * The finalized issuer signature over the PREPARED epoch message (base64url).
   * The RFC 9474 Randomized suite signs prepare(msg) = random(32) || msg, so the
   * signature verifies over `prepared`, not the bare message.
   */
  signature: string;
  /**
   * The prepared message this signature is over (base64url) = random(32) prefix
   * || epochTokenMessage(epochId, nonce). Presented at redemption so the server
   * can (a) RSA-PSS-verify the signature over these exact bytes and (b) confirm
   * the suffix equals the public epoch message, binding the token to its epoch.
   * The random prefix is per-token and revealed only for this token's own epoch,
   * so it does not link across epochs.
   */
  prepared: string;
}

/**
 * The device-held anonymous credential (work-order Phase 3B, part 1; schema v2;
 * unlinkable-redemption rework 2026-07-05).
 *
 * This is Havesay's OWN blind-signature credential (RFC 9474), now a STOCKPILE
 * of single-show per-epoch tokens rather than one reusable (secret, signature).
 * Each token was issued BLIND, so the server can never link the stockpile to the
 * verification evidence that earned it, NOR link the tokens to each other. At
 * contribution the device presents ONLY the current epoch's token signature; the
 * secret that the old design leaked no longer exists. Persisted ONLY on the
 * device; it authorizes contributions but is not itself opinion data. Absent
 * (undefined) until the voter completes the issuance ceremony.
 *
 * Clearing this field is part of the device "nuke" story: a device with no
 * credential simply drops out of the next epoch's recompute.
 */
export interface DeviceCredential {
  /** The per-epoch token stockpile. One entry per covered (epoch, nonce). */
  tokens: EpochToken[];
  /** The issuer key id that minted this stockpile (for verify + rotation). */
  keyId: string;
  /** The issuer public key (SPKI, base64url) these tokens verify against. */
  issuerPublicKey: string;
  /** The blind-signature suite name that minted it (forward-compat on rotation). */
  suite: string;
  /** ISO timestamp the credential was issued/stored. */
  issuedAt: string;
}

/**
 * The full on-device voter profile. `schemaVersion` gates the migration
 * scaffold in store.ts. Everything here is opinion data and NEVER leaves the
 * device in the voter flow (the one non-opinion exception is `credential`, the
 * anonymous personhood token, which is unlinkable to identity by construction).
 */
export interface VoterProfile {
  /** Bumped by migrations. Current: 2 (added the optional `credential` slot). */
  schemaVersion: number;
  /**
   * Anonymous, device-local identifier for THIS profile. Not a server user id.
   * Generated once on first save; lets the guide contract carry a stable
   * VoterProfile.id without leaking the server session.
   */
  localId: string;
  /** Stances keyed by sub_dimension_id. */
  answers: Record<string, DeviceAnswer>;
  /** Domain priority + derived weights. Null until quick-match is done. */
  emphasis: DeviceEmphasis | null;
  /** Which position view the matcher should use. Default 'inferred'. */
  matchView: MatchView;
  /** Per-race picks keyed by raceId. */
  picks: Record<string, DevicePick>;
  /** Plan-level state. */
  plan: DevicePlanState;
  /** Prompt-question history keyed by questionId (Phase 2A). */
  promptHistory: Record<string, DevicePromptHistoryEntry>;
  /**
   * The device's anonymous signal-pool credential (schema v2). Optional: absent
   * until the voter completes the issuance ceremony, and removed on nuke. Behind
   * NEXT_PUBLIC_SIGNAL_POOL_ENABLED, so it stays undefined for everyone until the
   * flag flips.
   */
  credential?: DeviceCredential;
  /**
   * Signal-pool device state (Phase 3B, part 2): the opt-in flag + any pending
   * jittered contribution. Optional and additive; absent until the voter opts in
   * (and cleared on nuke/stop). Gated behind NEXT_PUBLIC_SIGNAL_POOL_ENABLED, so
   * it stays undefined for everyone until the flag flips. Structurally typed here
   * to avoid a types <-> submission import cycle; see pool-submission.ts
   * PoolDeviceState for the authoritative shape.
   */
  pool?: {
    optedIn: boolean;
    pending?: {
      op: 'upsert' | 'delete';
      dueAtMs: number;
      payload: unknown;
      subsetSeed?: number;
    };
    lastSentAt?: string;
  };
  /** ISO timestamp of the last write to this profile. */
  updatedAt: string;
  /** ISO timestamp the profile was first created. */
  createdAt: string;
}

/**
 * The JSON shape `exportProfile()` returns and `importProfile()` accepts. It is
 * exactly the persisted `VoterProfile` plus an envelope so a future importer can
 * detect the format. Kept separate from VoterProfile so we can evolve the
 * envelope without touching the core shape.
 */
export interface ProfileExport {
  format: 'havesay.voter-profile';
  exportedAt: string;
  profile: VoterProfile;
}
