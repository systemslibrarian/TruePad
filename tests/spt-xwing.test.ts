import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { bytesToHex } from "../src/core/hex";
import { hx } from "./helpers/spt-hex";
import {
  decapsulate,
  encapsulate,
  encapsulateDerand,
  generateKeyPair,
  generateKeyPairDerand
} from "../src/spt/xwing-v1";
import {
  XWING_CIPHERTEXT_BYTES,
  XWING_PUBLIC_KEY_BYTES,
  XWING_SEED_BYTES,
  XWING_SHARED_SECRET_BYTES
} from "../src/spt/constants";

/* ============================================================================
 * VECTOR A — draft-connolly-cfrg-xwing-kem-10, Appendix C
 * ----------------------------------------------------------------------------
 * The suite's authoritative vectors, byte-for-byte.
 *
 * PROVENANCE CAVEAT, recorded rather than assumed. Appendix C carries the
 * draft's own editorial qualification — its heading reads "Test vectors # TODO:
 * replace with test vectors that re-use ML-KEM, X25519 values" — and it is an
 * Internet-Draft artifact, not a validated standard's, and not NIST CAVP. That
 * is why §2.2.2 also demands an INDEPENDENT implementation: a vector that only
 * agrees with itself proves nothing. See docs/SEALED-PAD-TRANSFER-VALIDATION.md
 * for the cross-implementation run against rxwing 0.1.0-draft10.
 *
 * The fixture was extracted verbatim from the published draft text; the
 * extraction is checked below by re-deriving every value from `seed`/`eseed`.
 * ========================================================================= */

type XWingVector = { seed: string; sk: string; pk: string; eseed: string; ct: string; ss: string };

const VECTORS: XWingVector[] = JSON.parse(
  readFileSync(join(resolve(__dirname, "fixtures"), "xwing-draft10-appendix-c.json"), "utf8")
);

describe("X-Wing suite 0x0001 — draft-10 Appendix C", () => {
  it("the fixture has three complete vectors at the frozen sizes", () => {
    expect(VECTORS.length).toBe(3);
    for (const v of VECTORS) {
      expect(v.seed.length / 2).toBe(XWING_SEED_BYTES);
      expect(v.sk).toBe(v.seed); // the packed secret key IS the seed
      expect(v.pk.length / 2).toBe(XWING_PUBLIC_KEY_BYTES);
      expect(v.eseed.length / 2).toBe(64);
      expect(v.ct.length / 2).toBe(XWING_CIPHERTEXT_BYTES);
      expect(v.ss.length / 2).toBe(XWING_SHARED_SECRET_BYTES);
    }
  });

  VECTORS.forEach((v, i) => {
    it(`vector ${i + 1}: GenerateKeyPairDerand(sk) reproduces pk`, () => {
      const kp = generateKeyPairDerand(hx(v.seed));
      expect(bytesToHex(kp.encapsulationKey)).toBe(v.pk);
      // TruePad's persisted private key is the 32-byte seed, never an expanded
      // implementation-specific structure (§12 of the Phase 1A brief).
      expect(bytesToHex(kp.decapsulationSeed)).toBe(v.sk);
    });

    it(`vector ${i + 1}: EncapsulateDerand(pk, eseed) reproduces ct and ss`, () => {
      const enc = encapsulateDerand(hx(v.pk), hx(v.eseed));
      expect(bytesToHex(enc.ciphertext)).toBe(v.ct);
      expect(bytesToHex(enc.sharedSecret)).toBe(v.ss);
    });

    it(`vector ${i + 1}: Decapsulate(ct, sk) reproduces ss`, () => {
      expect(bytesToHex(decapsulate(hx(v.ct), hx(v.sk)))).toBe(v.ss);
    });
  });
});

describe("the production surfaces", () => {
  it("generate, encapsulate and decapsulate agree", () => {
    const kp = generateKeyPair();
    expect(kp.decapsulationSeed.length).toBe(XWING_SEED_BYTES);
    expect(kp.encapsulationKey.length).toBe(XWING_PUBLIC_KEY_BYTES);
    const enc = encapsulate(kp.encapsulationKey);
    expect(enc.ciphertext.length).toBe(XWING_CIPHERTEXT_BYTES);
    expect(bytesToHex(decapsulate(enc.ciphertext, kp.decapsulationSeed))).toBe(bytesToHex(enc.sharedSecret));
  });

  it("are randomized — two key pairs and two encapsulations differ", () => {
    // Not a randomness test and not a certification of one: this only catches a
    // production path that has quietly become deterministic.
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(bytesToHex(a.decapsulationSeed)).not.toBe(bytesToHex(b.decapsulationSeed));
    const e1 = encapsulate(a.encapsulationKey);
    const e2 = encapsulate(a.encapsulationKey);
    expect(bytesToHex(e1.ciphertext)).not.toBe(bytesToHex(e2.ciphertext));
    expect(bytesToHex(e1.sharedSecret)).not.toBe(bytesToHex(e2.sharedSecret));
  });

  it("take no seed argument on the production path", () => {
    // §13: deterministic randomness is a TEST surface. If these ever grow an
    // optional seed parameter, a caller can pin the shared secret.
    expect(generateKeyPair.length).toBe(0);
    expect(encapsulate.length).toBe(1);
  });
});

describe("falsification", () => {
  const kp = generateKeyPairDerand(hx(VECTORS[0].seed));

  it("refuses a wrong-size encapsulation key", () => {
    expect(() => encapsulate(kp.encapsulationKey.subarray(0, 1215))).toThrow(RangeError);
    expect(() => encapsulate(new Uint8Array(XWING_PUBLIC_KEY_BYTES + 1))).toThrow(RangeError);
  });

  it("refuses a wrong-size ciphertext or seed on decapsulation", () => {
    const enc = encapsulateDerand(kp.encapsulationKey, hx(VECTORS[0].eseed));
    expect(() => decapsulate(enc.ciphertext.subarray(0, 1119), kp.decapsulationSeed)).toThrow(RangeError);
    expect(() => decapsulate(enc.ciphertext, kp.decapsulationSeed.subarray(0, 31))).toThrow(RangeError);
  });

  it("refuses a wrong-size eseed", () => {
    expect(() => encapsulateDerand(kp.encapsulationKey, new Uint8Array(63))).toThrow(RangeError);
    expect(() => encapsulateDerand(kp.encapsulationKey, new Uint8Array(65))).toThrow(RangeError);
  });

  it("performs the FIPS 203 §7.2 encapsulation-key check", () => {
    // A pk_M whose 12-bit coefficients do not re-encode canonically is refused,
    // which is what §7.2's modulus check is for. §2.2 requires Encaps to do this
    // and Decaps not to.
    const bad = Uint8Array.from(kp.encapsulationKey);
    bad.fill(0xff, 0, 384);
    expect(() => encapsulate(bad)).toThrow(/modulus/i);
  });

  it("a modified pk_M changes the shared secret", () => {
    const bad = Uint8Array.from(kp.encapsulationKey);
    bad[0] ^= 0x01;
    const good = encapsulateDerand(kp.encapsulationKey, hx(VECTORS[0].eseed));
    const evil = encapsulateDerand(bad, hx(VECTORS[0].eseed));
    expect(bytesToHex(evil.sharedSecret)).not.toBe(bytesToHex(good.sharedSecret));
  });

  it("a modified pk_X changes the shared secret — the combiner hashes pk_X", () => {
    const bad = Uint8Array.from(kp.encapsulationKey);
    bad[1184] ^= 0x01;
    const good = encapsulateDerand(kp.encapsulationKey, hx(VECTORS[0].eseed));
    const evil = encapsulateDerand(bad, hx(VECTORS[0].eseed));
    expect(bytesToHex(evil.sharedSecret)).not.toBe(bytesToHex(good.sharedSecret));
  });

  it("a modified ct_M or ct_X changes what decapsulation yields", () => {
    const enc = encapsulateDerand(kp.encapsulationKey, hx(VECTORS[0].eseed));
    const ctM = Uint8Array.from(enc.ciphertext);
    ctM[0] ^= 0x01; // inside ct_M
    expect(bytesToHex(decapsulate(ctM, kp.decapsulationSeed))).not.toBe(bytesToHex(enc.sharedSecret));
    const ctX = Uint8Array.from(enc.ciphertext);
    ctX[1088] ^= 0x01; // inside ct_X
    expect(bytesToHex(decapsulate(ctX, kp.decapsulationSeed))).not.toBe(bytesToHex(enc.sharedSecret));
  });

  it("decapsulating with the wrong seed yields a different shared secret", () => {
    const enc = encapsulateDerand(kp.encapsulationKey, hx(VECTORS[0].eseed));
    const other = generateKeyPairDerand(hx(VECTORS[1].seed));
    expect(bytesToHex(decapsulate(enc.ciphertext, other.decapsulationSeed))).not.toBe(
      bytesToHex(enc.sharedSecret)
    );
  });
});

describe("the one behavioural divergence from the frozen construction", () => {
  /* §2.2 freezes Decapsulate as `ss_X = X25519(sk_X, ct_X)` with NO all-zero
   * check — draft-10 is silent on one, and the document says TruePad adds none.
   *
   * @noble/post-quantum 0.7.1 inherits @noble/curves' all-zero rejection, so on
   * a ct_X that is a low-order point it THROWS where the frozen construction
   * would return a combined secret. The independent implementation rxwing
   * 0.1.0-draft10 returns one; the divergence is real and is recorded, not
   * papered over, in docs/SEALED-PAD-TRANSFER-VALIDATION.md.
   *
   * This test pins the CURRENT behaviour so a library change is noticed. The
   * protocol-level consequence — that the divergence is not observable through
   * openPayloadV1 — is demonstrated in spt-vectors.test.ts.
   */
  it("throws on a low-order ct_X, where draft-10 returns a shared secret", () => {
    const enc = encapsulateDerand(kp2().encapsulationKey, hx(VECTORS[0].eseed));
    const lowOrder = Uint8Array.from(enc.ciphertext);
    lowOrder.set(new Uint8Array(32), 1088); // the all-zero u-coordinate
    expect(() => decapsulate(lowOrder, kp2().decapsulationSeed)).toThrow();
  });

  function kp2() {
    return generateKeyPairDerand(hx(VECTORS[0].seed));
  }
});
