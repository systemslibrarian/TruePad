import { describe, expect, it } from "vitest";
import { encryptLetters } from "../src/core/cipher-otp";
import { LETTER_RANGE, Pad, type PadSource } from "../src/core/pad";
import { gradeShannon } from "../src/core/verdict";

/* ============================================================================
 * Lane 1 — entropy provenance, stated honestly.
 *
 * A pad records where its symbols came from. "csprng" means
 * crypto.getRandomValues(), a DRBG whose output is bounded by its state
 * entropy. "external" means the operator supplied the material and asserts
 * its provenance; this code cannot verify that and must not imply it does.
 * The verdict splits into COMBINER (the three Shannon conditions, which the
 * cipher structure satisfies regardless of source) and SOURCE.
 * ========================================================================= */

// Deterministic external material: every byte value once, then a tail.
function material(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 37 + 11) & 0xff;
  }
  return bytes;
}

describe("PadSource is recorded and carried", () => {
  it("Pad.generate tags its pad csprng", () => {
    const pad = Pad.generate(10, "letters");
    expect(pad.source).toBe<PadSource>("csprng");
    expect(pad.snapshot().source).toBe("csprng");
  });

  it("source survives serialize/deserialize", () => {
    const csprng = Pad.deserialize(Pad.generate(10, "bytes").serialize());
    expect(csprng.source).toBe("csprng");
    const external = Pad.deserialize(Pad.fromExternal(material(32), "bytes").serialize());
    expect(external.source).toBe("external");
    expect(JSON.parse(external.serialize()).source).toBe("external");
  });

  it("deserialize refuses a pad with no source or an unknown source — provenance is never assumed", () => {
    const serialized = JSON.parse(Pad.generate(4, "letters").serialize());
    delete serialized.source;
    expect(() => Pad.deserialize(JSON.stringify(serialized))).toThrow(/source/);
    serialized.source = "hardware";
    expect(() => Pad.deserialize(JSON.stringify(serialized))).toThrow(/source/);
  });
});

describe("Pad.fromExternal — operator-supplied material", () => {
  it("bytes mode: one symbol per byte, values untouched", () => {
    const bytes = material(64);
    const pad = Pad.fromExternal(bytes, "bytes");
    expect(pad.source).toBe("external");
    expect(pad.mode).toBe("bytes");
    expect(pad.size).toBe(64);
    for (let offset = 0; offset < 64; offset += 1) {
      expect(pad.valueAt(offset)).toBe(bytes[offset]);
    }
  });

  it("letters mode: range-reduces by REJECTION (bytes >= 234 dropped), never by modulo", () => {
    // 233 is the last accepted byte; 234, 240, 255 must be rejected outright.
    const bytes = Uint8Array.from([0, 25, 26, 233, 234, 240, 255, 51]);
    const pad = Pad.fromExternal(bytes, "letters");
    expect(pad.size).toBe(5);
    expect([0, 1, 2, 3, 4].map((o) => pad.valueAt(o))).toEqual([0, 25, 0, 233 % 26, 51 % 26]);
    // A modulo reduction would have kept all 8 and mapped 234 -> 0, 255 -> 21.
    for (let offset = 0; offset < pad.size; offset += 1) {
      expect(pad.valueAt(offset)).toBeLessThan(LETTER_RANGE);
    }
  });

  it("honours a requested size and refuses when the material is too short", () => {
    expect(Pad.fromExternal(material(64), "bytes", { size: 40 }).size).toBe(40);
    expect(() => Pad.fromExternal(material(10), "bytes", { size: 11 })).toThrow(/too short|10/);
    // Letters: 8 bytes with 3 rejects yield 5 symbols; asking for 6 must refuse.
    const bytes = Uint8Array.from([0, 25, 26, 233, 234, 240, 255, 51]);
    expect(Pad.fromExternal(bytes, "letters", { size: 5 }).size).toBe(5);
    expect(() => Pad.fromExternal(bytes, "letters", { size: 6 })).toThrow(/too short|5/);
  });

  it("refuses empty material, material that yields no symbols, and bad modes/sizes", () => {
    expect(() => Pad.fromExternal(new Uint8Array(0), "bytes")).toThrow();
    expect(() => Pad.fromExternal(Uint8Array.from([250, 251, 252]), "letters")).toThrow();
    expect(() => Pad.fromExternal(material(4), "hex" as never)).toThrow();
    expect(() => Pad.fromExternal(material(4), "bytes", { size: 0 })).toThrow();
    expect(() => Pad.fromExternal(material(4), "bytes", { size: 1.5 })).toThrow();
  });

  it("does not keep a reference to the caller's buffer", () => {
    const bytes = material(8);
    const pad = Pad.fromExternal(bytes, "bytes");
    bytes.fill(0);
    expect(pad.valueAt(0)).toBe(material(8)[0]);
  });

  it("an external pad encrypts and burns exactly like a generated one", () => {
    const pad = Pad.fromExternal(material(200), "letters");
    const before = pad.remaining;
    const result = encryptLetters("HELLO", pad);
    expect(result.ok).toBe(true);
    expect(pad.remaining).toBe(before - 5);
    expect(pad.highWaterMark).toBe(4);
  });

  it("assigns a PAD-XXXX label and honours an explicit one", () => {
    expect(Pad.fromExternal(material(8), "bytes").label).toMatch(/^PAD-[A-Z]{4}$/);
    expect(Pad.fromExternal(material(8), "bytes", { label: "PAD-DICE" }).label).toBe("PAD-DICE");
  });
});

describe("T5 — the verdict grades COMBINER and SOURCE separately", () => {
  const csprng = Pad.generate(200, "letters");
  const external = Pad.fromExternal(material(400), "letters");
  const a = gradeShannon({ kind: "pad", pad: csprng, messageLength: 52 });
  const b = gradeShannon({ kind: "pad", pad: external, messageLength: 52 });

  it("both pads pass all three Shannon conditions (the combiner)", () => {
    expect(a.conditions.map((c) => c.pass)).toEqual([true, true, true]);
    expect(b.conditions.map((c) => c.pass)).toEqual([true, true, true]);
    expect(a.isTrueOtp).toBe(true);
    expect(b.isTrueOtp).toBe(true);
  });

  it("their COMBINER verdicts are identical", () => {
    expect(a.combiner).toEqual(b.combiner);
    expect(a.combiner.pass).toBe(true);
    expect(a.combiner.title).toMatch(/unconditional/i);
  });

  it("their SOURCE verdicts differ, and each says exactly what it can and cannot claim", () => {
    expect(a.source.grade).toBe("computational");
    expect(b.source.grade).toBe("declared-external");
    expect(a.source).not.toEqual(b.source);

    expect(a.source.title).toContain("computational");
    expect(a.source.title).toContain("bounded by the platform DRBG state");
    expect(a.source.detail).not.toMatch(/information[- ]theoretic(ally)? secure/i);

    expect(b.source.title).toContain("declared external");
    expect(b.source.title).toContain("provenance asserted by the operator");
    expect(b.source.title).toContain("NOT verified by this tool");
    // The code must never imply it checked physical origin.
    expect(b.source.detail).not.toMatch(/verified|confirmed|hardware-backed/i);
  });

  it("a computational source does not flip the combiner: that combination is the honest common case", () => {
    expect(a.isTrueOtp).toBe(true);
    expect(a.source.grade).toBe("computational");
  });

  it("the deck's source line is explicitly not graded — its combiner fails first", () => {
    const deck = gradeShannon({ kind: "deck", messageLength: 52 });
    expect(deck.combiner.pass).toBe(false);
    expect(deck.source.grade).toBe("not-graded");
  });
});
