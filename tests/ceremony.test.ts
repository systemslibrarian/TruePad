import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// truepad2 before ceremony, deliberately: the two modules import each
// other, and truepad2's module body reads ceremony's assertion list —
// evaluating truepad2 first matches the launcher's load order.
import { Refused2 } from "../src/cli/v2/truepad2";
import { verifyMediumCopy } from "../src/cli/v2/ceremony";

/* ============================================================================
 * Phase 3 — ceremony as code (src/cli/v2/ceremony.ts; docs/CEREMONY.md;
 * FORMAT-V2.md §8.5, §12.4, §14.2 L3).
 *
 * Covered here: ceremony create refuses without the operator assertions,
 * with fewer than two sources, and with two media names reaching one
 * filesystem object (ceremony-incomplete, exit 2, nothing written); a full
 * create provisions TWO PEER MEDIA, each a whole openable pair copy — the
 * courier model, burn in medium A's copy and open in medium B's; the
 * workspace pair copy is gone after create; ceremony verify passes on a
 * good medium and refuses a half-pair. The operator-shaped flows run
 * through the real launcher; the provisioning byte-verification is also
 * tested at the helper level (verifyMediumCopy), where a medium file can
 * be corrupted deterministically between copy and verify instead of racing
 * the real create flow.
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
    // Both media were byte-verified against the workspace pair before the
    // workspace copy was removed, and the record says so.
    expect(created.stderr).toContain("medium A: byte-verifying every load-bearing file against the workspace pair");
    expect(created.stderr).toContain("medium B: byte-verifying every load-bearing file against the workspace pair");
    expect(created.stderr).toContain("byte-verified against the workspace pair at provisioning");

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

describe("ceremony create refuses two media names that reach one filesystem object", () => {
  it("the same path given twice: ceremony-incomplete, nothing generated", () => {
    const result = run(
      "ceremony", "create", ws,
      "--medium-a", mediumA, "--medium-b", mediumA,
      "--source", src1, "--source", src2,
      ...BUDGET_FLAGS, ...ALL_ASSERTIONS
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("refused: ceremony-incomplete");
    expect(result.stderr).toContain("same filesystem object");
    // The refusal is honest about what the check is worth: platform
    // identity checks, not proof of distinct physical devices.
    expect(result.stderr).toContain("cannot prove");
    expect(existsSync(join(ws, "pair"))).toBe(false);
    expect(existsSync(mediumA)).toBe(false);
  });

  it("a symlinked alias of medium-b onto medium-a: ceremony-incomplete, nothing generated", () => {
    // Two different path strings, one directory: the alias a mount-point or
    // symlink can create. String comparison passes; realpath/dev+inode do not.
    mkdirSync(mediumA, { recursive: true });
    symlinkSync(mediumA, mediumB);
    const result = create("--source", src1, "--source", src2, ...BUDGET_FLAGS, ...ALL_ASSERTIONS);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("refused: ceremony-incomplete");
    expect(result.stderr).toContain("same filesystem object");
    expect(existsSync(join(ws, "pair"))).toBe(false);
    expect(existsSync(join(mediumA, "a-to-b"))).toBe(false);
  });

  it("a DANGLING symlink alias — target created only by the copy — is caught after provisioning, workspace preserved", () => {
    // medium-b symlinks to a medium-a that does NOT exist yet, so neither the
    // up-front realpath nor dev+inode check can resolve it. The copy creates
    // the target; the post-copy re-check then sees one object under two names
    // and refuses BEFORE the workspace copy — the only other copy — is gone.
    symlinkSync(mediumA, mediumB); // mediumA absent at this point
    const result = create("--source", src1, "--source", src2, ...BUDGET_FLAGS, ...ALL_ASSERTIONS);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("refused: ceremony-incomplete");
    expect(result.stderr).toContain("same filesystem object");
    expect(result.stderr).toContain("NOT removed");
    // The workspace pair survives: the one good copy is not destroyed over a
    // one-object "two media".
    expect(existsSync(join(ws, "pair", "a-to-b", "secret.bin"))).toBe(true);
  });

  it("a medium that IS the workspace is refused: no copy may remain on the generating machine", () => {
    const result = run(
      "ceremony", "create", ws,
      "--medium-a", ws, "--medium-b", mediumB,
      "--source", src1, "--source", src2,
      ...BUDGET_FLAGS, ...ALL_ASSERTIONS
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("refused: ceremony-incomplete");
    expect(result.stderr).toContain("workspace");
    expect(existsSync(join(ws, "pair"))).toBe(false);
  });
});

describe("a provisioning failure names the recovery it actually leaves the operator", () => {
  it("a byte mismatch refuses with the no-re-provision recovery, workspace intact", async () => {
    const { verifyMediumCopy, RECOVERY_NOTE } = await import("../src/cli/v2/ceremony");
    // Provision cleanly, then corrupt a medium copy and re-verify at the
    // helper level (deterministic, no race against the real copy).
    expect(create("--source", src1, "--source", src2, ...BUDGET_FLAGS, ...ALL_ASSERTIONS).code).toBe(0);
    // ceremony create removed the workspace on success; rebuild a workspace
    // pair to compare against by copying medium A back, then diverge medium B.
    const wsPair = join(dir, "wspair");
    cpSync(mediumA, wsPair, { recursive: true });
    const secretB = join(mediumB, "a-to-b", "secret.bin");
    const bytes = readFileSync(secretB);
    bytes[0] ^= 0xff;
    writeFileSync(secretB, bytes);
    let caught: Error | undefined;
    try {
      verifyMediumCopy(wsPair, mediumB, "B");
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("does not byte-match");
    expect((caught as Error).message).toContain(RECOVERY_NOTE);
    expect((caught as Error).message).toContain("Do NOT reuse the collected source files");
  });
});

describe("provisioning byte-verification (verifyMediumCopy, helper level)", () => {
  /* The real create flow copies and verifies in one pass; corrupting a
   * medium inside that window would be a race. Here the helper is driven
   * directly: gen a real pair, copy it to two media the way create does
   * (structure-identical for the load-bearing files), corrupt exactly one
   * file, and call verifyMediumCopy. */

  let pair: string;

  beforeEach(() => {
    pair = join(dir, "pair");
    const generated = run("gen", pair, "--source", src1, "--source", src2, ...BUDGET_FLAGS);
    expect(generated.code).toBe(0);
    cpSync(pair, mediumA, { recursive: true });
    cpSync(pair, mediumB, { recursive: true });
  });

  // One byte XORed in place: same length, one bit of difference — the
  // smallest corruption a structural load would accept (secret.bin is
  // checked by length; content never decides liveness).
  function corruptByte(path: string, offset: number): void {
    const bytes = readFileSync(path);
    bytes[offset] ^= 0x01;
    writeFileSync(path, bytes);
    bytes.fill(0);
  }

  function expectRefusal(medium: string, label: string, rel: string): Refused2 {
    let caught: unknown;
    try {
      verifyMediumCopy(pair, medium, label);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Refused2);
    const refusal = caught as Refused2;
    expect(refusal.type).toBe("ceremony-incomplete");
    // The refusal names the medium and the file path that differed — and
    // says the workspace copy was kept, so the operator knows the good
    // bytes still exist.
    expect(refusal.message).toContain(`medium ${label}`);
    expect(refusal.message).toContain(join(medium, rel));
    expect(refusal.message).toContain("NOT removed");
    // The refusal states the actual recovery — no re-provision verb exists —
    // rather than ordering an action the tooling cannot perform.
    expect(refusal.message).toContain("Do NOT reuse the collected source files");
    // The workspace pair really is still on disk, byte-complete.
    for (const half of ["a-to-b", "b-to-a"]) {
      for (const name of ["head.json", "secret.bin", "journal.log"]) {
        expect(existsSync(join(pair, half, name))).toBe(true);
      }
    }
    expect(existsSync(join(pair, "manifest.json"))).toBe(true);
    return refusal;
  }

  // Value-independence, checked against the actual secret content: no hex
  // run of the secret appears anywhere in the refusal message. Every
  // 16-hex-character (8-byte) window is tried, so a partial leak would be
  // caught, not just a whole-secret dump.
  function expectNoHexRuns(message: string, secret: Uint8Array): void {
    const hex = Buffer.from(secret).toString("hex");
    const haystack = message.toLowerCase();
    for (let i = 0; i + 16 <= hex.length; i += 1) {
      expect(haystack).not.toContain(hex.slice(i, i + 16));
    }
  }

  it("a corrupted secret.bin byte on medium A: names medium A and the file, keeps the workspace, leaks no secret bytes", () => {
    const rel = join("a-to-b", "secret.bin");
    const workspaceSecret = readFileSync(join(pair, rel));
    corruptByte(join(mediumA, rel), 5);
    const corrupted = readFileSync(join(mediumA, rel));
    const refusal = expectRefusal(mediumA, "A", rel);
    expectNoHexRuns(refusal.message, workspaceSecret);
    expectNoHexRuns(refusal.message, corrupted);
  });

  it("a corrupted secret.bin byte on medium B: names medium B and the file, keeps the workspace, leaks no secret bytes", () => {
    const rel = join("b-to-a", "secret.bin");
    const workspaceSecret = readFileSync(join(pair, rel));
    corruptByte(join(mediumB, rel), E + 3); // inside the authentication slice
    const corrupted = readFileSync(join(mediumB, rel));
    const refusal = expectRefusal(mediumB, "B", rel);
    expectNoHexRuns(refusal.message, workspaceSecret);
    expectNoHexRuns(refusal.message, corrupted);
  });

  it("a corrupted head.json byte is caught and named", () => {
    const rel = join("a-to-b", "head.json");
    corruptByte(join(mediumA, rel), 2);
    expectRefusal(mediumA, "A", rel);
  });

  it("a corrupted journal.log byte is caught and named", () => {
    const rel = join("b-to-a", "journal.log");
    corruptByte(join(mediumB, rel), 0);
    expectRefusal(mediumB, "B", rel);
  });

  it("changed manifest.json content is caught and named", () => {
    const manifest = readFileSync(join(mediumA, "manifest.json"), "utf8");
    writeFileSync(join(mediumA, "manifest.json"), manifest.replace("\"formatVersion\":", "\"formatVersion\" :"));
    expectRefusal(mediumA, "A", "manifest.json");
  });

  it("a load-bearing file missing from a medium is caught and named", () => {
    rmSync(join(mediumB, "manifest.json"));
    const refusal = expectRefusal(mediumB, "B", "manifest.json");
    expect(refusal.message).toContain("missing");
  });

  it("clean copies pass on both media", () => {
    verifyMediumCopy(pair, mediumA, "A");
    verifyMediumCopy(pair, mediumB, "B");
  });
});
