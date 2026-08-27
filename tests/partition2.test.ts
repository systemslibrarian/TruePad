import { describe, expect, it } from "vitest";
import { authRecordAt, combineSources, partition, requiredSourceLength } from "../src/core/partition2";
import { AUTH_RECORD_BYTES } from "../src/core/wc-one-time";

/* ============================================================================
 * FORMAT-V2.md §7 — the source-material partition.
 *
 * L = 2·(E + 32·N); the combined material is carved as
 * [abEnc E][abAuth 32N][baEnc E][baAuth 32N], every byte in exactly one
 * slice at exactly one position, copies rather than views, and within an
 * auth slice record s is K_s at [32s, 32s+16) then R_s at [32s+16, 32s+32).
 * ========================================================================= */

// Small budgets keep every expected byte spellable by hand.
const E = 5;
const N = 2;
const L = 2 * (E + 32 * N); // 138

// combined[i] = i: a counting pattern makes "which byte went where" exact.
const counting = (length: number): Uint8Array => Uint8Array.from({ length }, (_, i) => i % 256);

describe("requiredSourceLength — L = 2·(E + 32·N)", () => {
  it("computes the formula exactly", () => {
    expect(requiredSourceLength(5, 2)).toBe(138);
    expect(requiredSourceLength(0, 0)).toBe(0);
    expect(requiredSourceLength(100, 3)).toBe(2 * (100 + 96));
    // The §1.1 example budgets: E = 1 MiB, N = 32768 records.
    expect(requiredSourceLength(1048576, 32768)).toBe(4194304);
  });

  it("AUTH_RECORD_BYTES is the 32 in the formula", () => {
    expect(AUTH_RECORD_BYTES).toBe(32);
    expect(requiredSourceLength(0, 1)).toBe(2 * AUTH_RECORD_BYTES);
  });

  it("throws on negative, fractional, or unsafe budgets", () => {
    expect(() => requiredSourceLength(-1, 0)).toThrow(/capacity/);
    expect(() => requiredSourceLength(0, -1)).toThrow(/capacityRecords/);
    expect(() => requiredSourceLength(1.5, 0)).toThrow(/capacity/);
    expect(() => requiredSourceLength(0, 2 ** 53)).toThrow(/capacityRecords/);
  });
});

describe("combineSources — bytewise XOR of the first `length` bytes", () => {
  it("one source: the first `length` bytes, copied", () => {
    const source = counting(10);
    const combined = combineSources([source], 6);
    expect([...combined]).toEqual([0, 1, 2, 3, 4, 5]);
    // A copy, not a view: mutating the result leaves the source alone.
    combined[0] = 0xff;
    expect(source[0]).toBe(0);
  });

  it("several sources XOR bytewise", () => {
    const a = Uint8Array.from([0x00, 0xff, 0x0f, 0xa5]);
    const b = Uint8Array.from([0xff, 0xff, 0xf0, 0x5a]);
    const c = Uint8Array.from([0x01, 0x02, 0x03, 0x04]);
    expect([...combineSources([a, b], 4)]).toEqual([0xff, 0x00, 0xff, 0xff]);
    expect([...combineSources([a, b, c], 4)]).toEqual([0xfe, 0x02, 0xfc, 0xfb]);
  });

  it("surplus beyond `length` is not used", () => {
    const a = Uint8Array.from([1, 2, 0xde, 0xad]);
    const b = Uint8Array.from([4, 8, 0xbe, 0xef]);
    expect([...combineSources([a, b], 2)]).toEqual([5, 10]);
  });

  it("throws when any source is shorter than `length` — all-or-nothing", () => {
    const long = counting(10);
    const short = counting(9);
    expect(() => combineSources([long, short], 10)).toThrow(/source 1 supplies 9 bytes/);
    expect(() => combineSources([short, long], 10)).toThrow(/source 0 supplies 9 bytes/);
  });

  it("throws on an empty source list and on a bad length", () => {
    expect(() => combineSources([], 4)).toThrow(/at least one source/);
    expect(() => combineSources([counting(4)], -1)).toThrow(/length/);
    expect(() => combineSources([counting(4)], 1.5)).toThrow(/length/);
  });
});

describe("partition — [abEnc E][abAuth 32N][baEnc E][baAuth 32N], exact", () => {
  it("every combined byte lands in exactly one slice at the right position", () => {
    const combined = counting(L);
    const slices = partition(combined, E, N);

    expect(slices.abEncryption.length).toBe(E);
    expect(slices.abAuthentication.length).toBe(32 * N);
    expect(slices.baEncryption.length).toBe(E);
    expect(slices.baAuthentication.length).toBe(32 * N);
    // The four lengths cover L exactly — no byte unassigned, none doubled...
    expect(E + 32 * N + E + 32 * N).toBe(L);

    // ...and each position maps per §7: byte e ↦ slice-local offset e.
    for (let e = 0; e < E; e += 1) {
      expect(slices.abEncryption[e]).toBe(combined[e]);
      expect(slices.baEncryption[e]).toBe(combined[E + 32 * N + e]);
    }
    for (let j = 0; j < 32 * N; j += 1) {
      expect(slices.abAuthentication[j]).toBe(combined[E + j]);
      expect(slices.baAuthentication[j]).toBe(combined[2 * E + 32 * N + j]);
    }

    // Concatenating the slices in §7 order reproduces the combined material.
    const rejoined = [
      ...slices.abEncryption,
      ...slices.abAuthentication,
      ...slices.baEncryption,
      ...slices.baAuthentication
    ];
    expect(rejoined).toEqual([...combined]);
  });

  it("returns copies, never views: zeroing the combined buffer leaves the slices intact", () => {
    const combined = counting(L);
    const slices = partition(combined, E, N);
    combined.fill(0);
    expect(slices.abEncryption[1]).toBe(1);
    expect(slices.abAuthentication[0]).toBe(E);
    expect(slices.baEncryption[0]).toBe(E + 32 * N);
    expect(slices.baAuthentication[0]).toBe(2 * E + 32 * N);
    // And none of the slices aliases the combined buffer's storage.
    for (const slice of Object.values(slices)) {
      expect(slice.buffer).not.toBe(combined.buffer);
    }
  });

  it("throws on a length mismatch — one byte short or one byte long", () => {
    expect(() => partition(counting(L - 1), E, N)).toThrow(/needs exactly 138/);
    expect(() => partition(counting(L + 1), E, N)).toThrow(/needs exactly 138/);
  });

  it("zero budgets partition an empty buffer", () => {
    const slices = partition(new Uint8Array(0), 0, 0);
    expect(slices.abEncryption.length).toBe(0);
    expect(slices.abAuthentication.length).toBe(0);
    expect(slices.baEncryption.length).toBe(0);
    expect(slices.baAuthentication.length).toBe(0);
  });
});

describe("authRecordAt — K_s first, then R_s, in slice-local offsets", () => {
  it("record s is bytes [32s, 32s+16) as key and [32s+16, 32s+32) as mask", () => {
    const slice = counting(32 * N);
    const record0 = authRecordAt(slice, 0);
    expect([...record0.key]).toEqual([...slice.slice(0, 16)]);
    expect([...record0.mask]).toEqual([...slice.slice(16, 32)]);
    const record1 = authRecordAt(slice, 1);
    expect([...record1.key]).toEqual([...slice.slice(32, 48)]);
    expect([...record1.mask]).toEqual([...slice.slice(48, 64)]);
    expect(record1.key.length).toBe(16);
    expect(record1.mask.length).toBe(16);
  });

  it("returns copies: mutating a returned record leaves the slice alone", () => {
    const slice = counting(64);
    const { key, mask } = authRecordAt(slice, 0);
    key.fill(0xff);
    mask.fill(0xff);
    expect(slice[0]).toBe(0);
    expect(slice[16]).toBe(16);
  });

  it("throws past the end of the slice, and on a bad sequence", () => {
    const slice = counting(64); // exactly two records
    expect(authRecordAt(slice, 1).key.length).toBe(16);
    expect(() => authRecordAt(slice, 2)).toThrow(/auth record 2/);
    expect(() => authRecordAt(slice, -1)).toThrow(/sequence/);
    expect(() => authRecordAt(slice, 0.5)).toThrow(/sequence/);
  });
});

describe("§7 end to end: combine, partition, address a record", () => {
  it("a record read from a partitioned XOR of two sources matches the bytes computed by hand", () => {
    const sourceA = counting(L);
    const sourceB = Uint8Array.from({ length: L }, (_, i) => (i * 7 + 3) % 256);
    const combined = combineSources([sourceA, sourceB], L);
    const slices = partition(combined, E, N);
    const { key, mask } = authRecordAt(slices.abAuthentication, 1);
    // A->B auth record 1 sits at absolute offsets [E+32, E+64) of the
    // combined material.
    for (let i = 0; i < 16; i += 1) {
      expect(key[i]).toBe(sourceA[E + 32 + i] ^ sourceB[E + 32 + i]);
      expect(mask[i]).toBe(sourceA[E + 48 + i] ^ sourceB[E + 48 + i]);
    }
  });
});
