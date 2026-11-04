// ---------------------------------------------------------------------------
// ANES party-identification battery (self-reported partisanship).
//
// Replaces the earlier ad hoc 1-5 "political lean" slider (operator, 2026-07:
// "rudimentary and unresearched"). This is the standard branching instrument
// used by the American National Election Studies (ANES) time series since
// 1952 to place respondents on the canonical 7-point party-identification
// scale used throughout political-science survey research (see Campbell,
// Converse, Miller & Stokes, "The American Voter", 1960; ANES Guide to
// Public Opinion and Electoral Behavior, table 2a.1 "Party Identification
// 7-Point Scale"). Two questions, branched:
//
//   Q1  Party self-identification: "Generally speaking, do you usually think
//       of yourself as a Democrat, a Republican, an Independent, or
//       something else?" (Democrat / Republican / Independent / something
//       else / no preference)
//   Q2a (asked ONLY if Q1 = Democrat or Republican) strength: "Would you call
//       yourself a strong [party] or a not very strong [party]?"
//   Q2b (asked ONLY if Q1 = Independent / something else / no preference)
//       lean: "Do you think of yourself as closer to the Democratic Party or
//       the Republican Party?" (closer to Democratic / closer to Republican
//       / neither)
//
// We store BOTH raw branch answers AND the derived 7-point code, so
// re-analysis never depends on deriveAnesPartyId7() staying byte-identical
// over time.
//
// Pure module, safe to import from both server (actions.ts) and client
// (LabelingClient.tsx) components, the same convention as bands.ts.
// ---------------------------------------------------------------------------

export type PartyIdQ1 =
  | "democrat"
  | "republican"
  | "independent"
  | "something_else"
  | "no_preference";

export type PartyIdQ2Strength = "strong" | "not_very_strong";

export type PartyIdQ2Lean = "closer_democratic" | "closer_republican" | "neither";

/** The standard ANES 7-point party-identification scale. */
export type PartyId7 =
  | "strong_democrat"
  | "weak_democrat"
  | "independent_lean_democrat"
  | "independent"
  | "independent_lean_republican"
  | "weak_republican"
  | "strong_republican";

export const PARTY_ID_Q1_OPTIONS: ReadonlyArray<{ value: PartyIdQ1; label: string }> = [
  { value: "democrat", label: "Democrat" },
  { value: "republican", label: "Republican" },
  { value: "independent", label: "Independent" },
  { value: "something_else", label: "Something else" },
  { value: "no_preference", label: "No preference" },
];

export const PARTY_ID_Q2_STRENGTH_OPTIONS: ReadonlyArray<{ value: PartyIdQ2Strength; label: string }> = [
  { value: "strong", label: "Strong" },
  { value: "not_very_strong", label: "Not very strong" },
];

export const PARTY_ID_Q2_LEAN_OPTIONS: ReadonlyArray<{ value: PartyIdQ2Lean; label: string }> = [
  { value: "closer_democratic", label: "Closer to the Democratic Party" },
  { value: "closer_republican", label: "Closer to the Republican Party" },
  { value: "neither", label: "Neither" },
];

export const PARTY_ID_7_LABELS: Record<PartyId7, string> = {
  strong_democrat: "Strong Democrat",
  weak_democrat: "Weak (not very strong) Democrat",
  independent_lean_democrat: "Independent, leans Democrat",
  independent: "Independent",
  independent_lean_republican: "Independent, leans Republican",
  weak_republican: "Weak (not very strong) Republican",
  strong_republican: "Strong Republican",
};

export function isPartyIdQ1(v: unknown): v is PartyIdQ1 {
  return (
    v === "democrat" ||
    v === "republican" ||
    v === "independent" ||
    v === "something_else" ||
    v === "no_preference"
  );
}

export function isPartyIdQ2Strength(v: unknown): v is PartyIdQ2Strength {
  return v === "strong" || v === "not_very_strong";
}

export function isPartyIdQ2Lean(v: unknown): v is PartyIdQ2Lean {
  return v === "closer_democratic" || v === "closer_republican" || v === "neither";
}

/** True when Q1 branches to the strength follow-up (2a) instead of the lean follow-up (2b). */
export function partyIdNeedsStrength(q1: PartyIdQ1 | null): boolean {
  return q1 === "democrat" || q1 === "republican";
}

/** Derive the standard ANES 7-point party-ID code from the two branched raw answers. */
export function deriveAnesPartyId7(
  q1: PartyIdQ1 | null,
  q2Strength: PartyIdQ2Strength | null,
  q2Lean: PartyIdQ2Lean | null,
): PartyId7 | null {
  if (q1 === "democrat") {
    if (q2Strength === "strong") return "strong_democrat";
    if (q2Strength === "not_very_strong") return "weak_democrat";
    return null;
  }
  if (q1 === "republican") {
    if (q2Strength === "strong") return "strong_republican";
    if (q2Strength === "not_very_strong") return "weak_republican";
    return null;
  }
  if (q1 === "independent" || q1 === "something_else" || q1 === "no_preference") {
    if (q2Lean === "closer_democratic") return "independent_lean_democrat";
    if (q2Lean === "closer_republican") return "independent_lean_republican";
    if (q2Lean === "neither") return "independent";
    return null;
  }
  return null;
}
