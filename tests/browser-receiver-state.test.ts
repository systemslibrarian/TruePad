import { describe, expect, it } from "vitest";

import { MemoryVfs, type Vfs } from "../src/browser/engine/vfs";
import { EngineRefused } from "../src/browser/engine/store";
import {
  bestEffortDropKey,
  cancelPendingReceiveRequest,
  cancelledPath,
  commitPendingReceiveRequest,
  consumePendingReceiveRequest,
  consumedPath,
  dkPath,
  expirePendingReceiveRequest,
  namespaceOccupied,
  parseStoredRequest,
  readReceiverState,
  receiveDir,
  requestPath,
  REQUEST_TTL_MS,
  type ReceiverState
} from "../src/browser/engine/spt-receiver-state";
import { deriveReceiveCompletion, handle } from "../src/browser/engine/verbs";
import type { EngineOk, EngineRequest, EngineResponse } from "../src/browser/engine/protocol";
import { bytesToHex } from "../src/core/hex";
import { toBase64Url } from "../src/spt/bytes";
import { requestFingerprint } from "../src/spt/fingerprint";
import { encodeRequestBody } from "../src/spt/receive-request";
import { generateKeyPairDerand } from "../src/spt/xwing-v1";
import { FaultVfs } from "./helpers/fault-vfs";

/* ============================================================================
 * THE RECIPIENT'S ONE-TIME KEY
 * ----------------------------------------------------------------------------
 * A receive request holds a decapsulation key whose entire value is that it
 * decapsulates once. The state machine is create → PENDING → CANCELLED or
 * CONSUMED, and never PENDING again.
 *
 * A mutable `state.json` rewritten PENDING → CONSUMED is unavailable: the
 * non-atomic `writeFileAtomic` fallback can tear it, and a torn rewrite of that
 * record resurrects a one-time key. So: immutable creation, plus terminal
 * markers that are TERMINAL BY EXISTING.
 *
 * Most of this file therefore breaks the write layer on purpose, on both an
 * atomic backing and the truncate-write-flush model, and checks the same thing
 * every time — that no failure produces a usable `dk`.
 *
 *     LOSS IS ACCEPTABLE. REUSE IS NOT.
 *
 * Everything frozen below is TEST VECTOR MATERIAL — NOT SECRET — NEVER
 * PRODUCTION MATERIAL.
 * ========================================================================= */

/** TEST VECTOR — NOT SECRET — NEVER PRODUCTION MATERIAL */
const SEED_1 = "01060b10151a1f24292e33383d42474c51565b60656a6f74797e83888d92979c";
/** TEST VECTOR — NOT SECRET — NEVER PRODUCTION MATERIAL */
const SEED_2 = "0204060810121416181a1c1e20222426282a2c2e30323436383a3c3e40424446";

const KP1 = generateKeyPairDerand(Uint8Array.from(Buffer.from(SEED_1, "hex")));
const KP2 = generateKeyPairDerand(Uint8Array.from(Buffer.from(SEED_2, "hex")));

const ID1 = new Uint8Array(16).fill(0x11);
const ID2 = new Uint8Array(16).fill(0x22);
const ID1_HEX = bytesToHex(ID1);
const ID2_HEX = bytesToHex(ID2);
const PAIR = "abcdef0123456789abcdef0123456789";

const CREATED = "2026-08-30T12:00:00.000Z";
const EXPIRES = new Date(Date.parse(CREATED) + REQUEST_TTL_MS).toISOString();
const BEFORE = new Date(Date.parse(CREATED) + 1000);
const AT_EXPIRY = new Date(Date.parse(EXPIRES));
const AFTER = new Date(Date.parse(EXPIRES) + 1000);

async function inputFor(id = ID1, kp = KP1) {
  const body = encodeRequestBody(id, kp.encapsulationKey);
  return {
    body,
    requestId: id,
    requestHash: await requestFingerprint(body),
    dk: kp.decapsulationSeed.slice(),
    createdAt: CREATED,
    expiresAt: EXPIRES
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

const enc = new TextEncoder();

/* ---- creation ------------------------------------------------------------- */

describe("creating a PENDING request", () => {
  it("stores the body, the hash, the timestamps and a 32-byte key", async () => {
    const vfs = new MemoryVfs();
    const input = await inputFor();
    const stored = await commitPendingReceiveRequest(vfs, input);
    expect(stored.requestId).toBe(ID1_HEX);
    expect(bytesToHex(stored.body)).toBe(bytesToHex(input.body));
    expect(bytesToHex(stored.requestHash)).toBe(bytesToHex(input.requestHash));
    expect(stored.createdAt).toBe(CREATED);
    expect(stored.expiresAt).toBe(EXPIRES);

    const dk = await vfs.readFile(dkPath(ID1_HEX));
    expect(dk!.length).toBe(32);
    expect(bytesToHex(dk!)).toBe(bytesToHex(KP1.decapsulationSeed));
    // The seed, raw. Not JSON, not base64, not an expanded ML-KEM key.
    expect(new TextDecoder().decode(dk!)).not.toContain("{");
  });

  it("writes request.json LAST — it is the publication commit marker", async () => {
    const vfs = new FaultVfs(new MemoryVfs());
    await commitPendingReceiveRequest(vfs, await inputFor());
    expect(vfs.writes.indexOf(dkPath(ID1_HEX))).toBeLessThan(vfs.writes.indexOf(requestPath(ID1_HEX)));
    expect(vfs.writes[vfs.writes.length - 1]).toBe(requestPath(ID1_HEX));
  });

  it("writes its fields in the frozen order", async () => {
    const vfs = new MemoryVfs();
    await commitPendingReceiveRequest(vfs, await inputFor());
    const raw = new TextDecoder().decode((await vfs.readFile(requestPath(ID1_HEX)))!);
    const order = ["version", "requestId", "requestHash", "body", "createdAt", "expiresAt"];
    for (let i = 1; i < order.length; i += 1) {
      expect(raw.indexOf(`"${order[i - 1]}"`)).toBeLessThan(raw.indexOf(`"${order[i]}"`));
    }
  });

  it("reads back as PENDING with a dk copy the caller owns", async () => {
    const vfs = new MemoryVfs();
    await commitPendingReceiveRequest(vfs, await inputFor());
    const state = await readReceiverState(vfs, ID1_HEX, BEFORE);
    expect(state.kind).toBe("pending");
    if (state.kind !== "pending") return;
    expect(bytesToHex(state.dk)).toBe(bytesToHex(KP1.decapsulationSeed));
    // Writing through the returned key must not disturb what is stored.
    state.dk.fill(0);
    const again = await readReceiverState(vfs, ID1_HEX, BEFORE);
    if (again.kind !== "pending") throw new Error("expected pending");
    expect(bytesToHex(again.dk)).toBe(bytesToHex(KP1.decapsulationSeed));
  });

  it("copies the key even when the backing hands back a live alias", async () => {
    // MemoryVfs's readFile already returns a fresh slice, which would hide an
    // aliasing bug entirely. The Vfs contract does not promise that, so this
    // backing deliberately hands back the stored array itself: the module must
    // do its own copying, not rely on the backing being generous.
    const inner = new MemoryVfs();
    await commitPendingReceiveRequest(inner, await inputFor());
    const live = new Map<string, Uint8Array>();
    const aliasing: Vfs = {
      ...inner,
      readFile: async (path: string) => {
        const bytes = await inner.readFile(path);
        if (bytes === null) return null;
        const kept = live.get(path) ?? bytes;
        live.set(path, kept);
        return kept; // the SAME array on every read
      },
      exists: (p: string) => inner.exists(p),
      list: (p: string) => inner.list(p),
      size: (p: string) => inner.size(p),
      withLock: <T,>(scope: string, fn: () => Promise<T>) => inner.withLock(scope, fn)
    } as Vfs;

    const first = await readReceiverState(aliasing, ID1_HEX, BEFORE);
    if (first.kind !== "pending") throw new Error("expected pending");
    first.dk.fill(0xff);
    const second = await readReceiverState(aliasing, ID1_HEX, BEFORE);
    if (second.kind !== "pending") throw new Error("expected pending");
    expect(bytesToHex(second.dk)).toBe(bytesToHex(KP1.decapsulationSeed));
  });

  it("does not mutate the caller's buffers", async () => {
    const vfs = new MemoryVfs();
    const input = await inputFor();
    const before = [bytesToHex(input.body), bytesToHex(input.dk), bytesToHex(input.requestHash)];
    await commitPendingReceiveRequest(vfs, input);
    expect([bytesToHex(input.body), bytesToHex(input.dk), bytesToHex(input.requestHash)]).toEqual(before);
  });

  it("G — a lost UI response costs nothing: the request is durable and the body recoverable", async () => {
    const vfs = new MemoryVfs();
    const input = await inputFor();
    await commitPendingReceiveRequest(vfs, input);
    // The worker "died" before replying. Everything needed to re-publish the
    // same TPR2 is on disk; no second keypair is generated.
    const state = await readReceiverState(vfs, ID1_HEX, BEFORE);
    if (state.kind !== "pending") throw new Error("expected pending");
    expect(bytesToHex(state.body)).toBe(bytesToHex(input.body));
    expect(bytesToHex(state.dk)).toBe(bytesToHex(KP1.decapsulationSeed));
  });

  const badInputs: Array<[string, (i: Awaited<ReturnType<typeof inputFor>>) => void]> = [
    ["a 31-byte key", (i) => (i.dk = i.dk.slice(0, 31))],
    ["a 33-byte key", (i) => (i.dk = new Uint8Array(33))],
    ["a requestId the body does not name", (i) => (i.requestId = ID2)],
    ["a requestHash that is not the body's", (i) => (i.requestHash = new Uint8Array(32).fill(9))],
    ["a body that is not 1235 bytes", (i) => (i.body = i.body.slice(0, 1234))],
    ["a TTL of six days", (i) => (i.expiresAt = new Date(Date.parse(CREATED) + REQUEST_TTL_MS - 86_400_000).toISOString())],
    ["a TTL of eight days", (i) => (i.expiresAt = new Date(Date.parse(CREATED) + REQUEST_TTL_MS + 86_400_000).toISOString())],
    ["a TTL one second out", (i) => (i.expiresAt = new Date(Date.parse(CREATED) + REQUEST_TTL_MS + 1000).toISOString())],
    ["a non-canonical timestamp", (i) => (i.createdAt = "2026-08-30T12:00:00Z")]
  ];
  for (const [name, mutate] of badInputs) {
    it(`refuses ${name}, and publishes nothing`, async () => {
      const vfs = new MemoryVfs();
      const input = await inputFor();
      mutate(input);
      await refusalOf(() => commitPendingReceiveRequest(vfs, input));
      expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).not.toBe("pending");
    });
  }

  it("the TTL is exactly seven days as an instant difference", async () => {
    expect(REQUEST_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(Date.parse(EXPIRES) - Date.parse(CREATED)).toBe(REQUEST_TTL_MS);
  });
});

/* ---- the requestId namespace is never recycled ---------------------------- */

describe("a requestId is never reused", () => {
  const residues: Array<[string, (vfs: Vfs) => Promise<void>]> = [
    ["an orphan dk.bin", async (v) => v.writeFileAtomic(dkPath(ID1_HEX), new Uint8Array(32))],
    ["a request.json only", async (v) => v.writeFileAtomic(requestPath(ID1_HEX), enc.encode("{}"))],
    ["a cancelled marker", async (v) => v.writeFileAtomic(cancelledPath(ID1_HEX), enc.encode("{}"))],
    ["a consumed marker", async (v) => v.writeFileAtomic(consumedPath(ID1_HEX), enc.encode("{}"))],
    ["a junk file", async (v) => v.writeFileAtomic(`${receiveDir(ID1_HEX)}/stray.tmp`, new Uint8Array(3))],
    ["corrupt JSON", async (v) => v.writeFileAtomic(requestPath(ID1_HEX), new Uint8Array([0x7b]))]
  ];

  for (const [name, seed] of residues) {
    it(`refuses creation when the namespace holds ${name}`, async () => {
      const vfs = new MemoryVfs();
      await seed(vfs);
      expect(await namespaceOccupied(vfs, ID1_HEX)).toBe(true);
      const refusal = await refusalOf(async () => commitPendingReceiveRequest(vfs, await inputFor()));
      expect(refusal.reason).toBe("request-id-unavailable");
      expect(refusal.message).toMatch(/never reused/);
    });

    it(`does not clean the namespace to reuse ${name}`, async () => {
      const vfs = new MemoryVfs();
      await seed(vfs);
      const before = await vfs.list(receiveDir(ID1_HEX));
      await refusalOf(async () => commitPendingReceiveRequest(vfs, await inputFor()));
      expect((await vfs.list(receiveDir(ID1_HEX))).sort()).toEqual(before.sort());
    });
  }

  it("a used request stays unavailable after it is cancelled", async () => {
    const vfs = new MemoryVfs();
    await commitPendingReceiveRequest(vfs, await inputFor());
    await cancelPendingReceiveRequest(vfs, ID1_HEX, "operator", CREATED, BEFORE);
    const refusal = await refusalOf(async () => commitPendingReceiveRequest(vfs, await inputFor()));
    expect(refusal.reason).toBe("request-id-unavailable");
  });

  it("a DIFFERENT requestId is unaffected", async () => {
    const vfs = new MemoryVfs();
    await commitPendingReceiveRequest(vfs, await inputFor(ID1, KP1));
    const stored = await commitPendingReceiveRequest(vfs, await inputFor(ID2, KP2));
    expect(stored.requestId).toBe(ID2_HEX);
  });
});

/* ---- terminal precedence -------------------------------------------------- */

describe("terminal markers are examined before any key material", () => {
  async function pending(): Promise<MemoryVfs> {
    const vfs = new MemoryVfs();
    await commitPendingReceiveRequest(vfs, await inputFor());
    return vfs;
  }
  const validCancelled = enc.encode(
    JSON.stringify({ version: 1, requestId: ID1_HEX, at: CREATED, reason: "operator" })
  );
  const validConsumed = enc.encode(
    JSON.stringify({
      version: 1,
      requestId: ID1_HEX,
      at: CREATED,
      pairId: PAIR,
      packageIdentity: toBase64Url(new Uint8Array(32).fill(7))
    })
  );

  it("C — a valid cancelled marker wins over a still-present dk", async () => {
    const vfs = await pending();
    await vfs.writeFileAtomic(cancelledPath(ID1_HEX), validCancelled);
    expect(await vfs.exists(dkPath(ID1_HEX))).toBe(true);
    const state = await readReceiverState(vfs, ID1_HEX, BEFORE);
    expect(state.kind).toBe("cancelled");
    expect(state).not.toHaveProperty("dk");
  });

  it("F — a valid consumed marker wins over a still-present dk", async () => {
    const vfs = await pending();
    await vfs.writeFileAtomic(consumedPath(ID1_HEX), validConsumed);
    const state = await readReceiverState(vfs, ID1_HEX, BEFORE);
    expect(state.kind).toBe("consumed");
    expect(state).not.toHaveProperty("dk");
  });

  it("G — both markers present is terminal-inconsistent, and no key is used", async () => {
    const vfs = await pending();
    await vfs.writeFileAtomic(cancelledPath(ID1_HEX), validCancelled);
    await vfs.writeFileAtomic(consumedPath(ID1_HEX), validConsumed);
    const state = await readReceiverState(vfs, ID1_HEX, BEFORE);
    expect(state.kind).toBe("terminal-inconsistent");
    expect(state).not.toHaveProperty("dk");
  });

  const torn: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["one byte", Uint8Array.from([0x7b])],
    ["truncated JSON", enc.encode('{"version":1,"requestId":"')],
    ["valid JSON, wrong shape", enc.encode('{"hello":"world"}')],
    ["a marker for another request", enc.encode(JSON.stringify({ version: 1, requestId: ID2_HEX, at: CREATED, reason: "operator" }))],
    ["an unrecognised reason", enc.encode(JSON.stringify({ version: 1, requestId: ID1_HEX, at: CREATED, reason: "bored" }))]
  ];

  for (const [name, bytes] of torn) {
    it(`B — a ${name} cancellation marker is terminal-unreadable, never PENDING`, async () => {
      const vfs = await pending();
      await vfs.writeFileAtomic(cancelledPath(ID1_HEX), bytes);
      const state = await readReceiverState(vfs, ID1_HEX, BEFORE);
      expect(state.kind).toBe("terminal-unreadable");
      expect(state).not.toHaveProperty("dk");
      // And never falls back to request.json, which is still perfectly valid.
      expect(await vfs.exists(requestPath(ID1_HEX))).toBe(true);
    });

    it(`E — a ${name} consumption marker is terminal-unreadable, never PENDING`, async () => {
      const vfs = await pending();
      await vfs.writeFileAtomic(consumedPath(ID1_HEX), bytes.slice());
      const state = await readReceiverState(vfs, ID1_HEX, BEFORE);
      expect(state.kind).toBe("terminal-unreadable");
      expect(state).not.toHaveProperty("dk");
    });

    it(`a ${name} terminal marker is never deleted to recover`, async () => {
      const vfs = await pending();
      await vfs.writeFileAtomic(consumedPath(ID1_HEX), bytes.slice());
      await readReceiverState(vfs, ID1_HEX, BEFORE);
      await refusalOf(() => cancelPendingReceiveRequest(vfs, ID1_HEX, "operator", CREATED, BEFORE));
      await refusalOf(() =>
        consumePendingReceiveRequest(vfs, ID1_HEX, { pairId: PAIR, packageIdentity: new Uint8Array(32), at: CREATED }, BEFORE)
      );
      expect(bytesToHex((await vfs.readFile(consumedPath(ID1_HEX)))!)).toBe(bytesToHex(bytes));
    });
  }

  it("a marker that cannot be READ is terminal-unreadable, not absent", async () => {
    const inner = new MemoryVfs();
    await commitPendingReceiveRequest(inner, await inputFor());
    await inner.writeFileAtomic(cancelledPath(ID1_HEX), validCancelled);
    const vfs = new FaultVfs(inner);
    vfs.failRead(cancelledPath(ID1_HEX), 1);
    expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).toBe("terminal-unreadable");
  });
});

/* ---- cancellation --------------------------------------------------------- */

describe("cancellation", () => {
  async function pending(): Promise<MemoryVfs> {
    const vfs = new MemoryVfs();
    await commitPendingReceiveRequest(vfs, await inputFor());
    return vfs;
  }

  it("PENDING → CANCELLED, and the key is no longer returned", async () => {
    const vfs = await pending();
    const state = await cancelPendingReceiveRequest(vfs, ID1_HEX, "operator", CREATED, BEFORE);
    expect(state.kind).toBe("cancelled");
    if (state.kind !== "cancelled") return;
    expect(state.reason).toBe("operator");
    expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).toBe("cancelled");
  });

  it("is idempotent, and the FIRST reason stands", async () => {
    const vfs = await pending();
    await cancelPendingReceiveRequest(vfs, ID1_HEX, "rejected", CREATED, BEFORE);
    const again = await cancelPendingReceiveRequest(vfs, ID1_HEX, "operator", EXPIRES, BEFORE);
    expect(again.kind).toBe("cancelled");
    if (again.kind !== "cancelled") return;
    // Nothing is rewritten, so a retry cannot restate why.
    expect(again.reason).toBe("rejected");
    expect(again.at).toBe(CREATED);
  });

  it("refuses a consumed request", async () => {
    const vfs = await pending();
    await consumePendingReceiveRequest(vfs, ID1_HEX, { pairId: PAIR, packageIdentity: new Uint8Array(32).fill(3), at: CREATED }, BEFORE);
    await refusalOf(() => cancelPendingReceiveRequest(vfs, ID1_HEX, "operator", CREATED, BEFORE));
  });

  it("refuses an absent request", async () => {
    const vfs = new MemoryVfs();
    await refusalOf(() => cancelPendingReceiveRequest(vfs, ID1_HEX, "operator", CREATED, BEFORE));
  });

  it("cancelled.json is the authority, not dk deletion", async () => {
    const vfs = await pending();
    await cancelPendingReceiveRequest(vfs, ID1_HEX, "operator", CREATED, BEFORE);
    // Cleanup is best-effort and happens AFTER the marker. Even if it never
    // ran — the key file is still here — the request is cancelled.
    expect(await vfs.exists(dkPath(ID1_HEX))).toBe(true);
    expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).toBe("cancelled");
    // And when it does run, the state is unchanged by its success or failure.
    await bestEffortDropKey(vfs, ID1_HEX);
    expect(await vfs.exists(dkPath(ID1_HEX))).toBe(false);
    expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).toBe("cancelled");
  });

  it("a failed key cleanup does not revert the state", async () => {
    const vfs = await pending();
    await cancelPendingReceiveRequest(vfs, ID1_HEX, "rejected", CREATED, BEFORE);
    const hostile = new FaultVfs(vfs);
    hostile.failRead(dkPath(ID1_HEX), 5);
    await bestEffortDropKey(hostile, ID1_HEX); // must not throw
    expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).toBe("cancelled");
  });
});

/* ---- consumption ---------------------------------------------------------- */

describe("consumption", () => {
  async function pending(): Promise<MemoryVfs> {
    const vfs = new MemoryVfs();
    await commitPendingReceiveRequest(vfs, await inputFor());
    return vfs;
  }
  const identity = new Uint8Array(32).fill(0x5c);

  it("PENDING → CONSUMED records the pair and the package identity", async () => {
    const vfs = await pending();
    const state = await consumePendingReceiveRequest(vfs, ID1_HEX, { pairId: PAIR, packageIdentity: identity, at: CREATED }, BEFORE);
    expect(state.kind).toBe("consumed");
    if (state.kind !== "consumed") return;
    expect(state.pairId).toBe(PAIR);
    expect(bytesToHex(state.packageIdentity)).toBe(bytesToHex(identity));
  });

  it("no key is ever returned again", async () => {
    const vfs = await pending();
    await consumePendingReceiveRequest(vfs, ID1_HEX, { pairId: PAIR, packageIdentity: identity, at: CREATED }, BEFORE);
    const state = await readReceiverState(vfs, ID1_HEX, BEFORE);
    expect(state.kind).toBe("consumed");
    expect(state).not.toHaveProperty("dk");
  });

  it("refuses a second consumption, a cancelled request, and an expired one", async () => {
    const a = await pending();
    await consumePendingReceiveRequest(a, ID1_HEX, { pairId: PAIR, packageIdentity: identity, at: CREATED }, BEFORE);
    await refusalOf(() => consumePendingReceiveRequest(a, ID1_HEX, { pairId: PAIR, packageIdentity: identity, at: CREATED }, BEFORE));

    const b = await pending();
    await cancelPendingReceiveRequest(b, ID1_HEX, "operator", CREATED, BEFORE);
    await refusalOf(() => consumePendingReceiveRequest(b, ID1_HEX, { pairId: PAIR, packageIdentity: identity, at: CREATED }, BEFORE));

    const c = await pending();
    await refusalOf(() => consumePendingReceiveRequest(c, ID1_HEX, { pairId: PAIR, packageIdentity: identity, at: CREATED }, AFTER));
  });

  it("refuses a bad pairId or packageIdentity", async () => {
    const vfs = await pending();
    await refusalOf(() => consumePendingReceiveRequest(vfs, ID1_HEX, { pairId: "nope", packageIdentity: identity, at: CREATED }, BEFORE));
    await refusalOf(() => consumePendingReceiveRequest(vfs, ID1_HEX, { pairId: PAIR, packageIdentity: new Uint8Array(31), at: CREATED }, BEFORE));
    expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).toBe("pending");
  });
});

/* ---- COMPLETE is derived -------------------------------------------------- */

let idSeq = 1;
type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;
async function send(vfs: Vfs, req: WithoutId<EngineRequest>): Promise<EngineResponse> {
  return handle(vfs, { ...req, id: idSeq++ } as EngineRequest);
}
function asOk<K extends EngineOk["op"]>(res: EngineResponse, op: K): Extract<EngineOk, { op: K }> {
  if (!res.ok) throw new Error(`expected ok:${op}, got ${res.kind}: ${res.message}`);
  return res as Extract<EngineOk, { op: K }>;
}

describe("COMPLETE is derived from two durable facts, never written", () => {
  it("H — consumed but the pair never imported is LOSS, not complete", async () => {
    const vfs = new MemoryVfs();
    await commitPendingReceiveRequest(vfs, await inputFor());
    await consumePendingReceiveRequest(vfs, ID1_HEX, { pairId: PAIR, packageIdentity: new Uint8Array(32), at: CREATED }, BEFORE);
    const completion = await deriveReceiveCompletion(vfs, ID1_HEX, BEFORE);
    expect(completion.kind).toBe("lost");
  });

  it("I — consumed plus a committed imported pair is COMPLETE", async () => {
    const alice = new MemoryVfs();
    const bob = new MemoryVfs();
    const gen = asOk(
      await send(alice, {
        op: "gen",
        label: "alice",
        sources: [{ name: "s.bin", declaredOrigin: "test material, operator-asserted", bytes: new Uint8Array(4096).fill(0x5c) }],
        encryptionBytes: 1024,
        authRecords: 8,
        witnessClass: "browser-none"
      }),
      "gen"
    );
    const pairId = gen.pair.pairId;
    const exported = asOk(await send(alice, { op: "export-pair", pairId }), "export-pair");
    asOk(await send(bob, { op: "import-pair", label: "bob", container: exported.container }), "import-pair");

    await commitPendingReceiveRequest(bob, await inputFor());
    await consumePendingReceiveRequest(bob, ID1_HEX, { pairId, packageIdentity: new Uint8Array(32), at: CREATED }, BEFORE);

    const completion = await deriveReceiveCompletion(bob, ID1_HEX, BEFORE);
    expect(completion.kind).toBe("complete");
    if (completion.kind !== "complete") return;
    expect(completion.pairId).toBe(pairId);
    // Nothing was written to say so.
    expect(await bob.exists(`${receiveDir(ID1_HEX)}/complete.json`)).toBe(false);
  });

  it("a generated-here pair does not count as a received one", async () => {
    const vfs = new MemoryVfs();
    const gen = asOk(
      await send(vfs, {
        op: "gen",
        label: "mine",
        sources: [{ name: "s.bin", declaredOrigin: "test material, operator-asserted", bytes: new Uint8Array(4096).fill(0x5c) }],
        encryptionBytes: 1024,
        authRecords: 8,
        witnessClass: "browser-none"
      }),
      "gen"
    );
    await commitPendingReceiveRequest(vfs, await inputFor());
    await consumePendingReceiveRequest(vfs, ID1_HEX, { pairId: gen.pair.pairId, packageIdentity: new Uint8Array(32), at: CREATED }, BEFORE);
    expect((await deriveReceiveCompletion(vfs, ID1_HEX, BEFORE)).kind).toBe("lost");
  });
});

/* ---- expiry --------------------------------------------------------------- */

describe("expiry", () => {
  async function pending(): Promise<MemoryVfs> {
    const vfs = new MemoryVfs();
    await commitPendingReceiveRequest(vfs, await inputFor());
    return vfs;
  }

  it("the boundary is exact: before is pending, at and after are not", async () => {
    const vfs = await pending();
    expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).toBe("pending");
    expect((await readReceiverState(vfs, ID1_HEX, AT_EXPIRY)).kind).toBe("expired-pending");
    expect((await readReceiverState(vfs, ID1_HEX, AFTER)).kind).toBe("expired-pending");
    // One millisecond under is still pending.
    const justUnder = new Date(Date.parse(EXPIRES) - 1);
    expect((await readReceiverState(vfs, ID1_HEX, justUnder)).kind).toBe("pending");
  });

  it("an expired request never yields a key", async () => {
    const vfs = await pending();
    const state = await readReceiverState(vfs, ID1_HEX, AFTER);
    expect(state).not.toHaveProperty("dk");
    // ...even though dk.bin is still sitting there.
    expect(await vfs.exists(dkPath(ID1_HEX))).toBe(true);
  });

  it("expiry is terminalized through the SAME marker transaction", async () => {
    const vfs = await pending();
    const state = await expirePendingReceiveRequest(vfs, ID1_HEX, EXPIRES, AFTER);
    expect(state.kind).toBe("cancelled");
    if (state.kind !== "cancelled") return;
    expect(state.reason).toBe("expired");
    expect(await vfs.exists(cancelledPath(ID1_HEX))).toBe(true);
  });

  it("an expired request cannot be terminalized under a different reason", async () => {
    const vfs = await pending();
    await refusalOf(() => cancelPendingReceiveRequest(vfs, ID1_HEX, "operator", EXPIRES, AFTER));
    await refusalOf(() => cancelPendingReceiveRequest(vfs, ID1_HEX, "rejected", EXPIRES, AFTER));
  });

  it("expiry does not alter the body, the hash, or the timestamps", async () => {
    const vfs = await pending();
    const input = await inputFor();
    const state = await readReceiverState(vfs, ID1_HEX, AFTER);
    if (state.kind !== "expired-pending") throw new Error("expected expired-pending");
    expect(bytesToHex(state.body)).toBe(bytesToHex(input.body));
    expect(bytesToHex(state.requestHash)).toBe(bytesToHex(input.requestHash));
    expect(state.expiresAt).toBe(EXPIRES);
  });

  it("expiry is never silently extended by a later read", async () => {
    const vfs = await pending();
    await readReceiverState(vfs, ID1_HEX, AFTER);
    await readReceiverState(vfs, ID1_HEX, new Date(Date.parse(EXPIRES) + 86_400_000));
    const raw = new TextDecoder().decode((await vfs.readFile(requestPath(ID1_HEX)))!);
    expect(raw).toContain(EXPIRES);
  });
});

/* ---- substitution --------------------------------------------------------- */

describe("a stored request is never trusted from its JSON alone", () => {
  async function pendingWith(mutate: (record: Record<string, unknown>) => void): Promise<MemoryVfs> {
    const vfs = new MemoryVfs();
    await commitPendingReceiveRequest(vfs, await inputFor());
    const record = JSON.parse(new TextDecoder().decode((await vfs.readFile(requestPath(ID1_HEX)))!));
    mutate(record);
    await vfs.writeFileAtomic(requestPath(ID1_HEX), enc.encode(JSON.stringify(record)));
    return vfs;
  }

  it("R1's request.json beside R2's dk still fails closed if relationships break", async () => {
    // The exact substitution §31 names: request R's key must never be used for
    // body B'. Here the record is moved wholesale into another id's directory.
    const vfs = new MemoryVfs();
    await commitPendingReceiveRequest(vfs, await inputFor(ID1, KP1));
    const record = await vfs.readFile(requestPath(ID1_HEX));
    await vfs.writeFileAtomic(requestPath(ID2_HEX), record!);
    await vfs.writeFileAtomic(dkPath(ID2_HEX), KP2.decapsulationSeed);
    const state = await readReceiverState(vfs, ID2_HEX, BEFORE);
    expect(state.kind).toBe("unusable");
    expect(state).not.toHaveProperty("dk");
  });

  const tampered: Array<[string, (r: Record<string, unknown>) => void]> = [
    ["a different requestId", (r) => (r.requestId = ID2_HEX)],
    ["a different requestHash", (r) => (r.requestHash = toBase64Url(new Uint8Array(32).fill(4)))],
    ["a body with another public key", (r) => (r.body = toBase64Url(encodeRequestBody(ID1, KP2.encapsulationKey)))],
    ["a body with a different version", (r) => {
      const body = encodeRequestBody(ID1, KP1.encapsulationKey);
      body[0] = 0x02;
      r.body = toBase64Url(body);
    }],
    ["a body with a different suite", (r) => {
      const body = encodeRequestBody(ID1, KP1.encapsulationKey);
      body[2] = 0x02;
      r.body = toBase64Url(body);
    }],
    ["a body of the wrong length", (r) => (r.body = toBase64Url(new Uint8Array(1234)))],
    ["a body naming another request", (r) => (r.body = toBase64Url(encodeRequestBody(ID2, KP1.encapsulationKey)))],
    ["expiresAt before createdAt", (r) => (r.expiresAt = "2020-01-01T00:00:00.000Z")],
    ["an extra field", (r) => (r.extra = 1)],
    ["a missing field", (r) => delete r.expiresAt],
    ["a wrong version", (r) => (r.version = 2)],
    ["padded base64url", (r) => (r.requestHash = `${r.requestHash as string}=`)]
  ];

  for (const [name, mutate] of tampered) {
    it(`refuses ${name}, before any key is exposed`, async () => {
      const vfs = await pendingWith(mutate);
      const state = await readReceiverState(vfs, ID1_HEX, BEFORE);
      expect(state.kind).toBe("unusable");
      expect(state).not.toHaveProperty("dk");
    });
  }

  it("a wrong-size dk.bin makes the request unusable", async () => {
    const vfs = new MemoryVfs();
    await commitPendingReceiveRequest(vfs, await inputFor());
    for (const length of [0, 31, 33, 64]) {
      await vfs.writeFileAtomic(dkPath(ID1_HEX), new Uint8Array(length));
      const state = await readReceiverState(vfs, ID1_HEX, BEFORE);
      expect(state.kind, `dk of ${length} bytes`).toBe("unusable");
    }
  });

  it("parseStoredRequest rejects the same things directly", async () => {
    const input = await inputFor();
    const good = {
      version: 1,
      requestId: ID1_HEX,
      requestHash: toBase64Url(input.requestHash),
      body: toBase64Url(input.body),
      createdAt: CREATED,
      expiresAt: EXPIRES
    };
    await expect(parseStoredRequest(enc.encode(JSON.stringify(good)), ID1_HEX)).resolves.toMatchObject({
      requestId: ID1_HEX
    });
    await expect(parseStoredRequest(enc.encode(JSON.stringify(good)), ID2_HEX)).rejects.toThrow(/different request/);
    await expect(parseStoredRequest(new Uint8Array(0), ID1_HEX)).rejects.toThrow(/empty/);
  });
});

/* ---- fault injection ------------------------------------------------------- */

for (const nonAtomic of [false, true]) {
  const backing = nonAtomic ? "the non-atomic truncate/write/flush fallback" : "an atomic replace backing";

  describe(`creation faults on ${backing}`, () => {
    const make = () => new FaultVfs(new MemoryVfs(), { nonAtomic });

    it("A — the dk write fails before the target: nothing publishable", async () => {
      const vfs = make();
      vfs.failWrite({ path: dkPath(ID1_HEX), mode: "throw-before" });
      await expect(commitPendingReceiveRequest(vfs, await inputFor())).rejects.toThrow();
      expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).not.toBe("pending");
      expect(await vfs.exists(requestPath(ID1_HEX))).toBe(false);
    });

    it("B — the dk becomes partial: nothing publishable, and the id is spent", async () => {
      const vfs = make();
      vfs.failWrite({ path: dkPath(ID1_HEX), mode: nonAtomic ? "partial-then-throw" : "throw-before", bytes: 10 });
      await expect(commitPendingReceiveRequest(vfs, await inputFor())).rejects.toThrow();
      expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).not.toBe("pending");
      if (nonAtomic) {
        // Residue: the requestId is never reused, even to retry.
        expect(await namespaceOccupied(vfs, ID1_HEX)).toBe(true);
        expect((await refusalOf(async () => commitPendingReceiveRequest(vfs, await inputFor()))).reason).toBe(
          "request-id-unavailable"
        );
      }
    });

    it("a silently truncated dk is caught by the read-back", async () => {
      const vfs = make();
      vfs.failWrite({ path: dkPath(ID1_HEX), mode: "silently-truncate", bytes: 16 });
      await refusalOf(async () => commitPendingReceiveRequest(vfs, await inputFor()));
      expect(await vfs.exists(requestPath(ID1_HEX))).toBe(false);
      expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).not.toBe("pending");
    });

    it("C — the request.json write fails before the target: nothing publishable", async () => {
      const vfs = make();
      vfs.failWrite({ path: requestPath(ID1_HEX), mode: "throw-before" });
      await expect(commitPendingReceiveRequest(vfs, await inputFor())).rejects.toThrow();
      const state = await readReceiverState(vfs, ID1_HEX, BEFORE);
      expect(state.kind).toBe("unusable"); // dk residue, so NOT absent
      expect(state).not.toHaveProperty("dk");
    });

    it("D — request.json becomes one byte: unusable, never PENDING", async () => {
      if (!nonAtomic) return;
      const vfs = make();
      vfs.failWrite({ path: requestPath(ID1_HEX), mode: "partial-then-throw", bytes: 1 });
      await expect(commitPendingReceiveRequest(vfs, await inputFor())).rejects.toThrow();
      const state = await readReceiverState(vfs, ID1_HEX, BEFORE);
      expect(state.kind).toBe("unusable");
      expect(state).not.toHaveProperty("dk");
      // ...and the id is never recycled to try again.
      expect((await refusalOf(async () => commitPendingReceiveRequest(vfs, await inputFor()))).reason).toBe(
        "request-id-unavailable"
      );
    });

    it("E — a silently truncated request.json is caught by the read-back", async () => {
      const vfs = make();
      vfs.failWrite({ path: requestPath(ID1_HEX), mode: "silently-truncate", bytes: 30 });
      const refusal = await refusalOf(async () => commitPendingReceiveRequest(vfs, await inputFor()));
      expect(refusal.message).toMatch(/read back invalid|nothing was published/);
      expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).toBe("unusable");
    });
  });

  describe(`terminal-marker faults on ${backing}`, () => {
    const make = async () => {
      const inner = new MemoryVfs();
      await commitPendingReceiveRequest(inner, await inputFor());
      return new FaultVfs(inner, { nonAtomic });
    };

    it("A — the cancellation write fails with no target: still PENDING, not acknowledged", async () => {
      const vfs = await make();
      vfs.failWrite({ path: cancelledPath(ID1_HEX), mode: "throw-before" });
      await refusalOf(() => cancelPendingReceiveRequest(vfs, ID1_HEX, "operator", CREATED, BEFORE));
      // The caller must NOT tell the operator it was cancelled.
      expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).toBe("pending");
    });

    it("B — the cancellation marker tears: terminal-unreadable, never PENDING", async () => {
      if (!nonAtomic) return;
      const vfs = await make();
      vfs.failWrite({ path: cancelledPath(ID1_HEX), mode: "partial-then-throw", bytes: 8 });
      const state = await cancelPendingReceiveRequest(vfs, ID1_HEX, "operator", CREATED, BEFORE);
      expect(state.kind).toBe("terminal-unreadable");
      expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).toBe("terminal-unreadable");
    });

    it("D — the consumption write fails with no target: still PENDING, retryable", async () => {
      const vfs = await make();
      vfs.failWrite({ path: consumedPath(ID1_HEX), mode: "throw-before" });
      await refusalOf(() =>
        consumePendingReceiveRequest(vfs, ID1_HEX, { pairId: PAIR, packageIdentity: new Uint8Array(32), at: CREATED }, BEFORE)
      );
      expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).toBe("pending");
      // The same session may retry the commit.
      const state = await consumePendingReceiveRequest(
        vfs,
        ID1_HEX,
        { pairId: PAIR, packageIdentity: new Uint8Array(32), at: CREATED },
        BEFORE
      );
      expect(state.kind).toBe("consumed");
    });

    it("E — the consumption marker tears: terminal, never PENDING, no key", async () => {
      if (!nonAtomic) return;
      const vfs = await make();
      vfs.failWrite({ path: consumedPath(ID1_HEX), mode: "partial-then-throw", bytes: 9 });
      const state = await consumePendingReceiveRequest(
        vfs,
        ID1_HEX,
        { pairId: PAIR, packageIdentity: new Uint8Array(32), at: CREATED },
        BEFORE
      );
      expect(state.kind).toBe("terminal-unreadable");
      expect(state).not.toHaveProperty("dk");
      // A malformed consumed marker may lose the transfer. It never reopens it.
      await refusalOf(() =>
        consumePendingReceiveRequest(vfs, ID1_HEX, { pairId: PAIR, packageIdentity: new Uint8Array(32), at: CREATED }, BEFORE)
      );
    });

    it("a complete-but-unacknowledged terminal write is a real transition", async () => {
      if (!nonAtomic) return;
      const vfs = await make();
      vfs.failWrite({ path: consumedPath(ID1_HEX), mode: "complete-then-throw" });
      const state = await consumePendingReceiveRequest(
        vfs,
        ID1_HEX,
        { pairId: PAIR, packageIdentity: new Uint8Array(32).fill(2), at: CREATED },
        BEFORE
      );
      // The disk is asked, not the exception: the marker landed and is valid.
      expect(state.kind).toBe("consumed");
      expect((await readReceiverState(vfs, ID1_HEX, BEFORE)).kind).toBe("consumed");
    });

    it("a silently truncated terminal marker is terminal, not ignored", async () => {
      const vfs = await make();
      vfs.failWrite({ path: cancelledPath(ID1_HEX), mode: "silently-truncate", bytes: 6 });
      const state = await cancelPendingReceiveRequest(vfs, ID1_HEX, "rejected", CREATED, BEFORE);
      expect(state.kind).toBe("terminal-unreadable");
    });
  });
}
