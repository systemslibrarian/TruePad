/* ============================================================================
 * truepad2 rollback witness — the separate-state-file class (FORMAT-V2.md §15)
 * ----------------------------------------------------------------------------
 * Node only. Imports core types; never imports the exhibit. Owns one witness
 * file: an authority OUTSIDE the pair directory's failure domain that
 * remembers how far a store has advanced, so a store rolled back by a restore
 * refuses to move (§9.4, §15.3) instead of reusing retired positions.
 *
 *   <path>  a JSON witness file (§15.2), 0600, rewritten atomically per §10:
 *           { "formatVersion": 2, "witness": { "<pairId>/<direction>":
 *             { "encryptionNextOffset": n, "authenticationNextSequence": n,
 *               "attemptsReserved": n } } }
 *           The entry is FROZEN as exactly those three required counters
 *           (§15.2). One file may witness several pairs. It holds counters
 *           and nothing else — never a pad byte, key, mask, plaintext, or
 *           ciphertext (§15.1, ledger N17).
 *
 * Two operations, matching §15.3's two touchpoints:
 *   readWitnessCounters — PREFLIGHT: fail closed. A missing or unreadable file
 *     is `witness-unreachable`; a file that parses but violates its own shape
 *     is `witness-inconsistent`; a file with no entry for this (pair,
 *     direction) yet is a fresh witness (null counters — protection begins at
 *     the first witnessed commit, §15.2). A present entry is returned for the
 *     caller to compare.
 *   advanceWitness — ADVANCE: read-modify-write, atomic replace + fsync + dir
 *     fsync (§10), MONOTONE (never lowers an existing entry — the elementwise
 *     max per counter), throws on any I/O failure. The caller runs it after
 *     the §12 durable commit and before the emit; on a throw the record's
 *     material is already retired and the output MUST be withheld (§15.3).
 *
 * Concurrency scope, and its boundary (§10.3). One witness may record several
 * pairs, and each pair has its own pad lock — so the shared file's
 * read-modify-write is serialised by a SECOND exclusive lock keyed on the
 * witness itself (`<canonical witness>.lock`, O_EXCL, fail-closed, no
 * pid-liveness guessing). Lock order is PAIR then WITNESS, never the reverse.
 *
 * That exclusion is only as good as `O_EXCL` on the medium, and lock.ts already
 * scopes that: local Linux ext4 only; network filesystem semantics untested.
 * The exposure is WORSE here than for a pad lock, because §15.2's whole
 * argument for a witness is that it lives in a failure domain the pair's backup
 * does not cover — which tempts an operator toward a network share or a sync
 * client, exactly where O_EXCL may admit two writers. So, normatively: a
 * witness shared by more than one pair MUST live on a local filesystem on one
 * host. "Independent failure domain" means a different device or backup regime,
 * not a network share. This build cannot detect the violation and does not
 * pretend to — it states it.
 *
 * Strength caveat, stated rather than flattened (§15.2): a separate state
 * file is an independent backup/failure domain, NOT intrinsically monotonic —
 * a second device can be restored too, and an emptied witness knows nothing.
 * A witness is only as monotonic as the mechanism enforcing its
 * non-regression; that mechanism here is the operator's assumption that the
 * path lives in a domain the pair's backup does not cover.
 * ========================================================================= */

import {
  accessSync,
  readdirSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import type { PadDirection } from "../../core/pad.ts";

// The three monotone quantities a witness records. The two high-waters catch
// a restore that would REUSE material (§9.4). attemptsReserved — the total
// verification attempts ever reserved for this (pair, direction) — catches a
// restore that would refill the per-record attempt budget: failed
// authentications reserve attempts without moving the high-waters, so a
// pair backup-restore could otherwise reset perSequenceAttempts and hand the
// attacker verifyAttemptLimit fresh guesses per restore, defeating §5's
// finite-forgery bound. All three are non-secret counters (N17).
export type WitnessCounters = {
  encryptionNextOffset: number;
  authenticationNextSequence: number;
  attemptsReserved: number;
};

// key: `${pairId}/${direction}` — one entry per (pair, direction).
export type WitnessFile = { formatVersion: 2; witness: Record<string, WitnessCounters> };

export type WitnessReadResult =
  | { ok: true; counters: WitnessCounters | null } // null = no entry yet (fresh witness: §15.2)
  | { ok: false; reason: "witness-unreachable" | "witness-inconsistent"; message: string };

const FILE_MODE = 0o600;

const keyOf = (pairId: string, direction: PadDirection): string => `${pairId}/${direction}`;

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validate a parsed witness file against the §15.2 shape. Returns a freshly
// constructed WitnessFile (never the raw parse — extra structure cannot ride
// along), or the reason it fails.
function validateWitnessFile(raw: unknown): { file: WitnessFile } | { why: string } {
  if (!isRecord(raw)) {
    return { why: "not a JSON object" };
  }
  if (raw.formatVersion !== 2) {
    return { why: `formatVersion must be the integer 2 (found ${JSON.stringify(raw.formatVersion)})` };
  }
  if (!isRecord(raw.witness)) {
    return { why: "witness must be an object mapping <pairId>/<direction> to counters" };
  }
  const witness: Record<string, WitnessCounters> = {};
  for (const [key, value] of Object.entries(raw.witness)) {
    if (!isRecord(value)) {
      return { why: `witness["${key}"] is not an object` };
    }
    const keys = Object.keys(value);
    // The frozen v2 witness entry is EXACTLY the three monotone counters, all
    // required. There is no legacy two-counter form: a store new enough to
    // have a witness is new enough to write attemptsReserved, so a missing
    // one is a shape violation (fails closed), never a silent 0 (which would
    // reopen the attempt-budget rollback §15.1 closes).
    if (
      keys.length !== 3 ||
      !isSafeCount(value.encryptionNextOffset) ||
      !isSafeCount(value.authenticationNextSequence) ||
      !isSafeCount(value.attemptsReserved)
    ) {
      return {
        why:
          `witness["${key}"] must be exactly { encryptionNextOffset, authenticationNextSequence, attemptsReserved } ` +
          "with safe integers >= 0 and no other keys"
      };
    }
    witness[key] = {
      encryptionNextOffset: value.encryptionNextOffset,
      authenticationNextSequence: value.authenticationNextSequence,
      attemptsReserved: value.attemptsReserved
    };
  }
  return { file: { formatVersion: 2, witness } };
}

/* ---- durability primitives (store2.ts idioms, atomic replace) ------------- */

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw new Error(`short write: ${offset} of ${bytes.length} bytes`);
    }
    offset += written;
  }
}

function fsyncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return; // this platform cannot open a directory handle
  }
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Atomic replace: per-process temp file (full write verified), fsync, rename
// over the target, fsync the directory. The parent directory is NOT created —
// the operator chooses the witness path, and a missing directory (or a
// read-only one) surfaces as a throw the caller turns into the §15.3 loss row.
function writeWitnessDurably(path: string, data: string): void {
  const dir = dirname(path);
  const tmp = `${path}.tmp.${process.pid}`;
  const fd = openSync(tmp, "w", FILE_MODE);
  try {
    writeAll(fd, Buffer.from(data, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dir);
}

/* ---- the witness authority lock (§15.3) ----------------------------------- */

// ONE witness file may hold entries for SEVERAL pairs (§15.2), and each pair
// has its own pad lock — so two pairs advancing at once take two DIFFERENT pad
// locks and nothing serialises the shared file. Atomic replace stops a torn
// file; it does not stop a lost update:
//
//   witness {A:10, B:20}
//   P1 (pair A) reads {A:10,B:20} -> computes {A:11,B:20}
//   P2 (pair B) reads {A:10,B:20} -> computes {A:10,B:21}
//   P1 writes {A:11,B:20}; P2 writes {A:10,B:21}   <- A REGRESSED 11 -> 10
//
// The elementwise max is applied only to the key being advanced; every other
// pair's entry rides along from a snapshot that may already be stale. A
// regressed witness is exactly what §9.4/§15.3 exist to refuse, so this is a
// correctness defect, not a tidiness one — and it must be serialised at the
// WITNESS, not at the pair.
//
// The lock is a sibling O_EXCL file beside the witness, on the same
// fail-closed discipline as src/cli/lock.ts: no pid-liveness guessing, because
// pids are reused and guessing turns a stale lock into a silent double-writer.
const LOCK_SUFFIX = ".lock";
// A witness RMW is a read, a small JSON rewrite, and two fsyncs — milliseconds.
// Waiting briefly lets honest concurrent pairs through; refusing after the
// bound keeps a stale lock from hanging an operator forever.
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 20;

export type WitnessLockRefusal = { reason: "witness-locked" | "witness-path-unsafe"; message: string };

// Thrown so truepad2.ts can map it onto the §15.3 rows rather than a bare I/O
// error; carries the typed reason the CLI already speaks.
export class WitnessLockError extends Error {
  readonly reason: WitnessLockRefusal["reason"];
  constructor(refusal: WitnessLockRefusal) {
    super(refusal.message);
    this.name = "WitnessLockError";
    this.reason = refusal.reason;
  }
}

function sleepSync(ms: number): void {
  // A synchronous pause without a busy spin. The witness path is entirely
  // synchronous (§10's write ordering depends on it), so this cannot await.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The lock must name the witness AUTHORITY, not the spelling of a path. Two
// stores may reach one witness through different text: relative vs absolute,
// through "..", through a symlinked parent directory, or — on a
// case-insensitive filesystem — through different case. `realpathSync` on the
// parent collapses the first three; it does NOT collapse case, because it
// returns the path as given, so the on-disk spelling of the basename is
// resolved separately (see canonicalBasename). One authority, one lock.
//
// A symlinked witness is refused outright: the advance's
// renameSync(tmp, path) REPLACES THE SYMLINK with a regular file rather than
// writing through it, so the authority silently forks in two and a second
// store still pointing at the target would witness nothing. That cannot be
// locked around.
//
// A basename ending in `.lock` is refused too: it would collide with the lock
// file of a witness configured one directory entry away, and a release could
// then unlink a live authority's lock.
//
// What this does NOT establish, stated rather than invented: a hard link is
// indistinguishable from the original by realpath, and two bind mounts or two
// network paths onto one file can canonicalise differently. Identity here is
// the platform's path identity and no more — never a hash of witness or pad
// content (N17).
// The on-disk spelling of `name` inside `realDir`. On a case-INSENSITIVE
// filesystem — APFS, the default on this project's own dev platform, and most
// SMB mounts — `/w/Witness.json` and `/w/witness.json` are ONE file, but
// `realpathSync` returns the path AS GIVEN rather than the canonical case, so
// canonicalising with realpath alone would still hand those two spellings two
// different locks and the lost update would reproduce in full.
//
// An EXACT directory entry always wins, which keeps this correct on a
// case-SENSITIVE filesystem where the two names really are two files. Only when
// no exact entry exists is a unique case-insensitive match substituted — the
// signature of a case-insensitive filesystem resolving a differently-spelled
// path to one file.
function canonicalBasename(realDir: string, name: string): string {
  let entries: string[];
  try {
    entries = readdirSync(realDir);
  } catch {
    return name; // unreadable directory: the caller fails closed downstream
  }
  if (entries.includes(name)) {
    return name;
  }
  const lowered = name.toLowerCase();
  const matches = entries.filter((entry) => entry.toLowerCase() === lowered);
  return matches.length === 1 ? matches[0] : name;
}

export function witnessLockPath(path: string): string {
  let link = false;
  try {
    link = lstatSync(path).isSymbolicLink();
  } catch {
    /* absent is not this function's business — the caller fails closed on it */
  }
  if (link) {
    throw new WitnessLockError({
      reason: "witness-path-unsafe",
      message:
        `the rollback witness at ${path} is a symbolic link. The witness is advanced by an atomic replace, which ` +
        "REPLACES a symlink with a regular file instead of writing through it — the authority would silently " +
        "split in two, and a store configured with the link's target would stop being witnessed at all. Point " +
        "--witness-path at the real file. Nothing was written."
    });
  }
  let realDir: string;
  try {
    realDir = realpathSync(dirname(path));
  } catch (error) {
    throw new WitnessLockError({
      reason: "witness-path-unsafe",
      message:
        `the rollback witness at ${path} has no reachable parent directory (${(error as Error).message}). The ` +
        "advance is serialised by a lock file beside the witness, and the directory holding both must resolve. " +
        "Nothing was written."
    });
  }
  const base = canonicalBasename(realDir, basename(path));
  if (base.endsWith(LOCK_SUFFIX)) {
    throw new WitnessLockError({
      reason: "witness-path-unsafe",
      message:
        `the rollback witness at ${path} ends in "${LOCK_SUFFIX}", which is reserved: it is the name this build ` +
        "gives the lock file of a witness one directory entry away, so the two would collide and a release could " +
        "unlink a live authority's lock. Rename the witness. Nothing was written."
    });
  }
  return join(realDir, `${base}${LOCK_SUFFIX}`);
}

// LOCK ORDER, global and without exception: PAD LOCK, then WITNESS LOCK.
// Every witness touchpoint runs inside truepad2.ts's withPair(), which holds
// the pad lock; this module never acquires a pad lock, so the order cannot
// invert and there is no cycle to deadlock on. One witness lock is held at a
// time, for one read-modify-write, and is released before returning — a future
// multi-pair verb must NOT hold one witness lock across two pad locks.
//
// Exclusive, cross-process, fail-closed. Waits briefly for an honest peer, then
// refuses and names the file to remove. It does NOT decide whether the recorded
// pid is alive: pids are reused, and a wrong guess here would let two writers
// into the read-modify-write this lock exists to prevent.
export function acquireWitnessLock(path: string, held?: { pairId: string; direction: PadDirection }): () => void {
  const lockPath = witnessLockPath(path);
  // The documented recovery is "confirm nothing holds this witness, then remove
  // the file", and the holder is BY CONSTRUCTION a different pair in a
  // different directory — that is the whole reason this lock exists. A body of
  // only "pid N" gives the operator nothing to confirm against, so it names the
  // host and the (pair, direction) too. All non-secret: pair ids and directions
  // already travel in headers, manifests and refusals, and none of it is
  // derived from pad material (N17).
  const body =
    `pid ${process.pid} host ${hostname()}` +
    (held ? ` pair ${held.pairId}/${held.direction}` : "") +
    ` since ${new Date().toISOString()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", FILE_MODE);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // EACCES / EROFS / ENOENT on the directory: the medium cannot host the
        // lock, so the advance cannot be serialised — refuse rather than run
        // the read-modify-write unserialised.
        throw new WitnessLockError({
          reason: "witness-path-unsafe",
          message:
            `the rollback witness at ${path} cannot be serialised: its lock file ${lockPath} could not be created ` +
            `(${(error as Error).message}). The advance is a read-modify-write of a file that may witness several ` +
            "pairs, so it is never performed without the lock. Nothing was written."
        });
      }
      if (Date.now() >= deadline) {
        let holder = "(unreadable)";
        try {
          holder = readFileSync(lockPath, "utf8").trim();
        } catch {
          /* keep the placeholder */
        }
        throw new WitnessLockError({
          reason: "witness-locked",
          message:
            `the rollback witness at ${path} is locked by ${holder} and did not free within ${LOCK_WAIT_MS}ms. One ` +
            "witness may record several pairs, so its update is serialised across processes. If that process is " +
            `gone (a crash or SIGKILL leaves this file behind), confirm no other TruePad operation is running ` +
            `against this witness and remove ${lockPath}. This is deliberately not decided by inspecting the ` +
            "recorded pid: pids are reused, and guessing wrong would admit the second writer this lock exists to " +
            "exclude. Nothing was written."
        });
      }
      sleepSync(LOCK_POLL_MS);
      continue;
    }
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      process.off("exit", release);
      try {
        // Unlink only a lock this process still owns. If an operator cleared a
        // lock believed stale and a third process then acquired it, the file at
        // this path is someone else's exclusion — deleting it would admit the
        // second writer the whole mechanism exists to exclude.
        if (readFileSync(lockPath, "utf8") === body) {
          unlinkSync(lockPath);
        }
      } catch {
        /* already gone, or unreadable — leave it rather than risk a stranger's */
      }
    };
    // A hard exit between acquire and release would otherwise strand the lock
    // and take every pair sharing this witness down with it.
    process.once("exit", release);
    return release;
  }
}

/* ---- test-only interleaving hold ------------------------------------------ */

// TEST ONLY, and never set by the CLI: `TRUEPAD_TEST_WITNESS_HOLD_MS` makes a
// process pause INSIDE the witness read-modify-write, immediately after the
// read, with the snapshot in hand.
//
// It exists because the defect this module had is a RACE, and a race shown by
// "spawn many and hope" is not shown at all. With a hold, the overlap is
// arranged rather than hoped for: start one process holding, start a second
// while the first still holds, and the two read-modify-writes are guaranteed
// to overlap. Unserialised, the second process reads the pre-first snapshot
// and its write erases the first's advance — the lost update, deterministically.
// Serialised, the second blocks on the witness lock, reads the FIRST's result,
// and both maxima survive.
//
// So this is also a permanent regression test: delete the lock and the
// concurrency suite fails, rather than passing on a lucky schedule.
function testHoldMs(): number {
  const raw = process.env.TRUEPAD_TEST_WITNESS_HOLD_MS;
  if (raw === undefined || raw === "") {
    return 0;
  }
  const ms = Number(raw);
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 60_000 ? ms : 0;
}

/* ---- the two touchpoints -------------------------------------------------- */

// PREFLIGHT read (§15.3). Fail closed: a witness that cannot be read is
// `witness-unreachable`, never a silent downgrade. A file that parses but
// violates its own shape is `witness-inconsistent`. A file with no entry for
// this (pair, direction) is a fresh witness — null counters, which the caller
// treats as pass (protection begins at the first witnessed commit, §15.2).
//
// Bootstrap: the operator provisions the witness file (an absent file fails
// closed as unreachable — a configured witness that is not there is an
// outage to surface, not a fresh start). A present-but-empty file — the
// natural `touch`ed "empty witness file" the ceremony asks for — is a fresh
// witness with no entries, exactly like `{"witness":{}}`. That an emptied
// witness reads as fresh is not a weakness the spec hides: §15.2 states a
// separate state file that is itself restored or emptied "knows nothing".
export function readWitnessCounters(path: string, pairId: string, direction: PadDirection): WitnessReadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: "witness-unreachable",
      message:
        `the configured rollback witness at ${path} cannot be read (${(error as Error).message}). A witness that ` +
        "cannot be reached fails closed (§15.3): witness outage is an availability failure, never a silent " +
        "downgrade. Provision the witness file (an empty file accepts a fresh pair) or restore its medium. " +
        "Nothing was burned."
    };
  }
  // A present-but-empty (or whitespace-only) file is the fresh-witness
  // bootstrap, not malformed JSON.
  if (text.trim() === "") {
    return { ok: true, counters: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: "witness-inconsistent",
      message:
        `the rollback witness at ${path} does not parse as JSON (${(error as Error).message}). A witness that ` +
        "violates its own shape fails closed (§15.3); inspect it by hand. Nothing was burned."
    };
  }
  const validated = validateWitnessFile(parsed);
  if ("why" in validated) {
    return {
      ok: false,
      reason: "witness-inconsistent",
      message:
        `the rollback witness at ${path} violates its own shape — ${validated.why} (§15.2). A witness that fails ` +
        "its shape fails closed (§15.3); inspect it by hand. Nothing was burned."
    };
  }
  const entry = validated.file.witness[keyOf(pairId, direction)];
  return { ok: true, counters: entry ?? null };
}

// Preflight PATH-SAFETY probe. The advance replaces the witness by rename, and
// rename does NOT follow a symlink on the final component: a symlinked witness
// would be REPLACED by a regular file, leaving the link's target frozen at its
// old counters while a second store configured with that target went on
// believing it was witnessed. One authority silently becomes two, which is the
// same class of defect as the lost update — so it is refused, and refused HERE,
// at preflight, where the refusal is free and nothing has been committed.
//
// Serialisation depends on the same path resolving to one lock, so this also
// surfaces an unresolvable parent directory before anything is consumed.
export function witnessPathSafe(path: string): { ok: true } | { ok: false; reason: "witness-unreachable"; message: string } {
  try {
    witnessLockPath(path);
    return { ok: true };
  } catch (error) {
    if (error instanceof WitnessLockError) {
      return { ok: false, reason: "witness-unreachable", message: error.message };
    }
    throw error;
  }
}

// Preflight writability probe. The advance write (§15.3) atomic-replaces
// through a temp file in the witness DIRECTORY, so a witness whose FILE reads
// but whose DIRECTORY cannot be written (a read-only mount, a write-protected
// card, ENOSPC) would pass a read-only preflight and then fail at advance —
// AFTER the store has durably committed, losing that record on EVERY
// operation, not once. Probing the directory's write permission here turns
// that into a free preflight refusal (witness-unreachable), so the loss is
// bounded to at most the one record already in flight when the medium went
// unwritable — exactly what §15.3 claims. It is a probe, not a guarantee:
// a race or a quota hit between probe and write can still lose one record,
// which is the stated bound.
export function witnessWritable(path: string): { ok: true } | { ok: false; reason: "witness-unreachable"; message: string } {
  try {
    accessSync(dirname(path), constants.W_OK);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "witness-unreachable",
      message:
        `the rollback witness at ${path} is readable but its directory is not writable ` +
        `(${(error as Error).message}). The witness is advanced by an atomic replace in that directory, so an ` +
        "unwritable medium fails closed at preflight (§15.3) rather than losing a record per operation: witness " +
        "outage is an availability failure, never a silent downgrade. Restore write access to the witness medium. " +
        "Nothing was burned."
    };
  }
}

// ADVANCE write (§15.3). Read-modify-write the entry for this (pair,
// direction) to the new high-waters, MONOTONE: the elementwise maximum, so an
// out-of-order or replayed advance never lowers the recorded position.
// Creates the file if absent (a fresh witness, first commit). Atomic replace +
// fsync + directory fsync (§10). Throws on any I/O failure — the caller has
// already committed the store durably, so a throw is the §15.3 loss row.
export function advanceWitness(path: string, pairId: string, direction: PadDirection, counters: WitnessCounters): void {
  // SERIALISE FIRST. The read below and the replace at the end are one
  // read-modify-write over a file that may witness several pairs; the pad lock
  // the caller holds is per-pair and does not cover it. Everything from here to
  // the directory fsync runs under the witness authority's own lock.
  const release = acquireWitnessLock(path, { pairId, direction });
  try {
    advanceLocked(path, pairId, direction, counters);
  } finally {
    release();
  }
}

function advanceLocked(path: string, pairId: string, direction: PadDirection, counters: WitnessCounters): void {
  let file: WitnessFile;
  let existing: string;
  try {
    existing = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // The configured witness VANISHED between preflight and advance. Do not
      // recreate it: a fresh file here would silently erase every other pair's
      // record — the same regression this lock exists to prevent, dressed as a
      // bootstrap. §15.2's fresh witness is a file the operator PROVISIONED
      // (present, empty), never one that disappeared. Fail closed.
      throw new Error(
        `the rollback witness at ${path} no longer exists — it was readable at preflight and is gone now. It is ` +
          "NOT recreated: a fresh witness here would erase the recorded high-water of every other pair sharing " +
          "this file. Restore the witness medium, then inspect the pair before using it again."
      );
    }
    throw error;
  }
  if (existing.trim() === "") {
    // The present-but-empty bootstrap file the operator provisions (see
    // readWitnessCounters). A fresh witness to build on — this is the ONLY
    // path that starts one, and it is not broadened.
    file = { formatVersion: 2, witness: {} };
  } else {
    const validated = validateWitnessFile(JSON.parse(existing));
    if ("why" in validated) {
      throw new Error(`the rollback witness at ${path} is inconsistent (${validated.why}); refusing to advance over it`);
    }
    file = validated.file;
  }
  // TEST-ONLY: hold here with the snapshot in hand, so the suite can guarantee
  // two read-modify-writes overlap. Never set by the CLI.
  const hold = testHoldMs();
  if (hold > 0) {
    sleepSync(hold);
  }

  const key = keyOf(pairId, direction);
  const prev = file.witness[key] ?? { encryptionNextOffset: 0, authenticationNextSequence: 0, attemptsReserved: 0 };
  // MONOTONE on every field: elementwise maximum, so an out-of-order or
  // replayed advance never lowers a recorded position or the attempt count.
  file.witness[key] = {
    encryptionNextOffset: Math.max(prev.encryptionNextOffset, counters.encryptionNextOffset),
    authenticationNextSequence: Math.max(prev.authenticationNextSequence, counters.authenticationNextSequence),
    attemptsReserved: Math.max(prev.attemptsReserved, counters.attemptsReserved)
  };
  writeWitnessDurably(path, JSON.stringify(file));
}
