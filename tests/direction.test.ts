import { describe, expect, it } from "vitest";
import { decryptBytes, decryptLetters, encryptBytes, encryptLetters, type Envelope } from "../src/core/cipher-otp";
import { oppositeDirection, Pad, receiverOf, senderOf, type PadDirection } from "../src/core/pad";

/* ============================================================================
 * Lane 3 — direction split.
 *
 * F4: both peers shared one pad and one nextOffset; if each encrypted before
 * receiving the other's message they consumed identical offsets. Now every
 * pad names its sending role, generation produces the pair, and the cipher
 * refuses a pad whose direction does not fit the caller's declared role.
 * ========================================================================= */

function untouched(pad: Pad): { remaining: number; nextOffset: number; bytes: string } {
  return { remaining: pad.remaining, nextOffset: pad.nextOffset, bytes: pad.serialize() };
}

describe("PadDirection on the pad", () => {
  it("helpers name the sender and receiver", () => {
    expect(senderOf("A->B")).toBe("A");
    expect(receiverOf("A->B")).toBe("B");
    expect(senderOf("B->A")).toBe("B");
    expect(oppositeDirection("A->B")).toBe("B->A");
  });

  it("generate defaults to the A->B half and honours an explicit direction", () => {
    expect(Pad.generate(5, "letters").direction).toBe<PadDirection>("A->B");
    expect(Pad.generate(5, "letters", { direction: "B->A" }).direction).toBe("B->A");
    expect(Pad.fromExternal(new Uint8Array(8), "bytes", { direction: "B->A" }).direction).toBe("B->A");
    expect(Pad.generate(5, "letters").snapshot().direction).toBe("A->B");
  });

  it("direction survives serialize/deserialize and is never assumed", () => {
    const pad = Pad.generate(5, "bytes", { direction: "B->A" });
    expect(Pad.deserialize(pad.serialize()).direction).toBe("B->A");
    const stripped = JSON.parse(pad.serialize());
    delete stripped.direction;
    expect(() => Pad.deserialize(JSON.stringify(stripped))).toThrow(/direction/);
    stripped.direction = "A<->B";
    expect(() => Pad.deserialize(JSON.stringify(stripped))).toThrow(/direction/);
  });
});

describe("Pad.generatePair — generation produces the pair", () => {
  it("yields one pad per direction, same mode and size, independent symbols, related labels", () => {
    const pair = Pad.generatePair(40, "letters", { label: "PAD-TEST" });
    const ab = pair["A->B"];
    const ba = pair["B->A"];
    expect(ab.direction).toBe("A->B");
    expect(ba.direction).toBe("B->A");
    expect(ab.label).toBe("PAD-TEST-AB");
    expect(ba.label).toBe("PAD-TEST-BA");
    expect([ab.mode, ab.size, ab.source]).toEqual([ba.mode, ba.size, ba.source]);
    // Two independent draws of 40 letters coincide with probability 26^-40.
    const same = Array.from({ length: 40 }, (_, o) => ab.valueAt(o) === ba.valueAt(o)).every(Boolean);
    expect(same).toBe(false);
    expect(Pad.generatePair(4, "bytes")["A->B"].label).toMatch(/^PAD-[A-Z]{4}-AB$/);
  });

  it("pairFromExternal splits the operator's material at the byte midpoint", () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const pair = Pad.pairFromExternal(bytes, "bytes", { label: "PAD-EXTR" });
    expect([0, 1, 2, 3].map((o) => pair["A->B"].valueAt(o))).toEqual([1, 2, 3, 4]);
    expect([0, 1, 2, 3].map((o) => pair["B->A"].valueAt(o))).toEqual([5, 6, 7, 8]);
    expect(pair["A->B"].source).toBe("external");
    expect(pair["B->A"].direction).toBe("B->A");
    expect(() => Pad.pairFromExternal(Uint8Array.from([1]), "bytes")).toThrow();
  });
});

describe("T2 — bidirectional collision is refused by the direction check", () => {
  it("the old model: both peers hold copies of ONE pad and each encrypts before receiving", () => {
    const shared = Pad.generate(60, "letters", { label: "PAD-ONE", direction: "A->B" });
    const aCopy = Pad.deserialize(shared.serialize());
    const bCopy = Pad.deserialize(shared.serialize());

    const fromA = encryptLetters("ATTACKATDAWN", aCopy, "A");
    expect(fromA.ok).toBe(true);

    // B, holding the same pad, tries to send with it. On the old code this
    // silently burned offsets 0..11 again — identical to A's — a two-time pad.
    const before = untouched(bCopy);
    const fromB = encryptLetters("MEETMEATNOON", bCopy, "B");
    expect(fromB.ok).toBe(false);
    if (fromB.ok) return;
    expect(fromB.reason).toBe("direction-mismatch");
    expect(fromB.message).toContain("PAD-ONE");
    expect(fromB.message).toContain("A->B");
    expect(fromB.message).toMatch(/same offsets|two-time pad/);
    expect(fromB.message).toContain("B->A");
    expect(untouched(bCopy)).toEqual(before);
  });

  it("the new model: with the pair, both peers encrypt without receiving and nothing overlaps", () => {
    const pair = Pad.generatePair(60, "letters");
    const a = { send: pair["A->B"], receive: pair["B->A"] };
    const b = { send: Pad.deserialize(pair["B->A"].serialize()), receive: Pad.deserialize(pair["A->B"].serialize()) };

    const fromA = encryptLetters("ATTACKATDAWN", a.send, "A");
    const fromB = encryptLetters("MEETMEATNOON", b.send, "B");
    expect(fromA.ok && fromB.ok).toBe(true);
    if (!fromA.ok || !fromB.ok) return;
    expect(fromA.envelope.label).not.toBe(fromB.envelope.label);

    // Each side opens the other's envelope with its receiving pad.
    const bOpens = decryptLetters(fromA.envelope, b.receive, "B");
    const aOpens = decryptLetters(fromB.envelope, a.receive, "A");
    expect(bOpens.ok && bOpens.text === "ATTACKATDAWN").toBe(true);
    expect(aOpens.ok && aOpens.text === "MEETMEATNOON").toBe(true);
  });

  it("bytes: same refusal on the byte path", () => {
    const pad = Pad.generate(16, "bytes", { direction: "A->B" });
    const r = encryptBytes(new Uint8Array(4), pad, "B");
    expect(!r.ok && r.reason).toBe("direction-mismatch");
    expect(pad.remaining).toBe(16);
  });
});

describe("decrypt refuses a pad whose direction is not the peer's", () => {
  it("the sender cannot open envelopes with its own outgoing pad", () => {
    const pair = Pad.generatePair(30, "letters");
    const delivered = pair["A->B"].serialize(); // courier copy, taken before any burn
    const fromA = encryptLetters("HELLO", pair["A->B"], "A");
    if (!fromA.ok) throw new Error("setup");
    const copyOfAB = Pad.deserialize(delivered);
    const before = untouched(copyOfAB);
    // A declares A and tries to open with the A->B pad: A is its sender, not its receiver.
    const r = decryptLetters(fromA.envelope, copyOfAB, "A");
    expect(!r.ok && r.reason).toBe("direction-mismatch");
    if (r.ok) return;
    expect(r.message).toContain("A sends with");
    expect(untouched(copyOfAB)).toEqual(before);
    // B, the peer, opens it.
    const ok = decryptLetters(fromA.envelope, Pad.deserialize(delivered), "B");
    expect(ok.ok).toBe(true);
  });

  it("bytes: same on the byte path", () => {
    const pad = Pad.generate(16, "bytes", { direction: "B->A" });
    const envelope: Envelope<Uint8Array> = { label: pad.label, startOffset: 0, consumed: 2, payload: new Uint8Array(2) };
    const r = decryptBytes(envelope, pad, "B");
    expect(!r.ok && r.reason).toBe("direction-mismatch");
    expect(pad.remaining).toBe(16);
  });

  it("decrypt: direction is checked before mode, label, envelope shape, reuse and exhaustion", () => {
    // A BYTES pad handed to decryptLetters: wrong mode, wrong label, replayed, exhausted — and wrong role.
    const pad = Pad.generate(4, "bytes", { direction: "A->B" });
    pad.consume(4);
    const r = decryptLetters({ label: "PAD-ELSE", startOffset: 0, consumed: 9, payload: "ABCDEFGHI" }, pad, "A");
    expect(!r.ok && r.reason).toBe("direction-mismatch");
    expect(pad.nextOffset).toBe(4);
  });

  it("encrypt: direction is checked before mode and exhaustion", () => {
    const wrongMode = Pad.generate(4, "bytes", { direction: "A->B" });
    const r1 = encryptLetters("HELLO", wrongMode, "B");
    expect(!r1.ok && r1.reason).toBe("direction-mismatch");
    const exhausted = Pad.generate(4, "letters", { direction: "A->B" });
    exhausted.consume(4);
    const r2 = encryptLetters("HELLO", exhausted, "B");
    expect(!r2.ok && r2.reason).toBe("direction-mismatch");
    const r3 = encryptBytes(new Uint8Array(9), wrongMode, "B");
    expect(!r3.ok && r3.reason).toBe("direction-mismatch");
    expect(wrongMode.remaining).toBe(4);
  });
});
