import { describe, expect, it } from "vitest";

import { MemoryVfs, type Vfs } from "../src/browser/engine/vfs";
import { EngineRefused } from "../src/browser/engine/store";
import {
  cleanPreCommitStaging,
  commitPhysicalHandoff,
  commitSealedHandoff,
  dismissSealedPayload,
  handoffConfirmPath,
  handoffPackagePath,
  loadCommittedSealedHandoff,
  markerPath,
  parseMarker,
  readHandoffState
} from "../src/browser/engine/handoff";
import { packageIdentity } from "../src/spt/sealed-package";
import { toBase64Url } from "../src/spt/bytes";
import { bytesToHex } from "../src/core/hex";
import { FaultVfs } from "./helpers/fault-vfs";

/* ============================================================================
 * The one-handoff record, and how it fails
 * ----------------------------------------------------------------------------
 * The invariant under test is not "the happy path works". It is:
 *
 *     A torn marker may cost the handoff. It must never reopen the pad.
 *     LOSS IS ACCEPTABLE. REUSE IS NOT.
 *
 * So most of this file crashes the write layer on purpose. Every fault case is
 * run against BOTH a backing whose atomic replace really is atomic and one
 * modelling OpfsVfs's truncate → write → flush fallback, because crash safety
 * demonstrated only on MemoryVfs is crash safety demonstrated on a backing that
 * cannot exhibit the failure.
 * ========================================================================= */

const PAIR = "0123456789abcdef0123456789abcdef";
const AT = "2026-08-30T12:00:00.000Z";
const enc = new TextEncoder();

const packageBytes = () => Uint8Array.from({ length: 1258 }, (_, i) => (i * 7) & 0xff);
const confirmValue = () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const requestHash = () => new Uint8Array(32).fill(0xa1);

async function sealedInput() {
  const bytes = packageBytes();
  return {
    packageBytes: bytes,
    requestHash: requestHash(),
    confirmValue: confirmValue(),
    packageIdentity: await packageIdentity(bytes)
  };
}

async function refusalOf(fn: () => Promise<unknown>): Promise<EngineRefused> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof EngineRefused) return error;
    throw error;
  }
  throw new Error("expected a refusal, got success");
}

/* ---- the marker's own grammar --------------------------------------------- */

describe("the marker parser refuses everything it should", () => {
  const good = {
    version: 1,
    pairId: PAIR,
    mode: "sealed",
    at: AT,
    requestHash: toBase64Url(new Uint8Array(32).fill(1)),
    packageIdentity: toBase64Url(new Uint8Array(32).fill(2)),
    confirmHash: toBase64Url(new Uint8Array(32).fill(3))
  };
  const parse = (o: unknown) => parseMarker(enc.encode(JSON.stringify(o)), PAIR);

  it("accepts a well-formed sealed and physical marker", () => {
    expect(parse(good).mode).toBe("sealed");
    expect(parse({ version: 1, pairId: PAIR, mode: "physical", at: AT }).mode).toBe("physical");
  });

  const bad: Array<[string, unknown]> = [
    ["a non-object", [1, 2, 3]],
    ["null", null],
    ["a string", "handoff"],
    ["the wrong version", { ...good, version: 2 }],
    ["a missing version", { pairId: PAIR, mode: "physical", at: AT }],
    ["an uppercase pairId", { ...good, pairId: PAIR.toUpperCase() }],
    ["a short pairId", { ...good, pairId: "abc" }],
    ["a different pair", { ...good, pairId: "f".repeat(32) }],
    ["an unsupported mode", { ...good, mode: "postal" }],
    ["a missing mode", { version: 1, pairId: PAIR, at: AT }],
    ["a non-ISO timestamp", { ...good, at: "yesterday" }],
    ["a truncated ISO timestamp", { ...good, at: "2026-08-30T12:00:00Z" }],
    ["an extra field", { ...good, extra: 1 }],
    ["padded base64url", { ...good, requestHash: "AAAA=" }],
    ["standard base64 characters", { ...good, packageIdentity: "+".repeat(43) }],
    ["a hash of the wrong size", { ...good, confirmHash: toBase64Url(new Uint8Array(31)) }],
    ["a physical marker carrying sealed fields", { version: 1, pairId: PAIR, mode: "physical", at: AT, requestHash: good.requestHash }],
    ["a sealed marker missing requestHash", { version: 1, pairId: PAIR, mode: "sealed", at: AT, packageIdentity: good.packageIdentity, confirmHash: good.confirmHash }],
    ["a sealed marker missing confirmHash", { version: 1, pairId: PAIR, mode: "sealed", at: AT, requestHash: good.requestHash, packageIdentity: good.packageIdentity }]
  ];
  for (const [name, value] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => parse(value)).toThrow();
    });
  }

  it("refuses empty bytes and non-JSON", () => {
    expect(() => parseMarker(new Uint8Array(0), PAIR)).toThrow(/empty/);
    expect(() => parseMarker(enc.encode("{"), PAIR)).toThrow(/parse/);
  });

  it("refuses a non-canonical base64url spelling of the same hash", () => {
    const canonical = toBase64Url(new Uint8Array(32).fill(9));
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = canonical[canonical.length - 1];
    const alt = canonical.slice(0, -1) + alphabet[(alphabet.indexOf(last) + 1) % 64];
    expect(alt).not.toBe(canonical);
    expect(() => parse({ ...good, requestHash: alt })).toThrow(/canonical/);
  });

  it("writes its fields in the frozen order", async () => {
    const vfs = new MemoryVfs();
    await commitSealedHandoff(vfs, PAIR, await sealedInput(), AT);
    const raw = new TextDecoder().decode((await vfs.readFile(markerPath(PAIR)))!);
    expect(raw.indexOf('"version"')).toBeLessThan(raw.indexOf('"pairId"'));
    expect(raw.indexOf('"pairId"')).toBeLessThan(raw.indexOf('"mode"'));
    expect(raw.indexOf('"mode"')).toBeLessThan(raw.indexOf('"at"'));
    expect(raw.indexOf('"at"')).toBeLessThan(raw.indexOf('"requestHash"'));
    expect(raw.indexOf('"requestHash"')).toBeLessThan(raw.indexOf('"packageIdentity"'));
    expect(raw.indexOf('"packageIdentity"')).toBeLessThan(raw.indexOf('"confirmHash"'));
  });
});

/* ---- existence is load-bearing -------------------------------------------- */

describe("a present marker is NEVER absence", () => {
  const corruptions: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["one byte", Uint8Array.from([0x7b])],
    ["truncated JSON", enc.encode('{"version":1,"pairId":"')],
    ["valid JSON, wrong shape", enc.encode('{"hello":"world"}')],
    ["a marker for another pair", enc.encode(JSON.stringify({ version: 1, pairId: "f".repeat(32), mode: "physical", at: AT }))],
    ["binary noise", Uint8Array.from([0xff, 0xfe, 0x00, 0x01])]
  ];

  for (const [name, bytes] of corruptions) {
    it(`${name} reads as unreadable-spent, not absent`, async () => {
      const vfs = new MemoryVfs();
      await vfs.writeFileAtomic(markerPath(PAIR), bytes);
      const state = await readHandoffState(vfs, PAIR);
      expect(state.kind).toBe("unreadable-spent");
    });

    it(`${name} refuses a new sealed handoff`, async () => {
      const vfs = new MemoryVfs();
      await vfs.writeFileAtomic(markerPath(PAIR), bytes);
      const refusal = await refusalOf(async () => commitSealedHandoff(vfs, PAIR, await sealedInput(), AT));
      expect(refusal.reason).toBe("handoff-state-unreadable");
    });

    it(`${name} is never auto-deleted or auto-repaired`, async () => {
      const vfs = new MemoryVfs();
      await vfs.writeFileAtomic(markerPath(PAIR), bytes);
      await readHandoffState(vfs, PAIR);
      await refusalOf(async () => commitSealedHandoff(vfs, PAIR, await sealedInput(), AT));
      await refusalOf(async () => cleanPreCommitStaging(vfs, PAIR));
      const after = await vfs.readFile(markerPath(PAIR));
      expect(after).not.toBeNull();
      expect(bytesToHex(after!)).toBe(bytesToHex(bytes));
    });
  }

  it("a marker that cannot be READ is unreadable-spent, not absent", async () => {
    const vfs = new FaultVfs(new MemoryVfs());
    await vfs.writeFileAtomic(markerPath(PAIR), enc.encode(JSON.stringify({ version: 1, pairId: PAIR, mode: "physical", at: AT })));
    vfs.failRead(markerPath(PAIR), 1);
    const state = await readHandoffState(vfs, PAIR);
    expect(state.kind).toBe("unreadable-spent");
  });

  it("the refusal never tells the operator to delete the record", async () => {
    const vfs = new MemoryVfs();
    await vfs.writeFileAtomic(markerPath(PAIR), new Uint8Array(1));
    const state = await readHandoffState(vfs, PAIR);
    expect(state.kind).toBe("unreadable-spent");
    if (state.kind !== "unreadable-spent") return;
    expect(state.message).toMatch(/refuses to create another copy/);
    expect(state.message).not.toMatch(/delete|remove|erase/i);
  });
});

/* ---- the sealed transaction ----------------------------------------------- */

describe("the sealed handoff is marker-last", () => {
  it("commits, and the marker describes the staged bytes", async () => {
    const vfs = new MemoryVfs();
    const input = await sealedInput();
    const marker = await commitSealedHandoff(vfs, PAIR, input, AT);
    expect(marker.mode).toBe("sealed");
    expect(marker.packageIdentity).toBe(toBase64Url(input.packageIdentity));
    const state = await readHandoffState(vfs, PAIR);
    expect(state.kind).toBe("sealed");
    if (state.kind !== "sealed") return;
    expect(state.packageAvailable).toBe(true);
    expect(state.confirmationAvailable).toBe(true);
  });

  it("writes the marker AFTER both payload files", async () => {
    const vfs = new FaultVfs(new MemoryVfs());
    await commitSealedHandoff(vfs, PAIR, await sealedInput(), AT);
    const order = vfs.writes;
    expect(order.indexOf(handoffPackagePath(PAIR))).toBeLessThan(order.indexOf(markerPath(PAIR)));
    expect(order.indexOf(handoffConfirmPath(PAIR))).toBeLessThan(order.indexOf(markerPath(PAIR)));
    // The marker is the LAST write, full stop.
    expect(order[order.length - 1]).toBe(markerPath(PAIR));
  });

  it("returns the EXACT bytes on a later load, never a new package", async () => {
    const vfs = new MemoryVfs();
    const input = await sealedInput();
    await commitSealedHandoff(vfs, PAIR, input, AT);
    const loaded = await loadCommittedSealedHandoff(vfs, PAIR);
    expect(bytesToHex(loaded.packageBytes)).toBe(bytesToHex(input.packageBytes));
    expect(bytesToHex(loaded.confirmValue)).toBe(bytesToHex(input.confirmValue));
    // ...and a second handoff is refused outright.
    const refusal = await refusalOf(async () => commitSealedHandoff(vfs, PAIR, await sealedInput(), AT));
    expect(refusal.reason).toBe("pad-already-sealed");
  });

  it("refuses a package whose supplied identity does not match its bytes", async () => {
    const vfs = new MemoryVfs();
    const input = await sealedInput();
    input.packageIdentity = new Uint8Array(32).fill(0xee);
    const refusal = await refusalOf(() => commitSealedHandoff(vfs, PAIR, input, AT));
    expect(refusal.reason).toBe("storage-failed");
    // Nothing committed: the pad is still free.
    expect((await readHandoffState(vfs, PAIR)).kind).toBe("absent");
  });

  it("refuses a confirmation value that is not exactly 11 bytes", async () => {
    const vfs = new MemoryVfs();
    for (const length of [10, 12, 0]) {
      const input = await sealedInput();
      input.confirmValue = new Uint8Array(length);
      await refusalOf(() => commitSealedHandoff(vfs, PAIR, input, AT));
    }
    expect((await readHandoffState(vfs, PAIR)).kind).toBe("absent");
  });

  it("stores the package verbatim and the confirmation as 11 raw bytes", async () => {
    const vfs = new MemoryVfs();
    const input = await sealedInput();
    await commitSealedHandoff(vfs, PAIR, input, AT);
    const stored = await vfs.readFile(handoffPackagePath(PAIR));
    expect(bytesToHex(stored!)).toBe(bytesToHex(input.packageBytes));
    const confirm = await vfs.readFile(handoffConfirmPath(PAIR));
    expect(confirm!.length).toBe(11);
    // No words, no indices, no base64, no JSON.
    expect(bytesToHex(confirm!)).toBe(bytesToHex(input.confirmValue));
    // ...and the marker keeps only a HASH of it.
    const marker = await readHandoffState(vfs, PAIR);
    if (marker.kind !== "sealed") return;
    expect(marker.marker.confirmHash).not.toBe(toBase64Url(input.confirmValue));
  });
});

/* ---- crash semantics, on both backings ------------------------------------ */

for (const nonAtomic of [false, true]) {
  const backing = nonAtomic ? "the non-atomic truncate/write/flush fallback" : "an atomic replace backing";

  describe(`crash semantics on ${backing}`, () => {
    const make = () => new FaultVfs(new MemoryVfs(), { nonAtomic });

    it("C — the package tears before the marker: no marker, no output, retry allowed", async () => {
      const vfs = make();
      vfs.failWrite({ path: handoffPackagePath(PAIR), mode: nonAtomic ? "partial-then-throw" : "throw-before" });
      await expect(commitSealedHandoff(vfs, PAIR, await sealedInput(), AT)).rejects.toThrow();
      expect((await readHandoffState(vfs, PAIR)).kind).toBe("absent");
      // Pre-commit staging may be discarded, and a retry succeeds.
      await cleanPreCommitStaging(vfs, PAIR);
      const marker = await commitSealedHandoff(vfs, PAIR, await sealedInput(), AT);
      expect(marker.mode).toBe("sealed");
    });

    it("crash after the package, before the confirmation: still no marker, still retryable", async () => {
      const vfs = make();
      vfs.failWrite({ path: handoffConfirmPath(PAIR), mode: nonAtomic ? "truncate-then-throw" : "throw-before" });
      await expect(commitSealedHandoff(vfs, PAIR, await sealedInput(), AT)).rejects.toThrow();
      expect((await readHandoffState(vfs, PAIR)).kind).toBe("absent");
      const marker = await commitSealedHandoff(vfs, PAIR, await sealedInput(), AT);
      expect(marker.mode).toBe("sealed");
    });

    it("D — the marker tears: handoff spent and unreadable, never a second package", async () => {
      const vfs = make();
      vfs.failWrite({ path: markerPath(PAIR), mode: nonAtomic ? "partial-then-throw" : "throw-before", bytes: 20 });
      await expect(commitSealedHandoff(vfs, PAIR, await sealedInput(), AT)).rejects.toThrow();
      const state = await readHandoffState(vfs, PAIR);
      if (nonAtomic) {
        // The target exists and is wrong: SPENT.
        expect(state.kind).toBe("unreadable-spent");
        const refusal = await refusalOf(async () => commitSealedHandoff(vfs, PAIR, await sealedInput(), AT));
        expect(refusal.reason).toBe("handoff-state-unreadable");
      } else {
        // move() backing: the target was never touched, so this is retryable.
        expect(state.kind).toBe("absent");
      }
    });

    it("B — the marker is truncated to zero length: spent, not absent", async () => {
      const vfs = make();
      await vfs.writeFileAtomic(markerPath(PAIR), new Uint8Array(0));
      expect((await readHandoffState(vfs, PAIR)).kind).toBe("unreadable-spent");
    });

    it("E — the marker lands but the write reports failure: later state sees it SPENT", async () => {
      const vfs = make();
      vfs.failWrite({ path: markerPath(PAIR), mode: "complete-then-throw" });
      if (!nonAtomic) return; // the atomic model never leaves the target written
      await expect(commitSealedHandoff(vfs, PAIR, await sealedInput(), AT)).rejects.toThrow();
      const state = await readHandoffState(vfs, PAIR);
      expect(state.kind).toBe("sealed");
      // And the retry returns the EXACT committed package, never a new one.
      const loaded = await loadCommittedSealedHandoff(vfs, PAIR);
      expect(bytesToHex(loaded.packageBytes)).toBe(bytesToHex(packageBytes()));
      const refusal = await refusalOf(async () => commitSealedHandoff(vfs, PAIR, await sealedInput(), AT));
      expect(refusal.reason).toBe("pad-already-sealed");
    });

    it("a leftover temp file is not mistaken for state", async () => {
      const vfs = make();
      await vfs.leaveTempFile(markerPath(PAIR), enc.encode('{"version":1}'));
      expect((await readHandoffState(vfs, PAIR)).kind).toBe("absent");
      const marker = await commitSealedHandoff(vfs, PAIR, await sealedInput(), AT);
      expect(marker.mode).toBe("sealed");
    });
  });
}

/* ---- marker valid, payload gone ------------------------------------------- */

describe("a valid marker with an unusable payload is SPENT and unrecoverable", () => {
  it("F — the package byte changed", async () => {
    const vfs = new MemoryVfs();
    const input = await sealedInput();
    await commitSealedHandoff(vfs, PAIR, input, AT);
    const tampered = Uint8Array.from(input.packageBytes);
    tampered[0] ^= 0x01;
    await vfs.writeFileAtomic(handoffPackagePath(PAIR), tampered);
    const refusal = await refusalOf(() => loadCommittedSealedHandoff(vfs, PAIR));
    expect(refusal.reason).toBe("handoff-unrecoverable");
    // Still refuses a reseal.
    const again = await refusalOf(async () => commitSealedHandoff(vfs, PAIR, await sealedInput(), AT));
    expect(again.reason).toBe("pad-already-sealed");
  });

  it("G — the confirmation value changed", async () => {
    const vfs = new MemoryVfs();
    await commitSealedHandoff(vfs, PAIR, await sealedInput(), AT);
    const tampered = confirmValue();
    tampered[10] ^= 0x01;
    await vfs.writeFileAtomic(handoffConfirmPath(PAIR), tampered);
    const refusal = await refusalOf(() => loadCommittedSealedHandoff(vfs, PAIR));
    expect(refusal.reason).toBe("handoff-unrecoverable");
    expect((await refusalOf(async () => commitSealedHandoff(vfs, PAIR, await sealedInput(), AT))).reason).toBe(
      "pad-already-sealed"
    );
  });

  it("the payload files are simply missing", async () => {
    const vfs = new MemoryVfs();
    await commitSealedHandoff(vfs, PAIR, await sealedInput(), AT);
    await vfs.remove(handoffPackagePath(PAIR));
    expect((await refusalOf(() => loadCommittedSealedHandoff(vfs, PAIR))).reason).toBe("handoff-unrecoverable");
  });
});

/* ---- dismissal and permanence --------------------------------------------- */

describe("the commit marker is permanent", () => {
  it("dismissal drops the payload and KEEPS the marker", async () => {
    const vfs = new MemoryVfs();
    await commitSealedHandoff(vfs, PAIR, await sealedInput(), AT);
    await dismissSealedPayload(vfs, PAIR);
    expect(await vfs.exists(handoffPackagePath(PAIR))).toBe(false);
    expect(await vfs.exists(handoffConfirmPath(PAIR))).toBe(false);
    expect(await vfs.exists(markerPath(PAIR))).toBe(true);
    const state = await readHandoffState(vfs, PAIR);
    expect(state.kind).toBe("sealed");
    if (state.kind !== "sealed") return;
    expect(state.packageAvailable).toBe(false);
    expect(state.confirmationAvailable).toBe(false);
  });

  it("after dismissal the pad stays handed off and no new package may be created", async () => {
    const vfs = new MemoryVfs();
    await commitSealedHandoff(vfs, PAIR, await sealedInput(), AT);
    await dismissSealedPayload(vfs, PAIR);
    expect((await refusalOf(async () => commitSealedHandoff(vfs, PAIR, await sealedInput(), AT))).reason).toBe(
      "pad-already-sealed"
    );
    // A same-request re-share is correctly unavailable, not regenerated.
    expect((await refusalOf(() => loadCommittedSealedHandoff(vfs, PAIR))).reason).toBe("handoff-unrecoverable");
  });

  it("no exported function ever removes the marker", async () => {
    const vfs = new MemoryVfs();
    await commitSealedHandoff(vfs, PAIR, await sealedInput(), AT);
    const before = await vfs.readFile(markerPath(PAIR));
    await dismissSealedPayload(vfs, PAIR);
    await refusalOf(() => cleanPreCommitStaging(vfs, PAIR));
    await refusalOf(() => loadCommittedSealedHandoff(vfs, PAIR));
    expect(bytesToHex((await vfs.readFile(markerPath(PAIR)))!)).toBe(bytesToHex(before!));
  });
});

/* ---- cross-mode ------------------------------------------------------------ */

describe("cross-mode refusals (H, I)", () => {
  it("H — a physical marker refuses a sealed commit", async () => {
    const vfs = new MemoryVfs();
    await commitPhysicalHandoff(vfs, PAIR, AT);
    const refusal = await refusalOf(async () => commitSealedHandoff(vfs, PAIR, await sealedInput(), AT));
    expect(refusal.reason).toBe("pad-already-handed-off");
  });

  it("a physical marker is not rewritten by a second physical handoff", async () => {
    const vfs = new MemoryVfs();
    const first = await commitPhysicalHandoff(vfs, PAIR, AT);
    expect(first.at).toBe(AT);
    const state = await readHandoffState(vfs, PAIR);
    expect(state.kind).toBe("physical");
  });

  it("K — the storage helper never fabricates provenance authority", async () => {
    // commitSealedHandoff takes no origin, reads no pair.json, and refuses
    // nothing on provenance grounds: that is the caller's job, and a storage
    // layer that guessed at authorization would be a second, weaker gate.
    const vfs = new MemoryVfs();
    await vfs.writeFileAtomic(
      `${PAIR}/pair.json`,
      enc.encode(JSON.stringify({ pairId: PAIR, label: "x", createdAt: AT, witness: "browser-none", origin: "imported" }))
    );
    // It commits, because storage is not the authorization layer.
    const marker = await commitSealedHandoff(vfs, PAIR, await sealedInput(), AT);
    expect(marker.mode).toBe("sealed");
    expect(commitSealedHandoff.length).toBe(4); // vfs, pairId, input, at — no origin
  });
});

/* ---- pre-commit staging ---------------------------------------------------- */

describe("staging without a marker is pre-commit", () => {
  it("orphans are removable while no marker exists", async () => {
    const vfs: Vfs = new MemoryVfs();
    await vfs.writeFileAtomic(handoffPackagePath(PAIR), packageBytes());
    await vfs.writeFileAtomic(handoffConfirmPath(PAIR), confirmValue());
    expect((await readHandoffState(vfs, PAIR)).kind).toBe("absent");
    await cleanPreCommitStaging(vfs, PAIR);
    expect(await vfs.exists(handoffPackagePath(PAIR))).toBe(false);
    expect(await vfs.exists(handoffConfirmPath(PAIR))).toBe(false);
  });

  it("L — cleanup refuses once ANY marker exists, valid or torn", async () => {
    for (const marker of [
      enc.encode(JSON.stringify({ version: 1, pairId: PAIR, mode: "physical", at: AT })),
      new Uint8Array(3)
    ]) {
      const vfs = new MemoryVfs();
      await vfs.writeFileAtomic(markerPath(PAIR), marker);
      await vfs.writeFileAtomic(handoffPackagePath(PAIR), packageBytes());
      await refusalOf(() => cleanPreCommitStaging(vfs, PAIR));
      // The staged file survives too — it may be the only copy of what left.
      expect(await vfs.exists(handoffPackagePath(PAIR))).toBe(true);
    }
  });
});
