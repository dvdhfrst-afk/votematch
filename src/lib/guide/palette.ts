/**
 * Nonpartisan color law — the single source of truth for the guide's
 * candidate/score/agreement color rules.
 *
 * Why this file exists (WAVE-1): the design bundle encodes a hard nonpartisan
 * rule (tokens.json `nations.us.constraints`, ds-README "US color rules"):
 *
 *   · Red and blue NEVER denote candidates, parties, agreement, or lean.
 *   · Match-score bars use a SINGLE-HUE slate-indigo scale, never red-to-green.
 *   · Red is restricted to errors, destructive actions, and a thin header accent.
 *
 * The CSS variables in globals.css already carry the correct values, but a CSS
 * custom property is opaque to code — you cannot lint `var(--score-high-bar)`.
 * This module mirrors the score/candidate-neutral fill hexes as plain constants
 * so the rule becomes machine-checkable (see __tests__/palette.test.ts).
 *
 * Source of truth for the hexes:
 *   .design-bundles/ballot-bridge/project/design-system/tokens.json
 *     → base.score.{high,mid,low}.bar     (score fills)
 *     → nations.us.light.civic-primary    (navy chrome)
 *     → nations.us.light.civic-text        (candidate diamond ink)
 *
 * If tokens.json changes, update BOTH here and globals.css, then re-run the test.
 */

// ── Score-fill scale (single-hue slate-indigo) ─────────────────────────────
// These are the ONLY fills permitted on a match-score visualization
// (ScoreBar fill, ScoreChip background, MatchChip gradient). Mirrors
// tokens.json base.score.*.bar. Deliberately NOT a red-to-green ramp:
// partisan-free and colour-vision-deficiency safe.
export const SCORE_FILL_HEX = {
  high: '#2a3d6b',
  mid: '#5a658a',
  low: '#8890a3',
} as const;

// The CSS-var names the primitives actually render. Kept here so a reviewer
// can grep one file to see every token that is allowed to fill a score surface.
export const SCORE_FILL_VARS = {
  high: 'var(--score-high-bar)',
  mid: 'var(--score-mid-bar)',
  low: 'var(--score-low-bar)',
} as const;

// ── Candidate disambiguation is by SHAPE, not colour ───────────────────────
// The SpectrumBar draws the voter as a circle (navy outline) and the candidate
// as a diamond (ink fill). Neither is red or blue-as-party. These are the only
// two inks a candidate marker may use.
export const CANDIDATE_MARKER_HEX = {
  /** voter pin outline — navy chrome, reads "official" not "Democrat blue" */
  voterOutline: '#1a2f5c',
  /** candidate diamond fill — near-black ink, never a party colour */
  candidateInk: '#1a1917',
} as const;

// ── Where red IS allowed (and nowhere else) ────────────────────────────────
// Crimson-brick, deliberately not flag-red, and only for these roles.
export const RESTRICTED_ACCENT_HEX = '#8b2e2e';
export const RESTRICTED_ACCENT_ROLES = [
  'error',
  'destructive-action',
  'thin-header-accent',
] as const;

// ── Lint helper: reject red or green hues on score/candidate surfaces ───────

/** Parse a #rrggbb string into [r,g,b] 0-255. Returns null if not a hex. */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Hue of a hex colour in degrees (0-360), or null for achromatic greys.
 * Red ≈ 0/360, green ≈ 120, blue ≈ 240.
 */
export function hueOf(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma < 0.04) return null; // effectively grey — no partisan hue
  let h: number;
  if (max === r) h = ((g - b) / chroma) % 6;
  else if (max === g) h = (b - r) / chroma + 2;
  else h = (r - g) / chroma + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

/**
 * True if a colour reads as a "partisan" red or green — the two hue families
 * banned from score and candidate-agreement surfaces. Slate-indigo (hue ~215-230)
 * and navy pass; crimson-brick error accents and any green fail.
 *
 * Bands (generous, to catch near-misses):
 *   red   : hue < 20 OR hue > 340
 *   green : 80 <= hue <= 170
 */
export function isPartisanHue(hex: string): boolean {
  const h = hueOf(hex);
  if (h === null) return false; // grey is always safe
  const isRed = h < 20 || h > 340;
  const isGreen = h >= 80 && h <= 170;
  return isRed || isGreen;
}

/**
 * Assert that every colour used on match-score fills is nonpartisan.
 * Throws with a descriptive message on violation. Call in tests or a lint step.
 */
export function assertScoreFillsNonpartisan(
  fills: Record<string, string> = SCORE_FILL_HEX,
): void {
  for (const [tier, hex] of Object.entries(fills)) {
    if (isPartisanHue(hex)) {
      throw new Error(
        `Nonpartisan color law violation: score fill "${tier}" = ${hex} ` +
          `resolves to a red/green partisan hue (${hueOf(hex)?.toFixed(0)}°). ` +
          `Score fills must be single-hue slate-indigo.`,
      );
    }
  }
}
