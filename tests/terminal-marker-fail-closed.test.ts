import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entryExists } from "../src/cli/v2/store2";
import { handle } from "../src/browser/engine/verbs";
import { MemoryVfs, type Vfs } from "../src/browser/engine/vfs";
import type { EngineRequest, EngineResponse } from "../src/browser/engine/protocol";

/* ============================================================================
 * THE TERMINAL MARKER MUST FAIL CLOSED (FORMAT-V2.md §17).
 *
 * `destroyed.json` is the irreversible boundary: once it is durable the pair
 * must never perform a cryptographic operation again. The gate therefore asks
 * "is this path NOT KNOWN TO BE ABSENT", not "is there a readable regular file
 * here" — because every way of being unreadable must still close the boundary.
 *
 * A REAL FAIL-OPEN, MEASURED RATHER THAN ASSUMED. The gate used `existsSync`,
 * which follows symlinks and answers FALSE for a symlink whose target is gone.
 * A tombstone in that shape read as absent and the destroyed pair became usable
 * again — pad reuse, the one outcome TruePad may never allow. Node, the JVM and
 * Foundation all answer `false` there, which is why Android and iOS carried the
 * identical defect and were corrected in the same change. These are the
 * regression tests for the TypeScript half; the Kotlin and Swift halves are
 * TerminalMarkerFailClosedTest.kt and TerminalMarkerFailClosedTests.swift, and
 * all three assert the same list of shapes.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");

let dir: string;
let sourceCount = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-terminal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...argv: string[]): { code: number; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
  return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}

function genPair(pair: string, e = 64, n = 8): void {
  sourceCount += 1;
  const source = join(dir, `source-${sourceCount}.bin`);
  writeFileSync(source, randomBytes(2 * (e + 32 * n)));
  const gen = run("gen", pair, "--source", source, "--encryption-bytes", String(e), "--auth-records", String(n));
  expect(gen.code).toBe(0);
}

/** Every shape a tombstone can take that is NOT "a well-formed readable file". */
const SHAPES: ReadonlyArray<{ name: string; make: (path: string) => void }> = [
  { name: "a symlink whose target does not exist", make: (p) => symlinkSync(join(dir, "gone-target"), p) },
  {
    name: "a symlink to a deleted file",
    make: (p) => {
      const t = join(dir, "t.bin");
      writeFileSync(t, "x");
      symlinkSync(t, p);
      rmSync(t);
    }
  },
  { name: "a directory", make: (p) => mkdirSync(p) },
  {
    name: "a non-empty directory",
    make: (p) => {
      mkdirSync(p);
      writeFileSync(join(p, "inner"), "x");
    }
  },
  { name: "an empty file (a torn write)", make: (p) => writeFileSync(p, "") },
  { name: "a truncated JSON object", make: (p) => writeFileSync(p, '{"formatVersion":2,"pairId":"aaaa') },
  { name: "not JSON at all", make: (p) => writeFileSync(p, "  not json") },
  { name: "JSON that is not an object", make: (p) => writeFileSync(p, "[1,2,3]") },
  {
    name: "a JSON object naming a DIFFERENT pair",
    make: (p) => writeFileSync(p, JSON.stringify({ formatVersion: 2, pairId: "f".repeat(32) }))
  },
  {
    name: "a file with no read permission",
    make: (p) => {
      writeFileSync(p, "{}");
      chmodSync(p, 0);
    }
  }
];

describe("the §17 terminal marker fails closed in every shape", { timeout: 240_000 }, () => {
  for (const shape of SHAPES) {
    it(`refuses a consuming verb when destroyed.json is ${shape.name}`, () => {
      const a = join(dir, "a");
      genPair(a);

      // Control FIRST: without the marker this exact call succeeds, so the
      // refusal below is caused by the marker and nothing else.
      expect(run("burn", a, "--as", "A", "before").code).toBe(0);

      shape.make(join(a, "destroyed.json"));

      const burn = run("burn", a, "--as", "A", "after");
      expect(burn.code, `burn must refuse (${shape.name})`).toBe(2);
      expect(burn.stderr).toContain("refused: pair-destroyed");
      expect(burn.stdout).toBe("");

      const status = run("status", a);
      expect(status.code, `status must refuse (${shape.name})`).toBe(2);
      expect(status.stderr).toContain("refused: pair-destroyed");
    });
  }

  it("a destroyed pair whose tombstone is replaced by a dangling symlink STAYS destroyed", () => {
    // The end-to-end shape of the original defect: destroy for real, then let a
    // restore or a sync tool leave a broken link where the tombstone was.
    const a = join(dir, "a");
    genPair(a);
    const confirm = run("status", a).stdout.match(/[0-9a-f]{32}/)?.[0];
    expect(confirm).toBeDefined();
    expect(run("destroy", a, "--confirm", confirm as string).code).toBe(0);

    rmSync(join(a, "destroyed.json"));
    symlinkSync(join(dir, "gone-target"), join(a, "destroyed.json"));

    const burn = run("burn", a, "--as", "A", "resurrected?");
    expect(burn.code).toBe(2);
    expect(burn.stderr).toContain("refused: pair-destroyed");
  });

  it("entryExists reports presence for every non-absent shape, and absence only when definite", () => {
    for (const [index, shape] of SHAPES.entries()) {
      const p = join(dir, `probe-${index}`);
      shape.make(p);
      expect(entryExists(p), `${shape.name} must read as present`).toBe(true);
    }
    // The ONE definitive negative: there is no such path.
    expect(entryExists(join(dir, "nothing-here"))).toBe(false);
    expect(entryExists(join(dir, "no", "such", "directory", "at", "all.json"))).toBe(false);

    // A path whose parent is not a directory is NOT a definitive negative. Only
    // ENOENT is reported identically by Node, the JVM and Foundation, so it is
    // the only answer the three editions agree to treat as absence.
    const file = join(dir, "plain.bin");
    writeFileSync(file, "x");
    expect(entryExists(join(file, "under-a-file"))).toBe(true);
  });
});

/* ============================================================================
 * THE BROWSER HALF.
 *
 * OPFS has no symlinks, so the shape that broke the other three editions cannot
 * occur here — but the RULE still has to hold, and the way it can break in a
 * browser is different: `OpfsVfs.exists` resolves a file handle, and a directory
 * standing where a file belongs makes that call THROW `TypeMismatchError` rather
 * than return false. The gate must let that throw close the boundary; swallowing
 * it into "absent" would be the same fail-open in a different costume.
 * ========================================================================= */

let browserIdSeq = 1;
type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;
async function send(vfs: Vfs, req: WithoutId<EngineRequest>): Promise<EngineResponse> {
  return handle(vfs, { ...req, id: browserIdSeq++ } as EngineRequest);
}

/** Injects the failure mode a real OPFS backing produces for a non-file entry. */
class TypeMismatchOnExistsVfs implements Vfs {
  readonly inner: Vfs;
  readonly throwFor: (path: string) => boolean;
  constructor(inner: Vfs, throwFor: (path: string) => boolean) {
    this.inner = inner;
    this.throwFor = throwFor;
  }
  readFile(p: string) { return this.inner.readFile(p); }
  appendFile(p: string, d: Uint8Array) { return this.inner.appendFile(p, d); }
  writeFileAtomic(p: string, d: Uint8Array) { return this.inner.writeFileAtomic(p, d); }
  readRange(p: string, o: number, l: number) { return this.inner.readRange(p, o, l); }
  writeRange(p: string, o: number, d: Uint8Array) { return this.inner.writeRange(p, o, d); }
  async exists(p: string) {
    if (this.throwFor(p)) {
      const error = new Error(`a directory stands at ${p}`);
      error.name = "TypeMismatchError";
      throw error;
    }
    return this.inner.exists(p);
  }
  remove(p: string) { return this.inner.remove(p); }
  size(p: string) { return this.inner.size(p); }
  list(p: string) { return this.inner.list(p); }
  withLock<T>(s: string, fn: () => Promise<T>) { return this.inner.withLock(s, fn); }
}

function uniformSource(e: number, n: number): Uint8Array {
  const bytes = randomBytes(2 * (e + 32 * n));
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function browserPair(vfs: Vfs): Promise<string> {
  const res = await send(vfs, {
    op: "gen",
    label: "terminal-marker",
    sources: [{ name: "src.bin", declaredOrigin: "test material, operator-asserted", bytes: uniformSource(64, 8) }],
    encryptionBytes: 64,
    authRecords: 8,
    witnessClass: "browser-local-witness"
  });
  if (!res.ok || res.op !== "gen") {
    throw new Error(`gen failed: ${JSON.stringify(res)}`);
  }
  return res.pair.pairId;
}

describe("the §17 terminal marker fails closed in the browser engine too", { timeout: 120_000 }, () => {
  const MALFORMED: ReadonlyArray<{ name: string; bytes: string }> = [
    { name: "an empty file (a torn write)", bytes: "" },
    { name: "a truncated JSON object", bytes: '{"formatVersion":2,"pairId":"aaaa' },
    { name: "not JSON at all", bytes: "  not json" },
    { name: "JSON that is not an object", bytes: "[1,2,3]" },
    { name: "a JSON object naming a DIFFERENT pair", bytes: JSON.stringify({ formatVersion: 2, pairId: "f".repeat(32) }) }
  ];

  for (const shape of MALFORMED) {
    it(`refuses pair-destroyed when the tombstone is ${shape.name}`, async () => {
      const vfs = new MemoryVfs();
      const pairId = await browserPair(vfs);

      // Control first: this exact call succeeds without the marker.
      const before = await send(vfs, { op: "burn", pairId, as: "A", plaintext: new TextEncoder().encode("before") });
      expect(before.ok).toBe(true);

      await vfs.writeFileAtomic(`${pairId}/destroyed.json`, new TextEncoder().encode(shape.bytes));

      const after = await send(vfs, { op: "burn", pairId, as: "A", plaintext: new TextEncoder().encode("after") });
      expect(after.ok, `burn must refuse (${shape.name})`).toBe(false);
      expect((after as { reason?: string }).reason).toBe("pair-destroyed");
    });
  }

  it("an exists() that throws closes the boundary instead of reading as absent", async () => {
    const inner = new MemoryVfs();
    const pairId = await browserPair(inner);
    const vfs = new TypeMismatchOnExistsVfs(inner, (p) => p === `${pairId}/destroyed.json`);

    const burn = await send(vfs, { op: "burn", pairId, as: "A", plaintext: new TextEncoder().encode("after") });
    expect(burn.ok, "a tombstone whose presence cannot be decided must not permit a burn").toBe(false);

    const open = await send(vfs, { op: "status", pairId });
    expect(open.ok, "status must not proceed either").toBe(false);
  });
});
