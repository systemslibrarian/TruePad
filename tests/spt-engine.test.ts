import { describe, expect, it } from "vitest";

import { MemoryVfs, type Vfs } from "../src/browser/engine/vfs";
import { handle, deriveReceiveCompletion, buildLiveCourierContainer } from "../src/browser/engine/verbs";
import { unpackContainer } from "../src/browser/engine/courier-format";
import { MemoryLockProvider, SptRuntime } from "../src/browser/engine/spt-runtime";
import { readHandoffState } from "../src/browser/engine/handoff";
import { readRequestClaim } from "../src/browser/engine/request-claim";
import { readReceiverState, cancelledPath } from "../src/browser/engine/spt-receiver-state";
import { handoffPackagePath, markerPath } from "../src/browser/engine/handoff";
import { confirmedPath } from "../src/browser/engine/spt-confirmed";
import type { EngineOk, EngineRequest, EngineResponse } from "../src/browser/engine/protocol";
import { bytesToHex } from "../src/core/hex";
import { FaultVfs } from "./helpers/fault-vfs";

/* ============================================================================
 * THE WHOLE FLOW, END TO END
 * ----------------------------------------------------------------------------
 * Two origins, two stores, two runtimes — Alice and Bob never share a lock
 * provider, because they are different browsers.
 *
 * The point of the final steps is not that the ceremony completed. It is that
 * what arrived is the SAME PAD: Alice and Bob then exchange ordinary TP2
 * messages over it, in both directions, through the existing unmodified
 * message path. Sealed transfer delivered the existing pad; it did not build a
 * parallel cryptosystem beside it.
 * ========================================================================= */

let idSeq = 1;
type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;

class Tab {
  readonly vfs: Vfs;
  readonly runtime: SptRuntime;
  constructor(vfs: Vfs, runtime: SptRuntime) {
    this.vfs = vfs;
    this.runtime = runtime;
  }
  send(req: WithoutId<EngineRequest>): Promise<EngineResponse> {
    return handle(this.vfs, { ...req, id: idSeq++ } as EngineRequest, this.runtime);
  }
}

function origin(): { vfs: MemoryVfs; locks: MemoryLockProvider; tab: Tab } {
  const vfs = new MemoryVfs();
  const locks = new MemoryLockProvider();
  return { vfs, locks, tab: new Tab(vfs, new SptRuntime(locks)) };
}

function ok<K extends EngineOk["op"]>(res: EngineResponse, op: K): Extract<EngineOk, { op: K }> {
  if (!res.ok) throw new Error(`expected ok:${op}, got ${res.kind} ${(res as { reason?: string }).reason}: ${res.message}`);
  if (res.op !== op) throw new Error(`expected op ${op}, got ${res.op}`);
  return res as Extract<EngineOk, { op: K }>;
}
function refused(res: EngineResponse): { reason: string; message: string } {
  if (res.ok) throw new Error("expected a refusal, got success");
  if (res.kind !== "refused") throw new Error(`expected refusal, got ${res.kind}: ${res.message}`);
  return { reason: res.reason, message: res.message };
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

async function makePad(tab: Tab, label = "alice"): Promise<string> {
  const res = ok(
    await tab.send({
      op: "gen",
      label,
      sources: [{ name: "s.bin", declaredOrigin: "test material, operator-asserted", bytes: new Uint8Array(8192).fill(0x5c) }],
      encryptionBytes: 2048,
      authRecords: 16,
      witnessClass: "browser-none"
    }),
    "gen"
  );
  return res.pair.pairId;
}

/** The full ceremony, returned in pieces so individual tests can interrupt it. */
async function ceremony() {
  const alice = origin();
  const bob = origin();
  const pairId = await makePad(alice.tab);

  const created = ok(await bob.tab.send({ op: "spt-create-request" }), "spt-create-request");
  const inspected = ok(await alice.tab.send({ op: "spt-inspect-request", text: created.tpr2 }), "spt-inspect-request");
  const confirmed = ok(
    await alice.tab.send({ op: "spt-confirm-request", reviewId: inspected.reviewId }),
    "spt-confirm-request"
  );
  return { alice, bob, pairId, created, inspected, confirmed };
}

/* ---- the happy path ------------------------------------------------------- */

describe("Alice seals a pad to Bob, and it is the same pad", () => {
  it("completes, and the delivered pad carries real messages both ways", async () => {
    const { alice, bob, pairId, created, inspected } = await ceremony();

    // 5 — both sides render the SAME twelve indices from the same request.
    expect(inspected.requestIndices).toEqual(created.requestIndices);
    expect(inspected.requestHash).toBe(created.requestHash);

    // The exact bytes Alice is about to seal, captured WITHOUT committing a
    // physical handoff, so the byte-identity assertion below is honest.
    const beforeSeal = await buildLiveCourierContainer(alice.vfs, pairId);
    expect((await readHandoffState(alice.vfs, pairId)).kind).toBe("absent");

    // 7, 8 — seal. The claim and the handoff are durable before the package
    // exists outside the worker.
    const sealed = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    expect(sealed.reshared).toBe(false);
    expect((await readRequestClaim(alice.vfs, hexBytes(created.requestHash))).kind).toBe("claimed");
    expect((await readHandoffState(alice.vfs, pairId)).kind).toBe("sealed");

    // 9, 10 — Bob opens it and the eight confirmation indices agree.
    const opened = ok(await bob.tab.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
    expect(opened.confirmationIndices).toEqual(sealed.confirmationIndices);
    expect(opened.requestId).toBe(created.requestId);

    // 11, 12, 13 — commit, and the pad is Bob's, marked as arrived.
    const committed = ok(await bob.tab.send({ op: "spt-commit-receive", sessionId: opened.sessionId }), "spt-commit-receive");
    expect(committed.complete).toBe(true);
    expect(committed.pair.pairId).toBe(pairId);
    const meta = JSON.parse(fromUtf8.decode((await bob.vfs.readFile(`${pairId}/pair.json`))!));
    expect(meta.origin).toBe("imported");
    expect((await deriveReceiveCompletion(bob.vfs, created.requestId, new Date())).kind).toBe("complete");

    // 49 — BYTE IDENTITY. Every one of the six frozen Store Format files that
    // arrived is exactly what Alice sealed. pair.json, the handoff record and
    // the SPT state are local product state and are not compared.
    const arrived = await buildLiveCourierContainer(bob.vfs, pairId);
    const before = unpackContainer(beforeSeal);
    const after = unpackContainer(arrived);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.files.map((f) => f.path).sort()).toEqual(before.files.map((f) => f.path).sort());
    for (const f of before.files) {
      const mine = after.files.find((x) => x.path === f.path)!;
      expect(bytesToHex(mine.bytes), `${f.path} must arrive byte-identical`).toBe(bytesToHex(f.bytes));
    }

    // 14–17 — THE PROOF. Ordinary TP2 messages, both directions, through the
    // existing unmodified message path.
    const a2b = ok(await alice.tab.send({ op: "burn", pairId, as: "A", plaintext: utf8.encode("delivered by sealed transfer") }), "burn");
    const gotA = ok(await bob.tab.send({ op: "open", pairId, as: "B", envelope: a2b.envelope }), "open");
    expect(fromUtf8.decode(gotA.plaintext)).toBe("delivered by sealed transfer");

    const b2a = ok(await bob.tab.send({ op: "burn", pairId, as: "B", plaintext: utf8.encode("and the reverse direction") }), "burn");
    const gotB = ok(await alice.tab.send({ op: "open", pairId, as: "A", envelope: b2a.envelope }), "open");
    expect(fromUtf8.decode(gotB.plaintext)).toBe("and the reverse direction");
  });

  it("no decrypted pad bytes ever appear in an EngineResponse", async () => {
    const { alice, bob, pairId, created } = await ceremony();
    const sealed = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    const opened = await bob.tab.send({ op: "spt-open-sealed", package: sealed.package });
    const committed = await bob.tab.send({ op: "spt-commit-receive", sessionId: ok(opened, "spt-open-sealed").sessionId });
    // The container's own magic string must not appear in any response we hand
    // the UI. The package itself is public ciphertext and is allowed.
    for (const res of [opened, committed]) {
      const json = JSON.stringify(res, (_k, v) => (v instanceof Uint8Array ? bytesToHex(v) : v));
      expect(json).not.toContain("truepad2-pair-bundle");
      expect(json).not.toContain(bytesToHex(utf8.encode("truepad2-pair-bundle")));
    }
  });
});

/** The engine speaks hex on its public surface; the storage helpers take bytes. */
function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/* ---- the sender ceremony -------------------------------------------------- */

describe("the sender ceremony", () => {
  it("the TPR2 is exactly 1652 characters", async () => {
    const bob = origin();
    const created = ok(await bob.tab.send({ op: "spt-create-request" }), "spt-create-request");
    expect(created.tpr2.length).toBe(1652);
    expect(created.tpr2.startsWith("TPR2:")).toBe(true);
    expect(created.requestIndices.length).toBe(12);
  });

  it("one edited character changes the fingerprint", async () => {
    const bob = origin();
    const alice = origin();
    const created = ok(await bob.tab.send({ op: "spt-create-request" }), "spt-create-request");
    const good = ok(await alice.tab.send({ op: "spt-inspect-request", text: created.tpr2 }), "spt-inspect-request");
    // Flip one base64url character in the middle of the encapsulation key.
    const at = 900;
    const alt = created.tpr2[at] === "A" ? "B" : "A";
    const edited = created.tpr2.slice(0, at) + alt + created.tpr2.slice(at + 1);
    const bad = ok(await alice.tab.send({ op: "spt-inspect-request", text: edited }), "spt-inspect-request");
    expect(bad.requestHash).not.toBe(good.requestHash);
    expect(bad.requestIndices).not.toEqual(good.requestIndices);
  });

  it("confirm takes a reviewId and nothing else", async () => {
    const { alice, inspected, confirmed, created } = await ceremony();
    expect(confirmed.requestHash).toBe(created.requestHash);
    // The confirmed record exists and is filed under the request's own hash.
    expect(await alice.vfs.exists(confirmedPath(created.requestHash))).toBe(true);
    // An unknown handle refuses.
    expect(refused(await alice.tab.send({ op: "spt-confirm-request", reviewId: "0".repeat(32) })).reason).toBe(
      "spt-review-not-found"
    );
    void inspected;
  });

  it("a review does not survive a new worker", async () => {
    const bob = origin();
    const vfs = new MemoryVfs();
    const locks = new MemoryLockProvider();
    const first = new Tab(vfs, new SptRuntime(locks));
    const created = ok(await bob.tab.send({ op: "spt-create-request" }), "spt-create-request");
    const inspected = ok(await first.send({ op: "spt-inspect-request", text: created.tpr2 }), "spt-inspect-request");
    // A new runtime is a new worker. Nothing durable was written by a review.
    const second = new Tab(vfs, new SptRuntime(locks));
    expect(refused(await second.send({ op: "spt-confirm-request", reviewId: inspected.reviewId })).reason).toBe(
      "spt-review-not-found"
    );
    expect(await vfs.exists(confirmedPath(created.requestHash))).toBe(false);
  });

  it("sealing an unconfirmed request refuses", async () => {
    const alice = origin();
    const bob = origin();
    const pairId = await makePad(alice.tab);
    const created = ok(await bob.tab.send({ op: "spt-create-request" }), "spt-create-request");
    // Never inspected, never confirmed.
    expect(refused(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId })).reason).toBe(
      "spt-confirmation-missing"
    );
    expect((await readHandoffState(alice.vfs, pairId)).kind).toBe("absent");
  });
});

/* ---- sender claim and handoff, through the product ------------------------ */

describe("one request, one pad; one pad, one request", () => {
  it("R→P then R→Q refuses before any encapsulation", async () => {
    const { alice, bob, pairId, created } = await ceremony();
    ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    const fresh = await makePad(alice.tab, "second pad");
    expect((await readHandoffState(alice.vfs, fresh)).kind).toBe("absent");
    const r = refused(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId: fresh }));
    expect(r.reason).toBe("request-claimed-elsewhere");
    // The fresh pad is untouched: no claim, no handoff, nothing encapsulated.
    expect((await readHandoffState(alice.vfs, fresh)).kind).toBe("absent");
    void bob;
  });

  it("P→R then P→R2 refuses", async () => {
    const { alice, bob, pairId, created } = await ceremony();
    ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    const second = ok(await bob.tab.send({ op: "spt-create-request" }), "spt-create-request");
    const review = ok(await alice.tab.send({ op: "spt-inspect-request", text: second.tpr2 }), "spt-inspect-request");
    ok(await alice.tab.send({ op: "spt-confirm-request", reviewId: review.reviewId }), "spt-confirm-request");
    expect(refused(await alice.tab.send({ op: "spt-seal", requestHash: second.requestHash, pairId })).reason).toBe(
      "pad-already-sealed"
    );
  });

  it("a physically exported pad cannot be sealed", async () => {
    const { alice, pairId, created } = await ceremony();
    ok(await alice.tab.send({ op: "export-pair", pairId }), "export-pair");
    expect(refused(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId })).reason).toBe(
      "pad-already-handed-off"
    );
  });

  it("a sealed pad cannot be physically exported", async () => {
    const { alice, pairId, created } = await ceremony();
    ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    expect(refused(await alice.tab.send({ op: "export-pair", pairId })).reason).toBe("pad-already-sealed");
  });

  it("an imported pad, an unknown-provenance pad, and a used pad all refuse", async () => {
    const { alice, bob, pairId, created } = await ceremony();
    // imported
    const exported = ok(await alice.tab.send({ op: "export-pair", pairId }), "export-pair");
    ok(await bob.tab.send({ op: "import-pair", label: "bob", container: exported.container }), "import-pair");
    const review = ok(await bob.tab.send({ op: "spt-inspect-request", text: (await freshRequest()).tpr2 }), "spt-inspect-request");
    const conf = ok(await bob.tab.send({ op: "spt-confirm-request", reviewId: review.reviewId }), "spt-confirm-request");
    expect(refused(await bob.tab.send({ op: "spt-seal", requestHash: conf.requestHash, pairId })).reason).toBe(
      "imported-pair-cannot-export"
    );

    // unknown provenance
    const other = origin();
    const legacy = await makePad(other.tab);
    const meta = JSON.parse(fromUtf8.decode((await other.vfs.readFile(`${legacy}/pair.json`))!));
    delete meta.origin;
    await other.vfs.writeFileAtomic(`${legacy}/pair.json`, utf8.encode(JSON.stringify(meta)));
    const r2 = ok(await other.tab.send({ op: "spt-inspect-request", text: (await freshRequest()).tpr2 }), "spt-inspect-request");
    const c2 = ok(await other.tab.send({ op: "spt-confirm-request", reviewId: r2.reviewId }), "spt-confirm-request");
    expect(refused(await other.tab.send({ op: "spt-seal", requestHash: c2.requestHash, pairId: legacy })).reason).toBe(
      "pad-provenance-unknown"
    );

    // used (not at genesis)
    const third = origin();
    const used = await makePad(third.tab);
    ok(await third.tab.send({ op: "burn", pairId: used, as: "A", plaintext: utf8.encode("hi") }), "burn");
    const r3 = ok(await third.tab.send({ op: "spt-inspect-request", text: (await freshRequest()).tpr2 }), "spt-inspect-request");
    const c3 = ok(await third.tab.send({ op: "spt-confirm-request", reviewId: r3.reviewId }), "spt-confirm-request");
    expect(refused(await third.tab.send({ op: "spt-seal", requestHash: c3.requestHash, pairId: used })).reason).toBe(
      "pad-not-at-genesis"
    );
    void created;
  });

  it("re-sealing the same request and pad returns the EXACT package, with no new encapsulation", async () => {
    const { alice, pairId, created } = await ceremony();
    const first = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    const again = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    expect(again.reshared).toBe(true);
    expect(bytesToHex(again.package)).toBe(bytesToHex(first.package));
    expect(again.confirmationIndices).toEqual(first.confirmationIndices);
    expect(again.packageIdentity).toBe(first.packageIdentity);
    // A third time, still identical. Randomized encapsulation would differ.
    const third = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    expect(bytesToHex(third.package)).toBe(bytesToHex(first.package));
  });

  it("re-share still works after the confirmation expires", async () => {
    // The security decision happened before the handoff committed; requiring a
    // fresh confirmation to hand over bytes that already exist would turn a
    // lapsed confirmation into a lost pad.
    const { alice, pairId, created } = await ceremony();
    const first = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    await alice.vfs.remove(confirmedPath(created.requestHash));
    const again = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    expect(bytesToHex(again.package)).toBe(bytesToHex(first.package));
  });
});

async function freshRequest() {
  const o = origin();
  return ok(await o.tab.send({ op: "spt-create-request" }), "spt-create-request");
}

/* ---- receiving ------------------------------------------------------------ */

describe("opening a sealed package", () => {
  async function sealedFor() {
    const { alice, bob, pairId, created } = await ceremony();
    const sealed = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    return { alice, bob, pairId, created, sealed };
  }

  it("a malformed package is refused before any request is looked up", async () => {
    const { bob, sealed } = await sealedFor();
    for (const mutate of [
      (b: Uint8Array) => (b[0] ^= 0xff), // magic
      (b: Uint8Array) => (b[4] = 0x02), // version
      (b: Uint8Array) => (b[6] = 0x02) // suite
    ]) {
      const bad = Uint8Array.from(sealed.package);
      mutate(bad);
      expect(refused(await bob.tab.send({ op: "spt-open-sealed", package: bad })).reason).toBe("spt-package-malformed");
    }
    expect(refused(await bob.tab.send({ op: "spt-open-sealed", package: new Uint8Array(10) })).reason).toBe(
      "spt-package-malformed"
    );
  });

  it("a package naming another request, or carrying a wrong hash, refuses", async () => {
    const { bob, sealed } = await sealedFor();
    const wrongId = Uint8Array.from(sealed.package);
    wrongId[7] ^= 0x01; // requestId
    expect(refused(await bob.tab.send({ op: "spt-open-sealed", package: wrongId })).reason).toBe(
      "spt-request-unavailable"
    );
    const wrongHash = Uint8Array.from(sealed.package);
    wrongHash[23] ^= 0x01; // requestHash
    expect(refused(await bob.tab.send({ op: "spt-open-sealed", package: wrongHash })).reason).toBe(
      "spt-request-unavailable"
    );
  });

  it("altered ciphertext, tag, nonce or KEM ciphertext are ONE outcome", async () => {
    const { bob, sealed } = await sealedFor();
    const reasons = new Set<string>();
    const messages = new Set<string>();
    for (const at of [55, 1175, 1195, sealed.package.length - 1]) {
      const bad = Uint8Array.from(sealed.package);
      bad[at] ^= 0x01;
      const r = refused(await bob.tab.send({ op: "spt-open-sealed", package: bad }));
      reasons.add(r.reason);
      messages.add(r.message);
    }
    // KEM failure and AEAD failure must be indistinguishable through the API.
    expect([...reasons]).toEqual(["spt-package-open-failed"]);
    expect(messages.size).toBe(1);
  });

  it("a low-order ct_X is refused exactly like an AEAD failure", async () => {
    const { bob, sealed } = await sealedFor();
    const lowOrder = Uint8Array.from(sealed.package);
    lowOrder.set(new Uint8Array(32), 55 + 1088); // ct_X = all-zero u-coordinate
    const badTag = Uint8Array.from(sealed.package);
    badTag[badTag.length - 1] ^= 0x01;
    const a = refused(await bob.tab.send({ op: "spt-open-sealed", package: lowOrder }));
    const b = refused(await bob.tab.send({ op: "spt-open-sealed", package: badTag }));
    expect(a.reason).toBe("spt-package-open-failed");
    expect(a.reason).toBe(b.reason);
    expect(a.message).toBe(b.message);
  });

  it("every failed open leaves the request PENDING and unconsumed", async () => {
    const { bob, sealed, created } = await sealedFor();
    const bad = Uint8Array.from(sealed.package);
    bad[1195] ^= 0x01;
    await bob.tab.send({ op: "spt-open-sealed", package: bad });
    expect((await readReceiverState(bob.vfs, created.requestId, new Date())).kind).toBe("pending");
    // ...and the session lock was released, so a good package still opens.
    ok(await bob.tab.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
  });

  it("a cancelled request refuses before decapsulation", async () => {
    const { bob, sealed, created } = await sealedFor();
    ok(await bob.tab.send({ op: "spt-cancel-request", requestId: created.requestId }), "spt-cancel-request");
    expect(refused(await bob.tab.send({ op: "spt-open-sealed", package: sealed.package })).reason).toBe(
      "spt-request-cancelled"
    );
  });

  it("a duplicate pair refuses, and consumes nothing", async () => {
    const { alice, bob, pairId, created, sealed } = await sealedFor();
    // Bob already holds that pairId, imported by the ordinary courier path.
    const container = await buildLiveCourierContainer(alice.vfs, pairId);
    ok(await bob.tab.send({ op: "import-pair", label: "already", container }), "import-pair");
    expect(refused(await bob.tab.send({ op: "spt-open-sealed", package: sealed.package })).reason).toBe("pair-exists");
    expect((await readReceiverState(bob.vfs, created.requestId, new Date())).kind).toBe("pending");
  });
});

/* ---- cross-tab ------------------------------------------------------------ */

describe("one live session per request, across tabs", () => {
  async function twoTabs() {
    const alice = origin();
    const pairId = await makePad(alice.tab);
    // ONE origin, TWO tabs: same store, same lock provider, different runtimes.
    const vfs = new MemoryVfs();
    const locks = new MemoryLockProvider();
    const tabA = new Tab(vfs, new SptRuntime(locks));
    const tabB = new Tab(vfs, new SptRuntime(locks));
    const created = ok(await tabA.send({ op: "spt-create-request" }), "spt-create-request");
    const review = ok(await alice.tab.send({ op: "spt-inspect-request", text: created.tpr2 }), "spt-inspect-request");
    ok(await alice.tab.send({ op: "spt-confirm-request", reviewId: review.reviewId }), "spt-confirm-request");
    const sealed = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    return { vfs, locks, tabA, tabB, created, sealed, alice, pairId };
  }

  it("the second tab is refused immediately, not queued", async () => {
    const { tabA, tabB, sealed } = await twoTabs();
    const first = ok(await tabA.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
    const started = Date.now();
    const second = refused(await tabB.send({ op: "spt-open-sealed", package: sealed.package }));
    expect(second.reason).toBe("spt-session-busy");
    // Immediate: it did not wait for the first session to end.
    expect(Date.now() - started).toBeLessThan(1000);
    void first;
  });

  it("a DIFFERENT package for the same request is also refused", async () => {
    const { tabA, tabB, sealed } = await twoTabs();
    ok(await tabA.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
    const other = Uint8Array.from(sealed.package);
    other[1195] ^= 0x01;
    expect(refused(await tabB.send({ op: "spt-open-sealed", package: other })).reason).toBe("spt-session-busy");
  });

  it("abandoning releases the lock and leaves the request PENDING", async () => {
    const { vfs, tabA, tabB, sealed, created } = await twoTabs();
    const first = ok(await tabA.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
    ok(await tabA.send({ op: "spt-abandon", sessionId: first.sessionId }), "spt-abandon");
    expect((await readReceiverState(vfs, created.requestId, new Date())).kind).toBe("pending");
    // No terminal marker, and the other tab may now open.
    ok(await tabB.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
  });

  it("a tab disappearing releases the lock too", async () => {
    const { locks, tabA, tabB, sealed, created } = await twoTabs();
    ok(await tabA.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
    // The worker died: the browser drops the Web Lock with it.
    locks.forceRelease(`spt-recv:${created.requestId}`);
    ok(await tabB.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
  });

  it("no durable session flag is ever written", async () => {
    const { vfs, tabA, sealed, created } = await twoTabs();
    const s = ok(await tabA.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
    const entries = await vfs.list(`spt/receive/${created.requestId}`);
    expect(entries.sort()).toEqual(["dk.bin", "request.json"]);
    void s;
  });
});

/* ---- reject, abandon, stale sessions -------------------------------------- */

describe("rejection is terminal, abandonment is not", () => {
  async function opened() {
    const { alice, bob, pairId, created } = await ceremony();
    const sealed = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    const session = ok(await bob.tab.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
    return { alice, bob, pairId, created, sealed, session };
  }

  it("reject terminalizes, and the stale session cannot commit", async () => {
    const { bob, created, session, sealed } = await opened();
    const r = ok(await bob.tab.send({ op: "spt-reject", sessionId: session.sessionId }), "spt-reject");
    expect(r.state).toBe("cancelled");
    const state = await readReceiverState(bob.vfs, created.requestId, new Date());
    expect(state.kind).toBe("cancelled");
    if (state.kind === "cancelled") expect(state.reason).toBe("rejected");
    // The old sessionId is dead.
    expect(refused(await bob.tab.send({ op: "spt-commit-receive", sessionId: session.sessionId })).reason).toBe(
      "spt-session-not-found"
    );
    // And the request refuses a new open before decapsulation.
    expect(refused(await bob.tab.send({ op: "spt-open-sealed", package: sealed.package })).reason).toBe(
      "spt-request-cancelled"
    );
  });

  it("abandon leaves everything reusable", async () => {
    const { bob, created, session, sealed } = await opened();
    ok(await bob.tab.send({ op: "spt-abandon", sessionId: session.sessionId }), "spt-abandon");
    expect((await readReceiverState(bob.vfs, created.requestId, new Date())).kind).toBe("pending");
    expect(refused(await bob.tab.send({ op: "spt-commit-receive", sessionId: session.sessionId })).reason).toBe(
      "spt-session-not-found"
    );
    // The same package opens again.
    ok(await bob.tab.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
  });

  it("commitReceive takes a session handle and nothing else", async () => {
    const { bob, session } = await opened();
    // There is no parameter through which pad bytes, a pairId, a requestHash or
    // a package could be supplied. Extra properties are simply not read.
    const sneaky = {
      op: "spt-commit-receive",
      sessionId: session.sessionId,
      padFileBytes: new Uint8Array(10).fill(0xff),
      pairId: "f".repeat(32),
      container: new Uint8Array(10)
    } as unknown as WithoutId<EngineRequest>;
    const committed = ok(await bob.tab.send(sneaky), "spt-commit-receive");
    // It imported the session's pad, not the caller's.
    expect(committed.pair.pairId).not.toBe("f".repeat(32));
  });
});

/* ---- consume before import, under faults ---------------------------------- */

describe("consume before import", () => {
  async function readyToCommit(nonAtomic: boolean) {
    const alice = origin();
    const pairId = await makePad(alice.tab);
    const inner = new MemoryVfs();
    const locks = new MemoryLockProvider();
    const faulty = new FaultVfs(inner, { nonAtomic });
    const bobTab = new Tab(faulty, new SptRuntime(locks));
    const created = ok(await bobTab.send({ op: "spt-create-request" }), "spt-create-request");
    const review = ok(await alice.tab.send({ op: "spt-inspect-request", text: created.tpr2 }), "spt-inspect-request");
    ok(await alice.tab.send({ op: "spt-confirm-request", reviewId: review.reviewId }), "spt-confirm-request");
    const sealed = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    const session = ok(await bobTab.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
    return { inner, faulty, bobTab, created, session, pairId, alice };
  }

  const consumedPath = (id: string) => `spt/receive/${id}/consumed.json`;

  it("A — the consume write fails with no target: no import, session retained, retry works", async () => {
    const { inner, faulty, bobTab, created, session, pairId } = await readyToCommit(false);
    faulty.failWrite({ path: consumedPath(created.requestId), mode: "throw-before" });
    const r = refused(await bobTab.send({ op: "spt-commit-receive", sessionId: session.sessionId }));
    expect(r.reason).not.toBe("spt-receive-loss");
    expect((await readReceiverState(inner, created.requestId, new Date())).kind).toBe("pending");
    expect(await inner.exists(`${pairId}/pair.json`)).toBe(false);
    // The session is still live and the retry succeeds.
    ok(await bobTab.send({ op: "spt-commit-receive", sessionId: session.sessionId }), "spt-commit-receive");
  });

  it("B — the consume marker tears: terminal, no import, session gone", async () => {
    const { inner, faulty, bobTab, created, session, pairId } = await readyToCommit(true);
    faulty.failWrite({ path: consumedPath(created.requestId), mode: "partial-then-throw", bytes: 8 });
    expect(refused(await bobTab.send({ op: "spt-commit-receive", sessionId: session.sessionId })).reason).toBe(
      "spt-receive-loss"
    );
    expect((await readReceiverState(inner, created.requestId, new Date())).kind).toBe("terminal-unreadable");
    expect(await inner.exists(`${pairId}/pair.json`)).toBe(false);
    expect(refused(await bobTab.send({ op: "spt-commit-receive", sessionId: session.sessionId })).reason).toBe(
      "spt-session-not-found"
    );
  });

  it("C — consume valid but the import fails: LOSS, and the request stays consumed", async () => {
    const { inner, faulty, bobTab, created, session, pairId } = await readyToCommit(false);
    faulty.failWrite({ path: `${pairId}/a-to-b/head.json`, mode: "throw-before", times: 99 });
    const r = refused(await bobTab.send({ op: "spt-commit-receive", sessionId: session.sessionId }));
    expect(r.reason).toBe("spt-receive-loss");
    expect(r.message).toMatch(/one-time receive request was used/);
    const state = await readReceiverState(inner, created.requestId, new Date());
    expect(state.kind).toBe("consumed");
    // Never reopened, and the package cannot be re-opened either.
    expect(refused(await bobTab.send({ op: "spt-commit-receive", sessionId: session.sessionId })).reason).toBe(
      "spt-session-not-found"
    );
  });

  it("D — consume valid, import commits, response lost: COMPLETE is derivable", async () => {
    const { inner, bobTab, created, session } = await readyToCommit(false);
    ok(await bobTab.send({ op: "spt-commit-receive", sessionId: session.sessionId }), "spt-commit-receive");
    // The response is "lost"; a fresh read of durable state answers anyway.
    expect((await deriveReceiveCompletion(inner, created.requestId, new Date())).kind).toBe("complete");
  });

  it("E — a pair appearing before the commit recheck is FREE: nothing consumed", async () => {
    const { inner, bobTab, created, session, pairId, alice } = await readyToCommit(false);
    const container = await buildLiveCourierContainer(alice.vfs, pairId);
    ok(await new Tab(inner, new SptRuntime(new MemoryLockProvider())).send({ op: "import-pair", label: "race", container }), "import-pair");
    expect(refused(await bobTab.send({ op: "spt-commit-receive", sessionId: session.sessionId })).reason).toBe("pair-exists");
    expect((await readReceiverState(inner, created.requestId, new Date())).kind).toBe("pending");
  });

  it("F — a tombstone appearing before the commit recheck is FREE", async () => {
    const { inner, bobTab, created, session, pairId } = await readyToCommit(false);
    await inner.writeFileAtomic(`${pairId}/destroyed.json`, utf8.encode(JSON.stringify({ pairId })));
    const r = refused(await bobTab.send({ op: "spt-commit-receive", sessionId: session.sessionId }));
    expect(r.reason).toBe("pair-destroyed");
    expect((await readReceiverState(inner, created.requestId, new Date())).kind).toBe("pending");
  });
});

/* ---- the importer is the SAME importer ------------------------------------ */

describe("sealed import uses the existing importer", () => {
  it("produces the same pair shape, provenance and commit gate as a courier import", async () => {
    const { alice, bob, pairId, created } = await ceremony();
    const sealed = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    const session = ok(await bob.tab.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
    ok(await bob.tab.send({ op: "spt-commit-receive", sessionId: session.sessionId }), "spt-commit-receive");

    // A courier import of the SAME pad into a third store, for comparison.
    const third = origin();
    const container = await buildLiveCourierContainer(alice.vfs, pairId);
    ok(await third.tab.send({ op: "import-pair", label: "courier", container }), "import-pair");

    for (const store of [bob.vfs, third.vfs]) {
      const meta = JSON.parse(fromUtf8.decode((await store.readFile(`${pairId}/pair.json`))!));
      expect(meta.origin).toBe("imported");
      expect(Object.keys(meta).sort()).toEqual(["createdAt", "label", "origin", "pairId", "witness"]);
      expect(await store.exists(`${pairId}/importing.json`)).toBe(false);
    }
    // The six frozen files are identical in both.
    const viaSpt = unpackContainer(await buildLiveCourierContainer(bob.vfs, pairId));
    const viaCourier = unpackContainer(await buildLiveCourierContainer(third.vfs, pairId));
    if (!viaSpt.ok || !viaCourier.ok) throw new Error("unpack failed");
    for (const f of viaSpt.files) {
      const other = viaCourier.files.find((x) => x.path === f.path)!;
      expect(bytesToHex(f.bytes), f.path).toBe(bytesToHex(other.bytes));
    }
    // The sealed import used the deterministic engine label.
    const label = JSON.parse(fromUtf8.decode((await bob.vfs.readFile(`${pairId}/pair.json`))!)).label;
    expect(label).toBe("Received pad");
  });
});

/* ---------------------------------------------------------------------------
 * Phase 1C.1 — an exact re-share is not a new seal
 * ------------------------------------------------------------------------ */

describe("re-sharing a committed package after the pad has been USED", () => {
  /** Seal, deliver, and then actually use the pad — which is the whole point of
   *  having delivered it, and which makes Alice's live store no longer genesis. */
  async function deliveredAndUsed() {
    const { alice, bob, pairId, created } = await ceremony();
    const first = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    const session = ok(await bob.tab.send({ op: "spt-open-sealed", package: first.package }), "spt-open-sealed");
    ok(await bob.tab.send({ op: "spt-commit-receive", sessionId: session.sessionId }), "spt-commit-receive");

    const burn = ok(
      await alice.tab.send({ op: "burn", pairId, as: "A", plaintext: utf8.encode("now the pad is in use") }),
      "burn"
    );
    ok(await bob.tab.send({ op: "open", pairId, as: "B", envelope: burn.envelope }), "open");
    return { alice, bob, pairId, created, first };
  }

  it("still re-shares the EXACT committed package once the pad is past genesis", async () => {
    const { alice, pairId, created, first } = await deliveredAndUsed();

    // The live pad is demonstrably no longer at genesis...
    const status = ok(await alice.tab.send({ op: "status", pairId }), "status");
    const advanced = Object.values(status.pair.meters).some(
      (m) => m.encryption.nextOffset > 0 || m.authentication.nextSequence > 0
    );
    expect(advanced, "the pad must have advanced for this test to mean anything").toBe(true);

    // ...and the committed package is still reachable, byte for byte.
    const again = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    expect(again.reshared).toBe(true);
    expect(bytesToHex(again.package)).toBe(bytesToHex(first.package));
    expect(again.packageIdentity).toBe(first.packageIdentity);
    expect(again.confirmationIndices).toEqual(first.confirmationIndices);
  });

  it("the re-share mutates nothing — no marker rewrite, no claim rewrite, no counter move", async () => {
    const { alice, pairId, created } = await deliveredAndUsed();
    const markerBefore = bytesToHex((await alice.vfs.readFile(markerPath(pairId)))!);
    const claimBefore = await readRequestClaim(alice.vfs, hexBytes(created.requestHash));
    const statusBefore = ok(await alice.tab.send({ op: "status", pairId }), "status");

    ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");

    expect(bytesToHex((await alice.vfs.readFile(markerPath(pairId)))!)).toBe(markerBefore);
    const claimAfter = await readRequestClaim(alice.vfs, hexBytes(created.requestHash));
    expect(JSON.stringify(claimAfter)).toBe(JSON.stringify(claimBefore));
    const statusAfter = ok(await alice.tab.send({ op: "status", pairId }), "status");
    expect(JSON.stringify(statusAfter.pair.meters)).toBe(JSON.stringify(statusBefore.pair.meters));
  });

  it("still re-shares after a retire advances the pad further", async () => {
    const { alice, pairId, created, first } = await deliveredAndUsed();
    const status = ok(await alice.tab.send({ op: "status", pairId }), "status");
    const ab = status.pair.meters["A->B"];
    ok(
      await alice.tab.send({
        op: "retire",
        pairId,
        direction: "A->B",
        throughSequence: ab.authentication.nextSequence,
        reason: "test advance"
      }),
      "retire"
    );
    const again = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    expect(again.reshared).toBe(true);
    expect(bytesToHex(again.package)).toBe(bytesToHex(first.package));
  });

  it("a re-share needs no current confirmation, even after the pad is used", async () => {
    const { alice, pairId, created, first } = await deliveredAndUsed();
    await alice.vfs.remove(confirmedPath(created.requestHash));
    const again = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    expect(bytesToHex(again.package)).toBe(bytesToHex(first.package));
  });

  it("DESTRUCTION still overrides a committed package", async () => {
    const { alice, pairId, created } = await deliveredAndUsed();
    ok(await alice.tab.send({ op: "destroy", pairId, confirm: pairId }), "destroy");
    // The stored package may well still be on disk; it must not come back out.
    expect(await alice.vfs.exists(handoffPackagePath(pairId))).toBe(true);
    expect(refused(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId })).reason).toBe(
      "pair-destroyed"
    );
  });

  it("a corrupt committed payload stays unrecoverable, used pad or not", async () => {
    const { alice, pairId, created } = await deliveredAndUsed();
    const tampered = (await alice.vfs.readFile(handoffPackagePath(pairId)))!;
    tampered[0] ^= 0x01;
    await alice.vfs.writeFileAtomic(handoffPackagePath(pairId), tampered);
    expect(refused(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId })).reason).toBe(
      "handoff-unrecoverable"
    );
    // And no new encapsulation was attempted to "fix" it.
    const again = refused(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }));
    expect(again.reason).toBe("handoff-unrecoverable");
  });

  it("a DIFFERENT request against the same sealed pad still refuses", async () => {
    const { alice, bob, pairId } = await deliveredAndUsed();
    const other = ok(await bob.tab.send({ op: "spt-create-request" }), "spt-create-request");
    const review = ok(await alice.tab.send({ op: "spt-inspect-request", text: other.tpr2 }), "spt-inspect-request");
    ok(await alice.tab.send({ op: "spt-confirm-request", reviewId: review.reviewId }), "spt-confirm-request");
    expect(refused(await alice.tab.send({ op: "spt-seal", requestHash: other.requestHash, pairId })).reason).toBe(
      "pad-already-sealed"
    );
  });
});

describe("a FIRST seal still requires genesis", () => {
  it("a used pad with no committed handoff refuses", async () => {
    // The gate moved later in the function; it did not go away.
    const { alice, pairId, created } = await ceremony();
    ok(await alice.tab.send({ op: "burn", pairId, as: "A", plaintext: utf8.encode("used first") }), "burn");
    expect((await readHandoffState(alice.vfs, pairId)).kind).toBe("absent");
    expect(refused(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId })).reason).toBe(
      "pad-not-at-genesis"
    );
    // ...and nothing was claimed or committed by the refused attempt.
    expect((await readRequestClaim(alice.vfs, hexBytes(created.requestHash))).kind).toBe("absent");
    expect((await readHandoffState(alice.vfs, pairId)).kind).toBe("absent");
  });

  it("an imported pad with no handoff still refuses, before any genesis test", async () => {
    const { alice, bob, pairId, created } = await ceremony();
    const container = await buildLiveCourierContainer(alice.vfs, pairId);
    ok(await bob.tab.send({ op: "import-pair", label: "bob", container }), "import-pair");
    const review = ok(await bob.tab.send({ op: "spt-inspect-request", text: (await freshRequest()).tpr2 }), "spt-inspect-request");
    const conf = ok(await bob.tab.send({ op: "spt-confirm-request", reviewId: review.reviewId }), "spt-confirm-request");
    expect(refused(await bob.tab.send({ op: "spt-seal", requestHash: conf.requestHash, pairId })).reason).toBe(
      "imported-pair-cannot-export"
    );
    void created;
  });
});

/* ---------------------------------------------------------------------------
 * Phase 1C.1 — TTL decisions belong to the moment they are made
 * ------------------------------------------------------------------------ */

describe("expiry is judged under the authority lock, not before the wait", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** Start an operation while `scope` is held by someone else, let `holdMs` of
   *  real time pass with it queued, then release and return its result.
   *
   *  The operation is NOT awaited while the lock is held — doing that would
   *  deadlock, since it cannot settle until the lock frees. */
  async function afterWaiting<T>(vfs: Vfs, scope: string, holdMs: number, start: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const acquired = new Promise<void>((r) => {
      void vfs.withLock(scope, async () => {
        r();
        await held;
      });
    });
    await acquired;
    const pending = start(); // queues behind the held lock
    await new Promise((r) => setTimeout(r, holdMs));
    release();
    return pending;
  }

  it("A — a confirmation that expires while seal waits is expired", async () => {
    const { alice, pairId, created } = await ceremony();
    // Rewrite the confirmation so it is valid now and expires in a moment.
    const raw = JSON.parse(fromUtf8.decode((await alice.vfs.readFile(confirmedPath(created.requestHash)))!));
    const confirmedAt = new Date(Date.now() - 7 * DAY + 50).toISOString();
    raw.confirmedAt = confirmedAt;
    raw.expiresAt = new Date(Date.parse(confirmedAt) + 7 * DAY).toISOString();
    await alice.vfs.writeFileAtomic(confirmedPath(created.requestHash), utf8.encode(JSON.stringify(raw)));

    // It is valid at this instant...
    expect(Date.parse(raw.expiresAt)).toBeGreaterThan(Date.now());
    // ...and seal waits past it on the sender lock.
    const sealResult = await afterWaiting(alice.vfs, `spt-send:${created.requestHash}`, 150, () =>
      alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId })
    );
    expect(refused(sealResult).reason).toBe("spt-confirmation-expired");
    expect((await readHandoffState(alice.vfs, pairId)).kind).toBe("absent");
  });

  it("B — a request that expires while open waits does not yield a key", async () => {
    const { alice, bob, pairId, created } = await ceremony();
    const sealed = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    // Rewrite the stored request so it expires in a moment.
    await expireRequestIn(bob.vfs, created.requestId, 60);

    const openResult = await afterWaiting(bob.vfs, `spt-req:${created.requestId}`, 150, () =>
      bob.tab.send({ op: "spt-open-sealed", package: sealed.package })
    );
    // The open must have refused as expired, and the request terminalized.
    expect(refused(openResult).reason).toBe("spt-request-expired");
    const state = await readReceiverState(bob.vfs, created.requestId, new Date());
    expect(state.kind).toBe("cancelled");
    if (state.kind === "cancelled") expect(state.reason).toBe("expired");
  });

  it("C — a request that expires during the human comparison is not imported", async () => {
    const { alice, bob, pairId, created } = await ceremony();
    const sealed = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
    const session = ok(await bob.tab.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
    // The operator takes a long time; the request lapses meanwhile.
    await expireRequestIn(bob.vfs, created.requestId, -1000);
    const r = refused(await bob.tab.send({ op: "spt-commit-receive", sessionId: session.sessionId }));
    expect(r.reason).toBe("spt-request-expired");
    expect(await bob.vfs.exists(`${pairId}/pair.json`)).toBe(false);
    const state = await readReceiverState(bob.vfs, created.requestId, new Date());
    expect(state.kind).toBe("cancelled");
    if (state.kind === "cancelled") expect(state.reason).toBe("expired");
  });

  it("D — a cancel that waits past expiry is recorded as expired, not operator", async () => {
    const bob = origin();
    const created = ok(await bob.tab.send({ op: "spt-create-request" }), "spt-create-request");
    await expireRequestIn(bob.vfs, created.requestId, 80);

    const cancelResult = await afterWaiting(bob.vfs, `spt-req:${created.requestId}`, 200, () =>
      bob.tab.send({ op: "spt-cancel-request", requestId: created.requestId })
    );
    const res = ok(cancelResult, "spt-cancel-request");
    // The pre-lock clock would have said "operator". The post-lock one says
    // what actually happened.
    expect(res.reason).toBe("expired");
    const marker = JSON.parse(fromUtf8.decode((await bob.vfs.readFile(cancelledPath(created.requestId)))!));
    expect(marker.reason).toBe("expired");
  });

  it("create stamps each attempt under its own request lock", async () => {
    const bob = origin();
    const before = Date.now();
    const created = ok(await bob.tab.send({ op: "spt-create-request" }), "spt-create-request");
    const raw = JSON.parse(fromUtf8.decode((await bob.vfs.readFile(`spt/receive/${created.requestId}/request.json`))!));
    expect(Date.parse(raw.createdAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(raw.expiresAt) - Date.parse(raw.createdAt)).toBe(7 * DAY);
    expect(raw.expiresAt).toBe(created.expiresAt);
  });
});

/** Rewrite a stored request so it expires `ms` from now (negative = already). */
async function expireRequestIn(vfs: Vfs, requestId: string, ms: number): Promise<void> {
  const path = `spt/receive/${requestId}/request.json`;
  const raw = JSON.parse(fromUtf8.decode((await vfs.readFile(path))!));
  const expiresAt = new Date(Date.now() + ms).toISOString();
  raw.expiresAt = expiresAt;
  raw.createdAt = new Date(Date.parse(expiresAt) - 7 * 24 * 60 * 60 * 1000).toISOString();
  await vfs.writeFileAtomic(path, utf8.encode(JSON.stringify(raw)));
}
