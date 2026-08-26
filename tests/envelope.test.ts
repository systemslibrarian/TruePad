import { describe, expect, it } from "vitest";
import {
  decodeEnvelope,
  decryptBytes,
  decryptLetters,
  encodeEnvelope,
  encryptBytes,
  encryptLetters,
  normalizeAZ,
  type Envelope
} from "../src/core/cipher-otp";
import { Pad, PadExhaustedError, PadReuseError } from "../src/core/pad";

/* ============================================================================
 * Lane 0 — the wire envelope and seek.
 *
 * What crosses the public channel is an Envelope { label, startOffset,
 * consumed, payload }. The receiver seeks to startOffset by burning forward
 * (skipped offsets are destroyed, not left recoverable) and refuses any
 * envelope whose startOffset is at or below the pad's high-water mark —
 * the reuse guard — before touching a single symbol.
 * ========================================================================= */

function courierPair(size: number, mode: "letters" | "bytes" = "letters"): [Pad, Pad] {
  const sender = Pad.generate(size, mode);
  return [sender, Pad.deserialize(sender.serialize())];
}

function okEnvelope<P extends string | Uint8Array>(result: { ok: true; envelope: Envelope<P> } | { ok: false }): Envelope<P> {
  if (!result.ok) throw new Error("expected ok");
  return result.envelope;
}

describe("Pad.consumeAt — seek by burning forward", () => {
  it("returns exactly [offset, offset+count) and destroys everything skipped", () => {
    const pad = Pad.generate(20, "letters");
    const symbols = pad.consumeAt(7, 4);
    expect(symbols.map((s) => s.offset)).toEqual([7, 8, 9, 10]);
    // Skipped offsets 0..6 are gone — not readable, not consumable.
    for (let offset = 0; offset < 7; offset += 1) {
      expect(pad.valueAt(offset)).toBeUndefined();
    }
    expect(pad.nextOffset).toBe(11);
    expect(pad.highWaterMark).toBe(10);
    expect(pad.remaining).toBe(9);
    expect(pad.spent).toBe(11);
  });

  it("is the same as consume() when offset equals nextOffset", () => {
    const pad = Pad.generate(10, "bytes");
    const a = pad.consumeAt(0, 3).map((s) => s.offset);
    const b = pad.consume(2).map((s) => s.offset);
    expect(a).toEqual([0, 1, 2]);
    expect(b).toEqual([3, 4]);
  });

  it("throws PadReuseError for any offset at or below the high-water mark — and burns nothing", () => {
    const pad = Pad.generate(10, "letters");
    pad.consume(4); // high-water mark is now 3
    expect(pad.highWaterMark).toBe(3);
    for (const offset of [0, 3]) {
      expect(() => pad.consumeAt(offset, 1)).toThrow(PadReuseError);
    }
    expect(pad.remaining).toBe(6);
    expect(pad.nextOffset).toBe(4);
    for (let offset = 4; offset < 10; offset += 1) {
      expect(pad.valueAt(offset)).toBeDefined();
    }
  });

  it("throws PadExhaustedError when the window runs past the pad — and burns nothing, not even the skip", () => {
    const pad = Pad.generate(10, "letters");
    expect(() => pad.consumeAt(8, 3)).toThrow(PadExhaustedError);
    expect(pad.remaining).toBe(10);
    expect(pad.nextOffset).toBe(0);
    expect(pad.valueAt(0)).toBeDefined();
  });

  it("a fresh pad has high-water mark -1, so offset 0 is fresh", () => {
    const pad = Pad.generate(3, "letters");
    expect(pad.highWaterMark).toBe(-1);
    expect(pad.consumeAt(0, 1)).toHaveLength(1);
  });

  it("the high-water mark survives serialize/deserialize", () => {
    const pad = Pad.generate(10, "letters");
    pad.consumeAt(6, 2); // burns 0..7
    const copy = Pad.deserialize(pad.serialize());
    expect(copy.highWaterMark).toBe(7);
    expect(() => copy.consumeAt(7, 1)).toThrow(PadReuseError);
    expect(copy.consumeAt(8, 1)[0].offset).toBe(8);
  });
});

describe("encrypt emits an envelope; decrypt seeks to it", () => {
  it("letters: the envelope carries label, startOffset, consumed and the ciphertext payload", () => {
    const [sender, receiver] = courierPair(40);
    const result = encryptLetters("Attack at dawn", sender);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { envelope } = result;
    expect(envelope.label).toBe(sender.label);
    expect(envelope.startOffset).toBe(0);
    expect(envelope.consumed).toBe(normalizeAZ("Attack at dawn").length);
    expect(envelope.payload).toHaveLength(envelope.consumed);
    // Nothing in the envelope is a pad symbol: only the four wire fields.
    expect(Object.keys(envelope).sort()).toEqual(["consumed", "label", "payload", "startOffset"]);

    const opened = decryptLetters(envelope, receiver);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.text).toBe("ATTACKATDAWN");
    expect(opened.startOffset).toBe(0);
    expect(opened.consumed).toBe(12);
    expect(opened.skipped).toBe(0);
  });

  it("bytes: XOR round-trips through an envelope", () => {
    const [sender, receiver] = courierPair(16, "bytes");
    const plain = new Uint8Array([0, 255, 17, 128]);
    const envelope = okEnvelope(encryptBytes(plain, sender));
    const opened = decryptBytes(envelope, receiver);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect([...opened.bytes]).toEqual([...plain]);
  });
});

describe("T3 — replay: the same envelope cannot be decrypted twice", () => {
  it("letters: second decrypt is refused as reuse, before any burn", () => {
    const [sender, receiver] = courierPair(30);
    const envelope = okEnvelope(encryptLetters("MEETMEATNOON", sender));
    const first = decryptLetters(envelope, receiver);
    expect(first.ok).toBe(true);
    const remainingAfterFirst = receiver.remaining;

    const replay = decryptLetters(envelope, receiver);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.reason).toBe("reuse-refused");
    expect(replay.message).toMatch(/high-water/i);
    // Refusal is a first-class result with no side effect on the pad.
    expect(receiver.remaining).toBe(remainingAfterFirst);
    expect(receiver.nextOffset).toBe(12);
  });

  it("bytes: replay is refused the same way", () => {
    const [sender, receiver] = courierPair(16, "bytes");
    const envelope = okEnvelope(encryptBytes(new Uint8Array([1, 2, 3]), sender));
    expect(decryptBytes(envelope, receiver).ok).toBe(true);
    const replay = decryptBytes(envelope, receiver);
    expect(!replay.ok && replay.reason === "reuse-refused").toBe(true);
    expect(receiver.nextOffset).toBe(3);
  });

  it("a replay that is ALSO too long is still reported as reuse — the graver refusal wins", () => {
    const [sender, receiver] = courierPair(8);
    const envelope = okEnvelope(encryptLetters("ABCDEFG", sender));
    expect(decryptLetters(envelope, receiver).ok).toBe(true);
    const replay = decryptLetters(envelope, receiver);
    expect(!replay.ok && replay.reason === "reuse-refused").toBe(true);
  });

  it("an envelope that overlaps the high-water mark by one symbol is refused", () => {
    const [sender, receiver] = courierPair(30);
    const first = okEnvelope(encryptLetters("HELLO", sender)); // offsets 0..4
    expect(decryptLetters(first, receiver).ok).toBe(true);
    const overlapping: Envelope<string> = { ...first, startOffset: 4, consumed: 3, payload: "XYZ" };
    const result = decryptLetters(overlapping, receiver);
    expect(!result.ok && result.reason === "reuse-refused").toBe(true);
    expect(receiver.nextOffset).toBe(5);
  });
});

describe("T4 — seek: drop message 2 of 3, decrypt 1 and 3", () => {
  it("message 3 decrypts correctly and the skipped offsets are unrecoverable", () => {
    const [sender, receiver] = courierPair(60);
    const e1 = okEnvelope(encryptLetters("FIRSTMESSAGE", sender)); // 0..11
    const e2 = okEnvelope(encryptLetters("SECONDONELOST", sender)); // 12..24
    const e3 = okEnvelope(encryptLetters("THIRDARRIVES", sender)); // 25..36
    expect(e2.startOffset).toBe(12);
    expect(e3.startOffset).toBe(25);

    const one = decryptLetters(e1, receiver);
    expect(one.ok && one.text === "FIRSTMESSAGE").toBe(true);

    // Message 2 never arrives. Message 3 seeks past it.
    const three = decryptLetters(e3, receiver);
    expect(three.ok).toBe(true);
    if (!three.ok) return;
    expect(three.text).toBe("THIRDARRIVES");
    expect(three.skipped).toBe(e2.consumed);
    expect(receiver.nextOffset).toBe(37);

    // The skipped offsets are destroyed: not readable...
    for (let offset = e2.startOffset; offset < e3.startOffset; offset += 1) {
      expect(receiver.valueAt(offset)).toBeUndefined();
    }
    // ...not present in any serialized form...
    const serialized = receiver.serialize();
    for (let offset = e2.startOffset; offset < e3.startOffset; offset += 1) {
      expect(serialized).not.toContain(`[${offset},`);
    }
    // ...and a late arrival of message 2 is refused as reuse, not decrypted.
    const late = decryptLetters(e2, receiver);
    expect(!late.ok && late.reason === "reuse-refused").toBe(true);
    expect(receiver.nextOffset).toBe(37);
  });

  it("bytes: seeking works the same way", () => {
    const [sender, receiver] = courierPair(32, "bytes");
    okEnvelope(encryptBytes(new Uint8Array(10), sender));
    const e2 = okEnvelope(encryptBytes(new Uint8Array([7, 8, 9]), sender));
    const opened = decryptBytes(e2, receiver);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect([...opened.bytes]).toEqual([7, 8, 9]);
    expect(opened.skipped).toBe(10);
    for (let offset = 0; offset < 10; offset += 1) {
      expect(receiver.valueAt(offset)).toBeUndefined();
    }
  });

  it("a seek that would run past the end of the pad is refused and burns nothing — not even the skip", () => {
    const [, receiver] = courierPair(20);
    const tooFar: Envelope<string> = { label: receiver.label, startOffset: 15, consumed: 10, payload: "ABCDEFGHIJ" };
    const result = decryptLetters(tooFar, receiver);
    expect(!result.ok && result.reason === "pad-exhausted").toBe(true);
    expect(receiver.nextOffset).toBe(0);
    expect(receiver.remaining).toBe(20);
  });
});

describe("envelope validation happens before any burn", () => {
  it("refuses an envelope addressed to a different pad page", () => {
    const [sender] = courierPair(20);
    const [, stranger] = courierPair(20);
    const envelope = okEnvelope(encryptLetters("HELLO", sender));
    const result = decryptLetters(envelope, stranger);
    expect(!result.ok && result.reason === "label-mismatch").toBe(true);
    expect(stranger.remaining).toBe(20);
  });

  it("refuses an envelope whose consumed count disagrees with its payload", () => {
    const [sender, receiver] = courierPair(20);
    const envelope = okEnvelope(encryptLetters("HELLO", sender));
    const lying: Envelope<string> = { ...envelope, consumed: 4 };
    const result = decryptLetters(lying, receiver);
    expect(!result.ok && result.reason === "envelope-invalid").toBe(true);
    expect(receiver.remaining).toBe(20);
  });

  it("refuses a negative or fractional startOffset", () => {
    const [sender, receiver] = courierPair(20);
    const envelope = okEnvelope(encryptLetters("HELLO", sender));
    for (const startOffset of [-1, 1.5]) {
      const result = decryptLetters({ ...envelope, startOffset }, receiver);
      expect(!result.ok && result.reason === "envelope-invalid").toBe(true);
    }
    expect(receiver.remaining).toBe(20);
  });

  it("refuses a mode mismatch before looking at offsets", () => {
    const [sender] = courierPair(20);
    const bytesPad = Pad.generate(20, "bytes", { label: sender.label });
    const envelope = okEnvelope(encryptLetters("HELLO", sender));
    const result = decryptLetters(envelope, bytesPad);
    expect(!result.ok && result.reason === "mode-mismatch").toBe(true);
  });
});

describe("wire encoding round-trips both payload kinds", () => {
  it("letters", () => {
    const envelope: Envelope<string> = { label: "PAD-ABCD", startOffset: 12, consumed: 5, payload: "HELLO" };
    const text = encodeEnvelope(envelope);
    expect(JSON.parse(text)).toEqual(envelope);
    expect(decodeEnvelope(text, "letters")).toEqual(envelope);
  });

  it("bytes go over the wire as hex", () => {
    const envelope: Envelope<Uint8Array> = {
      label: "PAD-ABCD",
      startOffset: 0,
      consumed: 3,
      payload: new Uint8Array([0, 171, 255])
    };
    const text = encodeEnvelope(envelope);
    expect(JSON.parse(text).payload).toBe("00ABFF");
    const decoded = decodeEnvelope(text, "bytes");
    expect(decoded).not.toBeNull();
    expect([...decoded!.payload]).toEqual([0, 171, 255]);
    expect(decoded!.startOffset).toBe(0);
  });

  it("rejects malformed wire text with null rather than a throw", () => {
    expect(decodeEnvelope("not json", "letters")).toBeNull();
    expect(decodeEnvelope("{}", "letters")).toBeNull();
    expect(decodeEnvelope('{"label":"PAD-ABCD","startOffset":0,"consumed":1,"payload":"zz"}', "bytes")).toBeNull();
    expect(decodeEnvelope('{"label":"PAD-ABCD","startOffset":0,"consumed":2,"payload":"A"}', "letters")).toBeNull();
  });
});
