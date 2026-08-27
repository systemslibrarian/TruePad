import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/* ============================================================================
 * truepad2 rollback witness end to end (FORMAT-V2.md §15, §9.4; ledger
 * N15–N18). The real binary via the launcher, the courier model of
 * truepad2-cli.test.ts, tiny budgets.
 *
 * Each peer keeps its OWN witness file on its OWN host (§15.2). On one test
 * filesystem that means one witness file per copy: gen bakes one path into
 * both headers, so after the courier copy the receiving copy's headers are
 * repointed at a second path — exactly the "same path string, different
 * physical file on a different host" that the real deployment relies on.
 *
 * The payoff (§9.4): a store restored below its witness refuses
 * witness-regressed before anything is consumed — both the whole-directory
 * restore and the both-state-files partial restore the load-time mark check
 * cannot see.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const LAUNCHER = join(ROOT, "bin", "truepad2.mjs");

let dir: string;
let sourceCount = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-witness-"));
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

function genWitnessed(pair: string, e: number, n: number, witnessPath: string): { code: number; stdout: string; stderr: string } {
  const source = sourceFile(2 * (e + 32 * n));
  return run(
    "gen", pair,
    "--source", source,
    "--encryption-bytes", String(e),
    "--auth-records", String(n),
    "--witness-class", "separate-state-file",
    "--witness-path", witnessPath
  );
}

// A witness file the operator provisions before first use: empty, so it
// accepts a fresh pair (§15.2 — protection begins at the first witnessed
// commit).
function emptyWitness(path: string): void {
  writeFileSync(path, JSON.stringify({ formatVersion: 2, witness: {} }));
}

function readWitness(path: string): { formatVersion: number; witness: Record<string, { encryptionNextOffset: number; authenticationNextSequence: number }> } {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Repoint one copy's header at a host-local witness path (headers are compact
// JSON, exactly as store2 writes them; only rollback.config.path changes, so
// the counters and the journal high-water are untouched).
function repointWitness(headPath: string, newPath: string): void {
  const head = JSON.parse(readFileSync(headPath, "utf8"));
  head.rollback = { witnessClass: "separate-state-file", config: { path: newPath } };
  writeFileSync(headPath, JSON.stringify(head));
}

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("rollback witness end to end", { timeout: 120_000 }, () => {
  it("gen writes head.rollback; burn and open advance each peer's own witness file", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    const wa = join(dir, "wa.json");
    const wb = join(dir, "wb.json");

    const gen = genWitnessed(a, 64, 8, wa);
    expect(gen.code).toBe(0);
    const pairId = JSON.parse(gen.stdout).pairId as string;
    const key = `${pairId}/A->B`;

    // head.rollback carries the class and the verbatim absolute path.
    const headAB = JSON.parse(readFileSync(join(a, "a-to-b", "head.json"), "utf8"));
    expect(headAB.rollback).toEqual({ witnessClass: "separate-state-file", config: { path: wa } });

    emptyWitness(wa);
    cpSync(a, b, { recursive: true });
    repointWitness(join(b, "a-to-b", "head.json"), wb);
    repointWitness(join(b, "b-to-a", "head.json"), wb);
    emptyWitness(wb);

    const burn = run("burn", a, "--as", "A", "attack at dawn"); // 14 bytes, seq 0
    expect(burn.code).toBe(0);
    // A's witness advanced to the new high-water.
    expect(readWitness(wa).witness[key]).toEqual({ encryptionNextOffset: 14, authenticationNextSequence: 1 });

    const opened = run("open", b, "--as", "B", burn.stdout.trim());
    expect(opened.code).toBe(0);
    expect(opened.stdout.trim()).toBe("attack at dawn");
    // B's own witness advanced independently, to the same position on B's copy.
    expect(readWitness(wb).witness[key]).toEqual({ encryptionNextOffset: 14, authenticationNextSequence: 1 });
  });

  it("§9.4 (a) whole-directory restore below the witness is refused witness-regressed, nothing consumed", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    const wa = join(dir, "wa.json");
    const wb = join(dir, "wb.json");
    expect(genWitnessed(a, 64, 8, wa).code).toBe(0);
    emptyWitness(wa);
    cpSync(a, b, { recursive: true });
    repointWitness(join(b, "a-to-b", "head.json"), wb);
    repointWitness(join(b, "b-to-a", "head.json"), wb);
    emptyWitness(wb);

    const e0 = run("burn", a, "--as", "A", "one").stdout.trim();
    const e1 = run("burn", a, "--as", "A", "two").stdout.trim();

    // Snapshot B's whole pair dir while fresh (the witness lives OUTSIDE it).
    const snap = join(dir, "snap");
    cpSync(b, snap, { recursive: true });

    // B opens one envelope — the witness (wb) records the advance.
    expect(run("open", b, "--as", "B", e0).code).toBe(0);

    // Restore the whole snapshot over B: head.json + journal.log regress
    // together, exactly the §9.4 case the load-time mark check cannot catch.
    rmSync(b, { recursive: true, force: true });
    cpSync(snap, b, { recursive: true });

    const journalBefore = readFileSync(join(b, "a-to-b", "journal.log"));
    const attempt = run("open", b, "--as", "B", e1);
    expect(attempt.code).toBe(2);
    expect(attempt.stderr).toContain("refused: witness-regressed");
    expect(attempt.stderr).toContain("restored-store signature");
    expect(attempt.stdout).toBe("");
    // Nothing consumed: the journal is byte-identical to the restored snapshot.
    expect(readFileSync(join(b, "a-to-b", "journal.log")).equals(journalBefore)).toBe(true);
  });

  it("§9.4 (b) mismatched restore of head.json+journal.log (secret.bin kept) is refused before any verification", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    const wa = join(dir, "wa.json");
    const wb = join(dir, "wb.json");
    expect(genWitnessed(a, 64, 8, wa).code).toBe(0);
    emptyWitness(wa);
    cpSync(a, b, { recursive: true });
    repointWitness(join(b, "a-to-b", "head.json"), wb);
    repointWitness(join(b, "b-to-a", "head.json"), wb);
    emptyWitness(wb);

    const e0 = run("burn", a, "--as", "A", "one").stdout.trim();
    const e1 = run("burn", a, "--as", "A", "two").stdout.trim();

    // Snapshot only the two state files of the receiving direction, while fresh.
    const headSnap = readFileSync(join(b, "a-to-b", "head.json"));
    const journalSnap = readFileSync(join(b, "a-to-b", "journal.log"));

    expect(run("open", b, "--as", "B", e0).code).toBe(0);

    // Restore ONLY head.json + journal.log; keep the (never-changing) secret.bin.
    writeFileSync(join(b, "a-to-b", "head.json"), headSnap);
    writeFileSync(join(b, "a-to-b", "journal.log"), journalSnap);

    const attempt = run("open", b, "--as", "B", e1);
    expect(attempt.code).toBe(2);
    expect(attempt.stderr).toContain("refused: witness-regressed");
    // Before any verification: no attempt line was appended (journal identical).
    expect(readFileSync(join(b, "a-to-b", "journal.log")).equals(journalSnap)).toBe(true);
  });

  it("an unreachable witness (file renamed away) fails closed: burn refused witness-unreachable, nothing consumed", () => {
    const a = join(dir, "a");
    const wa = join(dir, "wa.json");
    expect(genWitnessed(a, 64, 8, wa).code).toBe(0);
    emptyWitness(wa);
    expect(run("burn", a, "--as", "A", "one").code).toBe(0);

    const moved = join(dir, "wa.moved.json");
    renameSync(wa, moved);
    const journalBefore = readFileSync(join(a, "a-to-b", "journal.log"));
    const burn = run("burn", a, "--as", "A", "two");
    expect(burn.code).toBe(2);
    expect(burn.stderr).toContain("refused: witness-unreachable");
    expect(burn.stdout).toBe("");
    expect(readFileSync(join(a, "a-to-b", "journal.log")).equals(journalBefore)).toBe(true);

    // Restore the name — the channel moves again.
    renameSync(moved, wa);
    expect(run("burn", a, "--as", "A", "three").code).toBe(0);
  });

  it("a malformed or mis-shaped witness file is refused witness-inconsistent", () => {
    const a = join(dir, "a");
    const wa = join(dir, "wa.json");
    expect(genWitnessed(a, 64, 8, wa).code).toBe(0);

    writeFileSync(wa, "{ not json at all");
    const garbage = run("burn", a, "--as", "A", "hi");
    expect(garbage.code).toBe(2);
    expect(garbage.stderr).toContain("refused: witness-inconsistent");

    // Parses, but violates the §15.2 shape (a negative counter).
    writeFileSync(wa, JSON.stringify({ formatVersion: 2, witness: { x: { encryptionNextOffset: -1, authenticationNextSequence: 0 } } }));
    const misshaped = run("burn", a, "--as", "A", "hi");
    expect(misshaped.code).toBe(2);
    expect(misshaped.stderr).toContain("refused: witness-inconsistent");
  });

  it("a witness that cannot be advanced loses the record (exit 1, no output, store advanced), then re-aligns", () => {
    if (asRoot) {
      return; // root ignores the directory write bit; the denial cannot be staged
    }
    const a = join(dir, "a");
    const wdir = join(dir, "wdir");
    mkdirSync(wdir);
    const wa = join(wdir, "w.json");
    const gen = genWitnessed(a, 64, 8, wa);
    expect(gen.code).toBe(0);
    const pairId = JSON.parse(gen.stdout).pairId as string;
    const key = `${pairId}/A->B`;
    emptyWitness(wa);

    // Read passes (the empty file is readable); the atomic-replace WRITE cannot
    // create its temp file in a read/execute-only directory.
    chmodSync(wdir, 0o500);
    const burn1 = run("burn", a, "--as", "A", "one");
    chmodSync(wdir, 0o700); // restore before asserting, so cleanup always works

    expect(burn1.code).toBe(1);
    expect(burn1.stdout).toBe("");
    expect(burn1.stderr).toContain("already retired and is LOST");
    expect(burn1.stderr).toContain("withheld");

    // The store's high-waters advanced (the commit ran before the witness
    // write): the material is spent and lost.
    const status1 = JSON.parse(run("status", a).stdout);
    expect(status1["A->B"].authentication.nextSequence).toBe(1);

    // With the directory writable again, the next burn succeeds and re-aligns
    // the witness to the store's current high-water.
    const burn2 = run("burn", a, "--as", "A", "two");
    expect(burn2.code).toBe(0);
    expect(readWitness(wa).witness[key].authenticationNextSequence).toBe(2);
  });

  it("gen --witness-class platform-monotonic is refused witness-unsupported, nothing written", () => {
    const a = join(dir, "a");
    const source = sourceFile(2 * (16 + 32 * 1));
    const gen = run(
      "gen", a,
      "--source", source,
      "--encryption-bytes", "16",
      "--auth-records", "1",
      "--witness-class", "platform-monotonic",
      "--witness-path", "/tmp/does-not-matter.json"
    );
    expect(gen.code).toBe(2);
    expect(gen.stderr).toContain("refused: witness-unsupported");
    expect(existsSync(a)).toBe(false);

    // One flag without the other is a usage error (exit 1); a relative path is too.
    const lonely = run(
      "gen", a,
      "--source", sourceFile(2 * (16 + 32 * 1)),
      "--encryption-bytes", "16", "--auth-records", "1",
      "--witness-class", "separate-state-file"
    );
    expect(lonely.code).toBe(1);
    expect(lonely.stderr).toContain("must be given together");

    const relative = run(
      "gen", a,
      "--source", sourceFile(2 * (16 + 32 * 1)),
      "--encryption-bytes", "16", "--auth-records", "1",
      "--witness-class", "separate-state-file", "--witness-path", "relative/w.json"
    );
    expect(relative.code).toBe(1);
    expect(relative.stderr).toContain("must be an absolute path");
  });

  it("status reports the witness block per direction and refuses nothing when the witness is gone", () => {
    const a = join(dir, "a");
    const wa = join(dir, "wa.json");
    expect(genWitnessed(a, 16, 2, wa).code).toBe(0);
    emptyWitness(wa);

    // Fresh witness (no entry yet).
    const fresh = run("status", a);
    expect(fresh.code).toBe(0);
    expect(JSON.parse(fresh.stdout)["A->B"].witness).toMatchObject({
      witnessClass: "separate-state-file",
      reachable: true,
      counters: null,
      comparison: "fresh"
    });

    // After a burn the sending store aligns with its witness.
    expect(run("burn", a, "--as", "A", "hi").code).toBe(0);
    const aligned = JSON.parse(run("status", a).stdout);
    expect(aligned["A->B"].witness).toMatchObject({ witnessClass: "separate-state-file", reachable: true, comparison: "aligned" });

    // Remove the witness: status reports it unreachable but still exits 0.
    renameSync(wa, join(dir, "wa.gone.json"));
    const gone = run("status", a);
    expect(gone.code).toBe(0);
    expect(JSON.parse(gone.stdout)["A->B"].witness).toMatchObject({ witnessClass: "separate-state-file", reachable: false });
    expect(gone.stderr).toContain("WITNESS UNREACHABLE");
  });
});
