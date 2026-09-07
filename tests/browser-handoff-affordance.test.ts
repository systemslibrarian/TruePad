import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryVfs, type Vfs } from "../src/browser/engine/vfs";
import { handle } from "../src/browser/engine/verbs";
import type { EngineOk, EngineRequest, EngineResponse } from "../src/browser/engine/protocol";

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
  return res as Extract<EngineOk, { op: K }>;
}

async function gen(
  vfs: Vfs,
  label: string,
  o: { encryptionBytes: number; authRecords: number }
): Promise<string> {
  const need = 2 * (o.encryptionBytes + 32 * o.authRecords);
  const bytes = new Uint8Array(need);
  for (let i = 0; i < need; i += 65_536) {
    crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65_536, need)));
  }
  const res = asOk(
    await send(vfs, {
      op: "gen",
      label,
      sources: [{ name: "drbg.bin", declaredOrigin: "test DRBG material, operator-asserted", bytes }],
      encryptionBytes: o.encryptionBytes,
      authRecords: o.authRecords,
      witnessClass: "browser-none"
    }),
    "gen"
  );
  return res.pair.pairId;
}

/* ============================================================================
 * A pad is handed over once, and the interface may only offer what that allows
 * ----------------------------------------------------------------------------
 * `exportPair` refuses a `sealed` or `unreadable-spent` pad. It deliberately
 * lets a `physical` one through — the first save can be cancelled at the file
 * dialog or land nowhere, and the marker keeps the time of the FIRST handoff
 * either way. So the engine decides two of the three cases and NOT the third.
 *
 * The interface had no way to ask, and rendered one control for all three under
 * a sentence promising the engine "records it and refuses the other afterwards".
 * That is true of the other ROUTE and false of a second save by the same one:
 * two identical raw copies, handed to two people, both import as party B and
 * both burn B->A at the same offsets. Cross-copy reuse, no adversary, no error.
 *
 * `PairSummary.handoff` carries the answer now. These hold the engine's
 * behaviour and the interface's wording against each other.
 * ========================================================================= */
describe("the handoff state travels to the interface", () => {
  it("reports absent, then physical, and never invents a time", async () => {
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, "handoff-shape", { encryptionBytes: 256, authRecords: 4 });

    const fresh = asOk(await send(vfs, { op: "status", pairId }), "status").pair;
    expect(fresh.handoff).toEqual({ kind: "absent", at: null });

    asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    const after = asOk(await send(vfs, { op: "status", pairId }), "status").pair;
    expect(after.handoff.kind).toBe("physical");
    expect(after.handoff.at, "a committed handoff must carry when it happened").toBeTruthy();

    // A SECOND EXPORT IS STILL ALLOWED — deliberately — and must not move the
    // recorded time, because the pad left once.
    asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    const again = asOk(await send(vfs, { op: "status", pairId }), "status").pair;
    expect(again.handoff).toEqual(after.handoff);
  });

  it("carries no marker hashes, only the mode and the time", async () => {
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, "handoff-nonsecret", { encryptionBytes: 256, authRecords: 4 });
    asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    const summary = asOk(await send(vfs, { op: "status", pairId }), "status").pair;
    // The whole field, exactly — a marker also holds requestHash, packageIdentity
    // and confirmHash, and none of them has any business above the engine.
    expect(Object.keys(summary.handoff).sort()).toEqual(["at", "kind"]);
  });

  it("a destroyed pad hands nothing over, whatever its marker says", async () => {
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, "handoff-destroyed", { encryptionBytes: 256, authRecords: 4 });
    asOk(await send(vfs, { op: "destroy", pairId, confirm: pairId }), "destroy");
    const listed = asOk(await send(vfs, { op: "list-pairs" }), "list-pairs");
    const entry = listed.pairs.find((p) => p.pairId === pairId);
    expect(entry?.destroyed).toBe(true);
    expect(entry?.handoff.kind).not.toBe("absent");
  });

  it("the interface offers a fresh handoff only while one is available", () => {
    const dashboard = readFileSync(resolve(__dirname, "../src/browser/ui/dashboard.ts"), "utf8");
    // The share block is gated on the engine's answer, not rendered flat.
    expect(dashboard).toContain('pair.handoff.kind === "absent"');
    expect(dashboard).toContain("handedOverBlock(ctx, pairId, pair.handoff)");
    // And the one case the engine permits is named as what it is.
    expect(dashboard).toContain("Save the same pad file again");
    expect(dashboard).toContain("not a second handoff");
    // Sealed and unreadable-spent offer nothing at all.
    const block = dashboard.slice(dashboard.indexOf("function handedOverBlock"));
    const sealedBranch = block.slice(block.indexOf('handoff.kind === "sealed"'));
    expect(sealedBranch.slice(0, 400)).not.toContain("savePadFileButton");
  });

  it("the post-creation screen stops promising what the engine does not do", () => {
    const create = readFileSync(resolve(__dirname, "../src/browser/ui/create-pair.ts"), "utf8");
    // The sentence must be about the ROUTE, which is what the engine enforces.
    expect(create).toContain("refuses the other route afterwards");
    // And after a save it must say what a second save actually is.
    expect(create).toContain("Save the same pad file again");
    expect(create).toContain("writes the SAME pad");
    expect(create).toContain("onlineBtn.disabled = true");
  });
});
