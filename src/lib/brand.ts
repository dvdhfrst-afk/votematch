/**
 * brand.ts - the ONE place the product's public name lives.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * The product was renamed from "Havesay" to "VoteMatch". Every NEW surface reads
 * the product label from this single constant so a rename lands in ONE edit
 * instead of a 200-literal sweep. New code MUST import from here, never hard-code
 * the name. (The ~200 legacy "Havesay" literals across the app predate this file
 * and are tracked as a follow-up sweep; this constant is the forward-looking
 * source of truth and what the embeddable widget + rewritten methodology page use.)
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

/** The product's current public name. Change this ONE line when the name lands. */
export const PRODUCT_NAME = 'VoteMatch';

/** The one-line product promise (the canonical headline). */
export const PRODUCT_TAGLINE = 'Your whole ballot, explained.';

/**
 * A deliberately NAME-AGNOSTIC label for surfaces that ship to partners before
 * the rename is final (the newsroom embed). Reads as a description, not a brand,
 * so a co-branded widget never leads with a name that may change. When the name
 * is decided, callers can switch to PRODUCT_NAME (or keep this for the generic
 * co-brand slot). Kept here so "the tool" phrasing is consistent everywhere.
 */
export const PRODUCT_GENERIC_LABEL = 'the ballot guide';

/** Grouped export for convenience when a component wants more than one field. */
export const PRODUCT = {
  name: PRODUCT_NAME,
  tagline: PRODUCT_TAGLINE,
  genericLabel: PRODUCT_GENERIC_LABEL,
} as const;
