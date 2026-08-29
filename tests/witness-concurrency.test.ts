import { spawnSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireWitnessLock, advanceWitness, witnessLockPath, WitnessLockError } from "../src/cli/v2/witness";
import type { WitnessCounters } from "../src/cli/v2/witness";

/* ============================================================================
 * truepad2 rollback witness — SHARED-FILE CONCURRENCY (FORMAT-V2.md §10.3, §15)
 * ----------------------------------------------------------------------------
 * One witness file may record several pairs (§15.2), and each pair has its own
 * pad lock — so two pairs advancing at once take two DIFFERENT pad locks and
 * nothing serialises the shared file. Atomic replace stops a torn file; it does
 * not stop a LOST UPDATE:
 *
 *   witness {A:10, B:20}
 *   P1 (pair A) reads {A:10,B:20} -> computes {A:11,B:20}
 *   P2 (pair B) reads {A:10,B:20} -> computes {A:10,B:21}
 *   P1 writes; P2 writes  ->  {A:10, B:21}   A REGRESSED 11 -> 10
 *
 * The elementwise max is applied only to the key being advanced; every other
 * pair's entry rides along from a snapshot that may already be stale. A
 * regressed witness is precisely what §9.4/§15.3 exist to refuse, so this is a
 * correctness defect.
 *
 * These specs are DETERMINISTIC, not "spawn many and hope". `advanceWitness`
 * honours a test-only `TRUEPAD_TEST_WITNESS_HOLD_MS`, which pauses inside the
 * read-modify-write with the snapshot in hand. Starting a second process during
 * that hold GUARANTEES the two transactions overlap. Unserialised, the lost
 * update reproduces every run; serialised, the second blocks on the witness
 * lock, reads the first's result, and both maxima survive. Delete the lock and
 * these fail — they are the regression test for the defect, not a smoke test.
 *
 * THE INVARIANT, stated once: for one witness authority, no successful update
 * may cause ANY existing counter for ANY pair or direction to decrease or
 * disappear — for all three counters.
 * ========================================================================= */

const ROOT = resolve(__dirname, "..");
const ADVANCE = join(ROOT, "tests", "helpers", "advance-witness.mjs");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "truepad2-witness-race-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PAIR_A = "a".repeat(32);
const PAIR_B = "b".repeat(32);

type Entry = { encryptionNextOffset: number; authenticationNextSequence: number; attemptsReserved: number };
type File = { formatVersion: 2; witness: Record<string, Entry> };

const flat = (n: number): Entry => ({
  encryptionNextOffset: n,
  authenticationNextSequence: n,
  attemptsReserved: n
});

function writeWitness(path: string, witness: Record<string, Entry>): void {
  writeFileSync(path, JSON.stringify({ formatVersion: 2, witness } satisfies File));
}
function readWitness(path: string): File {
  return JSON.parse(readFileSync(path, "utf8"));
}

// One out-of-process advance through the REAL advanceWitness. `holdMs` pauses
// inside the read-modify-write, after the read.
function advanceInProcess(
  path: string,
  pairId: string,
  direction: string,
  counters: Entry,
  holdMs = 0
): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      ADVANCE,
      path,
      pairId,
      direction,
      String(counters.encryptionNextOffset),
      String(counters.authenticationNextSequence),
      String(counters.attemptsReserved)
    ],
    { env: { ...process.env, TRUEPAD_TEST_WITNESS_HOLD_MS: holdMs > 0 ? String(holdMs) : "" }, stdio: "pipe" }
  );
}

function settled(child: ReturnType<typeof spawn>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveP) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolveP({ code: code ?? -1, stderr }));
  });
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The hold is long enough that a second process launched mid-hold is certainly
// inside the same transaction window; the lock's own wait bound is longer still,
// so an honest peer waits rather than refusing.
const HOLD_MS = 2000;
const OVERLAP_MS = 400;

/* ==========================================================================
 * 1-2. Two pairs, and two directions, sharing one witness file.
 * ======================================================================== */

describe("shared witness: concurrent advances never lose an update", { timeout: 60_000 }, () => {
  it("(1) two PAIRS advancing at once both survive — the lost update is closed", async () => {
    const path = join(dir, "witness.json");
    writeWitness(path, { [`${PAIR_A}/A->B`]: flat(10), [`${PAIR_B}/A->B`]: flat(20) });

    // P1 reads {A:10,B:20} and holds. P2 starts inside that window: without the
    // witness lock it would read the same snapshot and its write would erase
    // A's advance.
    const p1 = advanceInProcess(path, PAIR_A, "A->B", flat(11), HOLD_MS);
    await wait(OVERLAP_MS);
    const p2 = advanceInProcess(path, PAIR_B, "A->B", flat(21));

    const [r1, r2] = await Promise.all([settled(p1), settled(p2)]);
    expect(r1.code, r1.stderr).toBe(0);
    expect(r2.code, r2.stderr).toBe(0);

    const after = readWitness(path).witness;
    // BOTH maxima committed — the elementwise maximum of every successful advance.
    expect(after[`${PAIR_A}/A->B`]).toEqual(flat(11));
    expect(after[`${PAIR_B}/A->B`]).toEqual(flat(21));
  });

  it("(2) two DIRECTIONS of one pair, from two copies, both survive", async () => {
    // The real shape of this: two couriered copies of one pair on one host,
    // each advancing its own direction into the witness they share.
    const path = join(dir, "witness.json");
    writeWitness(path, { [`${PAIR_A}/A->B`]: flat(5), [`${PAIR_A}/B->A`]: flat(7) });

    const p1 = advanceInProcess(path, PAIR_A, "A->B", flat(6), HOLD_MS);
    await wait(OVERLAP_MS);
    const p2 = advanceInProcess(path, PAIR_A, "B->A", flat(9));

    const [r1, r2] = await Promise.all([settled(p1), settled(p2)]);
    expect(r1.code, r1.stderr).toBe(0);
    expect(r2.code, r2.stderr).toBe(0);

    const after = readWitness(path).witness;
    expect(after[`${PAIR_A}/A->B`]).toEqual(flat(6));
    expect(after[`${PAIR_A}/B->A`]).toEqual(flat(9));
  });

  it("(3, 4, 5, 6) repeated concurrent advances: nothing disappears, nothing decreases", async () => {
    const path = join(dir, "witness.json");
    const keys = [`${PAIR_A}/A->B`, `${PAIR_A}/B->A`, `${PAIR_B}/A->B`, `${PAIR_B}/B->A`];
    const start: Record<string, Entry> = {};
    for (const k of keys) start[k] = flat(100);
    writeWitness(path, start);

    for (let round = 1; round <= 3; round += 1) {
      const target = 100 + round;
      // Every key advances by one, all at once, with one holder per round so the
      // transactions certainly overlap.
      const children = keys.map((k, i) => {
        const [pairId, direction] = k.split("/");
        return advanceInProcess(path, pairId, direction, flat(target), i === 0 ? HOLD_MS : 0);
      });
      const results = await Promise.all(children.map(settled));
      for (const r of results) expect(r.code, r.stderr).toBe(0);

      const after = readWitness(path).witness;
      // (4) no entry disappeared.
      expect(Object.keys(after).sort()).toEqual([...keys].sort());
      for (const k of keys) {
        // (5) no counter decreased, and (6) attemptsReserved in particular —
        // the counter that bounds a contested record's guesses (§15.1/§5.3).
        expect(after[k], `${k} after round ${round}`).toEqual(flat(target));
        expect(after[k].attemptsReserved).toBeGreaterThanOrEqual(100);
      }
    }
  });

  it("a lower advance never lowers a recorded counter (monotone under concurrency)", async () => {
    const path = join(dir, "witness.json");
    writeWitness(path, { [`${PAIR_A}/A->B`]: flat(50), [`${PAIR_B}/A->B`]: flat(50) });

    // A stale/replayed advance for A, concurrent with a forward advance for B.
    const p1 = advanceInProcess(path, PAIR_A, "A->B", flat(9), HOLD_MS);
    await wait(OVERLAP_MS);
    const p2 = advanceInProcess(path, PAIR_B, "A->B", flat(51));

    const [r1, r2] = await Promise.all([settled(p1), settled(p2)]);
    expect(r1.code, r1.stderr).toBe(0);
    expect(r2.code, r2.stderr).toBe(0);

    const after = readWitness(path).witness;
    expect(after[`${PAIR_A}/A->B`]).toEqual(flat(50)); // elementwise max held
    expect(after[`${PAIR_B}/A->B`]).toEqual(flat(51));
  });

  // The property the whole phase is about, over arbitrary forward advances.
  it("property: the committed state is at least the componentwise maximum of every successful advance", async () => {
    const path = join(dir, "witness.json");
    const keys = [`${PAIR_A}/A->B`, `${PAIR_B}/A->B`, `${PAIR_B}/B->A`];
    const base: Record<string, Entry> = {
      [keys[0]]: { encryptionNextOffset: 3, authenticationNextSequence: 1, attemptsReserved: 4 },
      [keys[1]]: { encryptionNextOffset: 1, authenticationNextSequence: 5, attemptsReserved: 9 },
      [keys[2]]: { encryptionNextOffset: 2, authenticationNextSequence: 6, attemptsReserved: 5 }
    };
    writeWitness(path, base);

    // Arbitrary-looking but fixed forward advances, each ≥ its base, applied
    // concurrently and out of order.
    const advances: { key: string; counters: Entry }[] = [
      { key: keys[0], counters: { encryptionNextOffset: 35, authenticationNextSequence: 8, attemptsReserved: 9 } },
      { key: keys[1], counters: { encryptionNextOffset: 8, authenticationNextSequence: 97, attemptsReserved: 9 } },
      { key: keys[2], counters: { encryptionNextOffset: 32, authenticationNextSequence: 38, attemptsReserved: 46 } },
      { key: keys[0], counters: { encryptionNextOffset: 26, authenticationNextSequence: 43, attemptsReserved: 38 } },
      { key: keys[1], counters: { encryptionNextOffset: 27, authenticationNextSequence: 9, attemptsReserved: 50 } }
    ];

    const children = advances.map((a, i) => {
      const [pairId, direction] = a.key.split("/");
      return advanceInProcess(path, pairId, direction, a.counters, i === 0 ? HOLD_MS : 0);
    });
    const results = await Promise.all(children.map(settled));
    for (const r of results) expect(r.code, r.stderr).toBe(0);

    // Expected = componentwise max of the base and every advance for that key.
    const expected: Record<string, Entry> = { ...base };
    for (const a of advances) {
      const prev = expected[a.key];
      expected[a.key] = {
        encryptionNextOffset: Math.max(prev.encryptionNextOffset, a.counters.encryptionNextOffset),
        authenticationNextSequence: Math.max(prev.authenticationNextSequence, a.counters.authenticationNextSequence),
        attemptsReserved: Math.max(prev.attemptsReserved, a.counters.attemptsReserved)
      };
    }
    expect(readWitness(path).witness).toEqual(expected);
  });
});

/* ==========================================================================
 * 7-11. Fail-closed: the lock, and what must never become a fresh witness.
 * ======================================================================== */

describe("witness lock and fail-closed discipline", () => {
  const counters: WitnessCounters = flat(1);

  it("(10) a stale witness lock fails closed — no pid-liveness guessing", () => {
    const path = join(dir, "witness.json");
    writeWitness(path, { [`${PAIR_A}/A->B`]: flat(1) });
    // A leftover from a SIGKILLed process: a lock file naming a pid, and no
    // process holding it. The implementation must NOT decide the pid is dead.
    writeFileSync(witnessLockPath(path), "pid 999999 since 2020-01-01T00:00:00.000Z");

    let thrown: unknown;
    try {
      advanceWitness(path, PAIR_B, "A->B", counters);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WitnessLockError);
    expect((thrown as WitnessLockError).reason).toBe("witness-locked");
    expect((thrown as WitnessLockError).message).toContain("pid 999999");
    // It names the file to remove, and says why it will not guess.
    expect((thrown as WitnessLockError).message).toContain(witnessLockPath(path));
    expect((thrown as WitnessLockError).message).toMatch(/pids are reused/);
    // Nothing was written: the other pair's record is untouched.
    expect(readWitness(path).witness).toEqual({ [`${PAIR_A}/A->B`]: flat(1) });
  }, 30_000);

  it("(11) clearing the stale lock restores operation", () => {
    const path = join(dir, "witness.json");
    writeWitness(path, { [`${PAIR_A}/A->B`]: flat(1) });
    const lock = witnessLockPath(path);
    writeFileSync(lock, "pid 999999 since 2020-01-01T00:00:00.000Z");
    expect(() => advanceWitness(path, PAIR_B, "A->B", counters)).toThrow();

    // The operator confirms nothing holds the witness and removes the file.
    rmSync(lock);
    advanceWitness(path, PAIR_B, "A->B", flat(2));
    expect(readWitness(path).witness[`${PAIR_B}/A->B`]).toEqual(flat(2));
    // ...and the lock did not survive the successful advance.
    expect(existsSync(lock)).toBe(false);
  }, 30_000);

  it("the lock is released after a successful advance and after a failed one", () => {
    const path = join(dir, "witness.json");
    writeWitness(path, {});
    const lock = witnessLockPath(path);

    advanceWitness(path, PAIR_A, "A->B", counters);
    expect(existsSync(lock)).toBe(false);

    // A malformed witness makes the advance throw; the lock must still go.
    writeFileSync(path, "{ not json");
    expect(() => advanceWitness(path, PAIR_A, "A->B", counters)).toThrow(/inconsistent|JSON/i);
    expect(existsSync(lock)).toBe(false);
  });

  it("(7) a malformed witness still fails closed at advance, and is not overwritten", () => {
    const path = join(dir, "witness.json");
    writeFileSync(path, JSON.stringify({ formatVersion: 2, witness: { bad: { encryptionNextOffset: -1 } } }));
    expect(() => advanceWitness(path, PAIR_A, "A->B", counters)).toThrow();
    // Refusing to advance over it means refusing to REPLACE it.
    expect(readFileSync(path, "utf8")).toContain('"bad"');
  });

  it("(8) a witness that VANISHED between preflight and advance is never recreated", () => {
    // Recreating it would silently erase every other pair's high-water — the
    // same regression the lock exists to prevent, dressed as a bootstrap.
    // §15.2's fresh witness is one the operator PROVISIONED, never one that
    // disappeared.
    const path = join(dir, "gone.json");
    expect(() => advanceWitness(path, PAIR_A, "A->B", counters)).toThrow(/no longer exists|NOT recreated/);
    expect(existsSync(path)).toBe(false);
  });

  it("the present-but-empty bootstrap witness still works, and is not broadened", () => {
    // The one path that may start a fresh witness: a file the operator made.
    const path = join(dir, "empty.json");
    writeFileSync(path, "");
    advanceWitness(path, PAIR_A, "A->B", flat(3));
    expect(readWitness(path).witness).toEqual({ [`${PAIR_A}/A->B`]: flat(3) });
  });
});

/* ==========================================================================
 * Path identity: one authority, one lock.
 * ======================================================================== */

describe("witness path identity", () => {
  it("aliased paths for one witness resolve to ONE lock file", () => {
    const path = join(dir, "witness.json");
    writeWitness(path, {});
    // The same file named through "..", and through a symlinked parent.
    const viaDotDot = join(dir, "sub", "..", "witness.json");
    writeWitness(join(dir, "witness.json"), {});
    mkdirSync(join(dir, "sub"), { recursive: true });
    const linkedParent = join(dir, "linked");
    symlinkSync(dir, linkedParent, "dir");
    const viaLinkedParent = join(linkedParent, "witness.json");

    expect(witnessLockPath(viaDotDot)).toBe(witnessLockPath(path));
    expect(witnessLockPath(viaLinkedParent)).toBe(witnessLockPath(path));
  });

  it("a SYMLINKED witness file is refused — rename would replace the link, forking the authority", () => {
    const real = join(dir, "real-witness.json");
    writeWitness(real, { [`${PAIR_A}/A->B`]: flat(1) });
    const link = join(dir, "link-witness.json");
    symlinkSync(real, link);

    let thrown: unknown;
    try {
      advanceWitness(link, PAIR_B, "A->B", flat(1));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WitnessLockError);
    expect((thrown as WitnessLockError).reason).toBe("witness-path-unsafe");
    expect((thrown as WitnessLockError).message).toMatch(/symbolic link/);
    // The real witness is untouched, and the link is still a link.
    expect(readWitness(real).witness).toEqual({ [`${PAIR_A}/A->B`]: flat(1) });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("the lock file sits beside the witness, named for it — never a bare 'lock'", () => {
    // A witness may legitimately live inside a directory that also holds a pad,
    // whose own lock is <dir>/lock. The two must never collide.
    //
    // The expected directory is the REALPATH of the witness's parent, not the
    // path as typed: on macOS the system temp dir is reached through /var, a
    // symlink to /private/var, and collapsing that is exactly the point — two
    // spellings of one authority must take one lock.
    const path = join(dir, "witness.json");
    writeWitness(path, {});
    expect(witnessLockPath(path)).toBe(join(realpathSync(dir), "witness.json.lock"));
    expect(witnessLockPath(path).endsWith("/lock")).toBe(false);
    expect(witnessLockPath(path).endsWith("witness.json.lock")).toBe(true);
  });

  it("case-only path differences resolve to ONE lock on a case-insensitive filesystem", () => {
    // APFS (this project's dev platform) and most SMB mounts are
    // case-insensitive: /w/Witness.json and /w/witness.json are ONE file.
    // Canonicalising only the parent would hand them two different locks and
    // the lost update would reproduce in full, so the FILE is canonicalised.
    const path = join(dir, "witness.json");
    writeWitness(path, {});
    const shouted = join(dir, "WITNESS.JSON");
    if (!existsSync(shouted)) {
      // A case-SENSITIVE filesystem: the two really are different files, and
      // two different locks is the correct answer. Nothing to assert.
      return;
    }
    expect(witnessLockPath(shouted)).toBe(witnessLockPath(path));
  });

  it('a witness path ending in ".lock" is refused — it would collide with a neighbour\'s lock', () => {
    // A witness at <X>.lock and a witness at <X> would share one file: <X>'s
    // lock IS <X>.lock. A release could then unlink a live authority's lock.
    const path = join(dir, "witness.json.lock");
    writeWitness(path, {});
    let thrown: unknown;
    try {
      advanceWitness(path, PAIR_A, "A->B", flat(1));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WitnessLockError);
    expect((thrown as WitnessLockError).reason).toBe("witness-path-unsafe");
    expect((thrown as WitnessLockError).message).toMatch(/reserved/);
  });

  it("the lock body names the holder, so the documented recovery can be confirmed", () => {
    const path = join(dir, "witness.json");
    writeWitness(path, {});
    const release = acquireWitnessLock(path, { pairId: PAIR_A, direction: "A->B" });
    const body = readFileSync(witnessLockPath(path), "utf8");
    release();
    // Enough for an operator to find the holder: pid, host, and which pair.
    expect(body).toMatch(/^pid \d+ host \S+ pair [0-9a-f]{32}\/A->B since /);
    // ...and nothing pad-derived (N17).
    expect(body).not.toMatch(/secret|key|mask|[0-9a-f]{64}/i);
  });

  it("release never unlinks a lock this process no longer owns", () => {
    // If an operator cleared a lock believed stale and a third process then
    // acquired it, deleting it on release would admit the second writer the
    // whole mechanism exists to exclude.
    const path = join(dir, "witness.json");
    writeWitness(path, {});
    const release = acquireWitnessLock(path, { pairId: PAIR_A, direction: "A->B" });
    const lock = witnessLockPath(path);
    // Someone else's lock now sits at that path.
    writeFileSync(lock, "pid 4242 host elsewhere pair " + PAIR_B + "/B->A since 2020-01-01T00:00:00.000Z");
    release();
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, "utf8")).toContain("4242");
  });

  it("an exclusive holder blocks a second acquirer, and releasing lets it through", () => {
    const path = join(dir, "witness.json");
    writeWitness(path, {});
    const release = acquireWitnessLock(path);
    expect(existsSync(witnessLockPath(path))).toBe(true);
    // A second acquire refuses rather than proceeding unserialised.
    expect(() => acquireWitnessLock(path)).toThrow(WitnessLockError);
    release();
    const again = acquireWitnessLock(path);
    again();
    expect(existsSync(witnessLockPath(path))).toBe(false);
  }, 30_000);
});
