import { describe, expect, it } from "vitest";

import { hkdf, hkdfExpand, hkdfExtract } from "../src/spt/hkdf";
import { bytesToHex } from "../src/core/hex";
import { hx } from "./helpers/spt-hex";

/* ============================================================================
 * RFC 5869 Appendix A — the SHA-256 vectors
 * ----------------------------------------------------------------------------
 * src/spt/hkdf.ts composes RFC 5869 over the platform's HMAC-SHA-256 because
 * WebCrypto's own HKDF caps `algorithm.info` at 1024 bytes on Node and §7.3's
 * AEAD-key info is 1219. That makes the composition ours, so it gets checked
 * against the standard's own vectors rather than against itself.
 *
 * Vectors A.1, A.2 and A.3 — the last of which uses a zero-length salt, the
 * case where "no salt" means HashLen zero bytes and not "skip the HMAC".
 * ========================================================================= */

type Vector = { name: string; ikm: string; salt: string; info: string; length: number; prk: string; okm: string };

const VECTORS: Vector[] = [
  {
    name: "A.1 basic",
    ikm: "0b".repeat(22),
    salt: "000102030405060708090a0b0c",
    info: "f0f1f2f3f4f5f6f7f8f9",
    length: 42,
    prk: "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5",
    okm: "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
  },
  {
    name: "A.2 longer inputs and output",
    ikm: Array.from({ length: 80 }, (_, i) => i.toString(16).padStart(2, "0")).join(""),
    salt: Array.from({ length: 80 }, (_, i) => (0x60 + i).toString(16).padStart(2, "0")).join(""),
    info: Array.from({ length: 80 }, (_, i) => (0xb0 + i).toString(16).padStart(2, "0")).join(""),
    length: 82,
    prk: "06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244",
    okm:
      "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09" +
      "da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87"
  },
  {
    name: "A.3 zero-length salt and info",
    ikm: "0b".repeat(22),
    salt: "",
    info: "",
    length: 42,
    prk: "19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04",
    okm: "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
  }
];

describe("HKDF-SHA-256 against RFC 5869 Appendix A", () => {
  for (const v of VECTORS) {
    it(`${v.name}: PRK`, async () => {
      expect(bytesToHex(await hkdfExtract(hx(v.salt), hx(v.ikm)))).toBe(v.prk);
    });

    it(`${v.name}: OKM from PRK`, async () => {
      expect(bytesToHex(await hkdfExpand(hx(v.prk), hx(v.info), v.length))).toBe(v.okm);
    });

    it(`${v.name}: extract-then-expand in one call`, async () => {
      expect(bytesToHex(await hkdf(hx(v.salt), hx(v.ikm), hx(v.info), v.length))).toBe(v.okm);
    });
  }

  it("expands across several HMAC blocks, not just the first", async () => {
    // A.2's 82 bytes needs three blocks; if the loop were wrong the first 32
    // would still be right, which is exactly the bug that hides.
    const v = VECTORS[1];
    const okm = await hkdfExpand(hx(v.prk), hx(v.info), v.length);
    expect(okm.length).toBe(82);
    expect(bytesToHex(okm.subarray(32, 64))).toBe(v.okm.slice(64, 128));
  });

  it("refuses more than 255 blocks", async () => {
    const prk = new Uint8Array(32);
    await expect(hkdfExpand(prk, new Uint8Array(0), 255 * 32 + 1)).rejects.toThrow(RangeError);
    await expect(hkdfExpand(prk, new Uint8Array(0), 255 * 32)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("info is not length-limited, which is the whole reason this file exists", async () => {
    // The §7.3 AEAD-key info is 1219 bytes. WebCrypto's HKDF rejects it on Node.
    const okm = await hkdf(new Uint8Array(32).fill(7), new Uint8Array(32).fill(9), new Uint8Array(1219).fill(3), 32);
    expect(okm.length).toBe(32);
  });
});
