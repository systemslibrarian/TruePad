import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, linkSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCK_FILE } from "../src/cli/lock";

/* ============================================================================
 * truepad2 end to end — the real binary via the launcher (FORMAT-V2.md §12).
 *
 * The courier model, which every test here observes: one pair directory is
 * generated once and COPIED whole to each peer before any traffic. A burns
 * in A's copy, B opens in B's copy. A single shared directory is the
 * operator mistake the format punishes immediately: the burn self-retires
 * the record in that copy, and every later open of it is sequence-retired.
 *
 * Covered: gen -> courier -> burn/open both directions; replay; skip-and-
 * late-arrival; retire unwedging a contested channel; a stale head.json;
 * v1 stores; half-pairs; source-too-short; the one-file-one-source rule
 * (by realpath); and the §13 status meters with both LIMITED BY values.
 * Budgets are kept tiny so every store fits in a few hundred bytes.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");
const V1_LAUNCHER = join(ROOT, "bin", "truepad-pad.mjs");

let dir: string;
let sourceCount = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...argv: string[]): { code: number; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [LAUNCHER, ...argv], { encoding: "utf8" });
  return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}

// A fresh random source of exactly the required 2*(E + 32*N) bytes.
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

function flipHex(hex: string, index = 0): string {
  return hex.slice(0, index) + (hex[index] === "0" ? "1" : "0") + hex.slice(index + 1);
}

// Each test spawns several Node processes; under CI load the default flakes.
describe("truepad2 end to end (real binary via the launcher)", { timeout: 120_000 }, () => {
  it("gen -> courier copy -> burn/open both directions; the burner's own copy self-retires; replay is refused", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    const gen = genPair(a, 64, 8, "--origin", "test fixture, randomBytes");
    expect(gen.code).toBe(0);
    // The Phase-1 verdict line and the manifest pointer, on stderr where humans read.
    expect(gen.stderr).toContain("Uniform if at least one declared source was uniform and independent of the others.");
    expect(gen.stderr).toContain("manifest:");
    const genOut = JSON.parse(gen.stdout);
    expect(genOut.pairId).toMatch(/^[0-9a-f]{32}$/);
    expect(genOut["A->B"]).toMatchObject({ direction: "A->B", maxRemainingSends: 8 });
    expect(genOut["A->B"].encryption).toMatchObject({ capacity: 64, nextOffset: 0, remainingBytes: 64 });
    expect(existsSync(join(a, "manifest.json"))).toBe(true);

    // Out-of-band delivery: the whole pair directory is copied BEFORE any burn.
    cpSync(a, b, { recursive: true });

    const fromA = run("burn", a, "--as", "A", "attack at dawn");
    expect(fromA.code).toBe(0);
    const envelope = JSON.parse(fromA.stdout);
    expect(envelope).toMatchObject({
      formatVersion: 2,
      pairId: genOut.pairId,
      direction: "A->B",
      sequence: 0,
      startOffset: 0,
      ciphertextLength: 14
    });
    expect(envelope.tag).toMatch(/^[0-9a-f]{32}$/);

    // The courier model's teeth: the burn already retired sequence 0 in A's
    // OWN copy, so opening the envelope in the same directory — the shared-
    // directory mistake — is sequence-retired, not a decryption.
    const shared = run("open", a, "--as", "B", fromA.stdout.trim());
    expect(shared.code).toBe(2);
    expect(shared.stderr).toContain("refused: sequence-retired");

    // B opens in B's copy; then the reverse direction.
    const bOpens = run("open", b, "--as", "B", fromA.stdout.trim());
    expect(bOpens.code).toBe(0);
    expect(bOpens.stdout.trim()).toBe("attack at dawn");

    const fromB = run("burn", b, "--as", "B", "meet me at noon");
    expect(fromB.code).toBe(0);
    expect(JSON.parse(fromB.stdout)).toMatchObject({ direction: "B->A", sequence: 0 });
    const aOpens = run("open", a, "--as", "A", fromB.stdout.trim());
    expect(aOpens.code).toBe(0);
    expect(aOpens.stdout.trim()).toBe("meet me at noon");

    // Replay of an already-opened record: its auth material is gone from B's copy.
    const replay = run("open", b, "--as", "B", fromA.stdout.trim());
    expect(replay.code).toBe(2);
    expect(replay.stderr).toContain("refused: sequence-retired");
    expect(replay.stderr).toContain("Nothing was burned");

    // No lock left behind by any of the above.
    expect(existsSync(join(a, LOCK_FILE))).toBe(false);
    expect(existsSync(join(b, LOCK_FILE))).toBe(false);
  });

  it("a skip retires the lost records' material unused, and the late arrival is then refused", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    expect(genPair(a, 64, 8).code).toBe(0);
    cpSync(a, b, { recursive: true });

    const first = run("burn", a, "--as", "A", "one"); // sequence 0, offsets [0, 3)
    const second = run("burn", a, "--as", "A", "two!"); // sequence 1, offsets [3, 7)
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);

    // The courier drops the first envelope; the second still opens, and the
    // seek retires the skipped material as surely as used material.
    const skip = run("open", b, "--as", "B", second.stdout.trim());
    expect(skip.code).toBe(0);
    expect(skip.stdout.trim()).toBe("two!");
    expect(skip.stderr).toContain("3 skipped encryption bytes and 1 skipped auth records");

    const status = JSON.parse(run("status", b).stdout);
    expect(status["A->B"].encryption).toMatchObject({ nextOffset: 7, remainingBytes: 57 });
    expect(status["A->B"].authentication).toMatchObject({ nextSequence: 2, remainingRecords: 6 });
    expect(status["A->B"].maxRemainingSends).toBe(6);

    // §1.2 hygiene: the retired ranges — used AND skipped — are zeroed in the
    // receiving copy: encryption [0, 7) and auth records 0..1 at [64, 128).
    const secret = readFileSync(join(b, "a-to-b", "secret.bin"));
    expect([...secret.subarray(0, 7)].every((byte) => byte === 0)).toBe(true);
    expect([...secret.subarray(64, 128)].every((byte) => byte === 0)).toBe(true);

    // The dropped envelope arrives late: its material is gone.
    const late = run("open", b, "--as", "B", first.stdout.trim());
    expect(late.code).toBe(2);
    expect(late.stderr).toContain("refused: sequence-retired");
  });

  it("retire unwedges a channel a contested sequence has blocked", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    expect(genPair(a, 64, 4, "--verify-attempt-limit", "2").code).toBe(0);
    cpSync(a, b, { recursive: true });

    const burn = run("burn", a, "--as", "A", "hello");
    expect(burn.code).toBe(0);
    const intact = burn.stdout.trim();
    const envelope = JSON.parse(intact);
    const forged = JSON.stringify({ ...envelope, tag: flipHex(envelope.tag) });

    // Two forged deliveries exhaust sequence 0's verification attempts.
    const firstTry = run("open", b, "--as", "B", forged);
    expect(firstTry.code).toBe(2);
    expect(firstTry.stderr).toContain("refused: auth-failed");
    expect(firstTry.stderr).toContain("1 verification attempt left");
    expect(run("open", b, "--as", "B", forged).code).toBe(2);

    // Now even the genuine envelope is refused: the sequence is contested.
    const wedged = run("open", b, "--as", "B", intact);
    expect(wedged.code).toBe(2);
    expect(wedged.stderr).toContain("refused: sequence-contested");
    expect(wedged.stderr).toContain("permanently contested");

    // The explicit operator recovery: retire the contested sequence.
    const retire = run("retire", b, "--direction", "a-to-b", "--through-sequence", "0", "--reason", "contested in transit");
    expect(retire.code).toBe(0);
    expect(JSON.parse(retire.stdout)).toEqual({ direction: "A->B", nextSequence: 1, nextOffset: 0 });
    expect(retire.stderr).toContain("destroyed unused, never spent");

    // The channel moves again: the next record opens; the retired one never will.
    const next = run("burn", a, "--as", "A", "world");
    expect(next.code).toBe(0);
    const opened = run("open", b, "--as", "B", next.stdout.trim());
    expect(opened.code).toBe(0);
    expect(opened.stdout.trim()).toBe("world");
    expect(run("open", b, "--as", "B", intact).code).toBe(2);
  });

  it("a stale head.json is refused regressed-below-mark: a header older than its own history", () => {
    const a = join(dir, "a");
    expect(genPair(a, 32, 2).code).toBe(0);
    const headPath = join(a, "a-to-b", "head.json");
    const stale = readFileSync(headPath, "utf8");
    expect(run("burn", a, "--as", "A", "hi").code).toBe(0);

    // Crash model: head.json regresses to a copy taken before the burn.
    writeFileSync(headPath, stale);

    const status = run("status", a);
    expect(status.code).toBe(2);
    expect(status.stderr).toContain("refused: regressed-below-mark");
    expect(status.stderr).toContain("older than its own history");
    // Nothing works around it: a burn on the regressed pair is the same refusal.
    const burn = run("burn", a, "--as", "A", "again");
    expect(burn.code).toBe(2);
    expect(burn.stderr).toContain("refused: regressed-below-mark");
  });

  it("a genuine v1 store is refused v1-store, pointing back at the v1 tool", () => {
    const a = join(dir, "a");
    const v1 = spawnSync(process.execPath, [V1_LAUNCHER, "gen", a, "--size", "10"], { encoding: "utf8" });
    expect(v1.status).toBe(0);
    for (const argv of [["status", a], ["burn", a, "--as", "A", "HELLO"], ["open", a, "--as", "B", "{}"]]) {
      const result = run(...argv);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("refused: v1-store");
      expect(result.stderr).toContain("pad.json");
      expect(result.stderr).toContain("truepad-pad");
    }
  });

  it("a half-pair (gen interrupted between halves) is refused by burn, open and status", () => {
    const a = join(dir, "a");
    expect(genPair(a, 16, 1).code).toBe(0);
    rmSync(join(a, "b-to-a"), { recursive: true, force: true });
    for (const argv of [["burn", a, "--as", "A", "HELLO"], ["open", a, "--as", "B", "{}"], ["status", a]]) {
      const result = run(...argv);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("refused: half-pair");
      expect(result.stderr).toContain("do not use the surviving half");
    }
    // The surviving half was never advanced.
    const head = JSON.parse(readFileSync(join(a, "a-to-b", "head.json"), "utf8"));
    expect(head.encryption.nextOffset).toBe(0);
    expect(existsSync(join(a, LOCK_FILE))).toBe(false);
  });

  it("gen refuses a short source with source-too-short, before writing anything", () => {
    const a = join(dir, "a");
    const short = join(dir, "short.bin");
    writeFileSync(short, randomBytes(100)); // E=64, N=8 requires 2*(64 + 256) = 640
    const gen = run("gen", a, "--source", short, "--encryption-bytes", "64", "--auth-records", "8");
    expect(gen.code).toBe(2);
    expect(gen.stderr).toContain("refused: source-too-short");
    expect(gen.stderr).toContain("640");
    expect(gen.stderr).toContain("Nothing was written");
    expect(existsSync(a)).toBe(false);
  });

  it("gen refuses one file declared as two sources — by realpath, so a symlink does not fool it", () => {
    const a = join(dir, "a");
    const source = sourceFile(2 * (16 + 32 * 4));
    const twice = run(
      "gen", a,
      "--source", source, "--source", source,
      "--encryption-bytes", "16", "--auth-records", "4"
    );
    expect(twice.code).toBe(1);
    expect(twice.stderr).toContain("one file is one source");
    expect(existsSync(a)).toBe(false);

    const link = join(dir, "alias.bin");
    symlinkSync(source, link);
    const aliased = run(
      "gen", a,
      "--source", source, "--source", link,
      "--encryption-bytes", "16", "--auth-records", "4"
    );
    expect(aliased.code).toBe(1);
    expect(aliased.stderr).toContain("one file is one source");
    expect(existsSync(a)).toBe(false);
  });

  it("status: exact meter shape, maxRemainingSends, and both LIMITED BY values", () => {
    // One auth record: 1 remaining record <= ceil(16 / 1048576) = 1, so even a
    // maximum-size send cannot spend the bytes first — AUTHENTICATION binds.
    const authBound = join(dir, "auth-bound");
    const genAuth = genPair(authBound, 16, 1);
    expect(genAuth.code).toBe(0);
    const pairIdAuth = JSON.parse(genAuth.stdout).pairId;
    const meters = (pairId: string, direction: string, records: number, limitedBy: string) => ({
      pairId,
      direction,
      encryption: { capacity: 16, nextOffset: 0, remainingBytes: 16 },
      authentication: { capacityRecords: records, nextSequence: 0, remainingRecords: records, contestedLive: 0 },
      verification: { failureCount: 0, clearedAtFailureCount: 0, frozen: false },
      maxRemainingSends: records,
      limitedBy
    });
    const authStatus = run("status", authBound);
    expect(authStatus.code).toBe(0);
    // toEqual, not toMatchObject: the machine line's shape is the contract.
    expect(JSON.parse(authStatus.stdout)).toEqual({
      "A->B": meters(pairIdAuth, "A->B", 1, "AUTHENTICATION"),
      "B->A": meters(pairIdAuth, "B->A", 1, "AUTHENTICATION")
    });
    expect(authStatus.stderr).toContain("CHANNEL CAPACITY LIMITED BY: AUTHENTICATION");
    expect(authStatus.stderr).toContain("maximum remaining sends 1");

    // Tiny encryption budget, many records: 6 records > ceil(16 / 1048576) = 1,
    // so the records outlast the bytes — ENCRYPTION binds.
    const encBound = join(dir, "enc-bound");
    const genEnc = genPair(encBound, 16, 6);
    expect(genEnc.code).toBe(0);
    const pairIdEnc = JSON.parse(genEnc.stdout).pairId;
    const encStatus = run("status", encBound);
    expect(encStatus.code).toBe(0);
    expect(JSON.parse(encStatus.stdout)).toEqual({
      "A->B": meters(pairIdEnc, "A->B", 6, "ENCRYPTION"),
      "B->A": meters(pairIdEnc, "B->A", 6, "ENCRYPTION")
    });
    expect(encStatus.stderr).toContain("CHANNEL CAPACITY LIMITED BY: ENCRYPTION");
  });
});

/* ============================================================================
 * open's release is the plaintext, byte-exact (§12.3 O6, §3 bytes-only):
 * no UTF-8 transcode, no appended newline. Asserted in buffer mode — a
 * string-mode comparison could not see either corruption.
 * ========================================================================= */

describe("open releases the plaintext byte-exact", () => {
  it("binary bytes round-trip exactly through burn --in / open --in", () => {
    const a = join(dir, "bin-a");
    const b = join(dir, "bin-b");
    const source = sourceFile(2 * (64 + 32 * 2));
    expect(run("gen", a, "--source", source, "--encryption-bytes", "64", "--auth-records", "2").code).toBe(0);
    cpSync(a, b, { recursive: true });
    const payload = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41, 0x42, 0xc3, 0x28, 0x0a, 0xf0]);
    const input = join(dir, "payload.bin");
    writeFileSync(input, payload);
    const burn = run("burn", a, "--as", "A", "--in", input);
    expect(burn.code).toBe(0);
    const envFile = join(dir, "env.json");
    writeFileSync(envFile, burn.stdout);
    const opened = spawnSync(process.execPath, [LAUNCHER, "open", b, "--as", "B", "--in", envFile]);
    expect(opened.status).toBe(0);
    expect(Buffer.compare(opened.stdout, payload)).toBe(0);
  });
});

/* ============================================================================
 * One file is one source, by device+inode: a hardlink is the same file under
 * a second name, and counting it twice would XOR the material to zeros.
 * ========================================================================= */

describe("gen refuses the same inode declared as two sources", () => {
  it("a hardlinked source is refused, and identical content under distinct inodes trips the all-zero tripwire", () => {
    const source = sourceFile(2 * (16 + 32 * 1));
    const hardlink = join(dir, "hardlink.bin");
    linkSync(source, hardlink);
    const linked = run(
      "gen", join(dir, "hl-pair"), "--source", source, "--source", hardlink,
      "--encryption-bytes", "16", "--auth-records", "1"
    );
    expect(linked.code).toBe(1);
    expect(linked.stderr).toContain("same device and inode");

    const copy = join(dir, "copy.bin");
    writeFileSync(copy, readFileSync(source));
    const cancelled = run(
      "gen", join(dir, "copy-pair"), "--source", source, "--source", copy,
      "--encryption-bytes", "16", "--auth-records", "1"
    );
    expect(cancelled.code).toBe(1);
    expect(cancelled.stderr).toContain("all zeros");
    expect(existsSync(join(dir, "copy-pair", "a-to-b", "head.json"))).toBe(false);
  });
});
