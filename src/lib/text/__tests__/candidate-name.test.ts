import { describe, it, expect } from "vitest";
import { formatCandidateName } from "../candidate-name";

describe("formatCandidateName", () => {
  it("returns empty string for null / undefined / blank", () => {
    expect(formatCandidateName(null)).toBe("");
    expect(formatCandidateName(undefined)).toBe("");
    expect(formatCandidateName("   ")).toBe("");
  });

  it("formats FEC 'LAST, FIRST MIDDLE HONORIFIC' with honorific stripped", () => {
    // FEC-style example (fictional name).
    expect(formatCandidateName("SAMPLE, EVAN J MR")).toBe("Evan J Sample");
  });

  it("formats FEC 'LAST, FIRST MIDDLE HONORIFIC. SUFFIX.' keeping the suffix", () => {
    expect(formatCandidateName("TESTER, GALE ROBIN DR. JR.")).toBe(
      "Gale Robin Tester, Jr.",
    );
  });

  it("title-cases an all-caps first-last name", () => {
    expect(formatCandidateName("JORDAN DAVENPLACE")).toBe("Jordan Davenplace");
    expect(formatCandidateName("JOANNA EXAMPLO")).toBe("Joanna Examplo");
  });

  it("corrects Mc / Mac capitalization", () => {
    expect(formatCandidateName("RICK MCFAKERTY")).toBe("Rick McFakerty");
    expect(formatCandidateName("Jonathan Mcsample")).toBe("Jonathan McSample");
    expect(formatCandidateName("angus macexample")).toBe("Angus MacExample");
  });

  it("corrects O' apostrophe capitalization", () => {
    expect(formatCandidateName("Kristie O'Example")).toBe("Kristie O'Example");
    expect(formatCandidateName("KRISTIE O'EXAMPLE")).toBe("Kristie O'Example");
  });

  it("preserves quoted nicknames and title-cases around them", () => {
    expect(formatCandidateName('Hollace "Holly" Testwood')).toBe(
      'Hollace "Holly" Testwood',
    );
    expect(formatCandidateName('Walter "Les" Samplestone')).toBe(
      'Walter "Les" Samplestone',
    );
    // Nickname preserved even from an all-caps source.
    expect(formatCandidateName('RACHEL "JONES" PLACEHOLD')).toBe(
      'Rachel "Jones" Placehold',
    );
  });

  it("keeps hyphenated surnames title-cased on both sides", () => {
    expect(formatCandidateName("MARLENE SAMPLE-WOODS")).toBe(
      "Marlene Sample-Woods",
    );
  });

  it("keeps recognized suffixes on no-comma names", () => {
    expect(formatCandidateName("John R. Example IV")).toBe("John R. Example, IV");
    expect(formatCandidateName("Thomas Testman II")).toBe("Thomas Testman, II");
  });

  it("attaches lowercase surname particles to the surname", () => {
    expect(formatCandidateName("BRIAN A DEL EXEMPIO")).toBe(
      "Brian A del Exempio",
    );
  });

  it("strips a mid-name honorific from a no-comma name", () => {
    // "ARJUN DR. SAMPLE": DR is an honorific, not a middle name.
    expect(formatCandidateName("ARJUN DR. SAMPLE")).toBe("Arjun Sample");
  });

  it("passes already-clean names through unchanged", () => {
    expect(formatCandidateName("Blake Fakerton")).toBe("Blake Fakerton");
    expect(formatCandidateName("Mark Testlamb")).toBe("Mark Testlamb");
  });

  it("handles a mononym", () => {
    expect(formatCandidateName("ZEPHYRA")).toBe("Zephyra");
  });

  it("handles an initial in the middle position", () => {
    expect(formatCandidateName("BRIAN A DEMO")).toBe("Brian A Demo");
    expect(formatCandidateName("M. ZORAN EXAMPLAR")).toBe("M. Zoran Examplar");
  });

  it("handles honorific with trailing period in the FEC form", () => {
    expect(formatCandidateName("SAMPLEKEY, DANA WAYNE MR.")).toBe(
      "Dana Wayne Samplekey",
    );
  });
});
