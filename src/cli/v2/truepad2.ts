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

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
import { combineSources, partition, requiredSourceLength } from "../../core/partition2.ts";
import { acquireLock } from "../lock.ts";
import {
  commitAdvance,
  initStore2,
  loadStore2,
  persistAuthFail,
  readAuthRecord,
  readEncryption,
  reserveAttempt,
  zeroizeRetired,
  type HeadV2,
  type LoadedStore2,
  type SourceDeclaration
} from "./store2.ts";
import { CEREMONY_ASSERTIONS, ceremonyCreate, ceremonyVerify } from "./ceremony.ts";

export const BANNER2 =
  "truepad2: reuse-safe pad handling with authenticated envelopes (Store Format v2; docs/FORMAT-V2.md is the\n" +
  "binding spec). Forgery of a record is bounded per FORMAT-V2.md §5, conditional on ceremony-grade source\n" +
  "material and the §10 durability scope. This is pad handling, not a messaging system, and not a\n" +
  "recommendation to use one-time pads for real traffic.";

export const USAGE2 = `usage:
  truepad2 gen          <dir> --source FILE [--source FILE ...] [--origin TEXT ...] --encryption-bytes E --auth-records N
                        [--verify-attempt-limit 8] [--max-auth-lookahead 64] [--freeze-threshold 32]
  truepad2 burn         <dir> --as A|B (TEXT | --in FILE)
  truepad2 open         <dir> --as A|B (ENVELOPE-JSON | --in FILE)
  truepad2 status       <dir>
  truepad2 clear-freeze <dir>
  truepad2 retire       <dir> --direction a-to-b|b-to-a --through-sequence S [--through-offset O] [--reason TEXT]
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
  | "ceremony-incomplete";

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

// A pair directory must hold BOTH v2 halves. A lone half is a crashed gen;
// a v1 pad.json anywhere in the pair is a v1 store, refused with no bridge.
function requirePair2(dir: string): void {
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
function withPair<T>(dir: string, fn: (pair: LoadedPair) => T): T {
  const lock = acquireLock(dir);
  if (!lock.ok) {
    throw new Refused2("locked", lock.message);
  }
  try {
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

/* ---- gen (Phase 1: multi-source generation, FORMAT-V2.md §7) -------------- */

function positiveInt(value: string | undefined, flag: string): number {
  const parsed = value === undefined ? NaN : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${flag} must be a positive integer`);
  }
  return parsed;
}

export function gen(args: Args2): void {
  const dir = dirArg(args, "gen");
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
  // Tripwire, not a uniformity check: an all-zero combination means the
  // declared sources cancelled each other exactly (identical content under
  // different names), which the identity check above cannot see. Uniform
  // material is all-zero with probability 2^-8L — never in practice.
  if (combined.every((byte) => byte === 0)) {
    throw new Error(
      "the combined source material is all zeros: the declared sources cancelled each other (identical content " +
        "under different names?). One file is one source. Nothing was written."
    );
  }
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
    recordPolicy: { authenticated: "required", downgradeAllowed: false },
    rollback: { witnessClass: "none", config: {} },
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
    const c = plaintext.length;
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
      ciphertext[i] = plaintext[i] ^ pad[i];
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

    // S2 — durable commit of BOTH namespaces, then hygiene.
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
    zeroizeRetired(halfDir, newHead, [
      { offset: startOffset, length: c },
      { offset: head.encryption.capacity + AUTH_RECORD_BYTES * sequence, length: AUTH_RECORD_BYTES }
    ]);

    // S3 — only now does the envelope exist outside this process.
    out(encodeEnvelope2(envelope));
    plaintext.fill(0); // in-memory hygiene only; no erasure claim
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

    // O1 — window, free.
    if (sequence < effective.nextSequence) {
      throw new Refused2(
        "sequence-retired",
        `sequence ${sequence} is below this store's auth high-water ${effective.nextSequence}: a replayed, late, ` +
          "or already-opened record. Its authentication material is gone from this copy. Nothing was burned."
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
    zeroizeRetired(halfDir, newHead, [
      { offset: oldOffset, length: startOffset + c - oldOffset },
      { offset: head.encryption.capacity + AUTH_RECORD_BYTES * oldSequence, length: AUTH_RECORD_BYTES * (sequence - oldSequence + 1) }
    ]);

    // O6 — only now is the plaintext released, byte-exact.
    if (skippedBytes > 0 || skippedRecords > 0) {
      err(
        `seek: ${skippedBytes} skipped encryption bytes and ${skippedRecords} skipped auth records were retired ` +
          "unused to reach this record (lost-message material is burned as surely as used material)."
      );
    }
    writeAllBytes(1, plaintext);
    plaintext.fill(0); // in-memory hygiene only; no erasure claim
    pad.fill(0);
    key.fill(0);
    mask.fill(0);
  });
}

/* ---- status (§13 meters) --------------------------------------------------- */

type Meters = {
  pairId: string;
  direction: PadDirection;
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
  const snapshot = withPair(dir, (pair) => ({ "A->B": meters(pair["A->B"]), "B->A": meters(pair["B->A"]) }));
  for (const direction of ["A->B", "B->A"] as const) {
    const m = snapshot[direction];
    err(
      `${direction}: encryption ${m.encryption.remainingBytes}/${m.encryption.capacity} bytes · authentication ` +
        `${m.authentication.remainingRecords}/${m.authentication.capacityRecords} records · maximum remaining ` +
        `sends ${m.maxRemainingSends}`
    );
    err(`${direction}: CHANNEL CAPACITY LIMITED BY: ${m.limitedBy}`);
    if (m.verification.frozen) {
      err(`${direction}: FROZEN (failureCount ${m.verification.failureCount}; clear with truepad2 clear-freeze)`);
    }
  }
  out(JSON.stringify(snapshot));
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
    zeroizeRetired(halfDir, newHead, [
      { offset: effective.nextOffset, length: newNextOffset - effective.nextOffset },
      {
        offset: head.encryption.capacity + AUTH_RECORD_BYTES * effective.nextSequence,
        length: AUTH_RECORD_BYTES * (newNextSequence - effective.nextSequence)
      }
    ]);
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
  "freeze-threshold"
] as const;

// Every flag each verb consumes; anything else is refused in main().
const ALLOWED_FLAGS: Record<string, readonly string[]> = {
  gen: GEN_FLAGS,
  burn: ["as", "in"],
  open: ["as", "in"],
  status: [],
  "clear-freeze": [],
  retire: ["direction", "through-sequence", "through-offset", "reason"],
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
