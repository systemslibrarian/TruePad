import { describe, expect, it } from "vitest";

import * as C from "../src/spt/constants";
import { asciiBytes } from "../src/spt/bytes";
import { domainPrefix } from "../src/spt/fingerprint";

/* ============================================================================
 * Sealed Pad Transfer — the frozen constants
 * ----------------------------------------------------------------------------
 * §6.2 of the specification says the domain-separator length octets MUST be
 * measured and MUST NOT be hard-coded, and gives the reason: a wrong constant
 * does not fail loudly, it silently forks requestHash — and with it the safety
 * words, the HKDF salt, and AAD bytes [23, 55) — between two conforming builds,
 * producing exactly the symptom of an active attack. For DS_PAD it is worse:
 * padHash never reaches the wire, so two builds would derive different nonces
 * for the same pad and every package would still verify.
 *
 * The document records that this mistake has now been made twice — 33 for a
 * 34-byte separator, then 28 for a 29-byte one. These assertions are the
 * mechanical check it asks for.
 * ========================================================================= */

describe("domain separators", () => {
  const EXPECTED: Array<[string, number]> = [
    [C.DS_REQUEST_FP, 34],
    [C.DS_AEAD_KEY, 23],
    [C.DS_CONFIRM, 36],
    [C.DS_NONCE, 25],
    [C.DS_PAD, 29]
  ];

  it("are the exact strings the specification freezes", () => {
    expect(C.DS_REQUEST_FP).toBe("TruePad/SPT/v1/request-fingerprint");
    expect(C.DS_AEAD_KEY).toBe("TruePad/SPT/v1/aead-key");
    expect(C.DS_CONFIRM).toBe("TruePad/SPT/v1/transfer-confirmation");
    expect(C.DS_NONCE).toBe("TruePad/SPT/v1/aead-nonce");
    expect(C.DS_PAD).toBe("TruePad/SPT/v1/pad-commitment");
  });

  it("have the measured lengths 34 / 23 / 36 / 25 / 29", () => {
    for (const [ds, length] of EXPECTED) {
      expect(asciiBytes(ds).length, `${ds} byte length`).toBe(length);
    }
  });

  it("are all five distinct, so the prefixes cannot collide", () => {
    const all = EXPECTED.map(([ds]) => ds);
    expect(new Set(all).size).toBe(all.length);
  });

  it("build a prefix whose first octet IS the measured length", () => {
    for (const [ds, length] of EXPECTED) {
      const prefix = domainPrefix(ds);
      expect(prefix.length).toBe(1 + length);
      expect(prefix[0]).toBe(length);
      expect(Array.from(prefix.subarray(1))).toEqual(Array.from(asciiBytes(ds)));
    }
  });

  it("refuses a separator outside 1..255", () => {
    expect(() => domainPrefix("")).toThrow(RangeError);
    expect(() => domainPrefix("x".repeat(256))).toThrow(RangeError);
    expect(() => domainPrefix("x".repeat(255))).not.toThrow();
  });

  it("refuses a non-ASCII separator, where character count ≠ byte count", () => {
    // The whole scheme assumes uint8(len(DS)) is unambiguous. A multi-byte
    // character would make "length" mean two different things.
    expect(() => domainPrefix("TruePad/SPT/v1/café")).toThrow();
  });
});

describe("frozen sizes", () => {
  it("X-Wing suite 0x0001", () => {
    expect(C.XWING_SEED_BYTES).toBe(32);
    expect(C.XWING_PUBLIC_KEY_BYTES).toBe(1216);
    expect(C.XWING_CIPHERTEXT_BYTES).toBe(1120);
    expect(C.XWING_SHARED_SECRET_BYTES).toBe(32);
    expect(C.XWING_ESEED_BYTES).toBe(64);
    // The concatenations must add up, or one of the halves is wrong.
    expect(C.MLKEM_PUBLIC_KEY_BYTES + C.X25519_BYTES).toBe(C.XWING_PUBLIC_KEY_BYTES);
    expect(C.MLKEM_CIPHERTEXT_BYTES + C.X25519_BYTES).toBe(C.XWING_CIPHERTEXT_BYTES);
  });

  it("TPR2 — 1235 bytes, 1652 characters", () => {
    expect(1 + 2 + C.REQUEST_ID_BYTES + C.XWING_PUBLIC_KEY_BYTES).toBe(C.TPR2_BODY_BYTES);
    expect(C.TPR2_BODY_BYTES).toBe(1235);
    expect(C.TPR2_PREFIX.length + Math.ceil((C.TPR2_BODY_BYTES * 4) / 3)).toBe(C.TPR2_TEXT_CHARS);
    expect(C.TPR2_TEXT_CHARS).toBe(1652);
  });

  it("TPS2 — a 1195-byte header that is also the AAD, 1211 fixed overhead", () => {
    const header =
      4 + 1 + 2 + C.REQUEST_ID_BYTES + C.REQUEST_HASH_BYTES + C.XWING_CIPHERTEXT_BYTES + C.AEAD_NONCE_BYTES + 8;
    expect(header).toBe(C.TPS2_HEADER_BYTES);
    expect(C.TPS2_HEADER_BYTES).toBe(1195);
    expect(C.TPS2_HEADER_BYTES + C.AEAD_TAG_BYTES).toBe(C.TPS2_FIXED_OVERHEAD_BYTES);
    expect(C.TPS2_FIXED_OVERHEAD_BYTES).toBe(1211);
    expect(C.MAX_PLAINTEXT_BYTES).toBe(16_777_216);
  });

  it("the header offsets are contiguous and end exactly at the AAD boundary", () => {
    const o = C.TPS2_OFFSETS;
    expect(o.magic).toBe(0);
    expect(o.version).toBe(o.magic + 4);
    expect(o.suite).toBe(o.version + 1);
    expect(o.requestId).toBe(o.suite + 2);
    expect(o.requestHash).toBe(o.requestId + C.REQUEST_ID_BYTES);
    expect(o.kemCiphertext).toBe(o.requestHash + C.REQUEST_HASH_BYTES);
    expect(o.nonce).toBe(o.kemCiphertext + C.XWING_CIPHERTEXT_BYTES);
    expect(o.plaintextLength).toBe(o.nonce + C.AEAD_NONCE_BYTES);
    expect(o.ciphertext).toBe(o.plaintextLength + 8);
    expect(o.ciphertext).toBe(C.TPS2_HEADER_BYTES);
  });

  it("version, suite, prefix and magic", () => {
    expect(C.TRANSFER_VERSION).toBe(0x01);
    expect(C.SUITE_ID).toBe(0x0001);
    expect(C.TPR2_PREFIX).toBe("TPR2:");
    expect(C.TPS2_MAGIC).toBe("TPS2");
    expect(Array.from(C.TPS2_MAGIC_BYTES)).toEqual([0x54, 0x50, 0x53, 0x32]);
    expect(Array.from(asciiBytes(C.TPS2_MAGIC))).toEqual(Array.from(C.TPS2_MAGIC_BYTES));
  });

  it("the two word renderings are different sizes, and say so", () => {
    expect(C.REQUEST_WORDS_COUNT * 11).toBe(C.REQUEST_WORDS_BITS);
    expect(C.REQUEST_WORDS_BITS).toBe(132);
    expect(C.CONFIRM_WORDS_COUNT * 11).toBe(C.CONFIRM_WORDS_BITS);
    expect(C.CONFIRM_WORDS_BITS).toBe(88);
    expect(C.CONFIRM_VALUE_BYTES * 8).toBe(C.CONFIRM_WORDS_BITS);
    expect(C.WORDLIST_SIZE).toBe(2 ** 11);
  });
});
