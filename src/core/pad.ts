/* ============================================================================
 * TruePad pad core
 * ----------------------------------------------------------------------------
 * Pure functions and one small class. No DOM, no localStorage, no CSS imports.
 * Everything in this file can be unit-tested in a plain Node test runner.
 *
 * A TruePad pad is the real thing DeckBook only gestures at:
 *
 *   - Every pad symbol is one draw, range-reduced by rejection sampling. No
 *     deck, no permutation, no mod-26 folding of a larger range. Never
 *     Math.random(). The draws come from crypto.getRandomValues() (source
 *     "csprng": a DRBG, so "independent uniform" holds computationally and
 *     the whole pad is bounded by the generator's state entropy) or from
 *     operator-supplied material (source "external": provenance asserted by
 *     the operator, not verified here). The pad records which. verdict.ts
 *     grades the two separately.
 *   - Letter mode draws one uniform value 0..25 per symbol (log2 26 ≈ 4.700
 *     bits each). Byte mode draws one uniform byte 0..255 (8 bits each).
 *   - Consuming a symbol BURNS it: the value is deleted from the pad, not
 *     flagged. No API on this instance can return a burned value, and
 *     serialize() never carries one — but an OLDER serialization still
 *     does. Durability across crashes and copies is the CLI store's job
 *     (a high-water mark kept apart from the pad file), not this class's.
 * ========================================================================= */

export type PadMode = "letters" | "bytes";

// Where the symbols came from. "csprng" = crypto.getRandomValues(), a DRBG.
// "external" = the operator supplied the bytes and asserts their origin;
// this code cannot verify physical provenance and never claims to.
export type PadSource = "csprng" | "external";

// The two parties, and which way a pad carries traffic. A pad is burned by
// its sender to encrypt and by its receiver to decrypt; the cipher refuses
// the other way round, and refuses both encrypting, against the caller's
// DECLARED role (it cannot tell who is really calling). Two-way traffic
// needs the PAIR.
export type Party = "A" | "B";
export type PadDirection = "A->B" | "B->A";

export const senderOf = (direction: PadDirection): Party => (direction === "A->B" ? "A" : "B");
export const receiverOf = (direction: PadDirection): Party => (direction === "A->B" ? "B" : "A");
export const oppositeDirection = (direction: PadDirection): PadDirection => (direction === "A->B" ? "B->A" : "A->B");

export type PadPair = { "A->B": Pad; "B->A": Pad };

export type PadSymbol = { offset: number; value: number };

export type PadSnapshot = {
  label: string;
  mode: PadMode;
  source: PadSource;
  direction: PadDirection;
  size: number;
  remaining: number;
  spent: number;
  bitsPerSymbol: number;
  generatedBits: number;
  spentBits: number;
  remainingBits: number;
};

export const LETTER_RANGE = 26;
export const BYTE_RANGE = 256;

// Entropy per symbol: log2 of the symbol alphabet size.
export const LETTER_BITS = Math.log2(LETTER_RANGE); // ≈ 4.700
export const BYTE_BITS = 8;

// Injectable byte source for the rejection sampler. Pad.generate feeds it
// crypto.getRandomValues; Pad.fromExternal feeds it the operator's bytes;
// tests may inject a known sequence.
export type RandomFill = (buffer: Uint8Array) => Uint8Array;

const cryptoFill: RandomFill = (buffer) => crypto.getRandomValues(buffer);

// Uniform integer in [0, maxExclusive) drawn one byte at a time. Rejection
// sampling removes modulo bias: bytes >= limit are discarded and redrawn, so
// every residue class is hit by exactly limit / maxExclusive byte values.
// For maxExclusive = 26 the limit is 234 (26 * 9); for 256 nothing is ever
// rejected.
export function uniformInt(maxExclusive: number, randomFill: RandomFill = cryptoFill): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > BYTE_RANGE) {
    throw new Error("maxExclusive must be an integer between 1 and 256");
  }
  const limit = BYTE_RANGE - (BYTE_RANGE % maxExclusive);
  const buffer = new Uint8Array(1);
  while (true) {
    randomFill(buffer);
    if (buffer[0] < limit) {
      return buffer[0] % maxExclusive;
    }
  }
}

export function bitsPerSymbol(mode: PadMode): number {
  return mode === "letters" ? LETTER_BITS : BYTE_BITS;
}

export function symbolRange(mode: PadMode): number {
  return mode === "letters" ? LETTER_RANGE : BYTE_RANGE;
}

// Thrown when a consume would need more symbols than the pad still holds.
// Consumption is all-or-nothing: a refused consume burns nothing.
export class PadExhaustedError extends Error {
  readonly required: number;
  readonly remaining: number;

  constructor(required: number, remaining: number) {
    super(
      `Pad exhausted: ${required} symbols needed but only ${remaining} remain. ` +
        "A one-time pad cannot borrow, wrap, or reuse."
    );
    this.name = "PadExhaustedError";
    this.required = required;
    this.remaining = remaining;
  }
}

// Thrown when a seek names an offset at or below the high-water mark — the
// highest offset this pad has ever burned. Every offset up to the mark is
// gone, so honouring the request would mean reuse. Nothing is burned.
export class PadReuseError extends Error {
  readonly offset: number;
  readonly highWaterMark: number;

  constructor(offset: number, highWaterMark: number) {
    super(
      `Reuse refused: offset ${offset} is at or below the high-water mark ${highWaterMark}. ` +
        "Every offset up to the mark has already been burned; a one-time pad never revisits one."
    );
    this.name = "PadReuseError";
    this.offset = offset;
    this.highWaterMark = highWaterMark;
  }
}

// Raised inside fromExternal's fill when the operator's material runs out.
class ExternalMaterialExhausted extends Error {}

// Human-readable pad-page label, e.g. "PAD-KQZM". The label is the only pad
// artifact allowed on the public channel; it identifies which pad page a
// ciphertext needs without revealing any pad symbol.
function randomLabel(randomFill: RandomFill): string {
  let letters = "";
  for (let i = 0; i < 4; i += 1) {
    letters += String.fromCharCode(65 + uniformInt(LETTER_RANGE, randomFill));
  }
  return `PAD-${letters}`;
}

export class Pad {
  readonly label: string;
  readonly mode: PadMode;
  readonly source: PadSource;
  readonly direction: PadDirection;
  readonly size: number;

  // offset -> value for symbols not yet consumed. Burning DELETES the entry;
  // no other field retains the value, which is what makes reuse through
  // this instance impossible rather than merely forbidden.
  #values: Map<number, number>;
  #nextOffset: number;

  private constructor(
    label: string,
    mode: PadMode,
    values: Map<number, number>,
    nextOffset: number,
    size: number,
    source: PadSource,
    direction: PadDirection
  ) {
    this.label = label;
    this.mode = mode;
    this.source = source;
    this.direction = direction;
    this.size = size;
    this.#values = values;
    this.#nextOffset = nextOffset;
  }

  // Generate a fresh pad of `size` symbols, one independent uniform draw per
  // symbol. The whole pad exists before any encryption starts — that is what
  // lets the cipher refuse up front instead of running out mid-message.
  // A lone pad is the A->B half by default; two-way traffic uses generatePair.
  static generate(
    size: number,
    mode: PadMode,
    options: { label?: string; randomFill?: RandomFill; direction?: PadDirection } = {}
  ): Pad {
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error("pad size must be a positive integer");
    }
    const randomFill = options.randomFill ?? cryptoFill;
    const range = symbolRange(mode);
    const values = new Map<number, number>();
    for (let offset = 0; offset < size; offset += 1) {
      values.set(offset, uniformInt(range, randomFill));
    }
    const label = options.label ?? randomLabel(randomFill);
    return new Pad(label, mode, values, 0, size, "csprng", options.direction ?? "A->B");
  }

  // Generation produces the pair: two independent pads, one per direction,
  // labelled <stem>-AB and <stem>-BA. Each party keeps both — sends with one,
  // opens with the other — so, by declared role, neither encrypts with the
  // pad the peer encrypts with.
  static generatePair(size: number, mode: PadMode, options: { label?: string; randomFill?: RandomFill } = {}): PadPair {
    const randomFill = options.randomFill ?? cryptoFill;
    const stem = options.label ?? randomLabel(randomFill);
    return {
      "A->B": Pad.generate(size, mode, { label: `${stem}-AB`, randomFill, direction: "A->B" }),
      "B->A": Pad.generate(size, mode, { label: `${stem}-BA`, randomFill, direction: "B->A" })
    };
  }

  // The pair from operator-supplied material: the first half of the bytes
  // becomes A->B, the second half B->A. Stated so the operator knows how
  // their material was divided.
  static pairFromExternal(bytes: Uint8Array, mode: PadMode, options: { label?: string } = {}): PadPair {
    if (!(bytes instanceof Uint8Array) || bytes.length < 2) {
      throw new Error("external pad material for a pair needs at least two bytes");
    }
    const stem = options.label ?? randomLabel(cryptoFill);
    const half = Math.floor(bytes.length / 2);
    return {
      "A->B": Pad.fromExternal(bytes.subarray(0, half), mode, { label: `${stem}-AB`, direction: "A->B" }),
      "B->A": Pad.fromExternal(bytes.subarray(half), mode, { label: `${stem}-BA`, direction: "B->A" })
    };
  }

  // Operator-supplied pad material — e.g. a file produced from a hardware
  // RNG. Tagged "external": this records the operator's assertion about
  // where the bytes came from; nothing here can verify it. Bytes are used
  // as-is in byte mode. In letter mode each byte is range-reduced by
  // REJECTION through the same uniformInt sampler generate() uses — bytes
  // >= 234 are discarded, never folded mod 26 — so the pad may be shorter
  // than the material (by exactly the number of bytes >= 234). `size` asks
  // for exactly that many symbols and refuses if
  // the material cannot supply them; without it, all the material is used.
  static fromExternal(
    bytes: Uint8Array,
    mode: PadMode,
    options: { label?: string; size?: number; direction?: PadDirection } = {}
  ): Pad {
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("external pad material must be a Uint8Array");
    }
    if (mode !== "letters" && mode !== "bytes") {
      throw new Error(`mode must be letters or bytes, not ${String(mode)}`);
    }
    if (options.size !== undefined && (!Number.isInteger(options.size) || options.size <= 0)) {
      throw new Error("size must be a positive integer");
    }
    if (bytes.length === 0) {
      throw new Error("external pad material is empty");
    }
    const range = symbolRange(mode);
    let index = 0;
    const fill: RandomFill = (buffer) => {
      for (let i = 0; i < buffer.length; i += 1) {
        if (index >= bytes.length) {
          throw new ExternalMaterialExhausted();
        }
        buffer[i] = bytes[index];
        index += 1;
      }
      return buffer;
    };
    const values = new Map<number, number>();
    try {
      while (options.size === undefined || values.size < options.size) {
        values.set(values.size, uniformInt(range, fill));
      }
    } catch (error) {
      if (!(error instanceof ExternalMaterialExhausted)) {
        throw error;
      }
    }
    if (values.size === 0) {
      throw new Error("external pad material yielded no symbols after rejection");
    }
    if (options.size !== undefined && values.size < options.size) {
      throw new Error(
        `external pad material is too short: ${values.size} ${mode} symbols after rejection, ${options.size} requested`
      );
    }
    const label = options.label ?? randomLabel(cryptoFill);
    return new Pad(label, mode, values, 0, values.size, "external", options.direction ?? "A->B");
  }

  get remaining(): number {
    return this.#values.size;
  }

  get spent(): number {
    return this.size - this.#values.size;
  }

  get nextOffset(): number {
    return this.#nextOffset;
  }

  get bitsPerSymbol(): number {
    return bitsPerSymbol(this.mode);
  }

  get generatedBits(): number {
    return this.size * this.bitsPerSymbol;
  }

  get spentBits(): number {
    return this.spent * this.bitsPerSymbol;
  }

  get remainingBits(): number {
    return this.remaining * this.bitsPerSymbol;
  }

  // Read a symbol WITHOUT consuming it — undefined once burned. Used by the
  // UI to render surviving symbols; the cipher itself only ever consume()s.
  valueAt(offset: number): number | undefined {
    return this.#values.get(offset);
  }

  // Consume `count` symbols starting at the lowest surviving offset. Each
  // returned symbol is deleted from the pad in the same step — the burn.
  // All-or-nothing: if the pad is short, throw and burn nothing.
  consume(count: number): PadSymbol[] {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("count must be a non-negative integer");
    }
    if (count > this.remaining) {
      throw new PadExhaustedError(count, this.remaining);
    }
    const symbols: PadSymbol[] = [];
    while (symbols.length < count) {
      const offset = this.#nextOffset;
      const value = this.#values.get(offset);
      this.#nextOffset += 1;
      if (value === undefined) {
        continue;
      }
      this.#values.delete(offset);
      symbols.push({ offset, value });
    }
    return symbols;
  }

  // The highest offset ever burned: -1 for a pristine pad. Every offset at
  // or below it is gone. Invariant maintained by consume/consumeAt and
  // checked by deserialize: the surviving symbols are exactly
  // [nextOffset, size), so highWaterMark is always nextOffset - 1.
  get highWaterMark(): number {
    return this.#nextOffset - 1;
  }

  // Seek-and-consume: return the symbols at [offset, offset + count) and
  // burn EVERYTHING from the current pointer through offset + count - 1.
  // Skipped offsets are destroyed, not left recoverable — a message that
  // never arrives has its pad symbols burned as surely as one that does.
  // Refuses (PadReuseError) any offset at or below the high-water mark;
  // that check runs before any burn. All-or-nothing: if the window runs
  // past the pad, throw and burn nothing — not even the skip.
  consumeAt(offset: number, count: number): PadSymbol[] {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("offset must be a non-negative integer");
    }
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("count must be a non-negative integer");
    }
    if (offset <= this.highWaterMark) {
      throw new PadReuseError(offset, this.highWaterMark);
    }
    const required = offset + count - this.#nextOffset; // skip + window
    if (required > this.remaining) {
      throw new PadExhaustedError(required, this.remaining);
    }
    while (this.#nextOffset < offset) {
      this.#values.delete(this.#nextOffset);
      this.#nextOffset += 1;
    }
    return this.consume(count);
  }

  snapshot(): PadSnapshot {
    return {
      label: this.label,
      mode: this.mode,
      source: this.source,
      direction: this.direction,
      size: this.size,
      remaining: this.remaining,
      spent: this.spent,
      bitsPerSymbol: this.bitsPerSymbol,
      generatedBits: this.generatedBits,
      spentBits: this.spentBits,
      remainingBits: this.remainingBits
    };
  }

  // Out-of-band transport form: only the SURVIVING symbols are serialized.
  // Burned offsets are not present in any form, so a deserialized copy can
  // no more reuse them than the original could. This string is the pad — it
  // must travel out of band and never touch the public channel.
  serialize(): string {
    return JSON.stringify({
      label: this.label,
      mode: this.mode,
      source: this.source,
      direction: this.direction,
      size: this.size,
      nextOffset: this.#nextOffset,
      symbols: [...this.#values.entries()]
    });
  }

  static deserialize(data: string): Pad {
    const parsed = JSON.parse(data) as {
      label: string;
      mode: PadMode;
      source: PadSource;
      direction: PadDirection;
      size: number;
      nextOffset: number;
      symbols: [number, number][];
    };
    if (
      typeof parsed.label !== "string" ||
      (parsed.mode !== "letters" && parsed.mode !== "bytes") ||
      !Number.isInteger(parsed.size) ||
      !Number.isInteger(parsed.nextOffset) ||
      !Array.isArray(parsed.symbols)
    ) {
      throw new Error("not a serialized TruePad pad");
    }
    // Provenance is never assumed: a pad without a recorded source is refused
    // rather than defaulted to either value.
    if (parsed.source !== "csprng" && parsed.source !== "external") {
      throw new Error("not a serialized TruePad pad: missing or unknown source (expected csprng or external)");
    }
    if (parsed.direction !== "A->B" && parsed.direction !== "B->A") {
      throw new Error("not a serialized TruePad pad: missing or unknown direction (expected A->B or B->A)");
    }
    if (parsed.size < 0 || parsed.nextOffset < 0 || parsed.nextOffset > parsed.size) {
      throw new Error("not a serialized TruePad pad: nextOffset outside [0, size]");
    }
    // Enforce the burn invariant on the way in: every surviving symbol sits
    // at or above nextOffset, below size, appears once, and is in range for
    // the mode. A symbol below nextOffset would be counted by `remaining`
    // yet unreachable by consume(), which would otherwise loop forever.
    const range = symbolRange(parsed.mode);
    const values = new Map<number, number>();
    for (const entry of parsed.symbols) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new Error("not a serialized TruePad pad: malformed symbol");
      }
      const [offset, value] = entry;
      if (
        !Number.isInteger(offset) ||
        offset < parsed.nextOffset ||
        offset >= parsed.size ||
        !Number.isInteger(value) ||
        value < 0 ||
        value >= range ||
        values.has(offset)
      ) {
        throw new Error(`not a serialized TruePad pad: symbol at offset ${offset} violates the burn invariant`);
      }
      values.set(offset, value);
    }
    // Unique + in [nextOffset, size) + this count means EXACTLY [nextOffset, size):
    // a pad with holes would make consumeAt return the wrong offsets.
    if (values.size !== parsed.size - parsed.nextOffset) {
      throw new Error(
        `not a serialized TruePad pad: ${values.size} surviving symbols but [${parsed.nextOffset}, ${parsed.size}) ` +
          `needs ${parsed.size - parsed.nextOffset}; the burn invariant requires a contiguous survivor set`
      );
    }
    return new Pad(parsed.label, parsed.mode, values, parsed.nextOffset, parsed.size, parsed.source, parsed.direction);
  }
}
