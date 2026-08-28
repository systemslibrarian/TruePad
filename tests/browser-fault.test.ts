import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryVfs, type Vfs } from "../src/browser/engine/vfs";
import { handle } from "../src/browser/engine/verbs";
import { packContainer, unpackContainer } from "../src/browser/engine/courier-format";
import type { EngineOk, EngineRequest, EngineResponse } from "../src/browser/engine/protocol";

/* ============================================================================
 * Browser Security Closure — the falsification pass (UI Phase 1.1)
 * ----------------------------------------------------------------------------
 * Adversarial and fault-injection coverage for the seven closure fixes:
 *   (1) the source combiner never conditions on content (no duplicate-source);
 *   (2) no protocol/store-format fork — the frozen head is always rollback:none;
 *   (3) the append-only witness survives / fails closed across write
 *       interruptions, and an established witness NEVER reads as fresh;
 *   (4) a failed witness advance withholds the output (loss, not reuse);
 *   (5) the courier never reaches the clipboard; secrets cross the worker
 *       boundary only as an explicit container;
 *   (6) a malformed / interrupted import never becomes active or permanently
 *       stuck;
 *   (7) CLI↔Browser FORMAT-V2 interop holds even with a browser-local witness.
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
function expectError(res: EngineResponse): string {
  if (res.ok) {
    throw new Error(`expected error but got ok:${res.op}`);
  }
  if (res.kind !== "error") {
    throw new Error(`expected error but got refused: ${(res as { reason?: string }).reason}`);
  }
  return res.message;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function uniformSource(e: number, n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(2 * (e + 32 * n)));
}

type GenOpts = { e: number; n: number; witness?: "browser-none" | "browser-local-witness"; verifyAttemptLimit?: number };
async function gen(vfs: Vfs, label: string, o: GenOpts, sources?: { name: string; declaredOrigin: string; bytes: Uint8Array }[]): Promise<string> {
  const res = asOk(
    await send(vfs, {
      op: "gen",
      label,
      sources: sources ?? [{ name: "src.bin", declaredOrigin: "test material, operator-asserted", bytes: uniformSource(o.e, o.n) }],
      encryptionBytes: o.e,
      authRecords: o.n,
      witnessClass: o.witness ?? "browser-local-witness",
      verifyAttemptLimit: o.verifyAttemptLimit
    }),
    "gen"
  );
  return res.pair.pairId;
}

function tamper(envelope: string): string {
  const obj = JSON.parse(envelope) as { tag: string };
  obj.tag = (obj.tag[0] === "0" ? "1" : "0") + obj.tag.slice(1);
  return JSON.stringify(obj);
}

// A Vfs wrapper that can inject an I/O fault on the next append matching a
// predicate — used to simulate a crash at a precise point in a transaction.
class FaultVfs implements Vfs {
  failAppendWhen: ((path: string) => boolean) | null = null;
  private readonly inner: Vfs;
  constructor(inner: Vfs) {
    this.inner = inner;
  }
  readFile(p: string) { return this.inner.readFile(p); }
  async appendFile(p: string, d: Uint8Array) {
    if (this.failAppendWhen && this.failAppendWhen(p)) {
      throw new Error(`simulated I/O fault on append to ${p}`);
    }
    return this.inner.appendFile(p, d);
  }
  writeFileAtomic(p: string, d: Uint8Array) { return this.inner.writeFileAtomic(p, d); }
  readRange(p: string, o: number, l: number) { return this.inner.readRange(p, o, l); }
  writeRange(p: string, o: number, d: Uint8Array) { return this.inner.writeRange(p, o, d); }
  exists(p: string) { return this.inner.exists(p); }
  remove(p: string) { return this.inner.remove(p); }
  size(p: string) { return this.inner.size(p); }
  list(p: string) { return this.inner.list(p); }
  withLock<T>(s: string, fn: () => Promise<T>) { return this.inner.withLock(s, fn); }
}

/* ============================================================================
 * (1) Exact-uniform source combiner — no content-dependent deduplication.
 * ========================================================================= */

describe("closure #1: the combiner never conditions on source content", () => {
  it("accepts two DISTINCT source objects that carry byte-identical bytes", async () => {
    const vfs = new MemoryVfs();
    const bytes = uniformSource(64, 4);
    // Two separate Uint8Array objects, equal over the whole required length.
    const a = bytes.slice();
    const b = bytes.slice();
    expect(a).not.toBe(b); // distinct objects
    const pairId = await gen(vfs, "identical-bytes", { e: 64, n: 4 }, [
      { name: "one.bin", declaredOrigin: "op-asserted A", bytes: a },
      { name: "two.bin", declaredOrigin: "op-asserted B", bytes: b }
    ]);
    // The pair is real and usable — no duplicate-source refusal.
    const st = asOk(await send(vfs, { op: "status", pairId }), "status");
    expect(st.pair.meters["A->B"].authentication.capacityRecords).toBe(4);
  });

  it("does NOT reject an all-zero combined result (two identical sources XOR to zero)", async () => {
    // Two identical sources XOR to an all-zero combined pad. That is a
    // legitimate draw from the uniform distribution; refusing it would condition
    // the accepted distribution. The store must generate AND round-trip.
    const alice = new MemoryVfs();
    const bob = new MemoryVfs();
    const same = uniformSource(64, 4);
    const pairId = await gen(alice, "zero-combined", { e: 64, n: 4, witness: "browser-none" }, [
      { name: "x.bin", declaredOrigin: "op A", bytes: same.slice() },
      { name: "y.bin", declaredOrigin: "op B", bytes: same.slice() }
    ]);
    // The combined pad is all zeros: verify by reading the sender secret.bin.
    const secret = await alice.readFile(`${pairId}/a-to-b/secret.bin`);
    expect(secret).not.toBeNull();
    expect((secret as Uint8Array).every((byte) => byte === 0)).toBe(true);

    // And it still works as a pad: courier, burn, open round-trips exactly.
    const exp = asOk(await send(alice, { op: "export-pair", pairId }), "export-pair");
    asOk(await send(bob, { op: "import-pair", label: "zero-b", container: exp.container }), "import-pair");
    const burn = asOk(await send(alice, { op: "burn", pairId, as: "A", plaintext: utf8.encode("zero pad works") }), "burn");
    const open = asOk(await send(bob, { op: "open", pairId, as: "B", envelope: burn.envelope }), "open");
    expect(fromUtf8.decode(open.plaintext)).toBe("zero pad works");
  });

  it("the engine source carries no content-dependent duplicate-source rejection", () => {
    const src = readFileSync(resolve(__dirname, "..", "src", "browser", "engine", "verbs.ts"), "utf8");
    expect(src).not.toMatch(/EngineRefused\(\s*["']duplicate-source["']/);
    expect(src).not.toMatch(/bytesEqualPrefix/);
  });
});

/* ============================================================================
 * (2) No protocol / store-format fork — the frozen head is always rollback:none.
 * ========================================================================= */

describe("closure #2: the frozen head is never forked by the browser witness", () => {
  it("a browser-local-witness gen writes head.json with rollback {witnessClass:none} and no browser vocabulary", async () => {
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, "unforked", { e: 64, n: 4, witness: "browser-local-witness" });
    for (const dir of ["a-to-b", "b-to-a"]) {
      const head = fromUtf8.decode((await vfs.readFile(`${pairId}/${dir}/head.json`)) as Uint8Array);
      expect(head).toContain('"rollback":{"witnessClass":"none","config":{}}');
      expect(head).not.toContain("browser-local-witness");
      expect(head).not.toContain("browser-independent-store");
    }
    // The browser witness kind lives OUTSIDE the frozen store, in pair.json.
    const meta = fromUtf8.decode((await vfs.readFile(`${pairId}/pair.json`)) as Uint8Array);
    expect(meta).toContain('"witness":"browser-local-witness"');
  });

  it("the courier container carries only standard FORMAT-V2 files, no browser header vocabulary", async () => {
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, "courier-clean", { e: 64, n: 4, witness: "browser-local-witness" });
    const exp = asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
    const unpacked = unpackContainer(exp.container);
    if (!unpacked.ok) throw new Error(unpacked.message);
    expect(unpacked.files.map((f) => f.path).sort()).toEqual([
      "a-to-b/head.json", "a-to-b/journal.log", "a-to-b/secret.bin",
      "b-to-a/head.json", "b-to-a/journal.log", "b-to-a/secret.bin"
    ]);
    for (const f of unpacked.files.filter((x) => x.path.endsWith("head.json"))) {
      const head = fromUtf8.decode(f.bytes);
      expect(head).toContain('"witnessClass":"none"');
      expect(head).not.toContain("browser-");
    }
  });

  it("refuses (not downgrades) importing a CLI store whose frozen witness class it cannot honour", async () => {
    const src = new MemoryVfs();
    const dst = new MemoryVfs();
    const pairId = await gen(src, "cli-witness", { e: 64, n: 4, witness: "browser-none" });
    const exp = asOk(await send(src, { op: "export-pair", pairId }), "export-pair");
    const unpacked = unpackContainer(exp.container);
    if (!unpacked.ok) throw new Error(unpacked.message);
    // Rewrite the A->B head to a frozen witness class the browser cannot honour.
    const files = unpacked.files.map((f) => {
      if (f.path !== "a-to-b/head.json") return f;
      const head = JSON.parse(fromUtf8.decode(f.bytes));
      head.rollback = { witnessClass: "separate-state-file", config: { path: "/somewhere/witness.json" } };
      return { path: f.path, bytes: utf8.encode(JSON.stringify(head)) };
    });
    const container = packContainer(pairId, files);
    // Refused, not silently downgraded to none.
    expectRefused(await send(dst, { op: "import-pair", label: "x", container }), "corrupt-head");
    // And nothing active was created.
    const list = asOk(await send(dst, { op: "list-pairs" }), "list-pairs");
    expect(list.pairs.length).toBe(0);
  });
});

/* ============================================================================
 * (3) The append-only witness: crash-safe, and NEVER reads an established
 *     witness as fresh.
 * ========================================================================= */

const witnessLog = (pairId: string) => `witness/${pairId}.log`;

describe("closure #3: the browser-local witness is crash-safe and fails closed", () => {
  async function advancedPair(): Promise<{ a: MemoryVfs; b: MemoryVfs; pairId: string; env: string }> {
    const a = new MemoryVfs();
    const b = new MemoryVfs();
    const pairId = await gen(a, "witness", { e: 256, n: 8, witness: "browser-local-witness" });
    const exp = asOk(await send(a, { op: "export-pair", pairId }), "export-pair");
    asOk(await send(b, { op: "import-pair", label: "b", container: exp.container }), "import-pair");
    const env = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("m0") }), "burn").envelope;
    asOk(await send(b, { op: "open", pairId, as: "B", envelope: env }), "open");
    const env2 = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("m1") }), "burn").envelope;
    return { a, b, pairId, env: env2 };
  }

  it("survives a TORN FINAL witness record — the previous records stand", async () => {
    const { a, pairId } = await advancedPair();
    // A crash mid-append leaves a partial record. Records are leading-newline
    // framed (`\n<json>`), so a real torn append starts with \n and is isolated.
    await a.appendFile(witnessLog(pairId), utf8.encode('\n{"d":"A->B","eno":99,"ans":9')); // torn, isolated
    // The store is still usable: the torn line is dropped, earlier records stand.
    const burn = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("after-torn") }), "burn");
    expect(burn.envelope.length).toBeGreaterThan(0);
  });

  it("a torn append never swallows the NEXT clean advance: a rollback to the intermediate state is still caught", async () => {
    // The re-attack scenario. With trailing framing, a torn (newline-free) partial
    // at EOF would fuse with the NEXT append and drop that clean record too, so
    // the witness would under-report and a rollback to the state the swallowed
    // advance retired would slip through as 'aligned'. Leading-newline framing
    // makes the torn partial an isolated line, so the next clean advance survives
    // and the rollback is still refused witness-regressed.
    const a = new MemoryVfs();
    const b = new MemoryVfs();
    const pairId = await gen(a, "swallow", { e: 512, n: 16, witness: "browser-local-witness" });
    const exp = asOk(await send(a, { op: "export-pair", pairId }), "export-pair");
    asOk(await send(b, { op: "import-pair", label: "b", container: exp.container }), "import-pair");

    // m0 advances the store+witness; snapshot the store at the POST-m0 state.
    asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("m0") }), "burn");
    const headSnap = await a.readFile(`${pairId}/a-to-b/head.json`);
    const jSnap = await a.readFile(`${pairId}/a-to-b/journal.log`);

    // A torn witness append lands (leading-newline framed, as a real one would be).
    await a.appendFile(witnessLog(pairId), utf8.encode('\n{"d":"A->B","eno":9,"ans":9'));

    // A crash-FREE m1 burn: its store commit AND its clean witness advance must
    // both take effect — the torn partial must not swallow the m1 advance.
    const m1 = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("m1") }), "burn");
    expect(m1.envelope.length).toBeGreaterThan(0);

    // Roll the pair store back to the post-m0 snapshot (the state m1 already
    // burned past). The witness remembers m1's advance, so this is refused.
    await a.writeFileAtomic(`${pairId}/a-to-b/head.json`, headSnap as Uint8Array);
    await a.writeFileAtomic(`${pairId}/a-to-b/journal.log`, jSnap as Uint8Array);
    expectRefused(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("rolled back") }), "witness-regressed");
  });

  it("repeated torn appends never brick the store; one clean advance heals it", async () => {
    const a = new MemoryVfs();
    const b = new MemoryVfs();
    const pairId = await gen(a, "storm", { e: 512, n: 16, witness: "browser-local-witness" });
    const exp = asOk(await send(a, { op: "export-pair", pairId }), "export-pair");
    asOk(await send(b, { op: "import-pair", label: "b", container: exp.container }), "import-pair");
    // A burst of isolated torn partials (as consecutive crash-during-append would leave).
    for (let i = 0; i < 5; i += 1) {
      await a.appendFile(witnessLog(pairId), utf8.encode(`\n{"d":"A->B","eno":${i},"ans":${i}`));
    }
    // The store is never bricked: burns keep working and heal the witness.
    for (const m of ["a", "b", "c"]) {
      const burn = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode(m) }), "burn");
      expect(burn.envelope.length).toBeGreaterThan(0);
    }
  });

  it("a provisioned witness that goes MISSING fails closed — never reads as fresh", async () => {
    const { a, pairId } = await advancedPair();
    // The classic truncate-in-place crash used to zero this file; deleting it
    // is the same observable state. It MUST NOT be read as a fresh store.
    await a.remove(witnessLog(pairId));
    expectRefused(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("x") }), "witness-inconsistent");
    // status also reports the inconsistency rather than a clean state.
    const st = asOk(await send(a, { op: "status", pairId }), "status");
    expect(st.pair.meters["A->B"].witness.state).toBe("inconsistent");
  });

  it("a provisioned witness truncated to EMPTY fails closed — never fresh", async () => {
    const { a, pairId } = await advancedPair();
    await a.writeFileAtomic(witnessLog(pairId), new Uint8Array(0));
    expectRefused(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("x") }), "witness-inconsistent");
  });

  it("a corrupt pair.json fails closed rather than defaulting to no-witness", async () => {
    const { a, pairId } = await advancedPair();
    await a.writeFileAtomic(`${pairId}/pair.json`, utf8.encode("{ not valid json"));
    expectRefused(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("x") }), "corrupt-pair-meta");
  });

  it("attempt reserved but witness advance interrupted: the store is AHEAD, no free attempt, never fresh", async () => {
    const a = new MemoryVfs();
    const b = new MemoryVfs();
    const pairId = await gen(a, "attempt-crash", { e: 256, n: 8, witness: "browser-local-witness", verifyAttemptLimit: 3 });
    const exp = asOk(await send(a, { op: "export-pair", pairId }), "export-pair");
    asOk(await send(b, { op: "import-pair", label: "b", container: exp.container }), "import-pair");
    const env = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("real") }), "burn").envelope;
    const forged = tamper(env);

    // Crash the witness advance of a forged open: the attempt reservation is
    // durable in the STORE journal, but the witness record is not written.
    const faulty = new FaultVfs(b);
    faulty.failAppendWhen = (p) => p.startsWith("witness/");
    const crashed = await send(faulty, { op: "open", pairId, as: "B", envelope: forged });
    expectError(crashed); // output withheld

    // Recover (no fault). The witness journal still holds its bootstrap records
    // (append-only — never emptied), so it is NOT fresh; the A->B store, whose
    // attempt was durably reserved, is AHEAD of its witness.
    const st = asOk(await send(b, { op: "status", pairId }), "status");
    expect(st.pair.meters["A->B"].witness.state).toBe("ahead");
    // The reserved attempt still counts — the budget was durably spent, so a
    // subsequent forged open verifies (and fails), it does not preflight-refuse.
    expectRefused(await send(b, { op: "open", pairId, as: "B", envelope: forged }), "auth-failed");
  });

  it("browser-none never provisions a witness journal (n/a), and is unaffected by these faults", async () => {
    const vfs = new MemoryVfs();
    const pairId = await gen(vfs, "none", { e: 64, n: 4, witness: "browser-none" });
    expect(await vfs.readFile(witnessLog(pairId))).toBeNull();
    const st = asOk(await send(vfs, { op: "status", pairId }), "status");
    expect(st.pair.meters["A->B"].witness).toEqual({ class: "browser-none", state: "n/a" });
  });
});

/* ============================================================================
 * (4) A failed witness advance withholds the output (loss, not reuse).
 * ========================================================================= */

describe("closure #4: a failed witness advance never releases an output", () => {
  it("a burn whose witness advance fails errors out — no envelope, but the record is durably retired", async () => {
    const inner = new MemoryVfs();
    const pairId = await gen(inner, "withhold", { e: 256, n: 8, witness: "browser-local-witness" });
    const faulty = new FaultVfs(inner);
    faulty.failAppendWhen = (p) => p.startsWith("witness/");
    const res = await send(faulty, { op: "burn", pairId, as: "A", plaintext: utf8.encode("lost") });
    expectError(res); // no envelope reaches the caller

    // The §12 commit already happened (loss, not reuse): the counter advanced.
    const st = asOk(await send(inner, { op: "status", pairId }), "status");
    expect(st.pair.meters["A->B"].authentication.nextSequence).toBe(1);
  });
});

/* ============================================================================
 * (6) Import is transactional / recoverable — never a partial active pair,
 *     never a permanently-stuck ghost.
 * ========================================================================= */

async function goodContainer(e = 64, n = 4): Promise<{ pairId: string; container: Uint8Array }> {
  const vfs = new MemoryVfs();
  const pairId = await gen(vfs, "src", { e, n, witness: "browser-none" });
  const exp = asOk(await send(vfs, { op: "export-pair", pairId }), "export-pair");
  return { pairId, container: exp.container };
}

describe("closure #6: courier import is transactional and recoverable", () => {
  it("a malformed container creates no pair and is retryable", async () => {
    const dst = new MemoryVfs();
    expectRefused(await send(dst, { op: "import-pair", label: "x", container: utf8.encode("not a bundle") }), "malformed-bundle");
    expect(asOk(await send(dst, { op: "list-pairs" }), "list-pairs").pairs.length).toBe(0);
    // A good import of a real pair afterwards still works (no ghost blocking).
    const good = await goodContainer();
    asOk(await send(dst, { op: "import-pair", label: "ok", container: good.container }), "import-pair");
    expect(asOk(await send(dst, { op: "list-pairs" }), "list-pairs").pairs.length).toBe(1);
  });

  it("an unknown, duplicate, or missing file is refused with no ghost", async () => {
    const { pairId, container } = await goodContainer();
    const unpacked = unpackContainer(container);
    if (!unpacked.ok) throw new Error(unpacked.message);

    const withUnknown = packContainer(pairId, [...unpacked.files, { path: "a-to-b/extra.bin", bytes: utf8.encode("x") }]);
    const d1 = new MemoryVfs();
    expectRefused(await send(d1, { op: "import-pair", label: "x", container: withUnknown }), "malformed-bundle");
    expect(asOk(await send(d1, { op: "list-pairs" }), "list-pairs").pairs.length).toBe(0);

    const withDup = packContainer(pairId, [...unpacked.files, unpacked.files[0]]);
    const d2 = new MemoryVfs();
    expectRefused(await send(d2, { op: "import-pair", label: "x", container: withDup }), "malformed-bundle");

    const missing = packContainer(pairId, unpacked.files.filter((f) => f.path !== "b-to-a/secret.bin"));
    const d3 = new MemoryVfs();
    expectRefused(await send(d3, { op: "import-pair", label: "x", container: missing }), "malformed-bundle");
    expect(asOk(await send(d3, { op: "list-pairs" }), "list-pairs").pairs.length).toBe(0);
  });

  it("a corrupt store body is refused, leaves no active pair, and the same pairId can be re-imported clean", async () => {
    const { pairId, container } = await goodContainer();
    const unpacked = unpackContainer(container);
    if (!unpacked.ok) throw new Error(unpacked.message);
    // Truncate the A->B secret body → loadStore refuses corrupt-secret-body.
    const broken = packContainer(pairId, unpacked.files.map((f) => (f.path === "a-to-b/secret.bin" ? { path: f.path, bytes: f.bytes.slice(0, f.bytes.length - 16) } : f)));
    const dst = new MemoryVfs();
    expectRefused(await send(dst, { op: "import-pair", label: "x", container: broken }));
    expect(asOk(await send(dst, { op: "list-pairs" }), "list-pairs").pairs.length).toBe(0);
    // No ghost: a clean re-import of the same pairId succeeds.
    asOk(await send(dst, { op: "import-pair", label: "clean", container }), "import-pair");
    const list = asOk(await send(dst, { op: "list-pairs" }), "list-pairs");
    expect(list.pairs.length).toBe(1);
    expect(list.pairs[0].pairId).toBe(pairId);
  });

  it("a crash mid-commit leaves an inactive, retryable pair (import-incomplete), completed by re-import", async () => {
    const { pairId, container } = await goodContainer();
    const unpacked = unpackContainer(container);
    if (!unpacked.ok) throw new Error(unpacked.message);
    const dst = new MemoryVfs();
    // Simulate a crash AFTER the import marker + a partial file copy, BEFORE the
    // pair.json commit: write the marker and one direction's files only.
    await dst.writeFileAtomic(`${pairId}/importing.json`, utf8.encode(JSON.stringify({ pairId })));
    for (const f of unpacked.files.filter((x) => x.path.startsWith("a-to-b/"))) {
      await dst.writeFileAtomic(`${pairId}/${f.path}`, f.bytes);
    }
    // The partial pair is NOT active: every consuming verb refuses it.
    expectRefused(await send(dst, { op: "status", pairId }), "import-incomplete");
    // It is not listed as an active pair either.
    expect(asOk(await send(dst, { op: "list-pairs" }), "list-pairs").pairs.some((p) => p.pairId === pairId && !p.destroyed)).toBe(false);
    // Re-importing the same bundle discards the partial and completes.
    asOk(await send(dst, { op: "import-pair", label: "retry", container }), "import-pair");
    const st = asOk(await send(dst, { op: "status", pairId }), "status");
    expect(st.pair.pairId).toBe(pairId);
    expect(await dst.exists(`${pairId}/importing.json`)).toBe(false);
  });

  it("a committed pair blocks re-import (pair-exists), never overwritten", async () => {
    const { container } = await goodContainer();
    const dst = new MemoryVfs();
    asOk(await send(dst, { op: "import-pair", label: "first", container }), "import-pair");
    expectRefused(await send(dst, { op: "import-pair", label: "again", container }), "pair-exists");
  });

  it("importing a tombstoned pairId is refused pair-destroyed (the boundary is irreversible)", async () => {
    const { pairId, container } = await goodContainer();
    const dst = new MemoryVfs();
    asOk(await send(dst, { op: "import-pair", label: "first", container }), "import-pair");
    asOk(await send(dst, { op: "destroy", pairId, confirm: pairId }), "destroy");
    expectRefused(await send(dst, { op: "import-pair", label: "reimport", container }), "pair-destroyed");
  });

  it("a pairId that disagrees with the head.json inside is refused", async () => {
    const { pairId, container } = await goodContainer();
    const unpacked = unpackContainer(container);
    if (!unpacked.ok) throw new Error(unpacked.message);
    // Repack under a DIFFERENT (valid-looking) pairId; the heads still say the old one.
    const otherId = "ffffffffffffffffffffffffffffffff";
    expect(otherId).not.toBe(pairId);
    const container2 = packContainer(otherId, unpacked.files);
    const dst = new MemoryVfs();
    expectRefused(await send(dst, { op: "import-pair", label: "x", container: container2 }), "malformed-bundle");
    expect(asOk(await send(dst, { op: "list-pairs" }), "list-pairs").pairs.length).toBe(0);
  });
});

/* ============================================================================
 * (5) The courier never reaches the clipboard; the UI never unpacks pad bytes.
 * ========================================================================= */

describe("closure #5: the courier UI never touches the clipboard or unpacks pad material", () => {
  const ROOT = resolve(__dirname, "..");
  const courierSrc = readFileSync(join(ROOT, "src", "browser", "ui", "courier.ts"), "utf8");
  const createSrc = readFileSync(join(ROOT, "src", "browser", "ui", "create-pair.ts"), "utf8");

  it("courier.ts offers no clipboard copy and does not import copyButton", () => {
    expect(courierSrc).not.toContain("copyButton");
    // The clipboard API itself must not be reached (the word may appear in the
    // warning copy — "never copy it to the clipboard" — which is the point).
    expect(courierSrc).not.toContain("navigator.clipboard");
    expect(courierSrc).not.toContain("Copy bundle text");
  });

  it("neither courier.ts nor create-pair.ts base64-encodes pad bytes on the UI thread", () => {
    // Packing/unpacking lives in the worker (engine/courier-format.ts).
    for (const src of [courierSrc, createSrc]) {
      expect(src).not.toContain("btoa(");
      expect(src).not.toContain("atob(");
      expect(src).not.toContain("unpackBundle");
      expect(src).not.toContain("packBundle");
    }
  });

  it("the framed-context gate exists in main.ts (the operational UI refuses to run in a frame)", () => {
    const main = readFileSync(join(ROOT, "src", "browser", "main.ts"), "utf8");
    expect(main).toMatch(/window\.self\s*!==\s*window\.top/);
    expect(main).toMatch(/isFramed/);
  });
});

/* ============================================================================
 * (7) CLI↔Browser FORMAT-V2 interop holds even with a browser-local witness:
 *     the frozen store is byte-identical; the witness lives outside it.
 * ========================================================================= */

describe("closure #7: a browser-local-witness store is still a bare FORMAT-V2 store", () => {
  it("stripping pair.json + witness leaves a store the engine reads as browser-none, unchanged counters", async () => {
    const a = new MemoryVfs();
    const b = new MemoryVfs();
    const pairId = await gen(a, "interop", { e: 128, n: 8, witness: "browser-local-witness" });
    const exp = asOk(await send(a, { op: "export-pair", pairId }), "export-pair");
    // The peer imports as browser-none (a bare FORMAT-V2 consumer).
    asOk(await send(b, { op: "import-pair", label: "b", container: exp.container, witnessClass: "browser-none" }), "import-pair");
    const st = asOk(await send(b, { op: "status", pairId }), "status");
    expect(st.pair.meters["A->B"].witness).toEqual({ class: "browser-none", state: "n/a" });
    expect(st.pair.meters["A->B"].authentication.nextSequence).toBe(0);
    // Round-trips fine without any witness.
    const burn = asOk(await send(a, { op: "burn", pairId, as: "A", plaintext: utf8.encode("interop ok") }), "burn");
    const open = asOk(await send(b, { op: "open", pairId, as: "B", envelope: burn.envelope }), "open");
    expect(fromUtf8.decode(open.plaintext)).toBe("interop ok");
  });
});
