/* ============================================================================
 * Shannon deployment — the documentation says the honest thing
 * ----------------------------------------------------------------------------
 * Pins the load-bearing sentences a reader relies on, and the wording the
 * classifier must never launder: XORing sources does not prove uniformity, a
 * software CSPRNG is computational, sealed delivery is computational, a witness
 * is about reuse not entropy, deletion is not proof of erasure, and the Browser
 * Edition never shows a Shannon-eligible pad.
 * ========================================================================= */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
// The doc is hard-wrapped; assert on a whitespace-collapsed copy so a sentence
// that crosses a line break still matches.
const DOC = read("docs", "SHANNON-DEPLOYMENT.md").replace(/\s+/g, " ");
const DASH = read("src", "browser", "ui", "dashboard.ts");

describe("SHANNON-DEPLOYMENT.md keeps the distinctions honest", () => {
  it("separates the combiner from the deployment", () => {
    expect(DOC).toMatch(/combiner is not the (OTP )?deployment/i);
    expect(DOC).toContain("C = P XOR K");
  });

  it("(§9) says XORing sources does NOT automatically make them uniform", () => {
    expect(DOC).toMatch(/not\*{0,2}\s*automatically uniform/i);
    expect(DOC).toContain("Uniform if at least one declared source was uniform and independent of the others.");
    // ...and introduces no certifying statistical test.
    expect(DOC).toMatch(/never proves the Shannon source premise/i);
  });

  it("(§4) names a software CSPRNG as computational, not the physical-source claim", () => {
    expect(DOC).toMatch(/software CSPRNG/);
    expect(DOC).toMatch(/computational/);
    expect(DOC).toMatch(/NOT ELIGIBLE/);
  });

  it("(§5) names sealed delivery as computational end to end", () => {
    expect(DOC).toMatch(/sealed .* computational|computational end to end/i);
  });

  it("(§7) says a witness is about reuse/rollback, not entropy", () => {
    expect(DOC).toMatch(/witness/i);
    expect(DOC).toMatch(/says nothing about entropy/i);
    expect(DOC).toMatch(/not physical-hardware monotonicity/i);
  });

  it("(§8/§22L) never claims software proved physical erasure", () => {
    expect(DOC).toMatch(/cannot prove that flash forgot the bytes/i);
    expect(DOC).not.toMatch(/erasure (is )?(proved|proven|verified|certified)/i);
  });

  it("states the three outcomes and that none is a stored verdict", () => {
    for (const label of ["CONDITIONALLY ELIGIBLE", "NOT ELIGIBLE", "INSUFFICIENT EVIDENCE"]) {
      expect(DOC).toContain(label);
    }
    expect(DOC).toMatch(/never stores a self-certifying security verdict/i);
    expect(DOC).toMatch(/trueRandom.*informationTheoretic|informationTheoretic.*trueRandom/);
  });
});

describe("the Browser Pad-details classification cannot be screenshot as 'secure'", () => {
  it("shows a factual classification, not a security score, and states what is unproven", () => {
    expect(DASH).toMatch(/A factual classification, not a security score/);
    expect(DASH).toMatch(/has not proved physical randomness/);
  });

  it("names no unconditional security claim on the pad card", () => {
    // The block renders "Not eligible" / "Insufficient evidence" for browser
    // pads; it must never assert an unqualified strong claim.
    for (const bad of [/perfectly secure/i, /information-theoretically secure/i, /unbreakable/i, /perfect secrecy/i]) {
      expect(DASH).not.toMatch(bad);
    }
  });
});
