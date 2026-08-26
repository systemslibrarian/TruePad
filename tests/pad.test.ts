import { describe, expect, it } from "vitest";
import {
  BYTE_BITS,
  BYTE_RANGE,
  LETTER_BITS,
  LETTER_RANGE,
  Pad,
  PadExhaustedError,
  type RandomFill,
  uniformInt
} from "../src/core/pad";

// Deterministic fill that replays a scripted byte sequence, so the rejection
// sampler can be tested against known inputs.
function scriptedFill(bytes: number[]): RandomFill {
  let index = 0;
  return (buffer) => {
    for (let i = 0; i < buffer.length; i += 1) {
      if (index >= bytes.length) {
        throw new Error("scripted fill ran out of bytes");
      }
      buffer[i] = bytes[index];
      index += 1;
    }
    return buffer;
  };
}

// Deterministic xorshift32 fill: statistically bland, fully reproducible.
function xorshiftFill(seed: number): RandomFill {
  let state = seed >>> 0;
  return (buffer) => {
    for (let i = 0; i < buffer.length; i += 1) {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      buffer[i] = state & 0xff;
    }
    return buffer;
  };
}

describe("uniformInt", () => {
  it("rejects invalid ranges", () => {
    expect(() => uniformInt(0)).toThrow();
    expect(() => uniformInt(-5)).toThrow();
    expect(() => uniformInt(257)).toThrow();
    expect(() => uniformInt(1.5)).toThrow();
  });

  it("rejection-samples away modulo bias for range 26 (limit 234)", () => {
    // 255, 240, 234 are all >= 234 and must be discarded; 235 too; then 10
    // is the first acceptable byte and 10 % 26 = 10.
    const fill = scriptedFill([255, 240, 235, 234, 10]);
    expect(uniformInt(LETTER_RANGE, fill)).toBe(10);
  });

  it("accepts byte 233 (the last unbiased value) and maps it mod 26", () => {
    expect(uniformInt(LETTER_RANGE, scriptedFill([233]))).toBe(233 % 26);
  });

  it("never rejects for range 256", () => {
    expect(uniformInt(BYTE_RANGE, scriptedFill([255]))).toBe(255);
    expect(uniformInt(BYTE_RANGE, scriptedFill([0]))).toBe(0);
  });
});

describe("Pad.generate", () => {
  it("draws every symbol inside the mode's range", () => {
    const letters = Pad.generate(500, "letters");
    for (let offset = 0; offset < 500; offset += 1) {
      const value = letters.valueAt(offset);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(LETTER_RANGE);
    }
    const bytes = Pad.generate(500, "bytes");
    for (let offset = 0; offset < 500; offset += 1) {
      const value = bytes.valueAt(offset);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(BYTE_RANGE);
    }
  });

  it("produces roughly uniform letter counts (statistical sanity)", () => {
    // 26,000 draws from crypto.getRandomValues: each letter expects 1000.
    // Std dev ≈ 31, so ±300 is a ~9.6σ band — this only fails if the
    // sampler is actually broken, not by bad luck.
    const pad = Pad.generate(26_000, "letters");
    const counts = new Array(LETTER_RANGE).fill(0);
    for (let offset = 0; offset < pad.size; offset += 1) {
      counts[pad.valueAt(offset)!] += 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(700);
      expect(count).toBeLessThan(1300);
    }
  });

  it("rejects a non-positive size", () => {
    expect(() => Pad.generate(0, "letters")).toThrow();
    expect(() => Pad.generate(-1, "bytes")).toThrow();
  });

  it("assigns a PAD-XXXX label and honours an explicit one", () => {
    expect(Pad.generate(5, "letters").label).toMatch(/^PAD-[A-Z]{4}$/);
    expect(Pad.generate(5, "letters", { label: "PAD-TEST" }).label).toBe("PAD-TEST");
  });
});

describe("burn invariant — a consumed offset can never be used again", () => {
  it("deletes consumed values irreversibly", () => {
    const pad = Pad.generate(10, "letters");
    const first = pad.consume(4);
    expect(first.map((symbol) => symbol.offset)).toEqual([0, 1, 2, 3]);
    for (const symbol of first) {
      expect(pad.valueAt(symbol.offset)).toBeUndefined();
    }
    expect(pad.remaining).toBe(6);
    expect(pad.spent).toBe(4);
  });

  it("never returns the same offset twice across a pad's whole life", () => {
    const pad = Pad.generate(50, "letters");
    const seen = new Set<number>();
    while (pad.remaining > 0) {
      const batch = pad.consume(Math.min(7, pad.remaining));
      for (const symbol of batch) {
        expect(seen.has(symbol.offset)).toBe(false);
        seen.add(symbol.offset);
      }
    }
    expect(seen.size).toBe(50);
    expect(() => pad.consume(1)).toThrow(PadExhaustedError);
  });

  it("keeps burned offsets burned through serialize/deserialize", () => {
    const pad = Pad.generate(12, "letters");
    const burned = pad.consume(5).map((symbol) => symbol.offset);
    const copy = Pad.deserialize(pad.serialize());
    for (const offset of burned) {
      expect(copy.valueAt(offset)).toBeUndefined();
      expect(pad.serialize()).not.toContain(`[${offset},`);
    }
    // The copy resumes where the original left off — offsets stay disjoint
    // from everything already burned.
    const next = copy.consume(copy.remaining).map((symbol) => symbol.offset);
    expect(next).toEqual([5, 6, 7, 8, 9, 10, 11]);
    expect(next.some((offset) => burned.includes(offset))).toBe(false);
  });
});

describe("refuse when short", () => {
  it("throws PadExhaustedError and burns nothing", () => {
    const pad = Pad.generate(8, "bytes");
    pad.consume(3);
    const before = pad.remaining;
    expect(() => pad.consume(6)).toThrow(PadExhaustedError);
    expect(pad.remaining).toBe(before);
    // The would-be offsets are all still intact.
    for (let offset = 3; offset < 8; offset += 1) {
      expect(pad.valueAt(offset)).toBeDefined();
    }
  });

  it("reports required vs remaining in the error", () => {
    const pad = Pad.generate(2, "letters");
    try {
      pad.consume(5);
      expect.unreachable("consume should have thrown");
    } catch (error) {
      const exhausted = error as PadExhaustedError;
      expect(exhausted.required).toBe(5);
      expect(exhausted.remaining).toBe(2);
      expect(exhausted.message).toContain("cannot borrow, wrap, or reuse");
    }
  });
});

describe("entropy ledger", () => {
  it("tracks generated, spent and remaining bits for letters", () => {
    const pad = Pad.generate(100, "letters");
    expect(pad.generatedBits).toBeCloseTo(100 * LETTER_BITS, 6);
    pad.consume(30);
    expect(pad.spentBits).toBeCloseTo(30 * LETTER_BITS, 6);
    expect(pad.remainingBits).toBeCloseTo(70 * LETTER_BITS, 6);
    expect(pad.spentBits + pad.remainingBits).toBeCloseTo(pad.generatedBits, 6);
  });

  it("counts 8 bits per byte-mode symbol", () => {
    const pad = Pad.generate(64, "bytes");
    expect(pad.generatedBits).toBe(64 * BYTE_BITS);
    pad.consume(10);
    expect(pad.spentBits).toBe(80);
    expect(pad.remainingBits).toBe(54 * BYTE_BITS);
  });
});

describe("deterministic generation with an injected fill", () => {
  it("is reproducible for the same scripted bytes", () => {
    const a = Pad.generate(20, "letters", { label: "PAD-SEED", randomFill: xorshiftFill(0xdecafbad) });
    const b = Pad.generate(20, "letters", { label: "PAD-SEED", randomFill: xorshiftFill(0xdecafbad) });
    for (let offset = 0; offset < 20; offset += 1) {
      expect(a.valueAt(offset)).toBe(b.valueAt(offset));
    }
  });
});

describe("deserialize enforces the burn invariant", () => {
  const base = { label: "PAD-TEST", mode: "letters", size: 4, nextOffset: 2 };

  it("accepts a well-formed pad and resumes at nextOffset", () => {
    const pad = Pad.deserialize(JSON.stringify({ ...base, symbols: [[2, 5], [3, 7]] }));
    expect(pad.remaining).toBe(2);
    expect(pad.highWaterMark).toBe(1);
  });

  it("rejects a symbol below nextOffset — it would be counted but unreachable", () => {
    // Before this check, such a pad made consume() spin forever: `remaining`
    // said 1 but the pointer could never reach offset 0.
    expect(() => Pad.deserialize(JSON.stringify({ ...base, symbols: [[0, 1]] }))).toThrow(/burn invariant/);
  });

  it("rejects offsets at or past size, duplicates, out-of-range values, and nextOffset outside [0, size]", () => {
    expect(() => Pad.deserialize(JSON.stringify({ ...base, symbols: [[4, 1]] }))).toThrow(/burn invariant/);
    expect(() => Pad.deserialize(JSON.stringify({ ...base, symbols: [[2, 1], [2, 3]] }))).toThrow(/burn invariant/);
    expect(() => Pad.deserialize(JSON.stringify({ ...base, symbols: [[2, 26]] }))).toThrow(/burn invariant/);
    expect(() => Pad.deserialize(JSON.stringify({ ...base, mode: "bytes", symbols: [[2, 256]] }))).toThrow(/burn invariant/);
    expect(() => Pad.deserialize(JSON.stringify({ ...base, nextOffset: 5, symbols: [] }))).toThrow(/nextOffset/);
    expect(() => Pad.deserialize(JSON.stringify({ ...base, nextOffset: -1, symbols: [] }))).toThrow(/nextOffset/);
  });
});

describe("deserialize requires the survivor set to be exactly [nextOffset, size)", () => {
  it("rejects a pad with holes — consumeAt would otherwise hand back the wrong offsets", () => {
    const holes = { label: "PAD-HOLE", mode: "letters", size: 10, nextOffset: 2, symbols: [[5, 1], [6, 2], [7, 3], [8, 4], [9, 5]] };
    expect(() => Pad.deserialize(JSON.stringify(holes))).toThrow(/contiguous/);
    const gap = { label: "PAD-HOLE", mode: "letters", size: 10, nextOffset: 0, symbols: [[0, 1], [1, 2], [2, 3], [8, 4], [9, 5]] };
    expect(() => Pad.deserialize(JSON.stringify(gap))).toThrow(/contiguous/);
  });

  it("accepts the full set and an empty tail", () => {
    const full = { label: "PAD-FULL", mode: "bytes", size: 3, nextOffset: 1, symbols: [[1, 200], [2, 7]] };
    expect(Pad.deserialize(JSON.stringify(full)).remaining).toBe(2);
    const drained = { label: "PAD-DONE", mode: "bytes", size: 3, nextOffset: 3, symbols: [] };
    expect(Pad.deserialize(JSON.stringify(drained)).remaining).toBe(0);
  });
});
