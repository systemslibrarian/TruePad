/* ============================================================================
 * Browser deployment assessment — derived per pad, fail-closed, never gold (§27)
 * ----------------------------------------------------------------------------
 * `status` assembles each pad's provenance and its live storage and hands them
 * to the single evaluator. A Browser Edition pad ALWAYS holds live state in
 * ordinary browser storage (OPFS), which is one rollback domain with no
 * independent witness — a known disqualifier. So a browser pad is NEVER
 * CONDITIONALLY ELIGIBLE, whatever its origin; the evaluator reports the most
 * specific known reason:
 *   · a browser-generated pad is a software CSPRNG source → NOT ELIGIBLE;
 *   · a pad delivered by sealed .tps2 is computational delivery → NOT ELIGIBLE,
 *     and no ordinary use or reload upgrades it;
 *   · a raw courier import over browser storage → NOT ELIGIBLE (storage);
 *   · a bare/legacy store with no provenance → NOT ELIGIBLE (storage).
 * ========================================================================= */

import { describe, expect, it } from "vitest";
import { MemoryVfs, type Vfs } from "../src/browser/engine/vfs";
import { handle, buildLiveCourierContainer } from "../src/browser/engine/verbs";
import { MemoryLockProvider, SptRuntime } from "../src/browser/engine/spt-runtime";
import type { EngineOk, EngineRequest, EngineResponse } from "../src/browser/engine/protocol";

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

function origin(): { vfs: MemoryVfs; tab: Tab } {
  const vfs = new MemoryVfs();
  return { vfs, tab: new Tab(vfs, new SptRuntime(new MemoryLockProvider())) };
}

function ok<K extends EngineOk["op"]>(res: EngineResponse, op: K): Extract<EngineOk, { op: K }> {
  if (!res.ok) throw new Error(`expected ok:${op}, got ${(res as { reason?: string }).reason}: ${res.message}`);
  if (res.op !== op) throw new Error(`expected op ${op}, got ${res.op}`);
  return res as Extract<EngineOk, { op: K }>;
}

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

async function statusOf(tab: Tab, pairId: string) {
  return ok(await tab.send({ op: "status", pairId }), "status").deployment;
}

/** Drive a full sealed transfer; return Bob's tab and the delivered pairId. */
async function sealedDelivery(): Promise<{ bob: { vfs: MemoryVfs; tab: Tab }; pairId: string }> {
  const alice = origin();
  const bob = origin();
  const pairId = await makePad(alice.tab);
  const created = ok(await bob.tab.send({ op: "spt-create-request" }), "spt-create-request");
  const inspected = ok(await alice.tab.send({ op: "spt-inspect-request", text: created.tpr2 }), "spt-inspect-request");
  ok(await alice.tab.send({ op: "spt-confirm-request", reviewId: inspected.reviewId }), "spt-confirm-request");
  const sealed = ok(await alice.tab.send({ op: "spt-seal", requestHash: created.requestHash, pairId }), "spt-seal");
  const opened = ok(await bob.tab.send({ op: "spt-open-sealed", package: sealed.package }), "spt-open-sealed");
  const committed = ok(await bob.tab.send({ op: "spt-commit-receive", sessionId: opened.sessionId }), "spt-commit-receive");
  expect(committed.pair.pairId).toBe(pairId);
  return { bob, pairId };
}

describe("browser deployment assessment (derived, fail-closed)", () => {
  it("(A) a browser-generated pad is NOT ELIGIBLE — a software CSPRNG source", async () => {
    const alice = origin();
    const pairId = await makePad(alice.tab);
    const d = await statusOf(alice.tab, pairId);
    expect(d.assessment).toBe("not-eligible");
    expect(d.creation).toBe("browser-generated");
    expect(d.source).toBe("software-csprng");
    expect(d.knownReason).toMatch(/CSPRNG/);
  });

  it("(C) a sealed-delivered pad is NOT ELIGIBLE — computational delivery, with a permanent sealed ancestor", async () => {
    const { bob, pairId } = await sealedDelivery();
    const d = await statusOf(bob.tab, pairId);
    expect(d.assessment).toBe("not-eligible");
    expect(d.creation).toBe("imported");
    expect(d.delivery).toBe("sealed-tps2");
    expect(d.sealedAncestor).toBe(true);
    expect(d.knownReason).toMatch(/computational/);
  });

  it("(D) a sealed-delivered pad stays NOT ELIGIBLE after ordinary use", async () => {
    const { bob, pairId } = await sealedDelivery();
    // Use the delivered pad: send a message over it, in the unchanged path.
    ok(await bob.tab.send({ op: "burn", pairId, as: "B", plaintext: new TextEncoder().encode("hello") }), "burn");
    expect((await statusOf(bob.tab, pairId)).assessment).toBe("not-eligible");
  });

  it("(E) a sealed-delivered pad never becomes CONDITIONALLY ELIGIBLE, and cannot be re-exported to launder it", async () => {
    const { bob, pairId } = await sealedDelivery();
    // An imported pad cannot be exported, so there is no export/re-import path
    // to strip its provenance.
    const exported = await bob.tab.send({ op: "export-pair", pairId });
    expect(exported.ok).toBe(false);
    // A second read (simulating a reload) is still NOT ELIGIBLE — the sealed
    // marker persists; nothing upgrades it.
    expect((await statusOf(bob.tab, pairId)).assessment).toBe("not-eligible");
  });

  it("(B) a raw courier import is NOT ELIGIBLE — its live state is browser storage", async () => {
    const alice = origin();
    const pairId = await makePad(alice.tab);
    const container = await buildLiveCourierContainer(alice.vfs, pairId);
    const charlie = origin();
    const imported = ok(await charlie.tab.send({ op: "import-pair", label: "raw", container }), "import-pair");
    const d = await statusOf(charlie.tab, imported.pair.pairId);
    expect(d.assessment).toBe("not-eligible");
    expect(d.creation).toBe("imported");
    expect(d.delivery).toBe("raw-import-unknown");
    expect(d.sealedAncestor).toBe(false);
    expect(d.knownReason).toMatch(/browser storage/);
  });

  it("(J) a bare store with no provenance is NOT ELIGIBLE (browser storage), and still usable", async () => {
    const alice = origin();
    const pairId = await makePad(alice.tab);
    // Remove the browser-only provenance file: a legacy/bare store.
    await alice.vfs.remove(`${pairId}/pair.json`);
    const d = await statusOf(alice.tab, pairId);
    expect(d.assessment).toBe("not-eligible");
    expect(d.creation).toBe("unknown");
    expect(d.source).toBe("unknown");
    expect(d.sealedAncestor).toBe("unknown");
    expect(d.knownReason).toMatch(/browser storage/);
    // Ordinary use is unaffected — the classification is separate from usability.
    ok(await alice.tab.send({ op: "burn", pairId, as: "A", plaintext: new TextEncoder().encode("hi") }), "burn");
  });

  it("(§27) NO browser pad — generated, sealed-imported, raw-imported, or bare — is ever CONDITIONALLY ELIGIBLE", async () => {
    const alice = origin();
    const generated = await makePad(alice.tab);
    expect((await statusOf(alice.tab, generated)).assessment).not.toBe("conditionally-eligible");

    const { bob, pairId: sealed } = await sealedDelivery();
    expect((await statusOf(bob.tab, sealed)).assessment).not.toBe("conditionally-eligible");

    const container = await buildLiveCourierContainer(alice.vfs, generated);
    const charlie = origin();
    const raw = ok(await charlie.tab.send({ op: "import-pair", label: "raw", container }), "import-pair");
    expect((await statusOf(charlie.tab, raw.pair.pairId)).assessment).not.toBe("conditionally-eligible");
  });
});
