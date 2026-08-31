import { describe, expect, it } from "vitest";

import { bytesToHex } from "../src/core/hex";
import { writeUint64BE } from "../src/spt/bytes";
import {
  AEAD_TAG_BYTES,
  MAX_PLAINTEXT_BYTES,
  TPS2_FIXED_OVERHEAD_BYTES,
  TPS2_HEADER_BYTES,
  TPS2_OFFSETS
} from "../src/spt/constants";
import { buildHeader, packageIdentity, parseSealedPackage } from "../src/spt/sealed-package";

/* ============================================================================
 * TPS2 structural parsing — §7.1, §7.2, and §14/§18 of the Phase 1A brief
 * ----------------------------------------------------------------------------
 * Structure only: nothing here decapsulates, derives a key, or decrypts. That
 * is the point — a hostile package must be refusable without a private key
 * having been touched, and without anything being allocated on the strength of
 * a number the package chose for itself.
 * ========================================================================= */

const FIELDS = {
  requestId: new Uint8Array(16).fill(0x11),
  requestHash: new Uint8Array(32).fill(0x22),
  kemCiphertext: new Uint8Array(1120).fill(0x33),
  nonce: new Uint8Array(12).fill(0x44),
  plaintextLength: 5
};

const HEADER = buildHeader(FIELDS);
const CIPHERTEXT = Uint8Array.from([1, 2, 3, 4, 5]);
const TAG = new Uint8Array(AEAD_TAG_BYTES).fill(0x55);

function build(header = HEADER, ciphertext = CIPHERTEXT, tag = TAG): Uint8Array {
  const out = new Uint8Array(header.length + ciphertext.length + tag.length);
  out.set(header, 0);
  out.set(ciphertext, header.length);
  out.set(tag, header.length + ciphertext.length);
  return out;
}

const PACKAGE = build();

describe("the header is the AAD, byte for byte", () => {
  it("has the frozen layout", () => {
    expect(HEADER.length).toBe(TPS2_HEADER_BYTES);
    expect(Array.from(HEADER.subarray(0, 4))).toEqual([0x54, 0x50, 0x53, 0x32]);
    expect(HEADER[TPS2_OFFSETS.version]).toBe(0x01);
    expect(HEADER[TPS2_OFFSETS.suite]).toBe(0x00);
    expect(HEADER[TPS2_OFFSETS.suite + 1]).toBe(0x01);
    expect(bytesToHex(HEADER.subarray(TPS2_OFFSETS.requestId, TPS2_OFFSETS.requestHash))).toBe("11".repeat(16));
    expect(bytesToHex(HEADER.subarray(TPS2_OFFSETS.requestHash, TPS2_OFFSETS.kemCiphertext))).toBe("22".repeat(32));
    expect(bytesToHex(HEADER.subarray(TPS2_OFFSETS.nonce, TPS2_OFFSETS.plaintextLength))).toBe("44".repeat(12));
    expect(bytesToHex(HEADER.subarray(TPS2_OFFSETS.plaintextLength))).toBe("0000000000000005");
  });

  it("the parsed AAD is exactly bytes [0, 1195)", () => {
    const parsed = parseSealedPackage(PACKAGE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.parsed.aad.length).toBe(TPS2_HEADER_BYTES);
    expect(bytesToHex(parsed.parsed.aad)).toBe(bytesToHex(HEADER));
    expect(bytesToHex(parsed.parsed.ciphertext)).toBe(bytesToHex(CIPHERTEXT));
    expect(bytesToHex(parsed.parsed.tag)).toBe(bytesToHex(TAG));
  });

  it("fixed overhead is 1211 bytes", () => {
    expect(PACKAGE.length - CIPHERTEXT.length).toBe(TPS2_FIXED_OVERHEAD_BYTES);
  });

  it("refuses to build a header with a wrong-size field", () => {
    expect(() => buildHeader({ ...FIELDS, requestId: new Uint8Array(15) })).toThrow(RangeError);
    expect(() => buildHeader({ ...FIELDS, requestHash: new Uint8Array(31) })).toThrow(RangeError);
    expect(() => buildHeader({ ...FIELDS, kemCiphertext: new Uint8Array(1119) })).toThrow(RangeError);
    expect(() => buildHeader({ ...FIELDS, nonce: new Uint8Array(11) })).toThrow(RangeError);
    expect(() => buildHeader({ ...FIELDS, plaintextLength: MAX_PLAINTEXT_BYTES + 1 })).toThrow(RangeError);
    expect(() => buildHeader({ ...FIELDS, plaintextLength: -1 })).toThrow(RangeError);
  });
});

describe("structural falsification", () => {
  function mutate(edit: (bytes: Uint8Array) => void): Uint8Array {
    const copy = Uint8Array.from(PACKAGE);
    edit(copy);
    return copy;
  }

  const cases: Array<[string, Uint8Array, string]> = [
    ["wrong magic", mutate((b) => (b[0] ^= 0x01)), "wrong-magic"],
    ["magic of a TPR2 request", mutate((b) => b.set([0x54, 0x50, 0x52, 0x32], 0)), "wrong-magic"],
    ["unsupported version", mutate((b) => (b[TPS2_OFFSETS.version] = 0x02)), "unsupported-version"],
    ["version zero", mutate((b) => (b[TPS2_OFFSETS.version] = 0x00)), "unsupported-version"],
    ["unsupported suite", mutate((b) => (b[TPS2_OFFSETS.suite + 1] = 0x02)), "unsupported-suite"],
    ["suite zero", mutate((b) => (b[TPS2_OFFSETS.suite + 1] = 0x00)), "unsupported-suite"],
    ["appended trailing byte", new Uint8Array([...PACKAGE, 0x00]), "length-mismatch"],
    ["truncated GCM tag", PACKAGE.subarray(0, PACKAGE.length - 1), "length-mismatch"],
    ["truncated header", PACKAGE.subarray(0, 1000), "too-short"],
    ["empty input", new Uint8Array(0), "too-short"],
    ["one byte under the fixed overhead", new Uint8Array(TPS2_FIXED_OVERHEAD_BYTES - 1), "too-short"]
  ];

  for (const [name, input, reason] of cases) {
    it(`refuses ${name}`, () => {
      const parsed = parseSealedPackage(input);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.reason).toBe(reason);
    });
  }

  it("refuses a declared plaintext length above 16 MiB WITHOUT allocating it", () => {
    const evil = mutate((b) => writeUint64BE(b, TPS2_OFFSETS.plaintextLength, BigInt(MAX_PLAINTEXT_BYTES) + 1n));
    const parsed = parseSealedPackage(evil);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("declared-length-too-large");
  });

  it("refuses a declared length of 2^64 - 1 rather than rounding it", () => {
    // Read through Number this is 18446744073709552000 — and any comparison
    // against it becomes a guess. The parser reads a BigInt and range-checks it
    // before converting, so this is a clean refusal.
    const evil = mutate((b) => writeUint64BE(b, TPS2_OFFSETS.plaintextLength, (1n << 64n) - 1n));
    const parsed = parseSealedPackage(evil);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("declared-length-too-large");
  });

  it("refuses a declared length just above Number.MAX_SAFE_INTEGER", () => {
    const evil = mutate((b) =>
      writeUint64BE(b, TPS2_OFFSETS.plaintextLength, BigInt(Number.MAX_SAFE_INTEGER) + 1n)
    );
    const parsed = parseSealedPackage(evil);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("declared-length-too-large");
  });

  it("refuses a declared length that disagrees with the actual size, either way", () => {
    for (const declared of [4n, 6n, 0n]) {
      const evil = mutate((b) => writeUint64BE(b, TPS2_OFFSETS.plaintextLength, declared));
      const parsed = parseSealedPackage(evil);
      expect(parsed.ok, `declared ${declared}`).toBe(false);
      if (parsed.ok) return;
      expect(parsed.reason).toBe("length-mismatch");
    }
  });

  it("accepts a zero-length payload when the declaration agrees", () => {
    const header = buildHeader({ ...FIELDS, plaintextLength: 0 });
    const parsed = parseSealedPackage(build(header, new Uint8Array(0), TAG));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.parsed.ciphertext.length).toBe(0);
    expect(parsed.parsed.tag.length).toBe(AEAD_TAG_BYTES);
  });

  it("checks magic before anything derived from a length the package chose", () => {
    // A package that is both short AND wrong-magic reports "too-short": the
    // bounds check has to come first or the magic read is out of range.
    const parsed = parseSealedPackage(new Uint8Array(10));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("too-short");
  });

  it("does not mutate the input", () => {
    const before = bytesToHex(PACKAGE);
    parseSealedPackage(PACKAGE);
    expect(bytesToHex(PACKAGE)).toBe(before);
  });
});

describe("packageIdentity commits to the WHOLE package", () => {
  it("differs when only the ciphertext changes", async () => {
    const base = await packageIdentity(PACKAGE);
    const other = build(HEADER, Uint8Array.from([1, 2, 3, 4, 6]), TAG);
    expect(bytesToHex(await packageIdentity(other))).not.toBe(bytesToHex(base));
  });

  it("differs when only the tag changes", async () => {
    const base = await packageIdentity(PACKAGE);
    const tag = Uint8Array.from(TAG);
    tag[0] ^= 0x01;
    expect(bytesToHex(await packageIdentity(build(HEADER, CIPHERTEXT, tag)))).not.toBe(bytesToHex(base));
  });

  it("is NOT SHA-256 of the AAD", async () => {
    // The regression Phase 0.6 repaired: SHA-256(AAD) is blind to both the
    // ciphertext and the tag, so the two packages above would have shared one
    // identity.
    const aadOnly = new Uint8Array(await crypto.subtle.digest("SHA-256", HEADER));
    expect(bytesToHex(await packageIdentity(PACKAGE))).not.toBe(bytesToHex(aadOnly));
  });

  it("is stable for identical bytes", async () => {
    expect(bytesToHex(await packageIdentity(PACKAGE))).toBe(bytesToHex(await packageIdentity(build())));
  });
});
