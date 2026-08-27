import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/* ============================================================================
 * Phase 3 — ceremony as code (src/cli/v2/ceremony.ts; docs/CEREMONY.md;
 * FORMAT-V2.md §8.5, §12.4, §14.2 L3).
 *
 * Covered here: ceremony create refuses without the operator assertions and
 * with fewer than two sources (ceremony-incomplete, exit 2, nothing
 * written); a full create provisions TWO PEER MEDIA, each a whole openable
 * pair copy — the courier model, burn in medium A's copy and open in
 * medium B's; the workspace pair copy is gone after create; ceremony
 * verify passes on a good medium and refuses a half-pair. Everything runs
 * through the real launcher, the way an operator would.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");

// Budgets small enough to test against: L = 2·(E + 32·N) = 384 bytes.
const E = 64;
const N = 4;
const REQUIRED = 2 * (E + 32 * N);

function run(...argv: string[]): { code: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

let dir: string;
let ws: string;
let mediumA: string;
let mediumB: string;
let src1: string;
let src2: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-ceremony-"));
  ws = join(dir, "ws");
  mediumA = join(dir, "medium-a");
  mediumB = join(dir, "medium-b");
  src1 = join(dir, "src1.bin");
  src2 = join(dir, "src2.bin");
  // Two distinct source fixtures, each longer than required (surplus is
  // reported unused, never silently spent).
  const a = new Uint8Array(REQUIRED + 16);
  const b = new Uint8Array(REQUIRED + 16);
  for (let i = 0; i < a.length; i += 1) {
    a[i] = i % 256;
    b[i] = (i * 7 + 3) % 256;
  }
  writeFileSync(src1, a);
  writeFileSync(src2, b);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BUDGET_FLAGS = ["--encryption-bytes", String(E), "--auth-records", String(N)];
const ALL_ASSERTIONS = ["--assert-offline", "--assert-distinct-physics", "--assert-tmpfs-workspace", "--assert-no-persistent-copy"];

function create(...extra: string[]): { code: number | null; stdout: string; stderr: string } {
  return run("ceremony", "create", ws, "--medium-a", mediumA, "--medium-b", mediumB, ...extra);
}

describe("ceremony create refuses an incomplete ceremony", () => {
  it("without the operator assertions: ceremony-incomplete, exit 2, nothing generated", () => {
    const result = create("--source", src1, "--source", src2, ...BUDGET_FLAGS);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("refused: ceremony-incomplete");
    // Every missing assertion is listed by name, and the tool says what an
    // assertion is: an operator statement it cannot verify.
    for (const flag of ALL_ASSERTIONS) {
      expect(result.stderr).toContain(flag);
    }
    expect(result.stderr).toContain("cannot verify");
    expect(result.stderr).toContain("Nothing was generated");
    expect(existsSync(join(ws, "pair"))).toBe(false);
    expect(existsSync(mediumA)).toBe(false);
    expect(existsSync(mediumB)).toBe(false);
  });

  it("with some assertions missing: exactly the missing ones are listed", () => {
    const result = create("--source", src1, "--source", src2, ...BUDGET_FLAGS, "--assert-offline", "--assert-distinct-physics");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("refused: ceremony-incomplete");
    expect(result.stderr).toContain("--assert-tmpfs-workspace");
    expect(result.stderr).toContain("--assert-no-persistent-copy");
    expect(existsSync(join(ws, "pair"))).toBe(false);
  });

  it("with fewer than two sources: ceremony-incomplete even with every assertion made", () => {
    const result = create("--source", src1, ...BUDGET_FLAGS, ...ALL_ASSERTIONS);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("refused: ceremony-incomplete");
    expect(result.stderr).toContain("at least two --source");
    expect(result.stderr).toContain("Nothing was generated");
    expect(existsSync(join(ws, "pair"))).toBe(false);
    expect(existsSync(mediumA)).toBe(false);
  });
});

describe("ceremony create provisions two peer media (the courier model)", () => {
  it("two full pair copies; burn from medium A's copy, open in medium B's; the workspace copy is gone", () => {
    const created = create(
      "--source", src1, "--source", src2,
      "--origin", "test fixture, physics one",
      "--origin", "test fixture, physics two",
      ...BUDGET_FLAGS,
      ...ALL_ASSERTIONS
    );
    expect(created.code).toBe(0);

    // One machine line on stdout: gen's, carrying the pairId and both
    // directions' meters at birth.
    const line = JSON.parse(created.stdout.trim()) as { pairId: string; "A->B": { encryption: { capacity: number } } };
    expect(line.pairId).toMatch(/^[0-9a-f]{32}$/);
    expect(line["A->B"].encryption.capacity).toBe(E);

    // The CEREMONY RECORD goes to stderr for the pad book: pairId, media,
    // every assertion by name, the verbatim verdict line.
    expect(created.stderr).toContain("CEREMONY RECORD");
    expect(created.stderr).toContain(line.pairId);
    expect(created.stderr).toContain(mediumA);
    expect(created.stderr).toContain(mediumB);
    for (const flag of ALL_ASSERTIONS) {
      expect(created.stderr).toContain(flag);
    }
    expect(created.stderr).toContain("Uniform if at least one declared source was uniform and independent of the others.");
    expect(created.stderr).toContain("not proof of erasure");

    // The workspace pair copy is gone after create.
    expect(existsSync(join(ws, "pair"))).toBe(false);

    // TWO PEER MEDIA: each holds the FULL pair — both direction stores and
    // the manifest — never one direction per drive.
    for (const medium of [mediumA, mediumB]) {
      expect(existsSync(join(medium, "a-to-b", "head.json"))).toBe(true);
      expect(existsSync(join(medium, "a-to-b", "secret.bin"))).toBe(true);
      expect(existsSync(join(medium, "b-to-a", "head.json"))).toBe(true);
      expect(existsSync(join(medium, "b-to-a", "secret.bin"))).toBe(true);
      expect(existsSync(join(medium, "manifest.json"))).toBe(true);
      expect(existsSync(join(medium, "lock"))).toBe(false);
    }

    // Courier model: A burns in A's copy, B opens in B's copy.
    const burned = run("burn", mediumA, "--as", "A", "HELLO CEREMONY");
    expect(burned.code).toBe(0);
    const envelope = burned.stdout.trim();
    expect(JSON.parse(envelope).pairId).toBe(line.pairId);

    const opened = run("open", mediumB, "--as", "B", envelope);
    expect(opened.code).toBe(0);
    expect(opened.stdout.trim()).toBe("HELLO CEREMONY");

    // And the reverse direction works from the other copy: both media are
    // whole pairs, not one direction each.
    const replyBurn = run("burn", mediumB, "--as", "B", "REPLY");
    expect(replyBurn.code).toBe(0);
    const replyOpen = run("open", mediumA, "--as", "A", replyBurn.stdout.trim());
    expect(replyOpen.code).toBe(0);
    expect(replyOpen.stdout.trim()).toBe("REPLY");
  });
});

describe("ceremony verify", () => {
  it("passes on a good medium and refuses a half-pair", () => {
    const created = create("--source", src1, "--source", src2, ...BUDGET_FLAGS, ...ALL_ASSERTIONS);
    expect(created.code).toBe(0);
    const pairId = (JSON.parse(created.stdout.trim()) as { pairId: string }).pairId;

    const good = run("ceremony", "verify", mediumB);
    expect(good.code).toBe(0);
    const verified = JSON.parse(good.stdout.trim()) as {
      pairId: string;
      "A->B": { encryption: { remainingBytes: number } };
      manifest: string;
    };
    expect(verified.pairId).toBe(pairId);
    expect(verified["A->B"].encryption.remainingBytes).toBe(E);
    expect(verified.manifest).toBe("present");
    // The meters and the manifest are printed; verify claims structure, not
    // provenance, and says so.
    expect(good.stderr).toContain("encryption");
    expect(good.stderr).toContain("manifest");
    expect(good.stderr).toContain("structure, not provenance");

    // A half-pair — one direction store alone on a medium — is refused.
    const half = join(dir, "half-medium");
    mkdirSync(half, { recursive: true });
    cpSync(join(mediumA, "a-to-b"), join(half, "a-to-b"), { recursive: true });
    const refused = run("ceremony", "verify", half);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("refused: half-pair");
    expect(refused.stderr).toContain("b-to-a/ is missing");
  });
});
