import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/* ============================================================================
 * truepad2 destruction end to end (FORMAT-V2.md §17; ledger N21). The real
 * binary via the launcher, the courier model of truepad2-cli.test.ts (gen
 * once, cp -R per peer), tiny budgets.
 *
 * destroy tears one pair down: confirmation → tombstone → best-effort
 * zero-overwrite of secret.bin → unlink the three files + remove the half
 * dirs → fsync the pair dir. manifest.json and destroyed.json remain. It
 * refuses without the matching confirmation touching nothing, works on a
 * store too corrupt to load, and claims no erasure of the medium.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");

const VERBATIM_LIMITATION =
  "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes.";

let dir: string;
let sourceCount = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-destroy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...argv: string[]): { code: number; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
  return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}

function sourceFile(bytes: number): string {
  sourceCount += 1;
  const path = join(dir, `source-${sourceCount}.bin`);
  writeFileSync(path, randomBytes(bytes));
  return path;
}

function genPair(pair: string, e: number, n: number, ...extra: string[]): { code: number; stdout: string; stderr: string } {
  const source = sourceFile(2 * (e + 32 * n));
  return run("gen", pair, "--source", source, "--encryption-bytes", String(e), "--auth-records", String(n), ...extra);
}

const THREE = ["secret.bin", "head.json", "journal.log"] as const;

describe("truepad2 destroy (FORMAT-V2.md §17)", { timeout: 120_000 }, () => {
  it("a wrong confirmation is refused destroy-unconfirmed and the directory is untouched", () => {
    const a = join(dir, "a");
    const gen = genPair(a, 64, 8);
    expect(gen.code).toBe(0);

    const secretBefore = readFileSync(join(a, "a-to-b", "secret.bin"));
    const destroyed = run("destroy", a, "--confirm", "0".repeat(32));
    expect(destroyed.code).toBe(2);
    expect(destroyed.stderr).toContain("refused: destroy-unconfirmed");
    expect(destroyed.stdout).toBe("");

    // Untouched: secret.bin byte-identical, the store still present, no tombstone.
    expect(readFileSync(join(a, "a-to-b", "secret.bin")).equals(secretBefore)).toBe(true);
    expect(existsSync(join(a, "a-to-b", "head.json"))).toBe(true);
    expect(existsSync(join(a, "destroyed.json"))).toBe(false);
  });

  it("a missing confirmation is refused destroy-unconfirmed, nothing touched", () => {
    const a = join(dir, "a");
    expect(genPair(a, 64, 8).code).toBe(0);
    const secretBefore = readFileSync(join(a, "a-to-b", "secret.bin"));

    const destroyed = run("destroy", a);
    expect(destroyed.code).toBe(2);
    expect(destroyed.stderr).toContain("refused: destroy-unconfirmed");
    expect(existsSync(join(a, "destroyed.json"))).toBe(false);
    expect(readFileSync(join(a, "a-to-b", "secret.bin")).equals(secretBefore)).toBe(true);
  });

  it("the expected pairId is not echoed in the refusal", () => {
    const a = join(dir, "a");
    const gen = genPair(a, 64, 8);
    const pairId = JSON.parse(gen.stdout).pairId as string;
    const destroyed = run("destroy", a, "--confirm", "nope");
    expect(destroyed.code).toBe(2);
    // The refusal names the requirement without printing the token to satisfy it.
    expect(destroyed.stderr).not.toContain(pairId);
    expect(destroyed.stderr).toContain("NOT echoed");
  });

  it("a matching confirmation destroys both halves, leaves manifest, and writes the tombstone", () => {
    const a = join(dir, "a");
    const gen = genPair(a, 64, 8);
    const pairId = JSON.parse(gen.stdout).pairId as string;

    // One burn so the tombstone records a non-zero A->B high-water.
    expect(run("burn", a, "--as", "A", "hi").code).toBe(0); // 2 bytes, seq 0

    const destroyed = run("destroy", a, "--confirm", pairId, "--reason", "pair exhausted, for the pad book");
    expect(destroyed.code).toBe(0);

    // The three files and the half directories are gone in BOTH halves.
    for (const half of ["a-to-b", "b-to-a"]) {
      for (const name of THREE) {
        expect(existsSync(join(a, half, name))).toBe(false);
      }
      expect(existsSync(join(a, half))).toBe(false);
    }
    // manifest.json survives; so does the tombstone.
    expect(existsSync(join(a, "manifest.json"))).toBe(true);
    expect(existsSync(join(a, "destroyed.json"))).toBe(true);

    const tombstone = JSON.parse(readFileSync(join(a, "destroyed.json"), "utf8"));
    expect(tombstone.pairId).toBe(pairId);
    expect(tombstone.reason).toBe("pair exhausted, for the pad book");
    expect(tombstone.limitation).toBe(VERBATIM_LIMITATION);
    // Final high-waters where readable: A->B advanced by the one burn, B->A idle.
    expect(tombstone.finalHighWaters["A->B"]).toEqual({ nextOffset: 2, nextSequence: 1 });
    expect(tombstone.finalHighWaters["B->A"]).toEqual({ nextOffset: 0, nextSequence: 0 });

    // The §17.2 limitation block reaches stderr, verbatim sentence and caveats.
    expect(destroyed.stderr).toContain(VERBATIM_LIMITATION);
    expect(destroyed.stderr).toContain("APFS");
    expect(destroyed.stderr).toContain("wear leveling");
    // The stdout result names the tombstone it wrote.
    expect(JSON.parse(destroyed.stdout)).toMatchObject({ destroyed: true, pairId });
  });

  it("a store too corrupt to load is destroyable only with the literal destroy-unreadable-pair token", () => {
    const a = join(dir, "a");
    const gen = genPair(a, 64, 8);
    const pairId = JSON.parse(gen.stdout).pairId as string;

    // Garble both halves' head.json: no pairId is readable any more.
    for (const half of ["a-to-b", "b-to-a"]) {
      writeFileSync(join(a, half, "head.json"), "not json at all");
    }

    // The old pairId no longer confirms — the pair cannot be identified by it.
    const byOldId = run("destroy", a, "--confirm", pairId);
    expect(byOldId.code).toBe(2);
    expect(byOldId.stderr).toContain("refused: destroy-unconfirmed");
    expect(byOldId.stderr).toContain("destroy-unreadable-pair");
    expect(existsSync(join(a, "destroyed.json"))).toBe(false);

    // The literal token destroys it; secret.bin (still present) is removed too.
    const literal = run("destroy", a, "--confirm", "destroy-unreadable-pair");
    expect(literal.code).toBe(0);
    for (const half of ["a-to-b", "b-to-a"]) {
      expect(existsSync(join(a, half))).toBe(false);
    }
    const tombstone = JSON.parse(readFileSync(join(a, "destroyed.json"), "utf8"));
    expect(tombstone.pairId).toBeNull();
    expect(tombstone.limitation).toBe(VERBATIM_LIMITATION);
  });

  it("a v1 store is refused v1-store and nothing is touched", () => {
    const v1 = join(dir, "v1");
    mkdirSync(join(v1, "a-to-b"), { recursive: true });
    const padPath = join(v1, "a-to-b", "pad.json");
    writeFileSync(padPath, JSON.stringify({ version: 1, note: "a v1 pad store" }));

    const destroyed = run("destroy", v1, "--confirm", "anything");
    expect(destroyed.code).toBe(2);
    expect(destroyed.stderr).toContain("refused: v1-store");
    expect(existsSync(padPath)).toBe(true);
    expect(existsSync(join(v1, "destroyed.json"))).toBe(false);
  });

  it("a destroyed pair no longer loads: status refuses with nothing usable left", () => {
    const a = join(dir, "a");
    const gen = genPair(a, 64, 8);
    const pairId = JSON.parse(gen.stdout).pairId as string;
    expect(run("destroy", a, "--confirm", pairId).code).toBe(0);

    const status = run("status", a);
    expect(status.code).toBe(2);
    expect(status.stderr).toMatch(/refused: (no-store|corrupt-store)/);
  });

  it("a configured rollback witness is left untouched by destroy (§17.2)", () => {
    const a = join(dir, "a");
    const wa = join(dir, "wa.json");
    const gen = genPair(a, 64, 8, "--witness-class", "separate-state-file", "--witness-path", wa);
    const pairId = JSON.parse(gen.stdout).pairId as string;

    // Provision an empty witness and advance it with one burn.
    writeFileSync(wa, JSON.stringify({ formatVersion: 2, witness: {} }));
    expect(run("burn", a, "--as", "A", "hi").code).toBe(0);
    const witnessBefore = readFileSync(wa);

    expect(run("destroy", a, "--confirm", pairId).code).toBe(0);

    // The witness file, outside the pair directory, is byte-identical.
    expect(existsSync(wa)).toBe(true);
    expect(readFileSync(wa).equals(witnessBefore)).toBe(true);
  });

  it("the courier model: destroy runs in each party's own copy independently", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    const gen = genPair(a, 64, 8);
    const pairId = JSON.parse(gen.stdout).pairId as string;
    cpSync(a, b, { recursive: true });

    // Destroying A's copy leaves B's copy fully usable.
    expect(run("destroy", a, "--confirm", pairId).code).toBe(0);
    expect(existsSync(join(a, "a-to-b"))).toBe(false);

    expect(existsSync(join(b, "a-to-b", "secret.bin"))).toBe(true);
    expect(run("status", b).code).toBe(0);

    // And B's copy destroys on its own confirmation (same pairId, its own files).
    expect(run("destroy", b, "--confirm", pairId).code).toBe(0);
    expect(existsSync(join(b, "b-to-a"))).toBe(false);
  });

  it("§17.2 order: the tombstone is durable BEFORE the files are unlinked (a mid-teardown failure still records the intent)", () => {
    const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (asRoot) {
      return; // root ignores the directory write bit; the unlink cannot be forced to fail
    }
    const a = join(dir, "a");
    const gen = genPair(a, 64, 8);
    const pairId = JSON.parse(gen.stdout).pairId as string;
    // Make one half undeletable: a read/execute-only half directory fails the
    // unlink of its files. Because the tombstone (step 2) is durable before any
    // unlink (step 4), the recorded intent survives even though the teardown
    // cannot complete — pinning the normative ordering against a reorder.
    chmodSync(join(a, "a-to-b"), 0o500);
    const destroyed = run("destroy", a, "--confirm", pairId);
    chmodSync(join(a, "a-to-b"), 0o700); // restore so cleanup works
    // The intent is recorded regardless of the unlink outcome.
    expect(existsSync(join(a, "destroyed.json"))).toBe(true);
    const tombstone = JSON.parse(readFileSync(join(a, "destroyed.json"), "utf8"));
    expect(tombstone.pairId).toBe(pairId);
    expect(tombstone.limitation).toContain("cannot prove that flash forgot the bytes");
    // The other half was still torn down.
    expect(existsSync(join(a, "b-to-a"))).toBe(false);
  });
});
