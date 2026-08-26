import { describe, expect, it } from "vitest";
import {
  bestCandidate,
  compareAttacks,
  dragCribReusedKey,
  dragCribSingleOtp,
  encryptWithKeystream,
  englishScore,
  LEAK_THRESHOLD
} from "../src/core/attack-otp";
import { encryptLetters, normalizeAZ } from "../src/core/cipher-otp";
import { Pad } from "../src/core/pad";

// The DeckBook-style keystream used for the reuse scenario: the canonical
// deck 0..51 folded mod 26 — deterministic, so every assertion is stable.
const DECK_KEYSTREAM = Array.from({ length: 52 }, (_, index) => index % 26);

const P1 = "ATTACKATDAWNONTHEHILL";
const P2 = "MEETMEATTHELIBRARYNOW";
const CRIB = "ATTACKATDAWN"; // a guess at a fragment of P1

describe("englishScore", () => {
  it("scores English above the leak threshold and noise below it", () => {
    expect(englishScore("MEETMEATTHEL")).toBeGreaterThan(LEAK_THRESHOLD);
    expect(englishScore("THEENEMYISNEAR")).toBeGreaterThan(LEAK_THRESHOLD);
    expect(englishScore("QZXJQKVWZQJX")).toBeLessThan(0);
  });
});

describe("crib drag against a true OTP (single ciphertext)", () => {
  it("finds every alignment equally consistent — zero information", () => {
    const pad = Pad.generate(64, "letters");
    const encrypted = encryptLetters("THEPACKAGEARRIVESTONIGHT", pad);
    expect(encrypted.ok).toBe(true);
    if (!encrypted.ok) return;

    const candidates = dragCribSingleOtp(encrypted.envelope.payload, "PACKAGE");
    const expectedPositions = normalizeAZ("THEPACKAGEARRIVESTONIGHT").length - "PACKAGE".length + 1;
    expect(candidates).toHaveLength(expectedPositions);
    for (const candidate of candidates) {
      expect(candidate.consistent).toBe(true);
      expect(candidate.score).toBe(candidates[0].score);
      expect(candidate.fragment).toHaveLength("PACKAGE".length);
    }
  });

  it("stays uninformative even when the crib IS the whole plaintext", () => {
    const pad = Pad.generate(30, "letters");
    const encrypted = encryptLetters("MEETATMIDNIGHT", pad);
    if (!encrypted.ok) throw new Error("unexpected refusal");
    const candidates = dragCribSingleOtp(encrypted.envelope.payload, "MEETATMIDNIGHT");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].consistent).toBe(true);
    expect(candidates[0].score).toBe(0);
  });
});

describe("crib drag against a reused keystream (DeckBook's sin)", () => {
  const c1 = encryptWithKeystream(P1, DECK_KEYSTREAM);
  const c2 = encryptWithKeystream(P2, DECK_KEYSTREAM);

  it("recovers the OTHER plaintext where the crib is correctly placed", () => {
    const candidates = dragCribReusedKey(c1, c2, CRIB);
    const atZero = candidates.find((candidate) => candidate.position === 0);
    expect(atZero).toBeDefined();
    expect(atZero!.fragment).toBe(P2.slice(0, CRIB.length)); // "MEETMEATTHEL"
    expect(atZero!.score).toBeGreaterThan(LEAK_THRESHOLD);
  });

  it("ranks the correct placement first", () => {
    const best = bestCandidate(dragCribReusedKey(c1, c2, CRIB));
    expect(best).toBeDefined();
    expect(best!.position).toBe(0);
  });
});

describe("compareAttacks — the same attack, both targets, side by side", () => {
  it("reports leak on reuse and no leak on the OTP", () => {
    const pad = Pad.generate(64, "letters");
    const otpEncrypted = encryptLetters(P1, pad);
    if (!otpEncrypted.ok) throw new Error("unexpected refusal");

    const comparison = compareAttacks({
      otpCiphertext: otpEncrypted.envelope.payload,
      reusedCiphertexts: [
        encryptWithKeystream(P1, DECK_KEYSTREAM),
        encryptWithKeystream(P2, DECK_KEYSTREAM)
      ],
      crib: CRIB
    });

    expect(comparison.otp.leaked).toBe(false);
    expect(comparison.otp.candidates.every((candidate) => candidate.consistent)).toBe(true);
    expect(new Set(comparison.otp.candidates.map((candidate) => candidate.score)).size).toBe(1);

    expect(comparison.reused.leaked).toBe(true);
    expect(comparison.reused.best?.position).toBe(0);
    expect(comparison.reused.best?.fragment).toBe("MEETMEATTHEL");
  });

  it("encryptWithKeystream refuses plaintext longer than the keystream", () => {
    expect(() => encryptWithKeystream("A".repeat(53), DECK_KEYSTREAM)).toThrow();
  });
});
