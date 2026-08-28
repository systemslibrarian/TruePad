import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../src/core/hex";
import { bytesToField, dot, fieldToBytes, gfMul, polyval } from "../src/core/gf128";

/* ============================================================================
 * GF(2^128) / POLYVAL against RFC 8452's own published values
 * ----------------------------------------------------------------------------
 * The field-operation examples are RFC 8452 Section 7; the worked POLYVAL
 * evaluation is its Appendix A. The same values are asserted by the
 * frozen-vector generator (spec/reference/vectors.mjs) before it emits
 * anything, so this suite and the generator cross-check each other through
 * the RFC, not through each other. Hex values here are copied from
 * docs/FORMAT-V2.md §11.2.
 *
 * hex.ts is exercised here too: every vector in this file and in
 * wc-one-time.test.ts flows through it, so its strictness is pinned where
 * a regression would corrupt the vectors silently.
 * ========================================================================= */

// Test-side unwrap: the vectors below are spelled correctly by construction,
// so a null from hexToBytes is a test bug and should explode loudly.
function mustHex(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes === null) {
    throw new Error(`test vector is not strict lowercase hex: ${hex}`);
  }
  return bytes;
}

const fe = (hex: string): bigint => bytesToField(mustHex(hex));
const hexOf = (value: bigint): string => bytesToHex(fieldToBytes(value));

describe("hex codec strictness", () => {
  it("bytesToHex emits lowercase, two characters per byte", () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0xab, 0xff]))).toBe("000fabff");
    expect(bytesToHex(new Uint8Array(0))).toBe("");
  });

  it("hexToBytes round-trips what bytesToHex emits", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
    expect(hexToBytes("")).toEqual(new Uint8Array(0));
  });

  it("rejects every alternate spelling as null — uppercase, odd length, prefixes, whitespace", () => {
    expect(hexToBytes("AB")).toBeNull(); // uppercase
    expect(hexToBytes("aB")).toBeNull(); // mixed case
    expect(hexToBytes("abc")).toBeNull(); // odd length
    expect(hexToBytes("0xab")).toBeNull(); // prefix
    expect(hexToBytes("ab cd")).toBeNull(); // whitespace
    expect(hexToBytes("ab\n")).toBeNull(); // trailing newline
    expect(hexToBytes("gg")).toBeNull(); // not hex at all
  });
});

describe("field element encoding (RFC 8452 §3 little-endian mapping)", () => {
  it("bytesToField is a little-endian 128-bit integer read", () => {
    // Bit 0 of the integer is the low bit of the FIRST byte (coefficient of x^0).
    expect(bytesToField(mustHex("01000000000000000000000000000000"))).toBe(1n);
    // The high bit of the LAST byte is the coefficient of x^127.
    expect(bytesToField(mustHex("00000000000000000000000000000080"))).toBe(1n << 127n);
  });

  it("fieldToBytes inverts bytesToField", () => {
    const bytes = mustHex("66e94bd4ef8a2c3b884cfa59ca342b2e");
    expect(fieldToBytes(bytesToField(bytes))).toEqual(bytes);
  });

  it("bytesToField throws unless given exactly 16 bytes", () => {
    expect(() => bytesToField(new Uint8Array(15))).toThrow(/exactly 16 bytes/);
    expect(() => bytesToField(new Uint8Array(17))).toThrow(/exactly 16 bytes/);
    expect(() => bytesToField(new Uint8Array(0))).toThrow(/exactly 16 bytes/);
  });
});

describe("RFC 8452 cross-checks (FORMAT-V2.md §11.2)", () => {
  // RFC 8452 Section 7 field-operation examples.
  const a = fe("66e94bd4ef8a2c3b884cfa59ca342b2e");
  const b = fe("ff000000000000000000000000000000");

  it("a·b matches the RFC 8452 §7 product", () => {
    expect(hexOf(gfMul(a, b))).toBe("37856175e9dc9df26ebc6d6171aa0ae9");
  });

  it("dot(a, b) matches the RFC 8452 §7 example", () => {
    expect(hexOf(dot(a, b))).toBe("ebe563401e7e91ea3ad6426b8140c394");
  });

  it("POLYVAL(H, X_1, X_2) matches the RFC 8452 Appendix A worked example", () => {
    const h = mustHex("25629347589242761d31f826ba4b757b");
    const x1 = "4f4f95668c83dfb6401762bb2d01a262";
    const x2 = "d1a24ddd2721d006bbe45f20d3c9f362";
    const message = mustHex(x1 + x2);
    expect(bytesToHex(polyval(h, message))).toBe("f7a3b47b846119fae5b7866cf5e5b77e");
  });
});

describe("field structure sanity", () => {
  it("gfMul has identity 1 and absorbs 0", () => {
    const a = fe("66e94bd4ef8a2c3b884cfa59ca342b2e");
    expect(gfMul(a, 1n)).toBe(a);
    expect(gfMul(1n, a)).toBe(a);
    expect(gfMul(a, 0n)).toBe(0n);
    expect(gfMul(0n, a)).toBe(0n);
  });

  it("gfMul commutes on the RFC operands", () => {
    const a = fe("66e94bd4ef8a2c3b884cfa59ca342b2e");
    const b = fe("ff000000000000000000000000000000");
    expect(gfMul(a, b)).toBe(gfMul(b, a));
  });

  it("polyval throws on anything that is not whole 16-byte blocks", () => {
    const h = mustHex("25629347589242761d31f826ba4b757b");
    expect(() => polyval(h, new Uint8Array(15))).toThrow(/16-byte blocks/);
    expect(() => polyval(h, new Uint8Array(17))).toThrow(/16-byte blocks/);
  });

  it("polyval of the empty message is zero (S_0 = 0, no blocks)", () => {
    const h = mustHex("25629347589242761d31f826ba4b757b");
    expect(bytesToHex(polyval(h, new Uint8Array(0)))).toBe("00000000000000000000000000000000");
  });
});

describe("zero key: POLYVAL(0, M) = 0 for every message", () => {
  // This documents a FACT, not a defense: every term of the polynomial is
  // multiplied by a power of the key, so K = 0 hashes everything to zero,
  // and an all-zero (K, R) verifies an all-zero tag on ANY message with
  // probability 1. The §5 bound already prices the zero key like any
  // other, and retirement never writes secret.bin (§1.2), so no store
  // state manufactures zeroed records; FORMAT-V2.md §9.4 documents the
  // restore hazards that do remain, as operator assumptions.
  it("returns zero for messages of several lengths and contents", () => {
    const zeroKey = new Uint8Array(16);
    const zeroHash = "00000000000000000000000000000000";
    const messages = [
      new Uint8Array(16), // one zero block
      mustHex("4f4f95668c83dfb6401762bb2d01a262"), // one nonzero block
      mustHex("4f4f95668c83dfb6401762bb2d01a262d1a24ddd2721d006bbe45f20d3c9f362"), // two blocks
      new Uint8Array(16 * 64).fill(0xa5) // many identical blocks
    ];
    for (const message of messages) {
      expect(bytesToHex(polyval(zeroKey, message))).toBe(zeroHash);
    }
  });
});
