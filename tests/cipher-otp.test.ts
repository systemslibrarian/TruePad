import { describe, expect, it } from "vitest";
import {
  decryptBytes,
  decryptLetters,
  encryptBytes,
  encryptLetters,
  groupedFive,
  lettersToNumbers,
  normalizeAZ,
  numbersToLetters
} from "../src/core/cipher-otp";
import { Pad, type RandomFill } from "../src/core/pad";

// Fill that yields the byte sequence 0, 1, 2, ... — all below the rejection
// limit of 234, so a letters pad becomes the keystream 0, 1, 2, ...
function countingFill(): RandomFill {
  let next = 0;
  return (buffer) => {
    for (let i = 0; i < buffer.length; i += 1) {
      buffer[i] = next & 0x7f;
      next += 1;
    }
    return buffer;
  };
}

describe("letter helpers", () => {
  it("normalizeAZ uppercases and strips non-letters", () => {
    expect(normalizeAZ("Hello, World! 123")).toBe("HELLOWORLD");
  });

  it("letters/numbers round-trip", () => {
    expect(numbersToLetters(lettersToNumbers("QUIETLY"))).toBe("QUIETLY");
  });

  it("groupedFive groups cosmetically", () => {
    expect(groupedFive("HELLOWORLD")).toBe("HELLO WORLD");
  });
});

describe("letter mode", () => {
  it("encrypts with add-mod-26 against known pad symbols", () => {
    // Keystream 0,1,2: A+0=A, B+1=C, C+2=E.
    const pad = Pad.generate(10, "letters", { label: "PAD-TEST", randomFill: countingFill() });
    const result = encryptLetters("ABC", pad);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.payload).toBe("ACE");
      expect(result.envelope.startOffset).toBe(0);
      expect(result.envelope.consumed).toBe(3);
      expect(result.envelope.label).toBe("PAD-TEST");
    }
  });

  it("round-trips through a serialized receiver copy of the pad", () => {
    const sender = Pad.generate(200, "letters");
    const receiver = Pad.deserialize(sender.serialize()); // out-of-band handoff
    const encrypted = encryptLetters("Attack at dawn, bring the LANTERNS!", sender);
    expect(encrypted.ok).toBe(true);
    if (!encrypted.ok) return;
    const decrypted = decryptLetters(encrypted.envelope, receiver);
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) return;
    expect(decrypted.text).toBe(normalizeAZ("Attack at dawn, bring the LANTERNS!"));
    expect(decrypted.startOffset).toBe(encrypted.envelope.startOffset);
  });

  it("burns disjoint offsets across consecutive messages", () => {
    const sender = Pad.generate(60, "letters");
    const receiver = Pad.deserialize(sender.serialize());
    const first = encryptLetters("MEETMEATNOON", sender);
    const second = encryptLetters("BRINGTHEBOOK", sender);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.envelope.startOffset).toBe(first.envelope.startOffset + first.envelope.consumed);
    // Receiver replays the same sequence and stays in sync.
    const firstPlain = decryptLetters(first.envelope, receiver);
    const secondPlain = decryptLetters(second.envelope, receiver);
    expect(firstPlain.ok && firstPlain.text === "MEETMEATNOON").toBe(true);
    expect(secondPlain.ok && secondPlain.text === "BRINGTHEBOOK").toBe(true);
  });

  it("refuses when the pad is short — and burns nothing", () => {
    const pad = Pad.generate(5, "letters");
    const result = encryptLetters("THISMESSAGEISTOOLONG", pad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("pad-exhausted");
    expect(result.required).toBe(20);
    expect(result.remaining).toBe(5);
    expect(result.message).toContain("cannot borrow, wrap, or reuse");
    // First-class refusal, not a side effect: the pad is untouched.
    expect(pad.remaining).toBe(5);
    expect(pad.valueAt(0)).toBeDefined();
  });

  it("refuses a bytes pad in letter mode", () => {
    const pad = Pad.generate(50, "bytes");
    const result = encryptLetters("HELLO", pad);
    expect(!result.ok && result.reason === "mode-mismatch").toBe(true);
  });

  it("decrypt refuses on a device whose pad copy is exhausted", () => {
    const pad = Pad.generate(4, "letters");
    pad.consume(4);
    const result = decryptLetters({ label: pad.label, startOffset: 4, consumed: 5, payload: "XYZZY" }, pad);
    expect(!result.ok && result.reason === "pad-exhausted").toBe(true);
  });
});

describe("byte mode", () => {
  it("XOR round-trips arbitrary bytes", () => {
    const sender = Pad.generate(32, "bytes");
    const receiver = Pad.deserialize(sender.serialize());
    const plain = new Uint8Array([0, 1, 2, 127, 128, 200, 255, 66]);
    const encrypted = encryptBytes(plain, sender);
    expect(encrypted.ok).toBe(true);
    if (!encrypted.ok) return;
    const decrypted = decryptBytes(encrypted.envelope, receiver);
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) return;
    expect([...decrypted.bytes]).toEqual([...plain]);
  });

  it("refuses when the pad is short", () => {
    const pad = Pad.generate(3, "bytes");
    const result = encryptBytes(new Uint8Array(10), pad);
    expect(!result.ok && result.reason === "pad-exhausted").toBe(true);
    expect(pad.remaining).toBe(3);
  });

  it("refuses a letters pad in byte mode", () => {
    const pad = Pad.generate(50, "letters");
    const result = encryptBytes(new Uint8Array([1, 2, 3]), pad);
    expect(!result.ok && result.reason === "mode-mismatch").toBe(true);
  });
});

describe("no keystream reuse at the cipher level", () => {
  it("encrypting the same plaintext twice uses different pad symbols", () => {
    const pad = Pad.generate(40, "letters", { randomFill: countingFill() });
    const first = encryptLetters("SAMEMESSAGE", pad);
    const second = encryptLetters("SAMEMESSAGE", pad);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Keystream 0,1,2,... is strictly increasing, so identical plaintext
    // cannot produce identical ciphertext — fresh symbols were burned.
    expect(second.envelope.payload).not.toBe(first.envelope.payload);
    expect(second.envelope.startOffset).toBe(first.envelope.consumed);
  });
});
