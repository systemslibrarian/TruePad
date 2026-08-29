/* ============================================================================
 * truepad2 — Store Format v2 verbs (docs/FORMAT-V2.md is the binding spec)
 * ----------------------------------------------------------------------------
 * Node only. Imports core and cli, never the exhibit. Runs from source under
 * Node's built-in type stripping (>= 22.18.0); bin/truepad2.mjs checks the
 * runtime before importing this file.
 *
 *   gen          <dir> --source FILE [--source FILE ...] [--origin TEXT ...]
 *                      --encryption-bytes E --auth-records N
 *   burn         <dir> --as A|B (TEXT | --in FILE)
 *   open         <dir> --as A|B (ENVELOPE-JSON | --in FILE)
 *   status       <dir>
 *   clear-freeze <dir>
 *   retire       <dir> --direction a-to-b|b-to-a --through-sequence S
 *                      [--through-offset O] [--reason TEXT]
 *   destroy      <dir> --confirm PAIRID|destroy-unreadable-pair [--reason TEXT]
 *   ceremony     create | verify — Phase 3 (src/cli/v2/ceremony.ts; docs/CEREMONY.md)
 *
 * The transactions here ARE FORMAT-V2.md §12: burn is SEND (S0..S3), open is
 * OPEN (O0..O6), and the order of durable acts inside each is normative, not
 * an implementation detail. Every refusal is typed per §14.1, exits 2, and
 * burns nothing it does not say it burns. v1 stores and v1 envelopes are
 * refused (§9); there is no --legacy, no --no-auth, no --force.
 *
 * This tool never modifies v1's truepad-pad; the two share only lock.ts and
 * the exit-code convention.
 * ========================================================================= */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bytesToHex, hexToBytes } from "../../core/hex.ts";
import type { PadDirection, Party } from "../../core/pad.ts";
import {
  MAX_CIPHERTEXT_BYTES,
  MAX_AUTH_LOOKAHEAD_DEFAULT,
  VERIFY_ATTEMPT_LIMIT_DEFAULT,
  FREEZE_THRESHOLD_DEFAULT,
  AUTH_RECORD_BYTES,
  tagsEqual,
  wcTag,
  type CanonicalFields
} from "../../core/wc-one-time.ts";
import { decodeEnvelope2, encodeEnvelope2, type EnvelopeV2 } from "../../core/envelope2.ts";
import { buildFrame, frameCapacity, parseFrame } from "../../core/frame2.ts";
import { combineSources, partition, requiredSourceLength } from "../../core/partition2.ts";
import { acquireLock } from "../lock.ts";
import {
  commitAdvance,
  HEAD_FILE,
  initStore2,
  JOURNAL_FILE,
  loadStore2,
  persistAuthFail,
  readAuthRecord,
  readEncryption,
  reserveAttempt,
  SECRET_FILE,
  type HeadV2,
  type LoadedStore2,
  type RecordSpec,
  type Rollback,
  type SourceDeclaration
} from "./store2.ts";
import {
  advanceWitness,
  readWitnessCounters,
  witnessLockProbe,
  witnessPathSafe,
  witnessWritable,
  WitnessLockError,
  type WitnessCounters
} from "./witness.ts";
import { CEREMONY_ASSERTIONS, ceremonyCreate, ceremonyVerify } from "./ceremony.ts";

export const BANNER2 =
  "truepad2: reuse-safe pad handling with authenticated envelopes (Store Format v2; docs/FORMAT-V2.md is the\n" +
  "binding spec). Forgery of a record is bounded per FORMAT-V2.md §5, conditional on ceremony-grade source\n" +
  "material and the §10 durability scope. This is pad handling, not a messaging system, and not a\n" +
  "recommendation to use one-time pads for real traffic.";

export const USAGE2 = `usage:
  truepad2 gen          <dir> --source FILE [--source FILE ...] [--origin TEXT ...] --encryption-bytes E --auth-records N
                        [--verify-attempt-limit 8] [--max-auth-lookahead 64] [--freeze-threshold 32]
                        [--witness-class separate-state-file --witness-path ABSOLUTE-PATH] [--record-bytes F]
  truepad2 burn         <dir> --as A|B (TEXT | --in FILE)
  truepad2 open         <dir> --as A|B (ENVELOPE-JSON | --in FILE)
  truepad2 status       <dir>
  truepad2 clear-freeze <dir>
  truepad2 retire       <dir> --direction a-to-b|b-to-a --through-sequence S [--through-offset O] [--reason TEXT]
  truepad2 destroy      <dir> --confirm PAIRID|destroy-unreadable-pair [--reason TEXT]
  truepad2 ceremony create <workspace> --medium-a DIR --medium-b DIR --source F --source F [--origin TEXT ...]
                        --encryption-bytes E --auth-records N [gen knobs] --assert-offline --assert-distinct-physics
                        --assert-tmpfs-workspace --assert-no-persistent-copy
  truepad2 ceremony verify <medium-dir>
<dir> holds the pair: a-to-b/ and b-to-a/. --as is your role: A burns a-to-b and opens b-to-a; B the reverse.
exit codes: 0 ok · 2 refused (nothing burned) · 1 usage or I/O error`;

export const SUBDIR2: Record<PadDirection, string> = { "A->B": "a-to-b", "B->A": "b-to-a" };

// §14.1 taxonomy. Every Refused2 carries one of these, printed on stderr as
// `refused: <type> — <message>` so the type is machine-visible next to the
// exit code.
export type RefusalType =
  | "malformed-envelope"
  | "envelope-v1"
  | "oversize-ciphertext"
  | "wrong-pair"
  | "wrong-direction"
  | "v1-store"
  | "pair-destroyed"
  | "corrupt-head"
  | "corrupt-secret-body"
  | "corrupt-store"
  | "corrupt-journal"
  | "half-pair"
  | "no-store"
  | "regressed-below-mark"
  | "sequence-retired"
  | "sequence-malformed"
  | "sequence-out-of-window"
  | "offset-retired"
  | "encryption-exhausted"
  | "auth-exhausted"
  | "frozen"
  | "sequence-contested"
  | "locked"
  | "auth-failed"
  | "source-too-short"
  | "ceremony-incomplete"
  | "record-size-mismatch"
  | "witness-unreachable"
  | "witness-inconsistent"
  | "witness-regressed"
  | "witness-unsupported"
  | "destroy-unconfirmed";

export class Refused2 extends Error {
  readonly type: RefusalType;

  constructor(type: RefusalType, message: string) {
    super(message);
    this.name = "Refused2";
    this.type = type;
  }
}

export function directionFor2(role: Party, op: "burn" | "open"): PadDirection {
  if (op === "burn") {
    return role === "A" ? "A->B" : "B->A";
  }
  return role === "A" ? "B->A" : "A->B";
}

/* ---- argument parsing ------------------------------------------------------
 * Unlike v1's parseArgs, flags are collected into lists so --source (and
 * --origin) may repeat. single() enforces at-most-once for everything else.
 */

export type Args2 = { positional: string[]; flags: Map<string, string[]> };

export function parseArgs2(argv: string[]): Args2 {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      // Ceremony assertions are presence flags (ceremony.ts owns the list
      // and the statements): the operator asserts by naming the flag, and
      // there is no value to consume.
      if (CEREMONY_ASSERTIONS.some((assertion) => assertion.flag === name)) {
        const asserted = flags.get(name) ?? [];
        asserted.push("asserted");
        flags.set(name, asserted);
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`flag ${arg} needs a value`);
      }
      const list = flags.get(name) ?? [];
      list.push(value);
      flags.set(name, list);
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function single(args: Args2, name: string): string | undefined {
  const list = args.flags.get(name);
  if (list === undefined) {
    return undefined;
  }
  if (list.length > 1) {
    throw new Error(`--${name} may be given only once`);
  }
  return list[0];
}

const out = (text: string): void => {
  writeSync(1, text.endsWith("\n") ? text : `${text}\n`);
};
const err = (text: string): void => {
  writeSync(2, text.endsWith("\n") ? text : `${text}\n`);
};

// open's plaintext release is byte-exact: no transcode, no appended newline —
// v2 is bytes-only (§3) and O6 releases the plaintext, not a rendering of it.
// write(2) may be partial on a pipe; loop until every byte is down.
function writeAllBytes(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw new Error(`short write: ${offset} of ${bytes.length} bytes`);
    }
    offset += written;
  }
}

function dirArg(args: Args2, verb: string): string {
  const dir = args.positional[1];
  if (dir === undefined) {
    throw new Error(`${verb} needs <dir>`);
  }
  return resolve(dir);
}

function roleArg(args: Args2): Party {
  const role = single(args, "as");
  if (role !== "A" && role !== "B") {
    throw new Error("--as A or --as B is required: it names YOUR role, and picks which half of the pair is used");
  }
  return role;
}

function readInputBytes(args: Args2, index: number): Uint8Array {
  const file = single(args, "in");
  if (file !== undefined) {
    return new Uint8Array(readFileSync(file));
  }
  const text = args.positional[index];
  if (text === undefined) {
    throw new Error("missing input: pass it as an argument or with --in FILE");
  }
  return new TextEncoder().encode(text);
}

function readInputText(args: Args2, index: number): string {
  const file = single(args, "in");
  if (file !== undefined) {
    return readFileSync(file, "utf8");
  }
  const text = args.positional[index];
  if (text === undefined) {
    throw new Error("missing input: pass it as an argument or with --in FILE");
  }
  return text;
}

/* ---- pair loading ---------------------------------------------------------- */

type LoadedPair = { "A->B": LoadedStore2; "B->A": LoadedStore2 };

// A v1 pad.json where a v2 half should be is a v1 store, refused with no
// bridge (§9.1). Shared by requirePair2 and destroy (§17.1): both refuse v1.
function refuseIfV1Store(dir: string): void {
  for (const direction of ["A->B", "B->A"] as const) {
    const half = join(dir, SUBDIR2[direction]);
    if (existsSync(join(half, "pad.json"))) {
      throw new Refused2(
        "v1-store",
        `${half} holds a v1 store (pad.json). v2 tooling refuses every v1 store — letters or bytes — and no ` +
          "conversion exists (FORMAT-V2.md §9). Use truepad-pad for v1 pads; generate a fresh v2 pair for v2."
      );
    }
  }
}

// A pair directory must hold BOTH v2 halves. A lone half is a crashed gen;
// a v1 pad.json anywhere in the pair is a v1 store, refused with no bridge.
function requirePair2(dir: string): void {
  refuseIfV1Store(dir);
  const missing = (["A->B", "B->A"] as const).filter((d) => !existsSync(join(dir, SUBDIR2[d], "head.json")));
  if (missing.length === 2) {
    throw new Refused2("no-store", `${dir} holds no v2 pad pair (no a-to-b/ or b-to-a/ head.json); run gen first`);
  }
  if (missing.length === 1) {
    throw new Refused2(
      "half-pair",
      `${dir} is a half-pair: ${SUBDIR2[missing[0]]}/ is missing. gen did not complete. Remove the directory and ` +
        "run gen again; do not use the surviving half."
    );
  }
}

function loadHalf2(dir: string, direction: PadDirection): LoadedStore2 {
  const loaded = loadStore2(join(dir, SUBDIR2[direction]));
  if (!loaded.ok) {
    throw new Refused2(loaded.reason as RefusalType, loaded.message);
  }
  return loaded;
}

// Hold the pair lock, check the pair is whole, load BOTH halves. Both are
// loaded even for single-direction verbs because the freeze is pair-wide
// (§8.4): a frozen receiving store pauses sending too.
// The destruction boundary (§17): once <dir>/destroyed.json is durable, the
// pair has crossed an irreversible line and MUST NEVER be used for a
// cryptographic operation again — even if an interrupted teardown left
// head.json/journal.log/secret.bin (whole or partially zeroed) behind. The
// tombstone is authoritative over the store files: it is checked BEFORE any
// secret is read, and there is no --force, restore, or clear that reopens
// the pair. Deleting the tombstone by hand is outside TruePad's guarantees.
function requireNotDestroyed(dir: string): void {
  if (existsSync(join(dir, TOMBSTONE_FILE))) {
    throw new Refused2(
      "pair-destroyed",
      `${dir} carries a durable ${TOMBSTONE_FILE}: destruction of this pair was initiated (§17), so it is ` +
        "permanently unusable. Its secret material may be partially overwritten or already absent, and there is no " +
        "path back to an active state. Re-run `truepad2 destroy` to finish any interrupted cleanup. Nothing was " +
        "touched."
    );
  }
}

function withPair<T>(dir: string, fn: (pair: LoadedPair) => T): T {
  const lock = acquireLock(dir);
  if (!lock.ok) {
    throw new Refused2("locked", lock.message);
  }
  try {
    // Before anything is loaded or any secret is read: a tombstoned pair is
    // refused outright (§17, §14.1 pair-destroyed).
    requireNotDestroyed(dir);
    requirePair2(dir);
    const pair: LoadedPair = { "A->B": loadHalf2(dir, "A->B"), "B->A": loadHalf2(dir, "B->A") };
    return fn(pair);
  } finally {
    lock.release();
  }
}

// §8.4: frozen when failureCount − clearedAtFailureCount reaches the
// threshold, on EITHER half. Clearing is an explicit operator action.
function frozenHalf(store: LoadedStore2): boolean {
  const threshold = store.head.verification.failurePolicy.threshold;
  return store.effective.failureCount - store.effective.clearedAtFailureCount >= threshold;
}

function requireNotFrozen(pair: LoadedPair): void {
  const frozen = (["A->B", "B->A"] as const).filter((d) => frozenHalf(pair[d]));
  if (frozen.length > 0) {
    throw new Refused2(
      "frozen",
      `The pair is frozen: ${frozen.join(" and ")} reached the failure threshold. The freeze is the reversible ` +
        "operator brake (§8.4): it burns nothing and resets nothing. Inspect the failures, then run " +
        "truepad2 clear-freeze <dir> to resume. Clearing never resets attempt counters. Nothing was burned."
    );
  }
}

/* ---- rollback witness (§15) ------------------------------------------------
 * The witness participates in exactly the verbs that advance high-waters —
 * burn, open, retire — at two touchpoints. PREFLIGHT is a free state gate,
 * run for the store's OWN direction after the store loads and before anything
 * is consumed; ADVANCE runs after the §12 durable commit and before the emit.
 * status reads and reports the witness but refuses nothing (§15.3).
 */

// §15.3 PREFLIGHT. none is a no-op; platform/remote are refused
// (witness-unsupported, never silently downgraded); separate-state-file reads
// the witness and refuses a store that sits strictly below it
// (witness-regressed — the restored-store signature of §9.4). All refusals
// are free: no byte of secret.bin is touched and no journal line is appended.
function witnessPreflight(store: LoadedStore2): void {
  const rollback = store.head.rollback;
  if (rollback.witnessClass === "none") {
    return;
  }
  if (rollback.witnessClass !== "separate-state-file") {
    // platform-monotonic / remote-monotonic: specified, unimplemented.
    throw new Refused2(
      "witness-unsupported",
      `rollback.witnessClass "${rollback.witnessClass}" is specified by FORMAT-V2.md §15.2 but is UNIMPLEMENTED in ` +
        "this build: it is refused, never silently downgraded to a weaker class (§15.2). Nothing was burned."
    );
  }
  const path = rollback.config.path;
  // Before anything else: the configured path must be one this build can both
  // serialise and atomically replace. A symlinked witness, or one whose parent
  // cannot be resolved, refuses FREE here rather than losing a record at the
  // post-commit advance.
  const safe = witnessPathSafe(path);
  if (!safe.ok) {
    throw new Refused2(safe.reason, safe.message);
  }
  const result = readWitnessCounters(path, store.head.pairId, store.head.direction);
  if (!result.ok) {
    throw new Refused2(result.reason, result.message);
  }
  // The advance (post-commit) writes the witness; probe now so an unwritable
  // witness refuses free here instead of losing a record per operation
  // (§15.3). This keeps the stated bound — at most the one in-flight record —
  // honest.
  const writable = witnessWritable(path);
  if (!writable.ok) {
    throw new Refused2(writable.reason, writable.message);
  }
  // ...and the same for the serialisation lock. The advance acquires it AFTER
  // the durable commit, so a leftover lock would otherwise retire this record's
  // pad and then withhold the output — every invocation, on every pair sharing
  // the witness. Probed here, that becomes a free refusal.
  const unlocked = witnessLockProbe(path);
  if (!unlocked.ok) {
    // Reported as the EXISTING `locked` refusal (§14.1), not a new witness-*
    // name: it is the same class of event as a held pad lock, wants the same
    // operator action, and §15's refusal taxonomy is not extended here.
    throw new Refused2("locked", unlocked.message);
  }
  if (result.counters !== null) {
    const { encryptionNextOffset, authenticationNextSequence, attemptsReserved } = result.counters;
    if (
      store.effective.nextOffset < encryptionNextOffset ||
      store.effective.nextSequence < authenticationNextSequence ||
      store.effective.attemptsReserved < attemptsReserved
    ) {
      throw new Refused2(
        "witness-regressed",
        `this store is behind its rollback witness: the witness at ${path} records encryptionNextOffset ` +
          `${encryptionNextOffset}, authenticationNextSequence ${authenticationNextSequence}, and attemptsReserved ` +
          `${attemptsReserved}, but this store is ` +
          `at nextOffset ${store.effective.nextOffset}, nextSequence ${store.effective.nextSequence}, and ` +
          `attemptsReserved ${store.effective.attemptsReserved}. A store below its witness is the restored-store ` +
          "signature (FORMAT-V2.md §9.4): head.json and journal.log were rolled back together — whole-directory or " +
          "the both-files partial restore the load-time mark check cannot see — while the witness, in its separate " +
          "failure domain, remembers the true high-water and attempt budget (a restore that only rolled back the " +
          "attempt count would otherwise refill a contested record's guesses). Refusing before anything is " +
          "consumed. Nothing was burned."
      );
    }
  }
  // A null entry is a fresh witness: protection begins at the first witnessed
  // commit (§15.2), so this passes and the advance below writes the entry.
}

// §15.3 ADVANCE. Runs after the durable commit and before the emit. On any
// failure the store is already committed (the material is retired) and the
// output MUST be withheld: this rethrows as a plain Error (exit 1), stating
// the §15.3 loss row so the operator knows the record is lost and that every
// later operation will refuse free at preflight until the witness returns.
function witnessAdvance(store: LoadedStore2, counters: WitnessCounters): void {
  const rollback = store.head.rollback;
  if (rollback.witnessClass !== "separate-state-file") {
    // none: no witness to advance. platform/remote never reach here — their
    // preflight already refused witness-unsupported.
    return;
  }
  try {
    advanceWitness(rollback.config.path, store.head.pairId, store.head.direction, counters);
  } catch (error) {
    if (error instanceof WitnessLockError && error.reason === "witness-locked") {
      throw new Error(
        `the durable state commit succeeded but the rollback witness at ${rollback.config.path} could not be ` +
          `advanced: ${error.message} This record's pad material is already retired and is LOST; the output was ` +
          "withheld and never released (FORMAT-V2.md §15.3, the same loss row as a crash between commit and emit). " +
          "The witness itself is intact and no other pair's record was disturbed — that is what the lock bought."
      );
    }
    throw new Error(
      `the durable state commit succeeded but the rollback witness at ${rollback.config.path} could not be ` +
        `advanced (${(error as Error).message}). This record's pad material is already retired and is LOST; the ` +
        "output was withheld and never released (FORMAT-V2.md §15.3, the same loss row as a crash between commit " +
        "and emit) — this is the race between the preflight writability probe and the advance. Every later " +
        "operation refuses free at preflight (witness-unreachable) until the witness is reachable and writable again."
    );
  }
}

// §15.3 status: read-only report of the witness state for one direction.
// Refuses nothing. For separate-state-file it names reachability, the entry's
// counters (or null for a fresh witness), and how the store compares.
type WitnessReport =
  | { witnessClass: "none" }
  | { witnessClass: "platform-monotonic" | "remote-monotonic"; supported: false }
  | {
      witnessClass: "separate-state-file";
      path: string;
      reachable: boolean;
      reason?: "witness-unreachable" | "witness-inconsistent";
      counters: WitnessCounters | null;
      comparison?: "fresh" | "aligned" | "ahead" | "regressed";
    };

function witnessReport(store: LoadedStore2): WitnessReport {
  const rollback = store.head.rollback;
  if (rollback.witnessClass === "none") {
    return { witnessClass: "none" };
  }
  if (rollback.witnessClass !== "separate-state-file") {
    return { witnessClass: rollback.witnessClass, supported: false };
  }
  const path = rollback.config.path;
  const result = readWitnessCounters(path, store.head.pairId, store.head.direction);
  if (!result.ok) {
    return { witnessClass: "separate-state-file", path, reachable: false, reason: result.reason, counters: null };
  }
  if (result.counters === null) {
    return { witnessClass: "separate-state-file", path, reachable: true, counters: null, comparison: "fresh" };
  }
  const behind =
    store.effective.nextOffset < result.counters.encryptionNextOffset ||
    store.effective.nextSequence < result.counters.authenticationNextSequence ||
    store.effective.attemptsReserved < result.counters.attemptsReserved;
  const aligned =
    store.effective.nextOffset === result.counters.encryptionNextOffset &&
    store.effective.nextSequence === result.counters.authenticationNextSequence &&
    store.effective.attemptsReserved === result.counters.attemptsReserved;
  return {
    witnessClass: "separate-state-file",
    path,
    reachable: true,
    counters: result.counters,
    comparison: behind ? "regressed" : aligned ? "aligned" : "ahead"
  };
}

/* ---- gen (Phase 1: multi-source generation, FORMAT-V2.md §7) -------------- */

function positiveInt(value: string | undefined, flag: string): number {
  const parsed = value === undefined ? NaN : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${flag} must be a positive integer`);
  }
  return parsed;
}

// Resolve the two gen witness flags into a §1.1 rollback header field.
// Neither flag → the default { witnessClass: "none", config: {} } (§15.2). One
// without the other is a usage error. platform/remote are the typed
// witness-unsupported refusal; only separate-state-file is written, and its
// path must be absolute.
function witnessRollbackFromFlags(witnessClass: string | undefined, witnessPath: string | undefined): Rollback {
  if (witnessClass === undefined && witnessPath === undefined) {
    return { witnessClass: "none", config: {} };
  }
  if (witnessClass === undefined || witnessPath === undefined) {
    throw new Error("--witness-class and --witness-path must be given together, or neither");
  }
  if (witnessClass === "platform-monotonic" || witnessClass === "remote-monotonic") {
    throw new Refused2(
      "witness-unsupported",
      `--witness-class ${witnessClass} is specified by FORMAT-V2.md §15.2 but is UNIMPLEMENTED in this build: it is ` +
        "refused, never silently downgraded to a weaker class. Use --witness-class separate-state-file, or none. " +
        "Nothing was written."
    );
  }
  if (witnessClass !== "separate-state-file") {
    throw new Error(
      `--witness-class must be separate-state-file (platform-monotonic/remote-monotonic are refused as unsupported); ` +
        `found ${JSON.stringify(witnessClass)}`
    );
  }
  if (!isAbsolute(witnessPath)) {
    throw new Error(
      `--witness-path must be an absolute path — it travels verbatim in the header and each peer maintains its own ` +
        `witness file at that path on its host (found ${JSON.stringify(witnessPath)})`
    );
  }
  return { witnessClass: "separate-state-file", config: { path: witnessPath } };
}

// Resolve --record-bytes into a §1.1 recordPolicy.record field. No flag → the
// argued default { kind: "variable" } (§16.2: fixed spends F pad bytes per
// message however short, so the spec never makes that spend silent). With the
// flag, F is validated per §16 here, before any file is written, so a bad F
// costs nothing. F <= capacity is NOT required — a store with F larger than
// its budget simply exhausts on the first send.
function recordSpecFromFlag(recordBytes: string | undefined): RecordSpec {
  if (recordBytes === undefined) {
    return { kind: "variable" };
  }
  const f = Number(recordBytes);
  if (!Number.isSafeInteger(f) || f < 32 || f > MAX_CIPHERTEXT_BYTES || f % 16 !== 0) {
    throw new Error(
      `--record-bytes must be a multiple of 16 with 32 <= F <= ${MAX_CIPHERTEXT_BYTES} (FORMAT-V2.md §16); ` +
        `found ${JSON.stringify(recordBytes)}`
    );
  }
  return { kind: "fixed", bytes: f };
}

export function gen(args: Args2): void {
  const dir = dirArg(args, "gen");
  // A tombstoned directory has crossed the §17.3 boundary: never provision a
  // fresh pair into it (it would be dead on arrival, and it would spend
  // ceremony-grade source material at a path no verb can use).
  requireNotDestroyed(dir);
  const sourcePaths = args.flags.get("source") ?? [];
  const origins = args.flags.get("origin") ?? [];
  if (sourcePaths.length === 0) {
    throw new Error("gen needs at least one --source FILE of declared-uniform material");
  }
  if (origins.length > 0 && origins.length !== sourcePaths.length) {
    throw new Error(`--origin must be given once per --source (${sourcePaths.length} sources, ${origins.length} origins)`);
  }
  const capacity = positiveInt(single(args, "encryption-bytes"), "encryption-bytes");
  const capacityRecords = positiveInt(single(args, "auth-records"), "auth-records");
  // §1.1/§5.3: these two are per-store values (the §5.3 bounds scale with
  // them); the freeze threshold is the operator brake's setting. All three
  // are frozen into the header at gen and never revisable afterwards.
  const verifyAttemptLimit =
    single(args, "verify-attempt-limit") === undefined
      ? VERIFY_ATTEMPT_LIMIT_DEFAULT
      : positiveInt(single(args, "verify-attempt-limit"), "verify-attempt-limit");
  const maxAuthLookahead =
    single(args, "max-auth-lookahead") === undefined
      ? MAX_AUTH_LOOKAHEAD_DEFAULT
      : positiveInt(single(args, "max-auth-lookahead"), "max-auth-lookahead");
  const freezeThreshold =
    single(args, "freeze-threshold") === undefined
      ? FREEZE_THRESHOLD_DEFAULT
      : positiveInt(single(args, "freeze-threshold"), "freeze-threshold");

  // §15.2 rollback witness: both flags together or neither. Only
  // separate-state-file is implemented; platform/remote are refused
  // witness-unsupported (never silently downgraded), anything else is a usage
  // error. The path travels verbatim in the header and each peer maintains
  // its own witness file at that path on its host — so it MUST be absolute.
  // Checked here, before any file is written, so a bad witness flag costs
  // nothing.
  const rollback = witnessRollbackFromFlags(single(args, "witness-class"), single(args, "witness-path"));

  // §16 fixed-size records: --record-bytes F freezes every ciphertext at F.
  // No flag writes { kind: "variable" } explicitly into the new header — the
  // default is argued, not silent (§16.2).
  const record = recordSpecFromFlag(single(args, "record-bytes"));

  // One file is one source: the same file declared twice — by repeated path,
  // symlink, or hardlink — is one physical origin counted twice, which the
  // XOR would cancel to zeros. Identity is device+inode, which catches all
  // three (a realpath comparison misses hardlinks).
  const identities = sourcePaths.map((p) => {
    const stat = statSync(p);
    return `${stat.dev}:${stat.ino}`;
  });
  if (new Set(identities).size !== identities.length) {
    throw new Error(
      "the same file (same device and inode) is declared as more than one --source; one file is one source"
    );
  }

  const required = requiredSourceLength(capacity, capacityRecords);
  // readFileSync's Buffer is used directly (a Buffer is a Uint8Array), so the
  // fill(0) below wipes the actual allocation, not a copy of it.
  const buffers: Uint8Array[] = sourcePaths.map((p) => readFileSync(p));
  const short = sourcePaths.filter((_, i) => buffers[i].length < required);
  if (short.length > 0) {
    throw new Refused2(
      "source-too-short",
      `every declared source must supply the complete ${required} bytes (2·(E + 32·N) for E=${capacity}, ` +
        `N=${capacityRecords}); too short: ${short.join(", ")}. Nothing was written.`
    );
  }

  const declarations: SourceDeclaration[] = sourcePaths.map((p, i) => ({
    name: basename(p),
    declaredOrigin: origins[i] ?? "declared by operator at gen; not verified by this tool",
    lengthBytes: buffers[i].length
  }));

  const combined = combineSources(buffers, required);
  // The combined bytes are NEVER inspected or rejected by value. If at
  // least one declared source is uniform and independent of the others,
  // the XOR is exactly uniform over the full space — and every value,
  // including all-zeros, is a legitimate draw. Rejecting any value would
  // condition the accepted distribution and quietly break the exact
  // uniformity this tool claims. Identity of the FILES (dedup above) is
  // checkable; identity of their CONTENT is the operator's declaration,
  // like every other provenance fact here.
  const slices = partition(combined, capacity, capacityRecords);
  combined.fill(0); // in-memory hygiene only; no erasure claim (§1.2 register)
  for (const buffer of buffers) {
    buffer.fill(0);
  }

  const pairId = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));

  const headFor = (direction: PadDirection): HeadV2 => ({
    formatVersion: 2,
    pairId,
    direction,
    mode: "bytes",
    sourceDeclarations: declarations,
    encryption: { capacity, nextOffset: 0 },
    authentication: {
      profile: "wc-one-time-v1",
      tagBits: 128,
      capacityRecords,
      nextSequence: 0,
      verifyAttemptLimit,
      maxCiphertextBytes: MAX_CIPHERTEXT_BYTES,
      maxAuthLookahead
    },
    recordPolicy: { authenticated: "required", downgradeAllowed: false, record },
    rollback,
    verification: {
      failurePolicy: { kind: "freeze", threshold: freezeThreshold },
      failureCount: 0,
      clearedAtFailureCount: 0,
      perSequenceAttempts: {}
    }
  });

  const secretFor = (enc: Uint8Array, auth: Uint8Array): Uint8Array => {
    const secret = new Uint8Array(capacity + AUTH_RECORD_BYTES * capacityRecords);
    secret.set(enc, 0);
    secret.set(auth, capacity);
    return secret;
  };

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = acquireLock(dir);
  if (!lock.ok) {
    throw new Refused2("locked", lock.message);
  }
  const secretAB = secretFor(slices.abEncryption, slices.abAuthentication);
  const secretBA = secretFor(slices.baEncryption, slices.baAuthentication);
  try {
    // §12.4: per half, secret.bin is durable before head.json and the init
    // line exist (initStore2 owns that order). A crash between the halves
    // leaves a half-pair, refused by every verb.
    initStore2(join(dir, SUBDIR2["A->B"]), headFor("A->B"), secretAB);
    initStore2(join(dir, SUBDIR2["B->A"]), headFor("B->A"), secretBA);
  } finally {
    lock.release();
  }
  secretAB.fill(0); // the full secret-body images: wiped like the slices below
  secretBA.fill(0);
  slices.abEncryption.fill(0);
  slices.abAuthentication.fill(0);
  slices.baEncryption.fill(0);
  slices.baAuthentication.fill(0);

  // The manifest is operational metadata for the pad book: declarations and
  // budgets only, NOTHING derived from pad bytes — no hashes, checksums, or
  // fingerprints, ever. Its integrity is the printed copy, not cryptography.
  const manifest = {
    formatVersion: 2,
    pairId,
    createdAt: new Date().toISOString(),
    encryptionBytesPerDirection: capacity,
    authRecordsPerDirection: capacityRecords,
    requiredSourceLength: required,
    sources: declarations.map((d) => ({ ...d, unusedBytes: d.lengthBytes - required })),
    verdict: "Uniform if at least one declared source was uniform and independent of the others."
  };
  const manifestPath = join(dir, "manifest.json");
  writeFileSyncPrivate(manifestPath, JSON.stringify(manifest, null, 2));

  err(`sources: ${sourcePaths.length} declared, XOR-combined over the first ${required} bytes of each.`);
  for (const source of manifest.sources) {
    err(`  ${source.name}: ${source.lengthBytes} bytes declared, ${source.unusedBytes} unused. Origin: ${source.declaredOrigin}`);
  }
  err("Uniform if at least one declared source was uniform and independent of the others.");
  err(`manifest: ${manifestPath} — print it for the pad book; its integrity is operational, not cryptographic.`);
  out(JSON.stringify({ pairId, "A->B": meters(loadHalf2(dir, "A->B")), "B->A": meters(loadHalf2(dir, "B->A")), manifest: manifestPath }));
}

// Manifest writes are ordinary owner-only file writes: the manifest is
// operational metadata, and its durability story is the printed copy.
function writeFileSyncPrivate(path: string, data: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/* ---- burn (SEND, §12.2) ---------------------------------------------------- */

export function burn(args: Args2): void {
  const dir = dirArg(args, "burn");
  const role = roleArg(args);
  if (single(args, "in") === undefined) {
    // The store is owner-only (0600) precisely against local observers, so
    // say when the invocation itself hands them the plaintext.
    err(
      "note: plaintext passed on the command line is visible to every local user via the process table and " +
        "lands in shell history; prefer --in FILE."
    );
  }
  const plaintext = readInputBytes(args, 2);
  withPair(dir, (pair) => {
    // S0 — checks, all free.
    requireNotFrozen(pair);
    const direction = directionFor2(role, "burn");
    const store = pair[direction];
    const { head, effective } = store;
    const halfDir = join(dir, SUBDIR2[direction]);
    // §15.3 preflight, free and for this direction's store only: a store below
    // its rollback witness refuses before anything is consumed.
    witnessPreflight(store);
    // §16.2: on a fixed store the plaintext is framed to exactly F bytes
    // (length prefix hides the message length on the wire), and C = F flows
    // through the unchanged §12.2 path. A plaintext past F − 4 is refused
    // record-size-mismatch here, free, before anything is staged. On a
    // variable store the payload IS the plaintext.
    const record = head.recordPolicy.record;
    let payload: Uint8Array;
    if (record.kind === "fixed") {
      const capacity = frameCapacity(record.bytes);
      if (plaintext.length > capacity) {
        throw new Refused2(
          "record-size-mismatch",
          `this store fixes every record at ${record.bytes} ciphertext bytes, so a message holds at most ` +
            `${capacity} bytes (F − 4); this one is ${plaintext.length}. Split it, or generate a store with a ` +
            "larger --record-bytes. Nothing was burned."
        );
      }
      payload = buildFrame(plaintext, record.bytes);
    } else {
      payload = plaintext;
    }
    const c = payload.length;
    if (c > head.authentication.maxCiphertextBytes) {
      throw new Refused2(
        "oversize-ciphertext",
        `this message is ${c} bytes; MAX_CIPHERTEXT_BYTES is ${head.authentication.maxCiphertextBytes}. ` +
          "Split it into multiple records. Nothing was burned."
      );
    }
    if (effective.nextSequence >= head.authentication.capacityRecords) {
      throw new Refused2(
        "auth-exhausted",
        `authentication records are exhausted (${head.authentication.capacityRecords} of ` +
          `${head.authentication.capacityRecords} used). Auth exhaustion permanently kills sending on this ` +
          "direction; stranded encryption material is destroyed at the retirement ceremony, never spent. " +
          "Nothing was burned."
      );
    }
    if (effective.nextOffset + c > head.encryption.capacity) {
      throw new Refused2(
        "encryption-exhausted",
        `this message needs ${c} encryption bytes but only ${head.encryption.capacity - effective.nextOffset} ` +
          "remain. A one-time pad cannot borrow, wrap, or reuse. Nothing was burned."
      );
    }

    // S1 — staged in memory. Nothing on disk changes.
    const sequence = effective.nextSequence;
    const startOffset = effective.nextOffset;
    const { key, mask } = readAuthRecord(halfDir, head, sequence);
    const pad = readEncryption(halfDir, head, startOffset, c);
    const ciphertext = new Uint8Array(c);
    for (let i = 0; i < c; i += 1) {
      ciphertext[i] = payload[i] ^ pad[i];
    }
    const pairIdBytes = hexToBytes(head.pairId);
    if (pairIdBytes === null || pairIdBytes.length !== 16) {
      throw new Refused2("corrupt-head", `pairId in head.json is not 32 lowercase hex characters: ${head.pairId}`);
    }
    const fields: CanonicalFields = { pairId: pairIdBytes, direction, sequence, startOffset, ciphertext };
    const tag = wcTag(key, mask, fields);
    const envelope: EnvelopeV2 = {
      pairId: head.pairId,
      direction,
      sequence,
      startOffset,
      ciphertextLength: c,
      ciphertext,
      tag
    };

    // S2 — durable commit of BOTH namespaces. secret.bin is not touched:
    // the consumed window and auth record stay physically present, retired
    // by these counters alone. Overwriting them in place was rejected — an
    // in-place write to a live secret.bin can tear the sector at the
    // retired/live boundary on crash and corrupt LIVE material beside it
    // (§1.2); present is not live, and the counters never move backwards.
    const newHead: HeadV2 = {
      ...head,
      encryption: { ...head.encryption, nextOffset: startOffset + c },
      authentication: { ...head.authentication, nextSequence: sequence + 1 }
    };
    commitAdvance(halfDir, newHead, {
      op: "send",
      sequence,
      startOffset,
      consumed: c,
      nextOffset: startOffset + c,
      nextSequence: sequence + 1,
      at: new Date().toISOString()
    });

    // §15.3 advance — after the durable commit, before the emit. A witness
    // write failure withholds the envelope (the material is already retired).
    // burn reserves no verification attempt, so attemptsReserved is unchanged.
    witnessAdvance(store, {
      encryptionNextOffset: startOffset + c,
      authenticationNextSequence: sequence + 1,
      attemptsReserved: store.effective.attemptsReserved
    });

    // S3 — only now does the envelope exist outside this process.
    out(encodeEnvelope2(envelope));
    plaintext.fill(0); // in-memory hygiene only; no erasure claim
    payload.fill(0); // the frame, when fixed (else the same buffer as plaintext)
    pad.fill(0);
    key.fill(0);
    mask.fill(0);
  });
}

/* ---- open (OPEN, §12.3) ---------------------------------------------------- */

export function open(args: Args2): void {
  const dir = dirArg(args, "open");
  const role = roleArg(args);
  const input = readInputText(args, 2);
  withPair(dir, (pair) => {
    const direction = directionFor2(role, "open");
    const store = pair[direction];
    const { head, effective } = store;
    const halfDir = join(dir, SUBDIR2[direction]);

    // O0 — structural, free, before any secret is touched.
    const decoded = decodeEnvelope2(input);
    if (!decoded.ok) {
      throw new Refused2(decoded.reason, decoded.message);
    }
    const envelope = decoded.envelope;
    if (envelope.pairId !== head.pairId) {
      throw new Refused2(
        "wrong-pair",
        `this envelope is addressed to pair ${envelope.pairId}, but this pair is ${head.pairId}. Nothing was burned.`
      );
    }
    if (envelope.direction !== direction) {
      throw new Refused2(
        "wrong-direction",
        `this envelope carries ${envelope.direction} traffic; as ${role} you open ${direction}. Nothing was burned.`
      );
    }
    const sequence = envelope.sequence;
    const startOffset = envelope.startOffset;
    const c = envelope.ciphertextLength;

    // O0 (§16.2): a fixed store accepts only F-byte ciphertexts. A wrong size
    // is structurally not one of this store's records — refused here, before
    // the window checks, costing nothing durable.
    const record = head.recordPolicy.record;
    if (record.kind === "fixed" && c !== record.bytes) {
      throw new Refused2(
        "record-size-mismatch",
        `this store fixes every record at ${record.bytes} ciphertext bytes, but this envelope declares ` +
          `ciphertextLength ${c}. It cannot be one of this store's records. Nothing was burned.`
      );
    }

    // O1 — window, free.
    if (sequence < effective.nextSequence) {
      throw new Refused2(
        "sequence-retired",
        `sequence ${sequence} is below this store's auth high-water ${effective.nextSequence}: a replayed, late, ` +
          "or already-opened record. Its authentication material is retired in this copy — still physically " +
          "present (FORMAT-V2.md §1.2), never again usable. Nothing was burned."
      );
    }
    if (sequence >= head.authentication.capacityRecords) {
      throw new Refused2(
        "sequence-malformed",
        `sequence ${sequence} does not exist in this store (capacityRecords ${head.authentication.capacityRecords}): ` +
          "malformed. Nothing was burned."
      );
    }
    if (sequence >= effective.nextSequence + head.authentication.maxAuthLookahead) {
      throw new Refused2(
        "sequence-out-of-window",
        `sequence ${sequence} is beyond the finite lookahead window [${effective.nextSequence}, ` +
          `${effective.nextSequence + head.authentication.maxAuthLookahead}). More than ` +
          `${head.authentication.maxAuthLookahead} consecutive lost records need explicit operator recovery ` +
          "(truepad2 retire); the channel does not heal silently. Nothing was burned."
      );
    }
    if (startOffset < effective.nextOffset) {
      throw new Refused2(
        "offset-retired",
        `startOffset ${startOffset} is below this store's encryption high-water ${effective.nextOffset}: a ` +
          "legitimate sender's offsets never run behind an accepting receiver. Nothing was burned."
      );
    }
    if (startOffset + c > head.encryption.capacity) {
      throw new Refused2(
        "encryption-exhausted",
        `this record's window [${startOffset}, ${startOffset + c}) runs past the encryption capacity ` +
          `${head.encryption.capacity}. Nothing was burned.`
      );
    }

    // O2 — state gates, free.
    requireNotFrozen(pair);
    // §15.3 preflight, before any verification: a store below its rollback
    // witness refuses here, so no attempt reservation is ever written.
    witnessPreflight(store);
    const attempts = effective.attempts.get(sequence) ?? 0;
    if (attempts >= head.authentication.verifyAttemptLimit) {
      throw new Refused2(
        "sequence-contested",
        `sequence ${sequence} has used all ${head.authentication.verifyAttemptLimit} verification attempts and is ` +
          "permanently contested: never verifiable again under its key and mask. Recovery is an explicit operator " +
          "retire (truepad2 retire). Nothing was burned."
      );
    }

    // O3 — the reservation. Durable BEFORE any verification (§13); a crash
    // from here on loses an attempt, never grants one.
    reserveAttempt(halfDir, sequence);
    const attemptsNow = attempts + 1;

    // §15.3 advance the witness with the new attempt total, still BEFORE the
    // verification — so a later backup-restore that rolls the attempt budget
    // back is refused witness-regressed at preflight. Failed authentications
    // do not move the high-waters, so without this the witness would never
    // learn about the attacker's guesses. A write failure here is the §15.3
    // loss row: the attempt is durable (consumed, the safe direction), the
    // output is not yet reachable, and the next op refuses free.
    witnessAdvance(store, {
      encryptionNextOffset: effective.nextOffset,
      authenticationNextSequence: effective.nextSequence,
      attemptsReserved: effective.attemptsReserved + 1
    });

    // O4 — verify over canonical bytes.
    const { key, mask } = readAuthRecord(halfDir, head, sequence);
    const pairIdBytes = hexToBytes(head.pairId);
    if (pairIdBytes === null || pairIdBytes.length !== 16) {
      throw new Refused2("corrupt-head", `pairId in head.json is not 32 lowercase hex characters: ${head.pairId}`);
    }
    const fields: CanonicalFields = {
      pairId: pairIdBytes,
      direction,
      sequence,
      startOffset,
      ciphertext: envelope.ciphertext
    };
    const expected = wcTag(key, mask, fields);
    if (!tagsEqual(expected, envelope.tag)) {
      // FAIL: burn neither namespace; persist the failure durably, THEN emit.
      // persistAuthFail owns BOTH increments (failureCount and the O3
      // reservation's attempt) — the head passed in carries the effective,
      // journal-reconciled base values, never pre-incremented ones.
      const baseAttempts = { ...head.verification.perSequenceAttempts };
      if (attempts > 0) {
        baseAttempts[String(sequence)] = attempts;
      }
      const failHead: HeadV2 = {
        ...head,
        verification: {
          ...head.verification,
          failureCount: effective.failureCount,
          perSequenceAttempts: baseAttempts
        }
      };
      persistAuthFail(halfDir, failHead, sequence);
      const remaining = head.authentication.verifyAttemptLimit - attemptsNow;
      throw new Refused2(
        "auth-failed",
        `the tag does not verify: a tampered, corrupted, or forged record. No pad material was consumed. ` +
          `Sequence ${sequence} has ${remaining} verification attempt${remaining === 1 ? "" : "s"} left before it ` +
          "is permanently contested. This refusal cost one durable attempt reservation — that is the stated " +
          "availability price of a finite forgery bound (FORMAT-V2.md §8.4)."
      );
    }

    // PASS: plaintext in memory, then O5.
    const pad = readEncryption(halfDir, head, startOffset, c);
    const plaintext = new Uint8Array(c);
    for (let i = 0; i < c; i += 1) {
      plaintext[i] = envelope.ciphertext[i] ^ pad[i];
    }
    const oldOffset = effective.nextOffset;
    const oldSequence = effective.nextSequence;
    const skippedBytes = startOffset - oldOffset;
    const skippedRecords = sequence - oldSequence;

    // O5 — durably retire every position ≤ N in BOTH namespaces, including
    // the skipped material, which is destroyed unused.
    const prunedAttempts: Record<string, number> = {};
    for (const [key2, count] of Object.entries(head.verification.perSequenceAttempts)) {
      if (Number(key2) > sequence) {
        prunedAttempts[key2] = count;
      }
    }
    const newHead: HeadV2 = {
      ...head,
      encryption: { ...head.encryption, nextOffset: startOffset + c },
      authentication: { ...head.authentication, nextSequence: sequence + 1 },
      verification: { ...head.verification, perSequenceAttempts: prunedAttempts }
    };
    commitAdvance(halfDir, newHead, {
      op: "open",
      sequence,
      startOffset,
      consumed: c,
      skipped: skippedBytes,
      nextOffset: startOffset + c,
      nextSequence: sequence + 1,
      at: new Date().toISOString()
    });
    // The retired ranges — used and skipped alike — stay physically present
    // in secret.bin; the durable counters above are what retire them (§1.2).

    // §15.3 advance — after the durable commit (O5), before the release (O6).
    // A witness write failure withholds the plaintext (material already
    // retired). attemptsReserved already advanced at O3; carry it forward.
    witnessAdvance(store, {
      encryptionNextOffset: startOffset + c,
      authenticationNextSequence: sequence + 1,
      attemptsReserved: effective.attemptsReserved + 1
    });

    // §16.2: on a fixed store the decrypted bytes are the frame; the length
    // prefix selects the released plaintext. A prefix past F − 4 cannot come
    // from a conforming sender and cannot be forged below the §5 bound — but
    // if it occurs the material is already retired (O5) and the tool reports
    // record-frame-invalid and EXITS 1. This is an error, not a refusal:
    // nothing was refused before consumption, and nothing is released — the
    // same loss row as a crash after O5. On a variable store the frame is the
    // plaintext.
    let released: Uint8Array = plaintext;
    if (record.kind === "fixed") {
      const parsed = parseFrame(plaintext);
      if (parsed === null) {
        throw new Error(
          `record-frame-invalid: the decrypted frame's length prefix exceeds this store's ${frameCapacity(record.bytes)}-` +
            `byte capacity (F − 4 for F=${record.bytes}). A conforming sender never writes such a frame, and it cannot ` +
            "be forged into existence below the FORMAT-V2.md §5 bound. The record's pad material is already retired " +
            "(O5) and is LOST; no plaintext was released (§16.2, the same loss row as a crash after O5)."
        );
      }
      released = parsed;
    }

    // O6 — only now is the plaintext released, byte-exact.
    if (skippedBytes > 0 || skippedRecords > 0) {
      err(
        `seek: ${skippedBytes} skipped encryption bytes and ${skippedRecords} skipped auth records were retired ` +
          "unused to reach this record (lost-message material is burned as surely as used material)."
      );
    }
    writeAllBytes(1, released);
    released.fill(0); // in-memory hygiene only; no erasure claim
    plaintext.fill(0); // the frame, when fixed (else the same buffer as released)
    pad.fill(0);
    key.fill(0);
    mask.fill(0);
  });
}

/* ---- status (§13 meters) --------------------------------------------------- */

type Meters = {
  pairId: string;
  direction: PadDirection;
  record: RecordSpec;
  encryption: { capacity: number; nextOffset: number; remainingBytes: number };
  authentication: { capacityRecords: number; nextSequence: number; remainingRecords: number; contestedLive: number };
  verification: { failureCount: number; clearedAtFailureCount: number; frozen: boolean };
  maxRemainingSends: number;
  limitedBy: "AUTHENTICATION" | "ENCRYPTION";
};

function meters(store: LoadedStore2): Meters {
  const { head, effective } = store;
  const remainingBytes = head.encryption.capacity - effective.nextOffset;
  const remainingRecords = head.authentication.capacityRecords - effective.nextSequence;
  let contestedLive = 0;
  for (const [sequence, count] of effective.attempts) {
    if (sequence >= effective.nextSequence && count >= head.authentication.verifyAttemptLimit) {
      contestedLive += 1;
    }
  }
  // §13 (PROPOSED display rule): AUTHENTICATION binds when even maximum-size
  // sends cannot spend the encryption budget before the records run out.
  const limitedBy =
    remainingRecords <= Math.ceil(remainingBytes / head.authentication.maxCiphertextBytes)
      ? "AUTHENTICATION"
      : "ENCRYPTION";
  return {
    pairId: head.pairId,
    direction: head.direction,
    record: head.recordPolicy.record,
    encryption: { capacity: head.encryption.capacity, nextOffset: effective.nextOffset, remainingBytes },
    authentication: {
      capacityRecords: head.authentication.capacityRecords,
      nextSequence: effective.nextSequence,
      remainingRecords,
      contestedLive
    },
    verification: {
      failureCount: effective.failureCount,
      clearedAtFailureCount: effective.clearedAtFailureCount,
      frozen: frozenHalf(store)
    },
    maxRemainingSends: remainingRecords,
    limitedBy
  };
}

export function status(args: Args2): void {
  const dir = dirArg(args, "status");
  // §15.3: status reads and reports the witness state per direction but
  // refuses nothing for witness reasons. The witness read happens under the
  // pair lock alongside the meters.
  const snapshot = withPair(dir, (pair) => ({
    "A->B": { meters: meters(pair["A->B"]), witness: witnessReport(pair["A->B"]) },
    "B->A": { meters: meters(pair["B->A"]), witness: witnessReport(pair["B->A"]) }
  }));
  const machine: Record<PadDirection, unknown> = { "A->B": undefined, "B->A": undefined };
  for (const direction of ["A->B", "B->A"] as const) {
    const m = snapshot[direction].meters;
    const w = snapshot[direction].witness;
    err(
      `${direction}: encryption ${m.encryption.remainingBytes}/${m.encryption.capacity} bytes · authentication ` +
        `${m.authentication.remainingRecords}/${m.authentication.capacityRecords} records · maximum remaining ` +
        `sends ${m.maxRemainingSends}`
    );
    err(`${direction}: CHANNEL CAPACITY LIMITED BY: ${m.limitedBy}`);
    if (m.verification.frozen) {
      err(`${direction}: FROZEN (failureCount ${m.verification.failureCount}; clear with truepad2 clear-freeze)`);
    }
    if (w.witnessClass === "separate-state-file") {
      if (!w.reachable) {
        err(
          `${direction}: WITNESS UNREACHABLE (${w.reason}) at ${w.path} — a configured witness that cannot be read ` +
            "fails closed at burn/open/retire; status reports it but refuses nothing (§15.3)."
        );
      } else if (w.comparison === "regressed") {
        err(
          `${direction}: WITNESS REGRESSED — this store is behind its witness at ${w.path}; burn/open/retire will ` +
            "refuse witness-regressed (a restored store, §9.4). status refuses nothing."
        );
      }
    }
    machine[direction] = { ...m, witness: w };
  }
  out(JSON.stringify(machine));
}

/* ---- clear-freeze (§8.4) --------------------------------------------------- */

export function clearFreeze(args: Args2): void {
  const dir = dirArg(args, "clear-freeze");
  withPair(dir, (pair) => {
    let cleared = 0;
    for (const direction of ["A->B", "B->A"] as const) {
      const store = pair[direction];
      if (!frozenHalf(store)) {
        continue;
      }
      const halfDir = join(dir, SUBDIR2[direction]);
      const newHead: HeadV2 = {
        ...store.head,
        verification: {
          ...store.head.verification,
          failureCount: store.effective.failureCount,
          clearedAtFailureCount: store.effective.failureCount
        }
      };
      commitAdvance(halfDir, newHead, {
        op: "clear-freeze",
        atFailureCount: store.effective.failureCount,
        at: new Date().toISOString()
      });
      cleared += 1;
      err(
        `${direction}: freeze cleared at failureCount ${store.effective.failureCount}. Attempt counters are NOT ` +
          "reset — a contested sequence stays contested (§8.4, §13)."
      );
    }
    if (cleared === 0) {
      err("nothing to clear: the pair is not frozen.");
    }
    out(JSON.stringify({ cleared }));
  });
}

/* ---- retire (§8.5 operator recovery; the ceremony references this verb) ---- */

export function retire(args: Args2): void {
  const dir = dirArg(args, "retire");
  const directionFlag = single(args, "direction");
  if (directionFlag !== "a-to-b" && directionFlag !== "b-to-a") {
    throw new Error("--direction a-to-b or --direction b-to-a is required: retire names a direction store, not a role");
  }
  const direction: PadDirection = directionFlag === "a-to-b" ? "A->B" : "B->A";
  const throughSequence = positiveIntOrZero(single(args, "through-sequence"), "through-sequence");
  const throughOffsetFlag = single(args, "through-offset");
  const reason = single(args, "reason") ?? "operator retire";

  withPair(dir, (pair) => {
    const store = pair[direction];
    const { head, effective } = store;
    const halfDir = join(dir, SUBDIR2[direction]);
    // §15.3 preflight, free and before anything is consumed: retire advances
    // high-waters, so a store below its witness refuses here too.
    witnessPreflight(store);
    if (throughSequence >= head.authentication.capacityRecords) {
      throw new Refused2(
        "sequence-malformed",
        `--through-sequence ${throughSequence} does not exist (capacityRecords ${head.authentication.capacityRecords}).`
      );
    }
    if (throughSequence < effective.nextSequence) {
      throw new Refused2(
        "sequence-retired",
        `sequences through ${throughSequence} are already retired (auth high-water ${effective.nextSequence}). ` +
          "Nothing to do; nothing was burned."
      );
    }
    const newNextSequence = throughSequence + 1;
    let newNextOffset = effective.nextOffset;
    if (throughOffsetFlag !== undefined) {
      const throughOffset = positiveIntOrZero(throughOffsetFlag, "through-offset");
      if (throughOffset >= head.encryption.capacity) {
        throw new Refused2("encryption-exhausted", `--through-offset ${throughOffset} runs past capacity ${head.encryption.capacity}.`);
      }
      if (throughOffset + 1 < effective.nextOffset) {
        throw new Refused2("offset-retired", `offsets through ${throughOffset} are already retired (high-water ${effective.nextOffset}).`);
      }
      newNextOffset = throughOffset + 1;
    }

    const prunedAttempts: Record<string, number> = {};
    for (const [key2, count] of Object.entries(head.verification.perSequenceAttempts)) {
      if (Number(key2) >= newNextSequence) {
        prunedAttempts[key2] = count;
      }
    }
    const newHead: HeadV2 = {
      ...head,
      encryption: { ...head.encryption, nextOffset: newNextOffset },
      authentication: { ...head.authentication, nextSequence: newNextSequence },
      verification: { ...head.verification, perSequenceAttempts: prunedAttempts }
    };
    commitAdvance(halfDir, newHead, {
      op: "retire",
      toSequence: newNextSequence,
      toOffset: newNextOffset,
      reason,
      at: new Date().toISOString()
    });
    // §15.3 advance — after the durable commit. A witness write failure exits
    // 1 with the loss row; the retire is durable regardless. retire reserves
    // no verification attempt, so attemptsReserved is unchanged.
    witnessAdvance(store, {
      encryptionNextOffset: newNextOffset,
      authenticationNextSequence: newNextSequence,
      attemptsReserved: effective.attemptsReserved
    });
    // Retired material stays physically present in secret.bin; the durable
    // counters above are the retirement (§1.2). "Destroyed" below is the
    // channel's meaning — never usable again — not physical erasure.
    err(
      `${direction}: retired auth sequences [${effective.nextSequence}, ${newNextSequence}) and encryption ` +
        `[${effective.nextOffset}, ${newNextOffset}) — destroyed unused, never spent. Reason: ${reason}. ` +
        "State never moves backwards; this action is irreversible."
    );
    out(JSON.stringify({ direction, nextSequence: newNextSequence, nextOffset: newNextOffset }));
  });
}

function positiveIntOrZero(value: string | undefined, flag: string): number {
  const parsed = value === undefined ? NaN : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${flag} must be a non-negative integer`);
  }
  return parsed;
}

/* ---- destroy (§17 destruction) ---------------------------------------------
 * `destroy` tears one pair down for good: it removes the pair's accessible
 * material and writes a non-secret tombstone recording the intent. It is
 * deliberately tolerant of a corrupt store — a store too damaged for
 * loadStore2 is still a store an operator must be able to destroy (§17.1) —
 * so it runs under the pair lock WITHOUT going through withPair (which would
 * refuse a corrupt or half store before destruction could begin).
 *
 * The zero-overwrite of secret.bin below (§17.2 step 3) is a DELIBERATE
 * one-time destruction of a pair being retired for good: the whole store is
 * torn down and its files unlinked immediately after. It is NOT the
 * per-operation active-store zeroization that Phase 3.5 removed. That one
 * overwrote a newly retired range of a still-LIVE secret.bin after every
 * burn/open, and was removed because an in-place write to a live file can
 * tear the sector at the retired/live boundary and corrupt LIVE material
 * beside it (§1.2). Here nothing beside it is live and the file is about to
 * be unlinked, so that tear risk is moot — but the overwrite still proves
 * nothing about the medium and claims no erasure (§17.2). The two must never
 * be confused: one advances a store, this one ends it.
 */

const UNREADABLE_PAIR_TOKEN = "destroy-unreadable-pair";

// The verbatim §17 sentence — pinned identically in the README, in the
// tombstone's `limitation` field, and in the stderr limitation block.
const DESTROY_LIMITATION =
  "Software can forget its reference to pad material; it cannot prove that flash forgot the bytes.";

const TOMBSTONE_FILE = "destroyed.json";

type HalfSummary = { pairId: string | null; nextOffset: number | null; nextSequence: number | null };

// An existing tombstone (a resume of an interrupted teardown). `record` is the
// original parsed object when it is well-formed enough to preserve — destroy
// keeps it rather than rewriting destroyedAt/reason as if destruction began
// again; `pairId` is lifted for the confirmation token when head.json is gone.
type ExistingTombstone = { exists: boolean; pairId: string | null; record: Record<string, unknown> | null };

function readTombstone(dir: string): ExistingTombstone {
  const path = join(dir, TOMBSTONE_FILE);
  if (!existsSync(path)) {
    return { exists: false, pairId: null, record: null };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const pairId = typeof obj.pairId === "string" && /^[0-9a-f]{32}$/.test(obj.pairId) ? obj.pairId : null;
      // Preserve only a well-formed original; a corrupt tombstone still marks
      // the boundary but its intent cannot be trusted, so it is rewritten.
      return { exists: true, pairId, record: obj.formatVersion === 2 ? obj : null };
    }
  } catch {
    /* unparseable tombstone: the boundary stands, but rewrite a clean one */
  }
  return { exists: true, pairId: null, record: null };
}

// Best-effort read of one half's identifying pairId and final high-waters for
// the tombstone and the confirmation token. A clean load gives the
// journal-reconciled effective high-waters; a store too corrupt to load often
// still has a head.json that parses, from which the pairId (and its raw
// counters) can be lifted. Everything fails soft to null — destroy proceeds on
// a corrupt store (§17.1), it never requires a clean load.
function readHalfSummary(halfDir: string): HalfSummary {
  const loaded = loadStore2(halfDir);
  if (loaded.ok) {
    return {
      pairId: loaded.head.pairId,
      nextOffset: loaded.effective.nextOffset,
      nextSequence: loaded.effective.nextSequence
    };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(halfDir, HEAD_FILE), "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const pairId = typeof obj.pairId === "string" && /^[0-9a-f]{32}$/.test(obj.pairId) ? obj.pairId : null;
      return { pairId, nextOffset: safeCountField(obj.encryption, "nextOffset"), nextSequence: safeCountField(obj.authentication, "nextSequence") };
    }
  } catch {
    /* head.json missing or unparseable — the pairId stays unreadable */
  }
  return { pairId: null, nextOffset: null, nextSequence: null };
}

function safeCountField(container: unknown, field: string): number | null {
  if (typeof container !== "object" || container === null) {
    return null;
  }
  const value = (container as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function highWatersOrNull(summary: HalfSummary): { nextOffset: number; nextSequence: number } | null {
  return summary.nextOffset !== null && summary.nextSequence !== null
    ? { nextOffset: summary.nextOffset, nextSequence: summary.nextSequence }
    : null;
}

// fsync a directory handle where the platform allows it (skipped otherwise),
// mirroring store2's private primitive rather than widening its surface.
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

// Atomic-replace + fsync of one file at <dir>/<name>, 0600 — the §10 durable
// write, reimplemented here (store2's writeFileDurably is not exported) for
// the tombstone alone.
function writeFileDurablyAt(dir: string, name: string, data: string): void {
  const tmp = join(dir, `${name}.tmp.${process.pid}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeAllBytes(fd, new TextEncoder().encode(data));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, name));
  fsyncDir(dir);
}

// §17.2 step 3: best-effort zero-overwrite of one half's secret.bin, then
// fsync. Failures are reported and swallowed — the file is unlinked regardless
// (step 4), and the overwrite is never claimed as erasure. See the section
// comment: this is a torn-down store, not the removed per-op zeroize.
function overwriteSecretWithZeros(halfDir: string): void {
  const secretPath = join(halfDir, SECRET_FILE);
  let size: number;
  try {
    size = statSync(secretPath).size;
  } catch {
    return; // no secret.bin on this (corrupt or partial) half — nothing to overwrite
  }
  try {
    const fd = openSync(secretPath, "r+");
    try {
      const chunk = new Uint8Array(Math.min(size, 1 << 16));
      let pos = 0;
      while (pos < size) {
        const want = Math.min(chunk.length, size - pos);
        let off = 0;
        while (off < want) {
          const written = writeSync(fd, chunk, off, want - off, pos + off);
          if (written <= 0) {
            throw new Error(`short write at offset ${pos + off}`);
          }
          off += written;
        }
        pos += want;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    err(
      `note: could not zero-overwrite ${secretPath} before unlink (${(error as Error).message}); the file is ` +
        "removed regardless. The overwrite is best-effort and proves nothing about the medium (§17.2)."
    );
  }
}

export function destroy(args: Args2): void {
  const dir = dirArg(args, "destroy");
  const confirm = single(args, "confirm");
  const reason = single(args, "reason") ?? "operator destroy";

  const lock = acquireLock(dir);
  if (!lock.ok) {
    throw new Refused2("locked", lock.message);
  }
  try {
    // §17.1: a v1 store is refused; v1 material is handled by v1's own tooling.
    // (Only when this is NOT already a tombstoned v2 pair: a destroyed pair
    // may have lost the head.json that distinguishes it, and a leftover
    // pad.json must not misroute a destroy-resume to v1.)
    const priorTombstone = readTombstone(dir);
    if (!priorTombstone.exists) {
      refuseIfV1Store(dir);
    }

    const summaries: Record<PadDirection, HalfSummary> = {
      "A->B": readHalfSummary(join(dir, SUBDIR2["A->B"])),
      "B->A": readHalfSummary(join(dir, SUBDIR2["B->A"]))
    };
    const pairId = summaries["A->B"].pairId ?? summaries["B->A"].pairId ?? priorTombstone.pairId;

    // §17.1 confirmation: --confirm MUST equal the pair's pairId where any
    // half's head.json (or, on a resume, the existing tombstone) yields one;
    // for a pair too corrupt to yield a pairId the literal token
    // destroy-unreadable-pair is required instead. The expected pairId is
    // deliberately NOT echoed — the operator confirms by knowing it (pad book /
    // head.json / tombstone), the way a destructive gesture should.
    const requiredToken = pairId ?? UNREADABLE_PAIR_TOKEN;
    if (confirm !== requiredToken) {
      throw new Refused2(
        "destroy-unconfirmed",
        pairId === null
          ? `this pair is too corrupt to confirm by pairId — no half's ${HEAD_FILE} nor the tombstone yields one — so ` +
              `destroy requires --confirm ${UNREADABLE_PAIR_TOKEN} for it. Re-run with that literal token. Nothing was touched.`
          : `--confirm must equal the pair's pairId to destroy it. It is NOT echoed here — read it from the pad book, ` +
              `a half's ${HEAD_FILE}, or ${TOMBSTONE_FILE} and pass it verbatim. Nothing was touched.`
      );
    }

    // Already fully torn down (tombstone present, both halves gone): destroy is
    // idempotent — report the existing destruction and change nothing. There
    // is nothing to resurrect and nothing left to remove.
    const alreadyGone =
      priorTombstone.exists &&
      !existsSync(join(dir, SUBDIR2["A->B"])) &&
      !existsSync(join(dir, SUBDIR2["B->A"]));
    if (alreadyGone) {
      err(`${dir} was already destroyed; ${TOMBSTONE_FILE} stands and nothing remained to remove.`);
      err(DESTROY_LIMITATION);
      out(JSON.stringify({ destroyed: true, alreadyDestroyed: true, pairId, tombstone: join(dir, TOMBSTONE_FILE) }));
      return;
    }

    // §17.2 order is normative.
    // 2 — the tombstone: non-secret recorded intent, durable, survives the
    // destruction. On a RESUME (a well-formed tombstone already exists) it is
    // PRESERVED, not rewritten — its original destroyedAt/reason/high-waters
    // are the historical truth, and a retry after a crash must not restamp
    // them as if destruction began later. Otherwise it is written fresh.
    if (priorTombstone.record !== null) {
      err(`resuming an interrupted destroy: ${TOMBSTONE_FILE} already records the intent; finishing cleanup.`);
    } else {
      const tombstone = {
        formatVersion: 2,
        pairId,
        destroyedAt: new Date().toISOString(),
        reason,
        finalHighWaters: {
          "A->B": highWatersOrNull(summaries["A->B"]),
          "B->A": highWatersOrNull(summaries["B->A"])
        },
        limitation: DESTROY_LIMITATION
      };
      writeFileDurablyAt(dir, TOMBSTONE_FILE, JSON.stringify(tombstone, null, 2));
    }

    // 3 — per half: best-effort zero-overwrite of secret.bin + fsync.
    for (const direction of ["A->B", "B->A"] as const) {
      overwriteSecretWithZeros(join(dir, SUBDIR2[direction]));
    }

    // 4 — unlink the three files, remove the half dirs, fsync the pair dir.
    // manifest.json and the tombstone at the pair root remain: the pair's
    // non-secret record.
    for (const direction of ["A->B", "B->A"] as const) {
      const halfDir = join(dir, SUBDIR2[direction]);
      for (const name of [SECRET_FILE, HEAD_FILE, JOURNAL_FILE]) {
        try {
          unlinkSync(join(halfDir, name));
        } catch {
          /* already gone on a corrupt or partial store */
        }
      }
      try {
        rmSync(halfDir, { recursive: true, force: true });
      } catch (error) {
        err(`note: could not remove ${halfDir} (${(error as Error).message}); its files were unlinked first.`);
      }
    }
    fsyncDir(dir);

    // 5 — the §17.2 limitation block, verbatim sentence first, then the
    // storage-specific caveats. A configured witness is deliberately untouched
    // (§17.2): its counters are non-secret, monotone, and harmless for a pair
    // that no longer exists.
    err(DESTROY_LIMITATION);
    err(
      "The zero-overwrite above is best-effort and proves nothing about the medium: a copy-on-write filesystem " +
        "(APFS among them) may preserve the pre-overwrite blocks; SSD wear leveling may preserve any block; and " +
        "backups are outside this tool's reach. Physical destruction of the medium is a ceremony step " +
        "(docs/CEREMONY.md), not a software claim. A configured rollback witness is left untouched."
    );

    out(JSON.stringify({ destroyed: true, pairId, tombstone: join(dir, TOMBSTONE_FILE), reason }));
  } finally {
    lock.release();
  }
}

/* ---- ceremony (Phase 3; the verbs live in ceremony.ts) ---------------------- */

function ceremony(args: Args2): void {
  const sub = args.positional[1];
  if (sub === "create") {
    ceremonyCreate(args);
    return;
  }
  if (sub === "verify") {
    ceremonyVerify(args);
    return;
  }
  throw new Error("ceremony needs a subcommand: create or verify");
}

/* ---- entry ----------------------------------------------------------------- */

const GEN_FLAGS = [
  "source",
  "origin",
  "encryption-bytes",
  "auth-records",
  "verify-attempt-limit",
  "max-auth-lookahead",
  "freeze-threshold",
  "witness-class",
  "witness-path",
  "record-bytes"
] as const;

// Every flag each verb consumes; anything else is refused in main().
const ALLOWED_FLAGS: Record<string, readonly string[]> = {
  gen: GEN_FLAGS,
  burn: ["as", "in"],
  open: ["as", "in"],
  status: [],
  "clear-freeze": [],
  retire: ["direction", "through-sequence", "through-offset", "reason"],
  destroy: ["confirm", "reason"],
  ceremony: [...GEN_FLAGS, "medium-a", "medium-b", ...CEREMONY_ASSERTIONS.map((assertion) => assertion.flag)]
};

export function main(argv: string[]): number {
  err(BANNER2);
  // §13, ledger N3: these flags do not exist in v2, in any position, with or
  // without a value, in either the bare or the = spelling — refused outright
  // rather than silently ignored. A v2 pair is always authenticated; there
  // is no downgrade, no legacy bridge, and no force path.
  const forbidden = argv.filter((a) => /^--(no-auth|legacy|force)(=|$)/.test(a));
  if (forbidden.length > 0) {
    err(
      `${[...new Set(forbidden)].join(", ")}: no such flag exists in v2. A v2 pair is always authenticated; ` +
        "there is no downgrade, no legacy bridge, and no force path (docs/FORMAT-V2.md §13)."
    );
    return 1;
  }
  let args: Args2;
  try {
    args = parseArgs2(argv);
  } catch (error) {
    err((error as Error).message);
    err(USAGE2);
    return 1;
  }
  const command = args.positional[0];
  // Unknown flags are refused, never silently ignored: a misspelled gen knob
  // silently falling back to its default would freeze the wrong limits into
  // the header for the life of the store (§1.1: never revisable).
  if (command !== undefined && Object.hasOwn(ALLOWED_FLAGS, command)) {
    const allowed = new Set(ALLOWED_FLAGS[command]);
    const unknown = [...args.flags.keys()].filter((name) => !allowed.has(name));
    if (unknown.length > 0) {
      err(
        `unknown flag${unknown.length === 1 ? "" : "s"} for ${command}: ` +
          `${unknown.map((name) => `--${name}`).join(", ")} — refused rather than silently ignored.`
      );
      err(USAGE2);
      return 1;
    }
  }
  const commands: Record<string, (a: Args2) => void> = {
    gen,
    burn,
    open,
    status,
    "clear-freeze": clearFreeze,
    retire,
    destroy,
    ceremony
  };
  if (command === undefined || !Object.hasOwn(commands, command)) {
    err(USAGE2);
    return 1;
  }
  try {
    commands[command](args);
    return 0;
  } catch (error) {
    if (error instanceof Refused2) {
      err(`refused: ${error.type} — ${error.message}`);
      return 2;
    }
    err(`error: ${(error as Error).message}`);
    return 1;
  }
}

// Run only when this file is the process entry (node src/cli/v2/truepad2.ts).
// Through bin/truepad2.mjs, argv[1] is the launcher and this is a no-op.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
