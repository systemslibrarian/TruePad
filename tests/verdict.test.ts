import { describe, expect, it } from "vitest";
import { LETTER_BITS, Pad } from "../src/pad";
import { DECK_ENTROPY_BITS, gradeShannon } from "../src/verdict";

describe("gradeShannon on a TruePad pad", () => {
  it("passes all three conditions for a fresh pad covering the message", () => {
    const pad = Pad.generate(200, "letters");
    const report = gradeShannon({ kind: "pad", pad, messageLength: 52 });
    expect(report.subject).toBe("pad");
    expect(report.conditions.map((condition) => condition.pass)).toEqual([true, true, true]);
    expect(report.isTrueOtp).toBe(true);
    expect(report.availableBits).toBeCloseTo(200 * LETTER_BITS, 6);
    expect(report.requiredBits).toBeCloseTo(52 * LETTER_BITS, 6);
  });

  it("fails condition 1 when the surviving pad is shorter than the message", () => {
    const pad = Pad.generate(60, "letters");
    pad.consume(30);
    const report = gradeShannon({ kind: "pad", pad, messageLength: 52 });
    const [keyLength, independence, usedOnce] = report.conditions;
    expect(keyLength.pass).toBe(false);
    expect(keyLength.detail).toContain("refuses");
    expect(independence.pass).toBe(true);
    expect(usedOnce.pass).toBe(true);
    expect(report.isTrueOtp).toBe(false);
  });
});

describe("gradeShannon on a DeckBook-style deck", () => {
  it("fails condition 1 for 52 letters with the entropy arithmetic shown", () => {
    const report = gradeShannon({ kind: "deck", messageLength: 52 });
    const [keyLength, independence, usedOnce] = report.conditions;

    expect(keyLength.pass).toBe(false);
    // ~225.6 bits available vs ~244.4 needed — the exhibit's headline numbers.
    expect(keyLength.detail).toContain("225.6");
    expect(keyLength.detail).toContain("244.4");
    expect(report.availableBits).toBeCloseTo(225.581, 2);
    expect(report.requiredBits).toBeCloseTo(52 * LETTER_BITS, 6);
    expect(report.requiredBits).toBeGreaterThan(DECK_ENTROPY_BITS);

    // Condition 2 names the structural sins: permutation + mod-26 folding.
    expect(independence.pass).toBe(false);
    expect(independence.detail).toContain("mod 26");
    expect(independence.detail).toContain("without replacement");

    expect(usedOnce.pass).toBe(true);
    expect(report.isTrueOtp).toBe(false);
  });

  it("fails condition 3 as well once the deck is reused", () => {
    const report = gradeShannon({ kind: "deck", messageLength: 52, timesUsed: 2 });
    expect(report.conditions[2].pass).toBe(false);
    expect(report.conditions[2].detail).toContain("crib-dragging");
  });

  it("even a short message never earns a deck the true-OTP verdict", () => {
    // 10 letters need only ~47 bits, so the raw entropy count passes —
    // but independence still fails, and that is the point.
    const report = gradeShannon({ kind: "deck", messageLength: 10 });
    expect(report.conditions[0].pass).toBe(true);
    expect(report.conditions[1].pass).toBe(false);
    expect(report.isTrueOtp).toBe(false);
  });

  it("DECK_ENTROPY_BITS is log2(52!)", () => {
    let expected = 0;
    for (let k = 2; k <= 52; k += 1) {
      expected += Math.log2(k);
    }
    expect(DECK_ENTROPY_BITS).toBe(expected);
    expect(DECK_ENTROPY_BITS).toBeGreaterThan(225);
    expect(DECK_ENTROPY_BITS).toBeLessThan(226);
  });
});
