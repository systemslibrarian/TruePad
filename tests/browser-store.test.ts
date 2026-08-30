import { describe, expect, it } from "vitest";
import { decodeEnvelope2, encodeEnvelope2 } from "../src/core/envelope2";
import { decodeCompactEnvelope2, encodeCompactEnvelope2 } from "../src/core/compact-envelope2";
import { bytesToHex, hexToBytes } from "../src/core/hex";
import { canonicalBytes, wcTag, type CanonicalFields } from "../src/core/wc-one-time";
import { MemoryVfs, type Vfs } from "../src/browser/engine/vfs";
import { handle } from "../src/browser/engine/verbs";
import type { EngineOk, EngineRequest, EngineResponse } from "../src/browser/engine/protocol";

/* ============================================================================
 * Browser engine over MemoryVfs (FORMAT-V2 §12 transactions, §15 witness, §17
 * destruction) — the SAME frozen protocol as the CLI, run through the async
 * Vfs and the protocol.ts RPC. MemoryVfs is deterministic and needs no OPFS.
 *
 * The courier model is honoured: a burn advances the SENDER's copy, an open
 * advances the RECEIVER's copy, so each round trip uses two independent Vfs
 * stores (gen on one, export→import to the other).
 * ========================================================================= */

let idSeq = 1;

type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;

async function send(vfs: Vfs, req: WithoutId<EngineRequest>): Promise<EngineResponse> {
  return handle(vfs, { ...req, id: idSeq++ } as EngineRequest);
}

function asOk<K extends EngineOk["op"]>(res: EngineResponse, op: K): Extract<EngineOk, { op: K }> {
  if (!res.ok) {
    const reason = (res as { reason?: string }).reason ?? "";
    throw new Error(`expected ok:${op} but got ${res.kind} ${reason}: ${res.message}`);
  }
  if (res.op !== op) {
    throw new Error(`expected op ${op} but got ${res.op}`);
  }
  return res as Extract<EngineOk, { op: K }>;
}

function expectRefused(res: EngineResponse, reason?: string): string {
  if (res.ok) {
    throw new Error(`expected refused but got ok:${res.op}`);
  }
  if (res.kind !== "refused") {
    throw new Error(`expected refused but got error: ${res.message}`);
  }
  if (reason !== undefined && res.reason !== reason) {
    throw new Error(`expected reason ${reason} but got ${res.reason}: ${res.message}`);
  }
  return res.reason;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

// A fresh uniform source of exactly the required length for E, N.
function source(encryptionBytes: number, authRecords: number): Uint8Array {
  const required = 2 * (encryptionBytes + 32 * authRecords);
  return crypto.getRandomValues(new Uint8Array(required));
}

type GenOpts = {
  encryptionBytes: number;
  authRecords: number;
  witnessClass?: "browser-none" | "browser-local-witness";
  recordBytes?: number;
  verifyAttemptLimit?: number;
  freezeThreshold?: number;
};

async function gen(vfs: Vfs, label: string, o: GenOpts): Promise<string> {
  const res = asOk(
    await send(vfs, {
      op: "gen",
      label,
      sources: [{ name: "drbg.bin", declaredOrigin: "test DRBG material, operator-asserted", bytes: source(o.encryptionBytes, o.authRecords) }],
      encryptionBytes: o.encryptionBytes,
      authRecords: o.authRecords,
      witnessClass: o.witnessClass ?? "browser-none",
      recordBytes: o.recordBytes,
      verifyAttemptLimit: o.verifyAttemptLimit,
      freezeThreshold: o.freezeThreshold
    }),
    "gen"
  );
  return res.pair.pairId;
}

// Courier a whole pair from one store to another (the out-of-band pad delivery).
// Export packs the container in the worker; import transfers the bytes back in.
async function courier(from: Vfs, to: Vfs, pairId: string, label: string): Promise<void> {
  const exp = asOk(await send(from, { op: "export-pair", pairId }), "export-pair");
  asOk(await send(to, { op: "import-pair", label, container: exp.container }), "import-pair");
}

// Flip one nibble of the tag so the envelope decodes structurally but fails
// verification (a forged/tampered record).
function tamper(envelope: string): string {
  const obj = JSON.parse(envelope) as { tag: string };
  obj.tag = (obj.tag[0] === "0" ? "1" : "0") + obj.tag.slice(1);
  return JSON.stringify(obj);
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

describe("browser engine: gen → burn → open round trip (both directions, courier)", () => {
  it("A sends to B and B sends to A across two couriered copies", async () => {
    const alice = new MemoryVfs();
    const bob = new MemoryVfs();
    const pairId = await gen(alice, "Alice&Bob", { encryptionBytes: 1024, authRecords: 16 });
    await courier(alice, bob, pairId, "Alice&Bob (Bob copy)");

    // A -> B: Alice burns a-to-b on her copy; Bob opens a-to-b on his copy.
    const m1 = "hello bob";
    const burn1 = asOk(await send(alice, { op: "burn", pairId, as: "A", plaintext: utf8.encode(m1) }), "burn");
    expect(burn1.consumed).toEqual({ encryptionBytes: m1.length, authRecords: 1 });
    const open1 = asOk(await send(bob, { op: "open", pairId, as: "B", envelope: burn1.envelope }), "open");
    expect(fromUtf8.decode(open1.plaintext)).toBe(m1);
    expect(open1.skipped).toEqual({ encryptionBytes: 0, authRecords: 0 });

    // B -> A: Bob burns b-to-a on his copy; Alice opens b-to-a on hers.
    const m2 = "hi alice, got it";
    const burn2 = asOk(await send(bob, { op: "burn", pairId, as: "B", plaintext: utf8.encode(m2) }), "burn");
    const open2 = asOk(await send(alice, { op: "open", pairId, as: "A", envelope: burn2.envelope }), "open");
    expect(fromUtf8.decode(open2.plaintext)).toBe(m2);

    // The dashboards agree on the advanced counters.
    expect(open1.meters.meters["A->B"].authentication.nextSequence).toBe(1);
    expect(open2.meters.meters["B->A"].authentication.nextSequence).toBe(1);
  });
});

describe("browser engine: replay and skip", () => {
  it("re-opening an already-opened record is sequence-retired", async () => {
    const a = new MemoryVfs();
    const b = new MemoryVfs();
    const pairId = await gen(a, "replay", { encryptionBytes: 256, authRecords: 8 });
    await courier(a, b, pairId, "replay-b");
    const burn = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("once") }), "burn");
    asOk(await send(b, { op: "open", pairId, as: "B", envelope: burn.envelope }), "open");
    expectRefused(await send(b, { op: "open", pairId, as: "B", envelope: burn.envelope }), "sequence-retired");
  });

  it("opening ahead retires the skipped records; the late ones are sequence-retired", async () => {
    const a = new MemoryVfs();
    const b = new MemoryVfs();
    const pairId = await gen(a, "skip", { encryptionBytes: 256, authRecords: 8 });
    await courier(a, b, pairId, "skip-b");
    const e0 = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("msg0") }), "burn").envelope;
    const e1 = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("msg1") }), "burn").envelope;
    const e2 = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("msg2") }), "burn").envelope;

    const open2 = asOk(await send(b, { op: "open", pairId, as: "B", envelope: e2 }), "open");
    expect(fromUtf8.decode(open2.plaintext)).toBe("msg2");
    expect(open2.skipped).toEqual({ encryptionBytes: 8, authRecords: 2 });

    // The two skipped records were retired unused; opening them late is refused.
    expectRefused(await send(b, { op: "open", pairId, as: "B", envelope: e0 }), "sequence-retired");
    expectRefused(await send(b, { op: "open", pairId, as: "B", envelope: e1 }), "sequence-retired");
  });
});

describe("browser engine: contested after the verification-attempt limit", () => {
  it("burns the finite attempt budget, then refuses sequence-contested", async () => {
    const a = new MemoryVfs();
    const b = new MemoryVfs();
    const pairId = await gen(a, "contest", { encryptionBytes: 256, authRecords: 4, verifyAttemptLimit: 2 });
    await courier(a, b, pairId, "contest-b");
    const burn = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("real") }), "burn");
    const forged = tamper(burn.envelope);

    // Two forgeries use the two attempts (auth-failed each).
    expectRefused(await send(b, { op: "open", pairId, as: "B", envelope: forged }), "auth-failed");
    expectRefused(await send(b, { op: "open", pairId, as: "B", envelope: forged }), "auth-failed");
    // The third try — even of the genuine record — is refused: the budget is spent.
    expectRefused(await send(b, { op: "open", pairId, as: "B", envelope: burn.envelope }), "sequence-contested");
  });
});

describe("browser engine: attempt-budget rollback is caught by the browser-local witness", () => {
  it("restoring the store while the witness stands refuses witness-regressed", async () => {
    const a = new MemoryVfs();
    const b = new MemoryVfs();
    const pairId = await gen(a, "rollback", { encryptionBytes: 256, authRecords: 4, witnessClass: "browser-local-witness" });
    await courier(a, b, pairId, "rollback-b");
    const burn = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("guarded") }), "burn");
    const forged = tamper(burn.envelope);

    const headPath = `${pairId}/a-to-b/head.json`;
    const journalPath = `${pairId}/a-to-b/journal.log`;
    // Snapshot the pair store (NOT the separate witness store) before the attacks.
    const headSnap = await b.readFile(headPath);
    const journalSnap = await b.readFile(journalPath);
    expect(headSnap).not.toBeNull();
    expect(journalSnap).not.toBeNull();

    // Two forgeries reserve two attempts and advance the witness to attemptsReserved=2.
    expectRefused(await send(b, { op: "open", pairId, as: "B", envelope: forged }), "auth-failed");
    expectRefused(await send(b, { op: "open", pairId, as: "B", envelope: forged }), "auth-failed");

    // A backup-restore rolls the pair store back — but the witness, in its
    // separate OPFS store, still remembers the two spent attempts.
    await b.writeFileAtomic(headPath, headSnap as Uint8Array);
    await b.writeFileAtomic(journalPath, journalSnap as Uint8Array);

    expectRefused(await send(b, { op: "open", pairId, as: "B", envelope: burn.envelope }), "witness-regressed");
  });
});

describe("browser engine: destruction boundary (§17)", () => {
  it("destroy tombstones the pair; every verb then refuses pair-destroyed, and destroy is restartable", async () => {
    const a = new MemoryVfs();
    const b = new MemoryVfs();
    const pairId = await gen(a, "doomed", { encryptionBytes: 256, authRecords: 4 });
    await courier(a, b, pairId, "doomed-b");
    const burn = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("before") }), "burn");

    // Wrong confirmation is refused; the real one destroys.
    expectRefused(await send(a, { op: "destroy", pairId, confirm: "not-the-id" }), "destroy-unconfirmed");
    const destroyed = asOk(await send(a, { op: "destroy", pairId, confirm: pairId }), "destroy");
    expect(destroyed.alreadyDestroyed).toBe(false);
    expect(destroyed.limitation).toBe("Software can forget its reference to pad material; it cannot prove that flash forgot the bytes.");

    // Every consuming verb now refuses pair-destroyed, before any secret is read.
    expectRefused(await send(a, { op: "status", pairId }), "pair-destroyed");
    expectRefused(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("after") }), "pair-destroyed");
    expectRefused(await send(a, { op: "open", pairId, as: "B", envelope: burn.envelope }), "pair-destroyed");
    expectRefused(await send(a, { op: "export-pair", pairId }), "pair-destroyed");
    expectRefused(await send(a, { op: "retire", pairId, direction: "A->B", throughSequence: 0 }), "pair-destroyed");

    // Restartable/idempotent: a second destroy finds the tombstone and nothing to remove.
    const again = asOk(await send(a, { op: "destroy", pairId, confirm: pairId }), "destroy");
    expect(again.alreadyDestroyed).toBe(true);
  });
});

describe("browser engine: fixed-size records (§16)", () => {
  it("a fixed store round-trips exact bytes and hides the length; oversize and wrong-size are refused", async () => {
    const a = new MemoryVfs();
    const b = new MemoryVfs();
    const F = 64;
    const pairId = await gen(a, "fixed", { encryptionBytes: 1024, authRecords: 16, recordBytes: F });
    await courier(a, b, pairId, "fixed-b");

    const msg = "hi fixed";
    const burn = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode(msg) }), "burn");
    // The wire record is exactly F bytes regardless of the (shorter) message.
    expect(burn.consumed.encryptionBytes).toBe(F);
    const open = asOk(await send(b, { op: "open", pairId, as: "B", envelope: burn.envelope }), "open");
    expect(fromUtf8.decode(open.plaintext)).toBe(msg);

    // A message past F − 4 is refused at burn, before anything is staged.
    const tooLong = new Uint8Array(F - 4 + 1);
    expectRefused(await send(a, { op: "burn", pairId, as: "A", plaintext: tooLong }), "record-size-mismatch");

    // A structurally-valid envelope whose ciphertextLength is not F cannot be
    // one of this store's records: refused at O0, before any window check.
    const wrongSize = JSON.stringify({
      formatVersion: 2,
      pairId,
      direction: "A->B",
      sequence: 1,
      startOffset: F,
      ciphertextLength: 16,
      ciphertext: "00".repeat(16),
      tag: "00".repeat(16)
    });
    expectRefused(await send(b, { op: "open", pairId, as: "B", envelope: wrongSize }), "record-size-mismatch");
  });
});

describe("browser engine: crypto is the frozen src/core, byte for byte", () => {
  it("reproduces the FORMAT-V2 §11.3 full-tag vector through the browser build's wcTag/canonicalBytes", () => {
    const fields: CanonicalFields = {
      pairId: hexToBytes("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf") as Uint8Array,
      direction: "A->B",
      sequence: 7,
      startOffset: 4096,
      ciphertext: hexToBytes("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f") as Uint8Array
    };
    const key = hexToBytes("000102030405060708090a0b0c0d0e0f") as Uint8Array;
    const mask = hexToBytes("101112131415161718191a1b1c1d1e1f") as Uint8Array;
    expect(bytesToHex(canonicalBytes(fields))).toBe(
      "77632d6f6e652d74696d652d76310000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf" +
        "0200000000000000070000000000000000100000000000002000000000000000" +
        "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"
    );
    expect(bytesToHex(wcTag(key, mask, fields))).toBe("5bb81c1ec47fe75e649f81d8280c64d9");
  });
});

describe("browser engine: retirement is logical — secret.bin never changes", () => {
  it("secret.bin is byte-identical after burns on the sender and opens on the receiver", async () => {
    const a = new MemoryVfs();
    const b = new MemoryVfs();
    const pairId = await gen(a, "logical", { encryptionBytes: 512, authRecords: 8 });
    await courier(a, b, pairId, "logical-b");

    const senderSecretPath = `${pairId}/a-to-b/secret.bin`;
    const receiverSecretPath = `${pairId}/a-to-b/secret.bin`;
    const senderBefore = await a.readFile(senderSecretPath);
    const receiverBefore = await b.readFile(receiverSecretPath);

    const envelopes: string[] = [];
    for (const text of ["one", "two", "three"]) {
      envelopes.push(asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode(text) }), "burn").envelope);
    }
    for (const envelope of envelopes) {
      asOk(await send(b, { op: "open", pairId, as: "B", envelope }), "open");
    }

    expect(bytesEqual(await a.readFile(senderSecretPath), senderBefore)).toBe(true);
    expect(bytesEqual(await b.readFile(receiverSecretPath), receiverBefore)).toBe(true);
  });
});

/* ============================================================================
 * TP2 compact transport across the browser/CLI boundary
 * ----------------------------------------------------------------------------
 * Both editions reuse src/core byte-for-byte, so the compact spelling of an
 * envelope produced by one is by construction the spelling the other reads.
 * These pin it anyway, because "by construction" is the kind of claim that
 * quietly stops being true.
 * ========================================================================= */

describe("interop: compact transport is the same envelope on both editions", () => {
  it("a browser burn's envelope survives JSON -> compact -> JSON unchanged", async () => {
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, "compact", { encryptionBytes: 512, authRecords: 8 });
    const burn = asOk(
      await send(vfs, { op: "burn", pairId, as: "A", plaintext: new TextEncoder().encode("across editions") }),
      "burn"
    );
    // The worker result is, and stays, canonical JSON.
    expect(burn.envelope.startsWith("{")).toBe(true);
    const decoded = decodeEnvelope2(burn.envelope);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const compact = encodeCompactEnvelope2(decoded.envelope);
    expect(compact.startsWith("TP2:")).toBe(true);
    expect(compact.length).toBeLessThan(burn.envelope.length);

    const back = decodeCompactEnvelope2(compact);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(encodeEnvelope2(back.envelope)).toBe(burn.envelope);
  });

  it("the browser engine OPENS a compact message, and its plaintext is byte-exact", async () => {
    const alice = new MemoryVfs();
    const bob = new MemoryVfs();
    const pairId = await gen(alice, "compact-open", { encryptionBytes: 512, authRecords: 8 });
    const exported = asOk(await send(alice, { op: "export-pair", pairId }), "export-pair");
    asOk(await send(bob, { op: "import-pair", label: "peer", container: exported.container }), "import-pair");

    // Arbitrary bytes, not text: a file payload travels exactly like a message.
    // Keep the expectation BEFORE burning — burn zeroes the caller's buffer as
    // in-memory hygiene, which is working as intended.
    const expected = [0, 1, 2, 250, 251, 255];
    const plaintext = new Uint8Array(expected);
    const burn = asOk(await send(alice, { op: "burn", pairId, as: "A", plaintext }), "burn");
    const decoded = decodeEnvelope2(burn.envelope);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const compact = encodeCompactEnvelope2(decoded.envelope);

    // Handed to the engine as TP2, with no flag and no mode selector.
    const opened = asOk(await send(bob, { op: "open", pairId, as: "B", envelope: compact }), "open");
    expect([...opened.plaintext]).toEqual(expected);
  });

  it("the browser engine still opens canonical JSON, and refuses malformed TP2 as compact", async () => {
    const alice = new MemoryVfs();
    const bob = new MemoryVfs();
    const pairId = await gen(alice, "compact-json", { encryptionBytes: 512, authRecords: 8 });
    const exported = asOk(await send(alice, { op: "export-pair", pairId }), "export-pair");
    asOk(await send(bob, { op: "import-pair", label: "peer", container: exported.container }), "import-pair");

    const burn = asOk(await send(alice, { op: "burn", pairId, as: "A", plaintext: new TextEncoder().encode("json still works") }), "burn");
    const opened = asOk(await send(bob, { op: "open", pairId, as: "B", envelope: burn.envelope }), "open");
    expect(new TextDecoder().decode(opened.plaintext)).toBe("json still works");

    // A malformed TP2 fails AS COMPACT — never retried as JSON — and consumes
    // nothing, because O0 is structural and free.
    const refused = await send(bob, { op: "open", pairId, as: "B", envelope: "TP2:$$$$" });
    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.kind === "refused") {
      expect(refused.reason).toBe("malformed-envelope");
      expect(refused.message).not.toMatch(/JSON/);
    }
  });
});
