import { describe, it, expect } from "vitest";
import { sanitizeDisplayName } from "../sanitize-display";

describe("sanitizeDisplayName", () => {
  it("returns empty string for null / undefined / blank", () => {
    expect(sanitizeDisplayName(null)).toBe("");
    expect(sanitizeDisplayName(undefined)).toBe("");
    expect(sanitizeDisplayName("   ")).toBe("");
  });

  it("replaces an em-dash with a hyphen and collapses spacing", () => {
    expect(sanitizeDisplayName("Arizona State Senator — District 14")).toBe(
      "Arizona State Senator - District 14",
    );
  });

  it("replaces an en-dash with a hyphen", () => {
    expect(sanitizeDisplayName("U.S. House – District 5")).toBe(
      "U.S. House - District 5",
    );
  });

  it("collapses doubled spaces left by substitution", () => {
    // An em-dash flanked by spaces should not leave a double space.
    expect(sanitizeDisplayName("Governor  —  Arizona")).toBe("Governor - Arizona");
  });

  it("leaves a plain-hyphen title unchanged", () => {
    expect(sanitizeDisplayName("Corporation Commissioner - Statewide")).toBe(
      "Corporation Commissioner - Statewide",
    );
  });

  it("is idempotent", () => {
    const once = sanitizeDisplayName("State Senator — District 3");
    expect(sanitizeDisplayName(once)).toBe(once);
  });
});
