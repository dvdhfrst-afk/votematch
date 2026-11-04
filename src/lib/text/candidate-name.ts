/**
 * Candidate display-name formatter (pure, render-layer only).
 *
 * Candidate names reach the app in several raw shapes:
 *   - FEC / voter-file style:   "SAMPLETON, EDGAR J MR"
 *                               "EXAMPLAR, GRANT ROBERT DR. JR."
 *   - all-caps first-last:      "JORDAN TESTWOOD", "RICK MCFAKERTY"
 *   - already-clean nickname:   'Hollace "Holly" Testwood'
 *   - suffixes:                 "John R. Fixture IV", "Thomas Sample II"
 *   - particled surnames:       "Kit O'Fakerty", "MARLA FIXTURE-WOODS",
 *                               "BRIAN A DEL EXEMPIO"
 *
 * `formatCandidateName` normalizes all of these to a single presentation form:
 *   "First [Middle] Last[, Suffix]"
 * title-cased, honorifics stripped, quoted nicknames preserved, Mc/Mac/O'/
 * hyphenated capitalization corrected, and recognized suffixes (Jr./Sr./II...)
 * kept and re-formatted.
 *
 * This is a DISPLAY transform only. It never mutates stored data; callers apply
 * it at the point a name is rendered. It is intentionally conservative: when a
 * token is ambiguous it prefers leaving the name readable over guessing.
 */

/** Honorific prefixes that carry no identity and are dropped from display. */
const HONORIFICS = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
  "sir",
  "hon",
  "rev",
  "prof",
]);

/**
 * Generational / professional suffixes we keep. Map from the normalized
 * (lowercase, dot-stripped) token to the canonical display spelling. Roman
 * numerals are upper-cased; jr/sr become "Jr."/"Sr.".
 */
const SUFFIXES: Record<string, string> = {
  jr: "Jr.",
  sr: "Sr.",
  ii: "II",
  iii: "III",
  iv: "IV",
  v: "V",
  vi: "VI",
};

/**
 * Lowercase surname particles that stay lowercased inside a name (unless they
 * lead the surname, where they get capitalized for readability). Kept small and
 * conservative — only the unambiguous ones.
 */
const LOWERCASE_PARTICLES = new Set([
  "de",
  "del",
  "della",
  "der",
  "di",
  "da",
  "van",
  "von",
  "la",
  "le",
  "du",
  "dos",
  "das",
]);

function stripDots(token: string): string {
  return token.replace(/\./g, "");
}

function normalizeToken(token: string): string {
  return stripDots(token).toLowerCase();
}

function isHonorific(token: string): boolean {
  return HONORIFICS.has(normalizeToken(token));
}

function suffixDisplay(token: string): string | null {
  return SUFFIXES[normalizeToken(token)] ?? null;
}

/**
 * Title-case a single name token, correcting the common particle patterns:
 *   - Mc/Mac prefixes:  "mcfakerty" -> "McFakerty", "macdonald" -> "MacDonald"
 *   - O'/D' prefixes:   "o'brien" -> "O'Brien"
 *   - hyphenated parts: "fixture-woods" -> "Fixture-Woods"
 *   - quoted nicknames: '"holly"' -> '"Holly"'
 *
 * Tokens already containing internal capitals in a plausible position (e.g.
 * "DeVries", "McKenna") are respected when the input is NOT all-caps; when the
 * whole token is all-caps we always recompute so "MCFAKERTY" is fixed.
 */
function titleCaseToken(rawToken: string): string {
  if (!rawToken) return rawToken;

  // Preserve and recurse into a wrapping quote pair (nickname): "Holly".
  const quoteMatch = rawToken.match(/^(['"])(.*)\1$/);
  if (quoteMatch) {
    const [, quote, inner] = quoteMatch;
    return `${quote}${titleCaseToken(inner)}${quote}`;
  }

  // Hyphenated compound: title-case each part.
  if (rawToken.includes("-")) {
    return rawToken
      .split("-")
      .map((p) => titleCaseToken(p))
      .join("-");
  }

  // Apostrophe particle (O'Brien, D'Angelo). Capitalize both sides.
  const apos = rawToken.match(/^([A-Za-z]+)(['’])([A-Za-z].*)$/);
  if (apos) {
    const [, head, mark, tail] = apos;
    // Only treat as a particle when the head is short (O, D, L, Mc-like).
    if (head.length <= 2) {
      return `${cap(head)}${mark}${cap(tail)}`;
    }
  }

  const lower = rawToken.toLowerCase();

  // Mc / Mac prefixes -> capitalize the letter after the prefix too.
  if (/^mc[a-z]/.test(lower)) {
    return "Mc" + cap(lower.slice(2));
  }
  if (/^mac[a-z]{2,}/.test(lower)) {
    // Only when what follows is a plausible surname stem (avoid "Mack").
    return "Mac" + cap(lower.slice(3));
  }

  return cap(lower);
}

/** Capitalize the first alphabetic character, lowercase the rest. */
function cap(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Title-case a run of given-name / surname tokens, honoring lowercase
 * particles in interior position and correcting particle capitalization.
 */
function titleCaseNameParts(tokens: string[]): string[] {
  return tokens.map((tok, i) => {
    const norm = normalizeToken(tok);
    // A lowercase particle (van, de, del, von...) stays lowercased whenever it
    // is FOLLOWED by another token in this run, so "DEL EXEMPIO" -> "del
    // Exempio". A trailing/standalone token that happens to match a particle is
    // still title-cased (it's acting as a real surname, not a particle).
    if (i < tokens.length - 1 && LOWERCASE_PARTICLES.has(norm)) {
      return norm;
    }
    return titleCaseToken(tok);
  });
}

/**
 * Format a raw candidate name for display.
 *
 * Handles two structural inputs:
 *   (a) "LAST, FIRST [MIDDLE...] [HONORIFIC] [SUFFIX]" (comma present)
 *   (b) "FIRST [MIDDLE...] LAST [SUFFIX]"              (no comma)
 *
 * Always returns "First [Middle] Last[, Suffix]" with honorifics removed.
 * Empty / whitespace-only input returns "".
 */
export function formatCandidateName(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";

  const hasComma = trimmed.includes(",");

  let given: string[];
  let surname: string[];
  let suffix: string | null = null;

  if (hasComma) {
    // "LAST, FIRST MIDDLE HONORIFIC SUFFIX"
    const [lastRaw, restRaw = ""] = splitOnFirstComma(trimmed);
    let lastTokens = lastRaw.trim().split(" ").filter(Boolean);
    let restTokens = restRaw.trim().split(" ").filter(Boolean);

    // A recognized suffix usually trails the given-name run ("... JR."); rarely
    // it trails the surname run ("SMITH JR, JOHN"). Pull from the given side
    // first, then the surname side.
    const pulledRest = pullSuffix(restTokens);
    restTokens = pulledRest.tokens;
    suffix = pulledRest.suffix;
    if (!suffix) {
      const pulledLast = pullSuffix(lastTokens);
      lastTokens = pulledLast.tokens;
      suffix = pulledLast.suffix;
    }

    // Drop honorifics from anywhere in the given-name run (e.g. "DR", "MR").
    restTokens = restTokens.filter((t) => !isHonorific(t));

    given = restTokens;
    surname = lastTokens;
  } else {
    // "FIRST MIDDLE LAST SUFFIX" — no comma.
    let tokens = trimmed.split(" ").filter(Boolean);

    const pulled = pullSuffix(tokens);
    tokens = pulled.tokens;
    suffix = pulled.suffix;

    // Drop honorifics wherever they appear (usually a mid-token like "DR.").
    tokens = tokens.filter((t) => !isHonorific(t));

    if (tokens.length === 0) {
      given = [];
      surname = [];
    } else if (tokens.length === 1) {
      // Single token — treat as the whole name (mononym).
      given = [];
      surname = tokens;
    } else {
      // Last token is the surname stem; everything before is given/middle.
      // Attach immediately-preceding lowercase particles to the surname so
      // "BRIAN A DEL EXEMPIO" -> given "Brian A", surname "del Exempio".
      let splitAt = tokens.length - 1;
      while (
        splitAt - 1 >= 1 &&
        LOWERCASE_PARTICLES.has(normalizeToken(tokens[splitAt - 1]))
      ) {
        splitAt -= 1;
      }
      given = tokens.slice(0, splitAt);
      surname = tokens.slice(splitAt);
    }
  }

  const givenDisplay = titleCaseNameParts(given).join(" ");
  const surnameDisplay = titleCaseNameParts(surname).join(" ");

  const core = [givenDisplay, surnameDisplay].filter(Boolean).join(" ").trim();
  if (!core) return "";
  return suffix ? `${core}, ${suffix}` : core;
}

/** Split "LAST, REST" on the FIRST comma only. */
function splitOnFirstComma(s: string): [string, string] {
  const idx = s.indexOf(",");
  if (idx === -1) return [s, ""];
  return [s.slice(0, idx), s.slice(idx + 1)];
}

/**
 * If the final token of `tokens` is a recognized suffix, remove it and return
 * its canonical display form. Otherwise return the tokens unchanged with a
 * null suffix.
 */
function pullSuffix(tokens: string[]): { tokens: string[]; suffix: string | null } {
  if (tokens.length === 0) return { tokens, suffix: null };
  const last = tokens[tokens.length - 1];
  const disp = suffixDisplay(last);
  if (disp) {
    return { tokens: tokens.slice(0, -1), suffix: disp };
  }
  return { tokens, suffix: null };
}
