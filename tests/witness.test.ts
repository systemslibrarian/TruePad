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

function readWitness(path: string): {
  formatVersion: number;
  witness: Record<string, { encryptionNextOffset: number; authenticationNextSequence: number; attemptsReserved: number }>;
} {
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
    // A's witness advanced to the new high-water; a burn reserves no attempt.
    expect(readWitness(wa).witness[key]).toEqual({
      encryptionNextOffset: 14,
      authenticationNextSequence: 1,
      attemptsReserved: 0
    });

    const opened = run("open", b, "--as", "B", burn.stdout.trim());
    expect(opened.code).toBe(0);
    expect(opened.stdout.trim()).toBe("attack at dawn");
    // B's own witness advanced independently; the successful open reserved one
    // attempt (recorded at O3), so B's attemptsReserved is 1.
    expect(readWitness(wb).witness[key]).toEqual({
      encryptionNextOffset: 14,
      authenticationNextSequence: 1,
      attemptsReserved: 1
    });
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

  it("§15.1/§5.3 attempt-budget rollback: restoring the pair to refill a contested record's guesses is refused witness-regressed", () => {
    // The attack the high-water witness alone missed: failed authentications
    // reserve attempts WITHOUT moving the high-waters, so a witness recording
    // only the high-waters would not notice a restore that resets
    // perSequenceAttempts. attemptsReserved closes it.
    const a = join(dir, "a");
    const wit = join(dir, "wit.json");
    // verify-attempt-limit 2 so the record contests after two guesses.
    const source = sourceFile(2 * (64 + 32 * 8));
    expect(
      run(
        "gen", a, "--source", source, "--encryption-bytes", "64", "--auth-records", "8",
        "--verify-attempt-limit", "2",
        "--witness-class", "separate-state-file", "--witness-path", wit
      ).code
    ).toBe(0);
    emptyWitness(wit);
    const pairId = JSON.parse(readFileSync(join(a, "a-to-b", "head.json"), "utf8")).pairId as string;
    const forge = JSON.stringify({
      formatVersion: 2, pairId, direction: "A->B", sequence: 0, startOffset: 0,
      ciphertextLength: 4, ciphertext: "deadbeef", tag: "0".repeat(32)
    });

    // Back up the PAIR ONLY — the witness stays in its separate domain.
    const backup = join(dir, "backup");
    cpSync(a, backup, { recursive: true });

    // Round 1: exhaust the 2 attempts on sequence 0; the record contests.
    expect(run("open", a, "--as", "B", forge).stderr).toContain("refused: auth-failed");
    expect(run("open", a, "--as", "B", forge).stderr).toContain("refused: auth-failed");
    expect(run("open", a, "--as", "B", forge).stderr).toContain("refused: sequence-contested");
    // The witness recorded the two reservations.
    expect(readWitness(wit).witness[`${pairId}/A->B`].attemptsReserved).toBe(2);

    // Restore the pair only; the witness (still recording attemptsReserved=2) is untouched.
    rmSync(a, { recursive: true, force: true });
    cpSync(backup, a, { recursive: true });

    // Round 2: every attempt is refused witness-regressed — no fresh guesses.
    for (let i = 0; i < 3; i += 1) {
      const attempt = run("open", a, "--as", "B", forge);
      expect(attempt.code).toBe(2);
      expect(attempt.stderr).toContain("refused: witness-regressed");
      expect(attempt.stderr).toContain("attempt budget");
    }
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

  it("a present-but-empty witness file is the fresh-witness bootstrap, not inconsistent", () => {
    // The ceremony tells the operator to provision an EMPTY witness file; a
    // literal `touch` (0 bytes) — and a whitespace-only file — must accept a
    // fresh pair and record the first commit, not fail witness-inconsistent.
    const a = join(dir, "a");
    const wa = join(dir, "wa.json");
    expect(genWitnessed(a, 64, 8, wa).code).toBe(0);
    writeFileSync(wa, ""); // 0-byte, as `touch` leaves it
    const first = run("burn", a, "--as", "A", "hello");
    expect(first.code).toBe(0);
    // The witness now carries this pair's first entry.
    expect(Object.keys(readWitness(wa).witness)).toHaveLength(1);

    // Whitespace-only is treated the same way.
    const a2 = join(dir, "a2");
    const wa2 = join(dir, "wa2.json");
    expect(genWitnessed(a2, 64, 8, wa2).code).toBe(0);
    writeFileSync(wa2, "  \n");
    expect(run("burn", a2, "--as", "A", "hello").code).toBe(0);
  });

  it("the witness entry shape is FROZEN as exactly three counters, all required (§15.2)", () => {
    const a = join(dir, "a");
    const wa = join(dir, "wa.json");
    const gen = genWitnessed(a, 64, 8, wa);
    expect(gen.code).toBe(0);
    const pairId = JSON.parse(gen.stdout).pairId as string;
    const key = `${pairId}/A->B`;
    const entry = (e: Record<string, unknown>): string => JSON.stringify({ formatVersion: 2, witness: { [key]: e } });
    const valid = { encryptionNextOffset: 0, authenticationNextSequence: 0, attemptsReserved: 0 };

    // Valid exact three-counter entry: a burn proceeds.
    writeFileSync(wa, entry(valid));
    expect(run("burn", a, "--as", "A", "ok").code).toBe(0);

    // Every malformed entry fails closed as witness-inconsistent, nothing consumed.
    const bad: Record<string, unknown>[] = [
      { encryptionNextOffset: 0, authenticationNextSequence: 0 }, // missing attemptsReserved (the old two-counter form)
      { authenticationNextSequence: 0, attemptsReserved: 0 }, // missing a high-water
      { encryptionNextOffset: 0, attemptsReserved: 0 }, // missing the other high-water
      { ...valid, extra: 1 }, // extra field
      { ...valid, attemptsReserved: -1 }, // negative
      { ...valid, attemptsReserved: 1.5 } // non-integer
    ];
    for (const e of bad) {
      writeFileSync(wa, entry(e));
      const journalBefore = readFileSync(join(a, "a-to-b", "journal.log"));
      const r = run("burn", a, "--as", "A", "x");
      expect(r.code, JSON.stringify(e)).toBe(2);
      expect(r.stderr, JSON.stringify(e)).toContain("refused: witness-inconsistent");
      expect(readFileSync(join(a, "a-to-b", "journal.log")).equals(journalBefore)).toBe(true);
    }

    // A valid witness object with no entry for this pair yet is the fresh
    // bootstrap — accepted, not inconsistent.
    writeFileSync(wa, JSON.stringify({ formatVersion: 2, witness: {} }));
    expect(run("burn", a, "--as", "A", "fresh").code).toBe(0);
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

  it("a witness whose medium is unwritable refuses FREE at preflight (no record lost), and re-aligns when writable", () => {
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
    // Advance once so the witness carries an entry, then make its medium
    // read-only: the file still READS, but the atomic-replace advance needs a
    // writable directory. The §15.3 writability probe must catch this at
    // preflight — a free refusal, NOT a per-operation record loss.
    expect(run("burn", a, "--as", "A", "zero").code).toBe(0);

    chmodSync(wdir, 0o500);
    const before = JSON.parse(run("status", a).stdout)["A->B"].authentication.nextSequence;
    const burn1 = run("burn", a, "--as", "A", "one");
    const burn2 = run("burn", a, "--as", "A", "two");
    chmodSync(wdir, 0o700); // restore before asserting, so cleanup always works

    // Both refuse free (witness-unreachable), nothing consumed — the store's
    // high-water did not move, so no record was lost per operation.
    for (const burn of [burn1, burn2]) {
      expect(burn.code).toBe(2);
      expect(burn.stdout).toBe("");
      expect(burn.stderr).toContain("refused: witness-unreachable");
    }
    const after = JSON.parse(run("status", a).stdout)["A->B"].authentication.nextSequence;
    expect(after).toBe(before);

    // With the directory writable again, sending resumes and the witness advances.
    const burn3 = run("burn", a, "--as", "A", "three");
    expect(burn3.code).toBe(0);
    expect(readWitness(wa).witness[key].authenticationNextSequence).toBe(before + 1);
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

  it("gen --witness-class remote-monotonic is also refused witness-unsupported (N18, the other unimplemented class)", () => {
    const a = join(dir, "a");
    const gen = run(
      "gen", a,
      "--source", sourceFile(2 * (16 + 32 * 1)),
      "--encryption-bytes", "16", "--auth-records", "1",
      "--witness-class", "remote-monotonic", "--witness-path", "/tmp/does-not-matter.json"
    );
    expect(gen.code).toBe(2);
    expect(gen.stderr).toContain("refused: witness-unsupported");
    expect(existsSync(a)).toBe(false);
  });

  it("a store whose header already names platform/remote monotonic is refused witness-unsupported at LOAD (N18, the at-load cell)", () => {
    // Header-injection: a store whose rollback.witnessClass was set to an
    // unimplemented class must be refused by burn/open/status, not silently
    // treated as none. loadStore2 accepts the shape; the verb preflight refuses.
    for (const cls of ["platform-monotonic", "remote-monotonic"] as const) {
      const a = join(dir, `load-${cls}`);
      const source = sourceFile(2 * (16 + 32 * 2));
      expect(run("gen", a, "--source", source, "--encryption-bytes", "16", "--auth-records", "2").code).toBe(0);
      for (const half of ["a-to-b", "b-to-a"]) {
        const hp = join(a, half, "head.json");
        const head = JSON.parse(readFileSync(hp, "utf8"));
        head.rollback = { witnessClass: cls, config: {} };
        writeFileSync(hp, JSON.stringify(head));
      }
      const journalBefore = readFileSync(join(a, "a-to-b", "journal.log"), "utf8");
      const burn = run("burn", a, "--as", "A", "hi");
      expect(burn.code).toBe(2);
      expect(burn.stderr).toContain("refused: witness-unsupported");
      // Free refusal: no durable write.
      expect(readFileSync(join(a, "a-to-b", "journal.log"), "utf8")).toBe(journalBefore);
    }
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
