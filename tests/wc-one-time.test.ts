import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../src/core/hex";
import {
  AUTH_RECORD_BYTES,
  CANONICAL_HEADER_BYTES,
  DOMAIN_SEPARATOR,
  FREEZE_THRESHOLD_DEFAULT,
  MAX_AUTH_LOOKAHEAD_DEFAULT,
  MAX_CIPHERTEXT_BYTES,
  TAG_BYTES,
  VERIFY_ATTEMPT_LIMIT_DEFAULT,
  canonicalBytes,
  tagsEqual,
  wcHash,
  wcTag,
  type CanonicalFields
} from "../src/core/wc-one-time";

/* ============================================================================
 * wc-one-time-v1 against the FROZEN vectors of docs/FORMAT-V2.md §11.3
 * ----------------------------------------------------------------------------
 * Every hex constant below is copied from the spec, which embeds the output
 * of `node spec/reference/vectors.mjs` verbatim. The vectors are frozen:
 * where this implementation and the spec disagree, the spec wins and this
 * implementation has a bug. The keys and masks are test constants for
 * comparing implementations — nothing shaped like them is ever real pad
 * material, and the protocol uses each (K, R) for exactly one sequence
 * number; the cases reuse one pair across messages because they test the
 * hash, not the protocol.
 * ========================================================================= */

function mustHex(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes === null) {
    throw new Error(`test vector is not strict lowercase hex: ${hex}`);
  }
  return bytes;
}

// Shared across all five §11.3 cases.
const PAIR_ID = mustHex("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf");
const KEY = mustHex("000102030405060708090a0b0c0d0e0f");
const MASK = mustHex("101112131415161718191a1b1c1d1e1f");

describe("pinned constants (FORMAT-V2.md §§2.2, 4, 6.1, 8)", () => {
  it("hold the spec's exact values", () => {
    expect(MAX_CIPHERTEXT_BYTES).toBe(1048576);
    expect(MAX_AUTH_LOOKAHEAD_DEFAULT).toBe(64);
    expect(VERIFY_ATTEMPT_LIMIT_DEFAULT).toBe(8);
    expect(FREEZE_THRESHOLD_DEFAULT).toBe(32);
    expect(AUTH_RECORD_BYTES).toBe(32);
    expect(TAG_BYTES).toBe(16);
    expect(CANONICAL_HEADER_BYTES).toBe(64);
  });

  it("domain separator is the §2.2 constant — ASCII wc-one-time-v1 then two 0x00, and nonzero", () => {
    expect(bytesToHex(DOMAIN_SEPARATOR)).toBe("77632d6f6e652d74696d652d76310000");
    expect(DOMAIN_SEPARATOR.length).toBe(16);
    expect(DOMAIN_SEPARATOR.some((byte) => byte !== 0)).toBe(true);
  });
});

describe("frozen vectors: hash-only and full-tag (FORMAT-V2.md §11.3)", () => {
  // Cases 1 and 2 share every field; full-tag is hash-only plus the mask.
  const fields: CanonicalFields = {
    pairId: PAIR_ID,
    direction: "A->B", // wire 0x00
    sequence: 7,
    startOffset: 4096,
    ciphertext: mustHex("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f")
  };
  const frozenCanonical =
    "77632d6f6e652d74696d652d76310000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf" +
    "0200000000000000070000000000000000100000000000002000000000000000" +
    "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f";

  it("canonicalBytes matches byte for byte (6 blocks)", () => {
    const canonical = canonicalBytes(fields);
    expect(bytesToHex(canonical)).toBe(frozenCanonical);
    expect(canonical.length / 16).toBe(6);
  });

  it("hash-only: POLYVAL(K, canonical) with no mask applied", () => {
    expect(bytesToHex(wcHash(KEY, fields))).toBe("4ba90e0dd06af1497c869bc334117ac6");
  });

  it("full-tag: tag = hash XOR mask", () => {
    expect(bytesToHex(wcTag(KEY, MASK, fields))).toBe("5bb81c1ec47fe75e649f81d8280c64d9");
  });
});

describe("frozen vector: empty-ciphertext (FORMAT-V2.md §11.3)", () => {
  const fields: CanonicalFields = {
    pairId: PAIR_ID,
    direction: "A->B",
    sequence: 8,
    startOffset: 4128,
    ciphertext: new Uint8Array(0)
  };

  it("C = 0: canonical bytes are exactly the 64-byte header, 4 blocks", () => {
    const canonical = canonicalBytes(fields);
    expect(bytesToHex(canonical)).toBe(
      "77632d6f6e652d74696d652d76310000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf" +
        "0200000000000000080000000000000020100000000000000000000000000000"
    );
    expect(canonical.length).toBe(64);
  });

  it("hash and tag match the frozen values", () => {
    expect(bytesToHex(wcHash(KEY, fields))).toBe("1a78ebf5d8a790e5f7a8630f141a691e");
    expect(bytesToHex(wcTag(KEY, MASK, fields))).toBe("0a69f9e6ccb286f2efb1791408077701");
  });
});

describe("frozen vector: partial-block (FORMAT-V2.md §11.3)", () => {
  const fields: CanonicalFields = {
    pairId: PAIR_ID,
    direction: "A->B",
    sequence: 9,
    startOffset: 4128,
    ciphertext: mustHex("c0c1c2c3c4")
  };

  it("C = 5: one padded ciphertext block; ciphertextLength (not the padding) fixes the boundary", () => {
    const canonical = canonicalBytes(fields);
    expect(bytesToHex(canonical)).toBe(
      "77632d6f6e652d74696d652d76310000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf" +
        "0200000000000000090000000000000020100000000000000500000000000000" +
        "c0c1c2c3c40000000000000000000000"
    );
    expect(canonical.length / 16).toBe(5);
  });

  it("hash and tag match the frozen values", () => {
    expect(bytesToHex(wcHash(KEY, fields))).toBe("7ef162614dd3184bb608bbd7f076f558");
    expect(bytesToHex(wcTag(KEY, MASK, fields))).toBe("6ee0707259c60e5cae11a1ccec6beb47");
  });
});

describe("frozen vector: max-ciphertext (FORMAT-V2.md §11.3)", () => {
  // C = MAX_CIPHERTEXT_BYTES with the spec's rule byte[i] = i mod 256 —
  // the ciphertext is generated, not embedded. 65,540 canonical blocks is
  // exactly the d_max at which §5.2's ε is evaluated. Bit-serial POLYVAL
  // over a MiB takes on the order of a second per pass; kept in its own
  // `it` with a generous timeout so the small cases stay fast to iterate.
  it(
    "hash and tag match the frozen values at 65,540 blocks",
    () => {
      const ciphertext = new Uint8Array(MAX_CIPHERTEXT_BYTES);
      for (let i = 0; i < ciphertext.length; i += 1) {
        ciphertext[i] = i % 256;
      }
      const fields: CanonicalFields = {
        pairId: PAIR_ID,
        direction: "B->A", // wire 0x01
        sequence: 10,
        startOffset: 4133,
        ciphertext
      };
      const canonical = canonicalBytes(fields);
      expect(canonical.length).toBe(1048640);
      expect(canonical.length / 16).toBe(65540);
      const key = mustHex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
      const mask = mustHex("e0e1e2e3e4e5e6e7e8e9eaebecedeeef");
      expect(bytesToHex(wcHash(key, fields))).toBe("bb000eb83f148210d884e5b9dfa26a68");
      expect(bytesToHex(wcTag(key, mask, fields))).toBe("5be1ec5bdbf164f7306d0f52334f8487");
    },
    60_000
  );
});

describe("canonicalBytes domain violations throw (callers pre-validate)", () => {
  const good: CanonicalFields = {
    pairId: PAIR_ID,
    direction: "A->B",
    sequence: 0,
    startOffset: 0,
    ciphertext: new Uint8Array(0)
  };

  it("direction byte mapping is exact: A->B is 0x00, B->A is 0x01", () => {
    expect(canonicalBytes(good)[33]).toBe(0x00);
    expect(canonicalBytes({ ...good, direction: "B->A" })[33]).toBe(0x01);
  });

  it("pairId must be exactly 16 bytes", () => {
    expect(() => canonicalBytes({ ...good, pairId: new Uint8Array(15) })).toThrow(/exactly 16 bytes/);
    expect(() => canonicalBytes({ ...good, pairId: new Uint8Array(17) })).toThrow(/exactly 16 bytes/);
  });

  it("sequence and startOffset must be non-negative safe integers", () => {
    expect(() => canonicalBytes({ ...good, sequence: -1 })).toThrow(/sequence/);
    expect(() => canonicalBytes({ ...good, sequence: 1.5 })).toThrow(/sequence/);
    expect(() => canonicalBytes({ ...good, sequence: 2 ** 53 })).toThrow(/sequence/);
    expect(() => canonicalBytes({ ...good, startOffset: -1 })).toThrow(/startOffset/);
    expect(() => canonicalBytes({ ...good, startOffset: Number.NaN })).toThrow(/startOffset/);
  });

  it("ciphertext must not exceed MAX_CIPHERTEXT_BYTES", () => {
    expect(() => canonicalBytes({ ...good, ciphertext: new Uint8Array(MAX_CIPHERTEXT_BYTES + 1) })).toThrow(
      /MAX_CIPHERTEXT_BYTES/
    );
  });

  it("wcTag requires a 16-byte mask; wcHash requires a 16-byte key", () => {
    expect(() => wcTag(KEY, new Uint8Array(15), good)).toThrow(/mask/);
    expect(() => wcHash(new Uint8Array(15), good)).toThrow(/exactly 16 bytes/);
  });
});

describe("tagsEqual", () => {
  const tag = mustHex("5bb81c1ec47fe75e649f81d8280c64d9");

  it("equal 16-byte tags compare true (including a distinct copy)", () => {
    expect(tagsEqual(tag, tag)).toBe(true);
    expect(tagsEqual(tag, mustHex("5bb81c1ec47fe75e649f81d8280c64d9"))).toBe(true);
  });

  it("a single flipped bit compares false, wherever it is", () => {
    for (const index of [0, 7, 15]) {
      const flipped = new Uint8Array(tag);
      flipped[index] ^= 0x01;
      expect(tagsEqual(tag, flipped)).toBe(false);
    }
  });

  it("length mismatch is false via the length check — never a byte-wise early return", () => {
    expect(tagsEqual(tag, tag.subarray(0, 15))).toBe(false);
    expect(tagsEqual(tag.subarray(0, 15), tag)).toBe(false);
    expect(tagsEqual(new Uint8Array(17), new Uint8Array(17))).toBe(false); // equal but not 16 bytes
    expect(tagsEqual(new Uint8Array(0), new Uint8Array(0))).toBe(false);
  });
});
