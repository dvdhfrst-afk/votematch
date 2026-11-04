/**
 * Display-layer text sanitizer for DB-sourced race / office / district names.
 *
 * Project hard rule: no em-dashes or en-dashes on user-facing surfaces. Some
 * race titles arrive from the database already carrying them (e.g.
 * "Arizona State Senator — District 14"). We cannot rewrite the stored data
 * from the render layer, so we sanitize at the point of display: replace em
 * (U+2014) and en (U+2013) dashes (and the horizontal bar U+2015) with a plain
 * hyphen, then collapse any doubled spaces the substitution leaves behind.
 *
 * Pure and idempotent — safe to apply anywhere a race/office/district name is
 * rendered.
 */
export function sanitizeDisplayName(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/[‒–—―]/g, "-")
    .replace(/ {2,}/g, " ")
    .trim();
}
