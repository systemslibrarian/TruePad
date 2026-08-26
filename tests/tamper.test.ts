import { describe, expect, it } from "vitest";
import { decryptBytes, decryptLetters, encryptBytes, encryptLetters, normalizeAZ } from "../src/core/cipher-otp";
import { Pad } from "../src/core/pad";
import { diffPositions, forgeBytes, forgeLetters, shiftCipherLetter } from "../src/exhibit/tamper";

// Encrypt `plaintext` with a fresh pad and return the ciphertext plus a
// factory for pristine receiver copies (each decryption needs its own copy,
// since decrypting burns).
function letterScene(plaintext: string) {
  const sender = Pad.generate(normalizeAZ(plaintext).length, "letters");
  const delivered = sender.serialize();
  const encrypted = encryptLetters(plaintext, sender, "A");
  if (!encrypted.ok) throw new Error("pad was generated to exact message length");
  return {
    ciphertext: encrypted.envelope.payload,
    decrypt(ciphertext: string): string {
      const copy = Pad.deserialize(delivered);
      // A tampered payload rides in the sender's own envelope: same page, same offsets.
      const result = decryptLetters({ ...encrypted.envelope, payload: ciphertext }, copy, "B");
      if (!result.ok) throw new Error("copy is pristine and exactly long enough");
      return result.text;
    }
  };
}

describe("shiftCipherLetter", () => {
  it("shifts the receiver's decryption at exactly that position, by exactly that delta", () => {
    const scene = letterScene("PAYBOBTENDOLLARSNOW");
    const tampered = shiftCipherLetter(scene.ciphertext, 7, 3);
    const original = scene.decrypt(scene.ciphertext);
    const received = scene.decrypt(tampered);
    expect(original).toBe("PAYBOBTENDOLLARSNOW");
    expect(diffPositions(original, received)).toEqual([7]);
    // p'[7] = p[7] + 3 mod 26: E (4) becomes H (7).
    expect(received[7]).toBe("H");
  });

  it("wraps negative deltas mod 26", () => {
    const scene = letterScene("ABC");
    const tampered = shiftCipherLetter(scene.ciphertext, 0, -27);
    // A (0) shifted by -27 ≡ -1 mod 26 is Z (25).
    expect(scene.decrypt(tampered)[0]).toBe("Z");
  });

  it("rejects positions outside the ciphertext", () => {
    expect(() => shiftCipherLetter("ABC", 3, 1)).toThrow(/outside the ciphertext/);
    expect(() => shiftCipherLetter("ABC", -1, 1)).toThrow(/outside the ciphertext/);
  });
});

describe("forgeLetters", () => {
  it("rewrites known plaintext to a chosen fragment without any key knowledge", () => {
    const scene = letterScene("PAY BOB TEN DOLLARS NOW");
    // "TEN" sits at position 6 of PAYBOBTENDOLLARSNOW.
    const forged = forgeLetters(scene.ciphertext, 6, "TEN", "SIX");
    expect(scene.decrypt(forged)).toBe("PAYBOBSIXDOLLARSNOW");
  });

  it("touches only the forged positions", () => {
    const scene = letterScene("PAYBOBTENDOLLARSNOW");
    const forged = forgeLetters(scene.ciphertext, 6, "TEN", "SIX");
    const changed = diffPositions(scene.decrypt(scene.ciphertext), scene.decrypt(forged));
    // T→S, E→I, N→X: all three letters differ, and nothing else does.
    expect(changed).toEqual([6, 7, 8]);
  });

  it("is the identity when desired equals known", () => {
    const scene = letterScene("HOLDTHEBRIDGE");
    expect(forgeLetters(scene.ciphertext, 4, "THE", "THE")).toBe(scene.ciphertext);
  });

  it("rejects mismatched fragment lengths and fragments that do not fit", () => {
    expect(() => forgeLetters("ABCDEF", 0, "TEN", "SEVEN")).toThrow(/same length/);
    expect(() => forgeLetters("ABCDEF", 4, "TEN", "SIX")).toThrow(/does not fit/);
  });
});

describe("forgeBytes", () => {
  it("rewrites known bytes to chosen bytes through XOR, leaving the rest alone", () => {
    const plain = new TextEncoder().encode("PAY BOB $10");
    const sender = Pad.generate(plain.length, "bytes");
    const delivered = sender.serialize();
    const encrypted = encryptBytes(plain, sender, "A");
    if (!encrypted.ok) throw new Error("pad was generated to exact message length");

    const forged = forgeBytes(
      encrypted.envelope.payload,
      8,
      new TextEncoder().encode("$10"),
      new TextEncoder().encode("$99")
    );
    const result = decryptBytes({ ...encrypted.envelope, payload: forged }, Pad.deserialize(delivered), "B");
    if (!result.ok) throw new Error("copy is pristine and exactly long enough");
    expect(new TextDecoder().decode(result.bytes)).toBe("PAY BOB $99");
  });

  it("does not mutate the input ciphertext", () => {
    const cipher = Uint8Array.from([1, 2, 3]);
    forgeBytes(cipher, 0, Uint8Array.from([9]), Uint8Array.from([4]));
    expect([...cipher]).toEqual([1, 2, 3]);
  });

  it("rejects mismatched fragment lengths and fragments that do not fit", () => {
    const cipher = Uint8Array.from([1, 2, 3]);
    expect(() => forgeBytes(cipher, 0, Uint8Array.from([1]), Uint8Array.from([1, 2]))).toThrow(
      /same length/
    );
    expect(() => forgeBytes(cipher, 2, Uint8Array.from([1, 2]), Uint8Array.from([3, 4]))).toThrow(
      /does not fit/
    );
  });
});

describe("diffPositions", () => {
  it("lists exactly the differing positions", () => {
    expect(diffPositions("ABCDE", "AXCYE")).toEqual([1, 3]);
    expect(diffPositions("SAME", "SAME")).toEqual([]);
  });

  it("rejects different lengths", () => {
    expect(() => diffPositions("AB", "ABC")).toThrow(/same length/);
  });
});
