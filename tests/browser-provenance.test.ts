import { describe, expect, it } from "vitest";

import { MemoryVfs, type Vfs } from "../src/browser/engine/vfs";
import { handle, readPairOrigin } from "../src/browser/engine/verbs";
import { unpackContainer } from "../src/browser/engine/courier-format";
import { markerPath, readHandoffState } from "../src/browser/engine/handoff";
import type { EngineOk, EngineRequest, EngineResponse } from "../src/browser/engine/protocol";
import { bytesToHex } from "../src/core/hex";
import { FaultVfs } from "./helpers/fault-vfs";

/* ============================================================================
 * PAIR PROVENANCE, AND THE FORWARDING HOLE IT CLOSES
 * ----------------------------------------------------------------------------
 * Phase 0.5 caught the sealed route: Alice seals to Bob, Bob imports, Bob seals
 * the same pad to Charlie — two-time pad. `origin` closed it.
 *
 * The PHYSICAL route is the same failure at walking pace, and it was left open
 * because §10.7 gated sealing only:
 *
 *     Alice hands the pad to Bob → Bob imports it → Bob picks
 *     "Save the pad file" → Bob gives that file to Charlie.
 *
 * Bob and Charlie now hold independently consumable copies of the same
 * directional OTP material and the same one-time authentication keys. Nobody
 * did anything wrong by the product's own rules. Once provenance exists,
 * software CAN tell this apart from a first handoff — so it does.
 *
 *     generated-here → may perform the first software-mediated handoff
 *     imported       → may NEVER export or seal onward
 *     unknown        → legacy physical export only, never sealed transfer
 *
 * `unknown` is a legacy compatibility boundary and NOT evidence that forwarding
 * is safe. It is what pads written before this field read as.
 * ========================================================================= */

const enc = new TextEncoder();
let idSeq = 1;
type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;

async function send(vfs: Vfs, req: WithoutId<EngineRequest>): Promise<EngineResponse> {
  return handle(vfs, { ...req, id: idSeq++ } as EngineRequest);
}
function asOk<K extends EngineOk["op"]>(res: EngineResponse, op: K): Extract<EngineOk, { op: K }> {
  if (!res.ok) throw new Error(`expected ok:${op}, got ${res.kind} ${(res as { reason?: string }).reason}: ${res.message}`);
  return res as Extract<EngineOk, { op: K }>;
}
function refusal(res: EngineResponse): { reason: string; message: string } {
  if (res.ok) throw new Error("expected a refusal, got success");
  if (res.kind !== "refused") throw new Error(`expected a refusal, got ${res.kind}: ${res.message}`);
  return { reason: res.reason, message: res.message };
}

async function makePair(vfs: Vfs, label = "alice"): Promise<string> {
  const res = asOk(
    await send(vfs, {
      op: "gen",
      label,
      sources: [{ name: "src.bin", declaredOrigin: "test material, operator-asserted", bytes: new Uint8Array(4096).fill(0x5c) }],
      encryptionBytes: 1024,
      authRecords: 8,
      witnessClass: "browser-none"
    }),
    "gen"
  );
  return res.pair.pairId;
}

async function readMeta(vfs: Vfs, pairId: string): Promise<Record<string, unknown>> {
  const bytes = await vfs.readFile(`${pairId}/pair.json`);
  if (bytes === null) throw new Error("no pair.json");
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/* ---- what gets written ----------------------------------------------------- */

describe("provenance is recorded, never inferred", () => {
  it("gen writes origin: generated-here in the pair.json it already commits", async () => {
    const vfs = new MemoryVfs();
    const pairId = await makePair(vfs);
    const meta = await readMeta(vfs, pairId);
    expect(meta.origin).toBe("generated-here");
    // In the SAME object as the rest — no second provenance file anywhere.
    expect(Object.keys(meta).sort()).toEqual(["createdAt", "label", "origin", "pairId", "witness"]);
    expect(await vfs.exists(`${pairId}/origin.json`)).toBe(false);
  });

  it("courier import writes origin: imported, before importing.json is removed", async () => {
    const alice = new MemoryVfs();
    const bob = new MemoryVfs();
    const pairId = await makePair(alice);
    const exported = asOk(await send(alice, { op: "export-pair", pairId }), "export-pair");
    asOk(await send(bob, { op: "import-pair", label: "bob", container: exported.container }), "import-pair");
    expect((await readMeta(bob, pairId)).origin).toBe("imported");
    // The import completed: the marker is gone and the pair is active.
    expect(await bob.exists(`${pairId}/importing.json`)).toBe(false);
  });

  it("the four provenance states are read as themselves", async () => {
    // The behavioural check that prose cannot give: until sealing exists,
    // `unknown` and `generated-here` are indistinguishable through the product,
    // so a silent backfill would pass every other test in this file.
    const vfs = new MemoryVfs();
    const pairId = await makePair(vfs);
    expect(await readPairOrigin(vfs, pairId)).toBe("generated-here");

    const meta = await readMeta(vfs, pairId);
    delete meta.origin;
    await vfs.writeFileAtomic(`${pairId}/pair.json`, enc.encode(JSON.stringify(meta)));
    expect(await readPairOrigin(vfs, pairId)).toBe("unknown");

    await vfs.remove(`${pairId}/pair.json`);
    expect(await readPairOrigin(vfs, pairId)).toBe("unknown");

    const bob = new MemoryVfs();
    const exported = asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    asOk(await send(bob, { op: "import-pair", label: "bob", container: exported.container }), "import-pair");
    expect(await readPairOrigin(bob, pairId)).toBe("imported");
  });

  it("reading a legacy pad never upgrades it, however many times it is read", async () => {
    const vfs = new MemoryVfs();
    const pairId = await makePair(vfs);
    const meta = await readMeta(vfs, pairId);
    delete meta.origin;
    await vfs.writeFileAtomic(`${pairId}/pair.json`, enc.encode(JSON.stringify(meta)));
    for (let i = 0; i < 3; i += 1) {
      expect(await readPairOrigin(vfs, pairId)).toBe("unknown");
      asOk(await send(vfs, { op: "status", pairId }), "status");
      asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    }
    expect(await readPairOrigin(vfs, pairId)).toBe("unknown");
  });

  it("a legacy pair.json with no origin field reads as unknown, and is not rewritten", async () => {
    const vfs = new MemoryVfs();
    const pairId = await makePair(vfs);
    const legacy = { pairId, label: "legacy", createdAt: "2020-01-01T00:00:00.000Z", witness: "browser-none" };
    await vfs.writeFileAtomic(`${pairId}/pair.json`, enc.encode(JSON.stringify(legacy)));
    // Reading it must not migrate it.
    asOk(await send(vfs, { op: "status", pairId }), "status");
    asOk(await send(vfs, { op: "list-pairs" }), "list-pairs");
    expect(await readMeta(vfs, pairId)).toEqual(legacy);
    // ...and legacy physical export still works, which is the entire point of
    // the `unknown` state.
    const exported = asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    expect(exported.fileCount).toBe(6);
  });

  it("no pair.json at all is unknown, not an error and not generated-here", async () => {
    const vfs = new MemoryVfs();
    const pairId = await makePair(vfs);
    await vfs.remove(`${pairId}/pair.json`);
    // A bare FORMAT-V2 store still exports (legacy), and still is not "made here".
    asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
  });

  const corrupt: Array<[string, unknown]> = [
    ["trailing space", "generated-here "],
    ["uppercase", "GENERATED-HERE"],
    ["null", null],
    ["a number", 7],
    ["an object", { value: "imported" }],
    ["an unknown string", "borrowed"],
    ["the internal state, serialized", "unknown"]
  ];
  for (const [name, value] of corrupt) {
    it(`a present-but-invalid origin (${name}) fails closed as corrupt metadata`, async () => {
      const vfs = new MemoryVfs();
      const pairId = await makePair(vfs);
      const meta = await readMeta(vfs, pairId);
      await vfs.writeFileAtomic(`${pairId}/pair.json`, enc.encode(JSON.stringify({ ...meta, origin: value })));
      expect(refusal(await send(vfs, { op: "export-pair", pairId })).reason).toBe("corrupt-pair-meta");
      expect(refusal(await send(vfs, { op: "status", pairId })).reason).toBe("corrupt-pair-meta");
    });
  }

  it("provenance is never inferred from counters, genesis, or createdAt", async () => {
    const vfs = new MemoryVfs();
    const pairId = await makePair(vfs);
    // A pad at genesis, freshly created, with a plausible timestamp — and NO
    // origin field. It stays unknown. Nothing about its shape upgrades it.
    const meta = await readMeta(vfs, pairId);
    delete meta.origin;
    await vfs.writeFileAtomic(`${pairId}/pair.json`, enc.encode(JSON.stringify(meta)));
    asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    expect(await readMeta(vfs, pairId)).not.toHaveProperty("origin");
  });
});

/* ---- the forwarding regression --------------------------------------------- */

describe("the imported → physical export forwarding hole", () => {
  it("Bob, who imported the pad, cannot save another copy for Charlie", async () => {
    const alice = new MemoryVfs();
    const bob = new MemoryVfs();
    const pairId = await makePair(alice);

    // Alice's first handoff: the ordinary courier path.
    const exported = asOk(await send(alice, { op: "export-pair", pairId }), "export-pair");
    asOk(await send(bob, { op: "import-pair", label: "bob", container: exported.container }), "import-pair");
    expect((await readMeta(bob, pairId)).origin).toBe("imported");

    // Bob tries to pass it on. This is the two-time pad, and it is refused.
    const refused = refusal(await send(bob, { op: "export-pair", pairId }));
    expect(refused.reason).toBe("imported-pair-cannot-export");
    expect(refused.message).toMatch(/arrived from someone else/);
    // No handoff record was created by the refused attempt.
    expect(await bob.exists(markerPath(pairId))).toBe(false);
  });

  it("but Bob can still send, open, retire and destroy the pad he imported", async () => {
    const alice = new MemoryVfs();
    const bob = new MemoryVfs();
    const pairId = await makePair(alice);
    const exported = asOk(await send(alice, { op: "export-pair", pairId }), "export-pair");
    asOk(await send(bob, { op: "import-pair", label: "bob", container: exported.container }), "import-pair");

    const burn = asOk(await send(bob, { op: "burn", pairId, as: "B", plaintext: enc.encode("hello") }), "burn");
    const open = asOk(await send(alice, { op: "open", pairId, as: "A", envelope: burn.envelope }), "open");
    expect(new TextDecoder().decode(open.plaintext)).toBe("hello");
    asOk(await send(bob, { op: "status", pairId }), "status");
    asOk(await send(bob, { op: "destroy", pairId, confirm: pairId }), "destroy");
  });

  it("Alice's own first export records a physical handoff", async () => {
    const vfs = new MemoryVfs();
    const pairId = await makePair(vfs);
    expect((await readHandoffState(vfs, pairId)).kind).toBe("absent");
    asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    const state = await readHandoffState(vfs, pairId);
    expect(state.kind).toBe("physical");
  });

  it("physical re-export stays allowed, and does not rewrite the marker", async () => {
    const vfs = new MemoryVfs();
    const pairId = await makePair(vfs);
    const first = asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    const marker = await vfs.readFile(markerPath(pairId));
    const second = asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    // Same bytes out, same record — "Save the pad file again" is unchanged.
    expect(bytesToHex(second.container)).toBe(bytesToHex(first.container));
    expect(bytesToHex((await vfs.readFile(markerPath(pairId)))!)).toBe(bytesToHex(marker!));
  });

  it("a sealed marker refuses physical export (I)", async () => {
    const vfs = new MemoryVfs();
    const pairId = await makePair(vfs);
    const { commitSealedHandoff } = await import("../src/browser/engine/handoff");
    const { claimRequestForPair } = await import("../src/browser/engine/request-claim");
    const { packageIdentity } = await import("../src/spt/sealed-package");
    const bytes = new Uint8Array(1258).fill(0x11);
    const requestHash = new Uint8Array(32).fill(2);
    const at = "2026-08-30T12:00:00.000Z";
    // The frozen write order binds the request to the pair BEFORE anything is
    // encapsulated, and commitSealedHandoff enforces it (§10.5.1).
    await claimRequestForPair(vfs, requestHash, pairId, at);
    await commitSealedHandoff(
      vfs,
      pairId,
      {
        packageBytes: bytes,
        requestHash,
        confirmValue: new Uint8Array(11).fill(3),
        packageIdentity: await packageIdentity(bytes)
      },
      at
    );
    expect(refusal(await send(vfs, { op: "export-pair", pairId })).reason).toBe("pad-already-sealed");
  });

  it("a torn marker refuses physical export, and says why without saying 'delete it'", async () => {
    const vfs = new MemoryVfs();
    const pairId = await makePair(vfs);
    await vfs.writeFileAtomic(markerPath(pairId), new Uint8Array(2));
    const refused = refusal(await send(vfs, { op: "export-pair", pairId }));
    expect(refused.reason).toBe("handoff-state-unreadable");
    expect(refused.message).toMatch(/refuses to create another copy/);
    expect(refused.message).not.toMatch(/delete|remove/i);
  });
});

/* ---- the marker is written LAST, and no container escapes without it -------- */

describe("no container leaves after a failed first-marker commit (A, B)", () => {
  it("A — the marker write throws before the target exists: nothing released, retry allowed", async () => {
    const inner = new MemoryVfs();
    const pairId = await makePair(inner);
    const vfs = new FaultVfs(inner, { nonAtomic: false });
    vfs.failWrite({ path: markerPath(pairId), mode: "throw-before" });

    const res = await send(vfs, { op: "export-pair", pairId });
    expect(res.ok).toBe(false);
    // No marker, so the pad is still free and a retry works.
    expect((await readHandoffState(vfs, pairId)).kind).toBe("absent");
    asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    expect((await readHandoffState(vfs, pairId)).kind).toBe("physical");
  });

  it("B — the marker target becomes 1 byte: nothing released, and every future handoff refuses", async () => {
    const inner = new MemoryVfs();
    const pairId = await makePair(inner);
    const vfs = new FaultVfs(inner, { nonAtomic: true });
    vfs.failWrite({ path: markerPath(pairId), mode: "partial-then-throw", bytes: 1 });

    const res = await send(vfs, { op: "export-pair", pairId });
    expect(res.ok).toBe(false);
    // The record exists and cannot be read: SPENT.
    expect((await readHandoffState(vfs, pairId)).kind).toBe("unreadable-spent");
    expect(refusal(await send(vfs, { op: "export-pair", pairId })).reason).toBe("handoff-state-unreadable");
  });

  it("the export refusal path never leaves a half-written marker readable as physical", async () => {
    const inner = new MemoryVfs();
    const pairId = await makePair(inner);
    const vfs = new FaultVfs(inner, { nonAtomic: true });
    vfs.failWrite({ path: markerPath(pairId), mode: "truncate-then-throw" });
    expect((await send(vfs, { op: "export-pair", pairId })).ok).toBe(false);
    expect((await readHandoffState(vfs, pairId)).kind).toBe("unreadable-spent");
  });
});

/* ---- the courier bundle is unchanged ---------------------------------------- */

describe("the courier container still carries exactly the six FORMAT-V2 files", () => {
  it("no pair.json, no handoff record, no provenance, no SPT metadata", async () => {
    const vfs = new MemoryVfs();
    const pairId = await makePair(vfs);
    const exported = asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    const unpacked = unpackContainer(exported.container);
    expect(unpacked.ok).toBe(true);
    if (!unpacked.ok) return;
    expect(unpacked.files.map((f) => f.path).sort()).toEqual([
      "a-to-b/head.json",
      "a-to-b/journal.log",
      "a-to-b/secret.bin",
      "b-to-a/head.json",
      "b-to-a/journal.log",
      "b-to-a/secret.bin"
    ]);
    const text = new TextDecoder().decode(exported.container);
    for (const forbidden of ["pair.json", "handoff", "origin", "generated-here", "imported"]) {
      expect(text, `the container must not mention ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("the same store state produces the same container bytes as before this phase", async () => {
    // The handoff record is written AFTER the container is built, and lives
    // outside it. A first export and a re-export of an unchanged store must
    // therefore be byte-identical — which is what "the bookkeeping is outside
    // the container" means in practice.
    const vfs = new MemoryVfs();
    const pairId = await makePair(vfs);
    const first = asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    expect(await vfs.exists(markerPath(pairId))).toBe(true);
    const second = asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    expect(bytesToHex(second.container)).toBe(bytesToHex(first.container));
  });
});

/* ---- import fault injection -------------------------------------------------- */

describe("no crash point makes an imported pair eligible as generated-here", () => {
  async function aliceContainer(): Promise<{ pairId: string; container: Uint8Array }> {
    const alice = new MemoryVfs();
    const pairId = await makePair(alice);
    const exported = asOk(await send(alice, { op: "export-pair", pairId }), "export-pair");
    return { pairId, container: exported.container };
  }

  it("crash BEFORE pair.json: the import is incomplete, not a generated-here pair", async () => {
    const { pairId, container } = await aliceContainer();
    const inner = new MemoryVfs();
    const vfs = new FaultVfs(inner, { nonAtomic: true });
    vfs.failWrite({ path: `${pairId}/pair.json`, mode: "throw-before" });
    expect((await send(vfs, { op: "import-pair", label: "bob", container })).ok).toBe(false);
    // importing.json is still there, so the pair is not committed at all.
    expect(await vfs.exists(`${pairId}/importing.json`)).toBe(true);
    expect(refusal(await send(vfs, { op: "export-pair", pairId })).reason).toBe("import-incomplete");
  });

  it("TORN pair.json: the pair either stays incomplete or fails closed — never generated-here", async () => {
    const { pairId, container } = await aliceContainer();
    for (const mode of ["truncate-then-throw", "partial-then-throw", "complete-then-throw"] as const) {
      const inner = new MemoryVfs();
      const vfs = new FaultVfs(inner, { nonAtomic: true });
      vfs.failWrite({ path: `${pairId}/pair.json`, mode });
      await send(vfs, { op: "import-pair", label: "bob", container });
      const res = await send(vfs, { op: "export-pair", pairId });
      if (res.ok) {
        // The only way export may succeed is if pair.json landed complete, in
        // which case it says "imported" — and export is then refused, so this
        // branch must not be reachable.
        throw new Error(`export unexpectedly succeeded for mode ${mode}`);
      }
      expect(
        ["import-incomplete", "corrupt-pair-meta", "imported-pair-cannot-export"],
        `mode ${mode} gave ${res.kind === "refused" ? res.reason : res.kind}`
      ).toContain(res.kind === "refused" ? res.reason : res.kind);
      // Whatever landed, it is never "generated-here".
      const bytes = await inner.readFile(`${pairId}/pair.json`);
      if (bytes !== null && bytes.length > 0) {
        expect(new TextDecoder().decode(bytes)).not.toContain("generated-here");
      }
    }
  });

  it("crash AFTER pair.json but before importing.json is removed: still not committed", async () => {
    const { pairId, container } = await aliceContainer();
    const inner = new MemoryVfs();
    const vfs = new FaultVfs(inner, { nonAtomic: true });
    // pair.json lands; the commit gate does not clear. The fault must fire on
    // the COMMIT removal, not on the pre-import `discardIncompleteImport`
    // sweep, which removes the same path before anything has been staged — so
    // it triggers only once the marker actually exists.
    const original = vfs.remove.bind(vfs);
    vfs.remove = async (path: string) => {
      if (path === `${pairId}/importing.json` && (await inner.exists(path))) {
        throw new Error("simulated crash before the commit gate cleared");
      }
      return original(path);
    };
    expect((await send(vfs, { op: "import-pair", label: "bob", container })).ok).toBe(false);
    expect(await inner.exists(`${pairId}/importing.json`)).toBe(true);
    // pair.json may exist and says "imported" — and the pair is still not active.
    const meta = await inner.readFile(`${pairId}/pair.json`);
    if (meta !== null) expect(new TextDecoder().decode(meta)).toContain('"origin":"imported"');
    expect(refusal(await send(vfs, { op: "export-pair", pairId })).reason).toBe("import-incomplete");
  });

  it("a completed import is 'imported' at the moment it becomes active", async () => {
    const { pairId, container } = await aliceContainer();
    const bob = new MemoryVfs();
    asOk(await send(bob, { op: "import-pair", label: "bob", container }), "import-pair");
    expect(await bob.exists(`${pairId}/importing.json`)).toBe(false);
    expect((await readMeta(bob, pairId)).origin).toBe("imported");
    expect(refusal(await send(bob, { op: "export-pair", pairId })).reason).toBe("imported-pair-cannot-export");
  });
});
