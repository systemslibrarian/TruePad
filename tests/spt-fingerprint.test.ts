import { describe, expect, it } from "vitest";

import { bytesToHex } from "../src/core/hex";
import { hx } from "./helpers/spt-hex";
import { asciiBytes, concatBytes } from "../src/spt/bytes";
import { confirmationIndices88, hashDomain, requestIndices132 } from "../src/spt/fingerprint";
import { DS_REQUEST_FP } from "../src/spt/constants";

/* ============================================================================
 * §6.2 H_ds, §6.3 requestWords132, §8.2 confirmationWords88
 * ----------------------------------------------------------------------------
 * The bit extraction is where a plausible-looking bug survives review. Every
 * boundary the brief names is exercised: all-zero, all-one, high bit only, the
 * four discarded low bits, and each 11-bit lane moving on its own.
 * ========================================================================= */

const bytes = (...v: number[]) => Uint8Array.from(v);

describe("H_ds", () => {
  it("is SHA-256 of uint8(len(DS)) ‖ DS ‖ X, computed independently here", async () => {
    const payload = asciiBytes("payload");
    const ds = asciiBytes(DS_REQUEST_FP);
    const manual = new Uint8Array(
      await crypto.subtle.digest("SHA-256", concatBytes(Uint8Array.of(ds.length), ds, payload))
    );
    expect(bytesToHex(await hashDomain(DS_REQUEST_FP, payload))).toBe(bytesToHex(manual));
  });

  it("is injective across separators — the length prefix is what does that", async () => {
    // Without the prefix, H("ab", "c") and H("a", "bc") would collide. With it
    // they cannot, because the first octet differs.
    const a = await hashDomain("ab", asciiBytes("c"));
    const b = await hashDomain("a", asciiBytes("bc"));
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("changes when any input byte changes", async () => {
    const one = await hashDomain(DS_REQUEST_FP, bytes(1, 2, 3));
    const two = await hashDomain(DS_REQUEST_FP, bytes(1, 2, 4));
    expect(bytesToHex(one)).not.toBe(bytesToHex(two));
  });
});

describe("requestIndices132", () => {
  it("returns twelve indices, each below 2048", () => {
    const idx = requestIndices132(hx("5288daabb08983e5eddd4ebcb27a905e4c9422e9866a47d53826c3347f971744"));
    expect(idx.length).toBe(12);
    for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
    for (const i of idx) expect(i).toBeLessThan(2048);
  });

  it("all-zero → twelve zeros", () => {
    expect(requestIndices132(new Uint8Array(32))).toEqual(Array(12).fill(0));
  });

  it("all-one → twelve 0x7ff", () => {
    expect(requestIndices132(new Uint8Array(32).fill(0xff))).toEqual(Array(12).fill(0x7ff));
  });

  it("high bit only → 0x400 in lane 0 and nothing anywhere else", () => {
    const h = new Uint8Array(32);
    h[0] = 0x80;
    expect(requestIndices132(h)).toEqual([0x400, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("the LOW FOUR BITS of byte 16 are discarded", () => {
    // The 132 bits are hash[0..17) >> 4, so the bottom nibble of the 17th byte
    // must not reach any index. If the shift were dropped, this fails.
    const base = new Uint8Array(32).fill(0xa5);
    for (let low = 0; low < 16; low += 1) {
      const variant = Uint8Array.from(base);
      variant[16] = (variant[16] & 0xf0) | low;
      expect(requestIndices132(variant), `low nibble ${low}`).toEqual(requestIndices132(base));
    }
    // ...but the HIGH nibble of byte 16 is the last lane's low bits and DOES.
    const moved = Uint8Array.from(base);
    moved[16] = (moved[16] & 0x0f) | 0x50;
    expect(requestIndices132(moved)).not.toEqual(requestIndices132(base));
  });

  it("bytes 17..32 are not read at all", () => {
    const a = new Uint8Array(32).fill(0x11);
    const b = Uint8Array.from(a);
    b.fill(0xee, 17);
    expect(requestIndices132(b)).toEqual(requestIndices132(a));
  });

  it("each 11-bit lane moves independently — one bit set per lane", () => {
    // Build a 132-bit value with exactly one lane set to 1, twelve times over,
    // and confirm each lands in its own lane.
    for (let lane = 0; lane < 12; lane += 1) {
      const m = 1n << BigInt(121 - 11 * lane);
      const n = m << 4n; // put the four discarded bits back
      const h = new Uint8Array(32);
      let v = n;
      for (let i = 16; i >= 0; i -= 1) {
        h[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      const expected = Array(12).fill(0);
      expected[lane] = 1;
      expect(requestIndices132(h), `lane ${lane}`).toEqual(expected);
    }
  });

  it("the twelve lanes partition all 132 bits with nothing shared", () => {
    // Reassemble the indices back into the 132-bit integer and compare with the
    // value read straight from the bytes. Any overlap or gap breaks this.
    const h = hx("0123456789abcdeffedcba98765432100f1e2d3c4b5a69788796a5b4c3d2e1f0");
    let n = 0n;
    for (let i = 0; i < 17; i += 1) n = (n << 8n) | BigInt(h[i]);
    const expected = n >> 4n;
    let rebuilt = 0n;
    for (const index of requestIndices132(h)) rebuilt = (rebuilt << 11n) | BigInt(index);
    expect(rebuilt).toBe(expected);
  });

  it("refuses a hash shorter than 17 bytes rather than reading past the end", () => {
    expect(() => requestIndices132(new Uint8Array(16))).toThrow(RangeError);
  });
});

describe("confirmationIndices88", () => {
  it("returns eight indices below 2048", () => {
    const idx = confirmationIndices88(hx("5d05c0d7749762262ff678"));
    expect(idx.length).toBe(8);
    for (const i of idx) expect(i).toBeLessThan(2048);
  });

  it("all-zero and all-one", () => {
    expect(confirmationIndices88(new Uint8Array(11))).toEqual(Array(8).fill(0));
    expect(confirmationIndices88(new Uint8Array(11).fill(0xff))).toEqual(Array(8).fill(0x7ff));
  });

  it("discards nothing — 88 bits is exactly 8 × 11", () => {
    const v = hx("0123456789abcdef012345");
    let n = 0n;
    for (let i = 0; i < 11; i += 1) n = (n << 8n) | BigInt(v[i]);
    let rebuilt = 0n;
    for (const index of confirmationIndices88(v)) rebuilt = (rebuilt << 11n) | BigInt(index);
    expect(rebuilt).toBe(n);
  });

  it("coincides with requestIndices132's first eight lanes on the same bytes — which is exactly why the names are kept apart", () => {
    // Both renderings cut 11-bit lanes from the TOP of the same byte string,
    // and 8 × 11 = 88 sits entirely above the four bits requestIndices132
    // discards at the BOTTOM of its 136-bit window. So on identical leading
    // bytes the first eight indices are identical.
    //
    // That is an arithmetic fact, not a defect — and it is precisely the reason
    // §8.2 insists the two ceremonies be NAMED apart. Their outputs look
    // interchangeable; what makes them different is the value each is computed
    // over (requestHash vs confirmValue), how many words are read, and which
    // threat model each answers. Nothing in the numbers would stop an
    // implementer from feeding one to the other, so the type of the argument
    // and the name of the function have to.
    const h = hx("5288daabb08983e5eddd4ebcb27a905e4c9422e9866a47d53826c3347f971744");
    expect(confirmationIndices88(h.subarray(0, 11))).toEqual(requestIndices132(h).slice(0, 8));
    // They still differ in what they read and how much they return.
    expect(requestIndices132(h).length).toBe(12);
    expect(confirmationIndices88(h.subarray(0, 11)).length).toBe(8);
    // ...and the last four lanes have no counterpart at all.
    expect(requestIndices132(h).slice(8).length).toBe(4);
  });

  it("refuses a value shorter than 11 bytes", () => {
    expect(() => confirmationIndices88(new Uint8Array(10))).toThrow(RangeError);
  });
});
