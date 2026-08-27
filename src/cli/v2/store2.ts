/* ============================================================================
 * truepad2 store — one v2 direction store on disk, advanced durably
 * ----------------------------------------------------------------------------
 * Node only. Imports core types; never imports the exhibit. Owns one
 * direction store per docs/FORMAT-V2.md §1:
 *
 *   <dir>/head.json    non-secret header (§1.1) — no secret ever appears
 *                      here. Rewritten atomically: write head.json.tmp.<pid>
 *                      in full (short writes detected), fsync, rename over
 *                      head.json, fsync the directory. Created 0600.
 *   <dir>/secret.bin   the secret body (§1.2): exactly E + 32·N bytes laid
 *                      out [encryption slice E][auth record per sequence:
 *                      K (16) then R (16)]. Written durably at gen BEFORE
 *                      head.json or any journal line exists (§12.4) — the
 *                      reverse order could survive a power loss at the
 *                      correct length with zeroed blocks, undetectable
 *                      thereafter — and never written again for the life
 *                      of the store. Which bytes are live is decided by
 *                      the header/journal counters, never by file content.
 *   <dir>/journal.log  append-only, fsynced, 0600. One JSON line per event
 *                      (§12.1) — the durable authority that the header's
 *                      counters merely cache.
 *
 * Commit orders, non-negotiable:
 *   advance (SEND S2 / OPEN O5 / operator actions): rewrite head.json
 *     atomically, then append the journal line, each durable — only then
 *     may the caller emit anything.
 *   attempt reservation (OPEN O3): journal append only; verification must
 *     not begin until it is durable.
 *   auth failure (OPEN O4): journal append FIRST, header rewrite second —
 *     the one deliberate inversion; load-time reconciliation takes the
 *     maximum, so either half surviving a crash never under-counts.
 * Load-time reconciliation (§12.1): header high-waters below the journal's
 * maxima are refused (regressed-below-mark — a header older than its own
 * history); attempt counts, failureCount, and clearedAtFailureCount resolve
 * as the elementwise maximum and never refuse — a crash can only make the
 * machine believe in more spent attempts than the attacker truly got.
 *
 * This module is storage and reconciliation only. It computes no tag and
 * decides no window, budget, freeze, or verification outcome — those belong
 * to the caller — and the pair-level lock belongs to lock.ts. The v1
 * durability primitives it mirrors (writeAll, atomic replace,
 * append-then-fsync, fsyncDir) are reimplemented here because v1's store.ts
 * does not export them; no v1 file is modified.
 *
 * Limitation, stated rather than papered over: this defends against crashes
 * and against loading a stale copy of head.json. It does not defend against
 * an operator restoring the whole directory from a backup, which regresses
 * the store and its journal together (§9.4, open until Phase 4). Durability
 * is verified on Linux ext4 only; fsync on a directory handle is skipped
 * where one cannot be opened, and macOS fsync does not guarantee media
 * flush without F_FULLFSYNC, which these primitives do not issue (§10.2).
 * Retired ranges stay physically present in secret.bin for the life of
 * the store: retirement is the durable counters' doing alone, and this
 * module never writes secret.bin after gen — an in-place overwrite of a
 * live file has no sector-write atomicity promise here, so a crash mid-
 * write could tear the sector at the retired/live boundary and corrupt
 * LIVE material next to it (§1.2). Software can forget its reference to
 * pad material; it cannot prove that the storage medium forgot the
 * bytes. Destruction and its limits belong to Phase 6.
 * ========================================================================= */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeSync
} from "node:fs";
import { join } from "node:path";
import type { PadDirection } from "../../core/pad.ts";

export const HEAD_FILE = "head.json";
export const SECRET_FILE = "secret.bin";
export const JOURNAL_FILE = "journal.log";

// The v1 store's pad file: its presence without head.json marks a v1 store.
const V1_PAD_FILE = "pad.json";

// Store material and its history are the operator's secret: owner-only.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// §4: not a per-store knob. A header carrying any other value is refused
// corrupt-head; the value is pinned here rather than imported so this module
// depends on core types only (the constant also lives in core/wc-one-time.ts).
const MAX_CIPHERTEXT_BYTES = 1048576;

const AUTH_RECORD_BYTES = 32; // K (16) + R (16), §1.2
const KEY_BYTES = 16;

/* ---- header shape (§1.1) -------------------------------------------------- */

export type SourceDeclaration = {
  name: string;
  declaredOrigin: string;
  lengthBytes: number;
};

export type HeadV2 = {
  formatVersion: 2;
  pairId: string; // 32 lowercase hex characters — an identifier, never a secret
  direction: PadDirection;
  mode: "bytes";
  sourceDeclarations: SourceDeclaration[];
  encryption: { capacity: number; nextOffset: number };
  authentication: {
    profile: "wc-one-time-v1";
    tagBits: number; // pinned 128 (§2.2); validated on load
    capacityRecords: number;
    nextSequence: number;
    verifyAttemptLimit: number;
    maxCiphertextBytes: number; // MUST equal 1048576 (§4)
    maxAuthLookahead: number;
  };
  recordPolicy: { authenticated: "required"; downgradeAllowed: false };
  rollback: { witnessClass: "none"; config: Record<string, never> };
  verification: {
    failurePolicy: { kind: "freeze"; threshold: number };
    failureCount: number;
    clearedAtFailureCount: number;
    perSequenceAttempts: Record<string, number>;
  };
};

/* ---- journal shape (§12.1) ------------------------------------------------ */

// `at` is operational metadata (an ISO timestamp), never load-bearing:
// validation does not refuse on it, and reconciliation never reads it.
export type JournalRecord =
  | { op: "init"; pairId: string; direction: PadDirection; capacity: number; capacityRecords: number; at: string }
  | { op: "send"; sequence: number; startOffset: number; consumed: number; nextOffset: number; nextSequence: number; at: string }
  | { op: "attempt"; sequence: number; at: string }
  | { op: "auth-fail"; sequence: number; failureCount: number; at: string }
  | { op: "open"; sequence: number; startOffset: number; consumed: number; skipped: number; nextOffset: number; nextSequence: number; at: string }
  | { op: "retire"; toSequence: number; toOffset: number; reason: string; at: string }
  | { op: "clear-freeze"; atFailureCount: number; at: string };

/* ---- results -------------------------------------------------------------- */

export type Store2Refusal = {
  ok: false;
  reason:
    | "no-store"
    | "v1-store"
    | "corrupt-head"
    | "corrupt-secret-body"
    | "corrupt-store"
    | "corrupt-journal"
    | "regressed-below-mark";
  message: string;
};

// The reconciled truth after the §12.1 maximum rule: counters from the
// header (already checked at-or-above the journal), attempt/failure caches
// as the elementwise max of header and journal.
export type EffectiveState = {
  nextOffset: number;
  nextSequence: number;
  attempts: Map<number, number>;
  failureCount: number;
  clearedAtFailureCount: number;
};

export type LoadedStore2 = { ok: true; head: HeadV2; effective: EffectiveState };

/* ---- durability primitives (v1 store.ts idioms, reimplemented) ------------ */

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

// write(2) may write fewer bytes than asked (disk full, RLIMIT_FSIZE); Node's
// writeSync does not loop. Loop until every byte is down, or throw before
// anything is renamed into place.
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

// Write `data` to <dir>/<name> atomically: per-process temp file (full write
// verified), fsync, rename, fsync dir.
function writeFileDurably(dir: string, name: string, data: string): void {
  const tmp = join(dir, `${name}.tmp.${process.pid}`);
  const fd = openSync(tmp, "w", FILE_MODE);
  try {
    writeAll(fd, Buffer.from(data, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, name));
  fsyncDir(dir);
}

function appendLineDurably(dir: string, name: string, line: string): void {
  const fd = openSync(join(dir, name), "a", FILE_MODE);
  try {
    writeAll(fd, Buffer.from(`${line}\n`, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDir(dir);
}

// readSync may return fewer bytes than asked; loop, and throw on EOF — a
// caller that reads past the body has broken an invariant loadStore2 checks.
function readExactly(fd: number, length: number, position: number): Uint8Array {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const got = readSync(fd, buf, done, length - done, position + done);
    if (got <= 0) {
      throw new Error(`short read: ${done} of ${length} bytes at ${SECRET_FILE} offset ${position}`);
    }
    done += got;
  }
  return new Uint8Array(buf); // a copy — callers may zero it independently
}

/* ---- small validators ----------------------------------------------------- */

const HEX_32 = /^[0-9a-f]{32}$/;
const DECIMAL_KEY = /^(?:0|[1-9][0-9]*)$/;

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Exact key set: a header is validated whole — nothing missing, nothing
// unexpected — rather than partially trusted. Returns a description of the
// difference, or null when the keys match exactly.
function keyMismatch(obj: Record<string, unknown>, expected: readonly string[], where: string): string | null {
  const missing = expected.filter((key) => !Object.hasOwn(obj, key));
  const extra = Object.keys(obj).filter((key) => !expected.includes(key));
  if (missing.length === 0 && extra.length === 0) {
    return null;
  }
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    parts.push(`unexpected ${extra.join(", ")}`);
  }
  return `${where}: ${parts.join("; ")}`;
}

/* ---- header validation (§1.1) --------------------------------------------- */

// Validate a parsed head.json strictly against the §1.1 shape. Returns a
// freshly constructed HeadV2 (never the raw parse — extra structure cannot
// ride along), or the reason it fails.
function validateHead(raw: unknown): { head: HeadV2 } | { why: string } {
  if (!isRecord(raw)) {
    return { why: "not a JSON object" };
  }
  const topKeys = [
    "formatVersion",
    "pairId",
    "direction",
    "mode",
    "sourceDeclarations",
    "encryption",
    "authentication",
    "recordPolicy",
    "rollback",
    "verification"
  ] as const;
  const topMismatch = keyMismatch(raw, topKeys, "top-level keys");
  if (topMismatch) {
    return { why: topMismatch };
  }
  if (raw.formatVersion !== 2) {
    return { why: `formatVersion must be the integer 2 (found ${JSON.stringify(raw.formatVersion)})` };
  }
  if (typeof raw.pairId !== "string" || !HEX_32.test(raw.pairId)) {
    return { why: "pairId must be exactly 32 lowercase hex characters" };
  }
  if (raw.direction !== "A->B" && raw.direction !== "B->A") {
    return { why: `direction must be "A->B" or "B->A" (found ${JSON.stringify(raw.direction)})` };
  }
  if (raw.mode !== "bytes") {
    return { why: `mode must be "bytes" (found ${JSON.stringify(raw.mode)})` };
  }

  if (!Array.isArray(raw.sourceDeclarations)) {
    return { why: "sourceDeclarations must be an array" };
  }
  const sourceDeclarations: SourceDeclaration[] = [];
  for (const [index, entry] of raw.sourceDeclarations.entries()) {
    if (!isRecord(entry)) {
      return { why: `sourceDeclarations[${index}] is not an object` };
    }
    const entryMismatch = keyMismatch(entry, ["name", "declaredOrigin", "lengthBytes"], `sourceDeclarations[${index}]`);
    if (entryMismatch) {
      return { why: entryMismatch };
    }
    if (typeof entry.name !== "string" || typeof entry.declaredOrigin !== "string" || !isSafeCount(entry.lengthBytes)) {
      return { why: `sourceDeclarations[${index}] fields are malformed` };
    }
    sourceDeclarations.push({ name: entry.name, declaredOrigin: entry.declaredOrigin, lengthBytes: entry.lengthBytes });
  }

  if (!isRecord(raw.encryption)) {
    return { why: "encryption is not an object" };
  }
  const encMismatch = keyMismatch(raw.encryption, ["capacity", "nextOffset"], "encryption");
  if (encMismatch) {
    return { why: encMismatch };
  }
  const { capacity, nextOffset } = raw.encryption;
  if (!isSafeCount(capacity) || !isSafeCount(nextOffset)) {
    return { why: "encryption.capacity and encryption.nextOffset must be safe integers >= 0" };
  }
  if (nextOffset > capacity) {
    return { why: `encryption.nextOffset ${nextOffset} exceeds capacity ${capacity}` };
  }

  if (!isRecord(raw.authentication)) {
    return { why: "authentication is not an object" };
  }
  const authKeys = [
    "profile",
    "tagBits",
    "capacityRecords",
    "nextSequence",
    "verifyAttemptLimit",
    "maxCiphertextBytes",
    "maxAuthLookahead"
  ] as const;
  const authMismatch = keyMismatch(raw.authentication, authKeys, "authentication");
  if (authMismatch) {
    return { why: authMismatch };
  }
  const auth = raw.authentication;
  if (auth.profile !== "wc-one-time-v1") {
    return { why: `authentication.profile must be "wc-one-time-v1" (found ${JSON.stringify(auth.profile)})` };
  }
  if (auth.tagBits !== 128) {
    return { why: `authentication.tagBits must be 128 (found ${JSON.stringify(auth.tagBits)})` };
  }
  if (!isSafeCount(auth.capacityRecords) || !isSafeCount(auth.nextSequence)) {
    return { why: "authentication.capacityRecords and nextSequence must be safe integers >= 0" };
  }
  if (auth.nextSequence > auth.capacityRecords) {
    return { why: `authentication.nextSequence ${auth.nextSequence} exceeds capacityRecords ${auth.capacityRecords}` };
  }
  if (!isSafeCount(auth.verifyAttemptLimit) || !isSafeCount(auth.maxAuthLookahead)) {
    return { why: "authentication.verifyAttemptLimit and maxAuthLookahead must be safe integers >= 0" };
  }
  if (auth.maxCiphertextBytes !== MAX_CIPHERTEXT_BYTES) {
    return {
      why:
        `authentication.maxCiphertextBytes must equal ${MAX_CIPHERTEXT_BYTES} — it is not a per-store knob ` +
        `(found ${JSON.stringify(auth.maxCiphertextBytes)})`
    };
  }

  if (!isRecord(raw.recordPolicy)) {
    return { why: "recordPolicy is not an object" };
  }
  const policyMismatch = keyMismatch(raw.recordPolicy, ["authenticated", "downgradeAllowed"], "recordPolicy");
  if (policyMismatch) {
    return { why: policyMismatch };
  }
  if (raw.recordPolicy.authenticated !== "required" || raw.recordPolicy.downgradeAllowed !== false) {
    return { why: 'recordPolicy must be exactly { "authenticated": "required", "downgradeAllowed": false }' };
  }

  if (!isRecord(raw.rollback)) {
    return { why: "rollback is not an object" };
  }
  const rollbackMismatch = keyMismatch(raw.rollback, ["witnessClass", "config"], "rollback");
  if (rollbackMismatch) {
    return { why: rollbackMismatch };
  }
  if (raw.rollback.witnessClass !== "none") {
    return { why: `rollback.witnessClass must be "none" — other classes are a later phase (found ${JSON.stringify(raw.rollback.witnessClass)})` };
  }
  if (!isRecord(raw.rollback.config) || Object.keys(raw.rollback.config).length !== 0) {
    return { why: 'rollback.config must be {} for witnessClass "none"' };
  }

  if (!isRecord(raw.verification)) {
    return { why: "verification is not an object" };
  }
  const verificationKeys = ["failurePolicy", "failureCount", "clearedAtFailureCount", "perSequenceAttempts"] as const;
  const verificationMismatch = keyMismatch(raw.verification, verificationKeys, "verification");
  if (verificationMismatch) {
    return { why: verificationMismatch };
  }
  const verification = raw.verification;
  if (!isRecord(verification.failurePolicy)) {
    return { why: "verification.failurePolicy is not an object" };
  }
  const failurePolicyMismatch = keyMismatch(verification.failurePolicy, ["kind", "threshold"], "verification.failurePolicy");
  if (failurePolicyMismatch) {
    return { why: failurePolicyMismatch };
  }
  if (verification.failurePolicy.kind !== "freeze" || !isSafeCount(verification.failurePolicy.threshold)) {
    return { why: 'verification.failurePolicy must be { "kind": "freeze", "threshold": <safe integer >= 0> }' };
  }
  if (!isSafeCount(verification.failureCount) || !isSafeCount(verification.clearedAtFailureCount)) {
    return { why: "verification.failureCount and clearedAtFailureCount must be safe integers >= 0" };
  }
  if (!isRecord(verification.perSequenceAttempts)) {
    return { why: "verification.perSequenceAttempts is not an object" };
  }
  const perSequenceAttempts: Record<string, number> = {};
  for (const [key, value] of Object.entries(verification.perSequenceAttempts)) {
    if (!DECIMAL_KEY.test(key) || !isSafeCount(value)) {
      return { why: `verification.perSequenceAttempts["${key}"] must map a decimal sequence to a safe integer >= 0` };
    }
    perSequenceAttempts[key] = value;
  }

  const head: HeadV2 = {
    formatVersion: 2,
    pairId: raw.pairId,
    direction: raw.direction,
    mode: "bytes",
    sourceDeclarations,
    encryption: { capacity, nextOffset },
    authentication: {
      profile: "wc-one-time-v1",
      tagBits: 128,
      capacityRecords: auth.capacityRecords,
      nextSequence: auth.nextSequence,
      verifyAttemptLimit: auth.verifyAttemptLimit,
      maxCiphertextBytes: MAX_CIPHERTEXT_BYTES,
      maxAuthLookahead: auth.maxAuthLookahead
    },
    recordPolicy: { authenticated: "required", downgradeAllowed: false },
    rollback: { witnessClass: "none", config: {} },
    verification: {
      failurePolicy: { kind: "freeze", threshold: verification.failurePolicy.threshold },
      failureCount: verification.failureCount,
      clearedAtFailureCount: verification.clearedAtFailureCount,
      perSequenceAttempts
    }
  };
  return { head };
}

/* ---- journal parsing (§12.1) ---------------------------------------------- */

const atOf = (record: Record<string, unknown>): string => (typeof record.at === "string" ? record.at : "");

// Validate one parsed journal line's load-bearing fields for its op.
// Returns the typed record, or null when the line is malformed.
function parseJournalRecord(raw: unknown): JournalRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  switch (raw.op) {
    case "init":
      if (
        typeof raw.pairId === "string" &&
        (raw.direction === "A->B" || raw.direction === "B->A") &&
        isSafeCount(raw.capacity) &&
        isSafeCount(raw.capacityRecords)
      ) {
        return {
          op: "init",
          pairId: raw.pairId,
          direction: raw.direction,
          capacity: raw.capacity,
          capacityRecords: raw.capacityRecords,
          at: atOf(raw)
        };
      }
      return null;
    case "send":
      if (
        isSafeCount(raw.sequence) &&
        isSafeCount(raw.startOffset) &&
        isSafeCount(raw.consumed) &&
        isSafeCount(raw.nextOffset) &&
        isSafeCount(raw.nextSequence)
      ) {
        return {
          op: "send",
          sequence: raw.sequence,
          startOffset: raw.startOffset,
          consumed: raw.consumed,
          nextOffset: raw.nextOffset,
          nextSequence: raw.nextSequence,
          at: atOf(raw)
        };
      }
      return null;
    case "attempt":
      if (isSafeCount(raw.sequence)) {
        return { op: "attempt", sequence: raw.sequence, at: atOf(raw) };
      }
      return null;
    case "auth-fail":
      if (isSafeCount(raw.sequence) && isSafeCount(raw.failureCount)) {
        return { op: "auth-fail", sequence: raw.sequence, failureCount: raw.failureCount, at: atOf(raw) };
      }
      return null;
    case "open":
      if (
        isSafeCount(raw.sequence) &&
        isSafeCount(raw.startOffset) &&
        isSafeCount(raw.consumed) &&
        isSafeCount(raw.skipped) &&
        isSafeCount(raw.nextOffset) &&
        isSafeCount(raw.nextSequence)
      ) {
        return {
          op: "open",
          sequence: raw.sequence,
          startOffset: raw.startOffset,
          consumed: raw.consumed,
          skipped: raw.skipped,
          nextOffset: raw.nextOffset,
          nextSequence: raw.nextSequence,
          at: atOf(raw)
        };
      }
      return null;
    case "retire":
      if (isSafeCount(raw.toSequence) && isSafeCount(raw.toOffset) && typeof raw.reason === "string") {
        return { op: "retire", toSequence: raw.toSequence, toOffset: raw.toOffset, reason: raw.reason, at: atOf(raw) };
      }
      return null;
    case "clear-freeze":
      if (isSafeCount(raw.atFailureCount)) {
        return { op: "clear-freeze", atFailureCount: raw.atFailureCount, at: atOf(raw) };
      }
      return null;
    default:
      return null;
  }
}

// The journal's aggregates per §12.1. Retire lines feed both maxima.
type JournalAggregates = {
  maxNextOffset: number;
  maxNextSequence: number;
  attemptCounts: Map<number, number>;
  failureCount: number;
  lastClearedAt: number;
};

// Parse journal.log line by line. A malformed LAST line is the expected
// signature of a crash between an append and its fsync; a malformed line
// mid-file is not a crash signature. The two refusals say which (the v1
// corrupt-marks distinction, carried forward).
function readJournal(dir: string): JournalAggregates | Store2Refusal {
  // Only the single empty element a final newline produces is dropped: a
  // blank line anywhere else is unexpected journal content and falls through
  // to the malformed-line refusal, with exact file line numbers preserved.
  const raw = readFileSync(join(dir, JOURNAL_FILE), "utf8");
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const aggregates: JournalAggregates = {
    maxNextOffset: 0,
    maxNextSequence: 0,
    attemptCounts: new Map<number, number>(),
    failureCount: 0,
    lastClearedAt: 0
  };
  for (const [index, line] of lines.entries()) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      /* fall through to the malformed-line refusal */
    }
    const record = parsed === null ? null : parseJournalRecord(parsed);
    if (record === null) {
      const isLast = index === lines.length - 1;
      return {
        ok: false,
        reason: "corrupt-journal",
        message: isLast
          ? `${JOURNAL_FILE} ends in a malformed line — the expected signature of a crash between an append and ` +
            `its fsync. Every earlier record is intact. Remove only that last line and retry; the store is still ` +
            `checked against the surviving records. Refusing until then. Bad line: ${line}`
          : `${JOURNAL_FILE} holds a malformed record in the middle of the file (line ${index + 1}), which is not ` +
            `a crash signature. Refusing; inspect the file by hand. Bad line: ${line}`
      };
    }
    switch (record.op) {
      case "init":
        break;
      case "send":
      case "open":
        aggregates.maxNextOffset = Math.max(aggregates.maxNextOffset, record.nextOffset);
        aggregates.maxNextSequence = Math.max(aggregates.maxNextSequence, record.nextSequence);
        break;
      case "attempt":
        aggregates.attemptCounts.set(record.sequence, (aggregates.attemptCounts.get(record.sequence) ?? 0) + 1);
        break;
      case "auth-fail":
        // The line count is the journal's failure count; each line also
        // carries the header value it was written toward. Take the larger —
        // monotone either way, and over-counting is the safe direction.
        aggregates.failureCount = Math.max(aggregates.failureCount + 1, record.failureCount);
        break;
      case "retire":
        aggregates.maxNextOffset = Math.max(aggregates.maxNextOffset, record.toOffset);
        aggregates.maxNextSequence = Math.max(aggregates.maxNextSequence, record.toSequence);
        break;
      case "clear-freeze":
        aggregates.lastClearedAt = record.atFailureCount;
        break;
    }
  }
  return aggregates;
}

/* ---- store lifecycle ------------------------------------------------------ */

const secretLength = (head: HeadV2): number =>
  head.encryption.capacity + AUTH_RECORD_BYTES * head.authentication.capacityRecords;

// Create <dir> and write a fresh direction store into it, in the §12.4
// order, non-negotiable: secret.bin durable FIRST (full write with short
// writes detected, fsync, directory fsync), THEN head.json (atomic
// replace), THEN the init journal line (append + fsync). The reverse order
// could leave a secret.bin that survives a power loss at its correct length
// with lost data blocks — undetectable thereafter, because content never
// decides liveness. Refuses to overwrite an existing store: a direction
// store is written once and advanced forward, never replaced. The caller
// holds the pair lock, so two gens cannot race the exists check.
export function initStore2(dir: string, head: HeadV2, secret: Uint8Array): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const headPath = join(dir, HEAD_FILE);
  if (existsSync(headPath)) {
    throw new Error(`${headPath} already exists; a v2 direction store is written once and never overwritten`);
  }
  const expected = secretLength(head);
  if (secret.length !== expected) {
    throw new Error(
      `secret material is ${secret.length} bytes but the header's budgets require exactly ${expected} ` +
        `(E + 32*N = ${head.encryption.capacity} + 32*${head.authentication.capacityRecords})`
    );
  }
  const secretFd = openSync(join(dir, SECRET_FILE), "w", FILE_MODE);
  try {
    writeAll(secretFd, secret);
    fsyncSync(secretFd);
  } finally {
    closeSync(secretFd);
  }
  fsyncDir(dir);
  writeFileDurably(dir, HEAD_FILE, JSON.stringify(head));
  const record: JournalRecord = {
    op: "init",
    pairId: head.pairId,
    direction: head.direction,
    capacity: head.encryption.capacity,
    capacityRecords: head.authentication.capacityRecords,
    at: new Date().toISOString()
  };
  appendLineDurably(dir, JOURNAL_FILE, JSON.stringify(record));
}

// Load one direction store and reconcile header against journal (§12.1).
// Refuses v1 stores, structural damage, and a header behind its own
// journal; resolves the attempt/failure caches as the elementwise maximum,
// which is never a refusal.
export function loadStore2(dir: string): LoadedStore2 | Store2Refusal {
  const headPath = join(dir, HEAD_FILE);
  if (!existsSync(headPath)) {
    if (existsSync(join(dir, V1_PAD_FILE))) {
      return {
        ok: false,
        reason: "v1-store",
        message:
          `Refusing ${dir}: this directory holds a v1 pad store (${V1_PAD_FILE}) — letters or bytes makes no ` +
          `difference. v2 tooling cannot operate on a v1 store, and no conversion path exists: keep using the v1 ` +
          `truepad-pad tool for it, or generate a fresh v2 pair. Nothing was burned.`
      };
    }
    // §12.4: head.json missing while its siblings exist is the crashed-gen
    // shape (gen writes secret.bin durably FIRST), and that is corrupt-store,
    // not an empty directory.
    if (existsSync(join(dir, SECRET_FILE)) || existsSync(join(dir, JOURNAL_FILE))) {
      return {
        ok: false,
        reason: "corrupt-store",
        message:
          `${dir} holds ${SECRET_FILE} or ${JOURNAL_FILE} but no ${HEAD_FILE} — the signature of a gen that ` +
          `crashed between the secret body and the header. Remove the pair directory and run gen again; do not ` +
          `use the surviving files. Nothing was burned.`
      };
    }
    return { ok: false, reason: "no-store", message: `no ${HEAD_FILE} in ${dir}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(headPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: "corrupt-head",
      message: `Refusing ${dir}: ${HEAD_FILE} does not parse as JSON (${(error as Error).message}). Nothing was burned.`
    };
  }
  const validated = validateHead(parsed);
  if ("why" in validated) {
    return {
      ok: false,
      reason: "corrupt-head",
      message:
        `Refusing ${dir}: ${HEAD_FILE} fails validation — ${validated.why}. A header is refused whole rather ` +
        `than partially trusted. Nothing was burned.`
    };
  }
  const head = validated.head;

  const missing = [SECRET_FILE, JOURNAL_FILE].filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "corrupt-store",
      message:
        `Refusing ${dir}: ${HEAD_FILE} is present but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} ` +
        `missing. A v2 direction store is three files written in a fixed order; this tooling does not guess about ` +
        `a partial one. Nothing was burned.`
    };
  }

  const expected = secretLength(head);
  const actual = statSync(join(dir, SECRET_FILE)).size;
  if (actual !== expected) {
    return {
      ok: false,
      reason: "corrupt-secret-body",
      message:
        `Refusing ${dir}: ${SECRET_FILE} is ${actual} bytes but the header's budgets require exactly ${expected} ` +
        `(E + 32*N = ${head.encryption.capacity} + 32*${head.authentication.capacityRecords}). A secret body of ` +
        `the wrong length is refused before any of it is used. Nothing was burned.`
    };
  }

  const journal = readJournal(dir);
  if (!("maxNextOffset" in journal)) {
    return journal;
  }

  // High-waters: a header below the journal's maxima is a stale copy.
  if (head.authentication.nextSequence < journal.maxNextSequence) {
    return {
      ok: false,
      reason: "regressed-below-mark",
      message:
        `Refusing ${dir}: ${HEAD_FILE} says nextSequence ${head.authentication.nextSequence}, but ${JOURNAL_FILE} ` +
        `records that this store has already retired every sequence below ${journal.maxNextSequence}. This header ` +
        `is older than its own history — a restored backup or a copy taken before a commit. Loading it would offer ` +
        `retired auth records for reuse. Nothing was burned.`
    };
  }
  if (head.encryption.nextOffset < journal.maxNextOffset) {
    return {
      ok: false,
      reason: "regressed-below-mark",
      message:
        `Refusing ${dir}: ${HEAD_FILE} says nextOffset ${head.encryption.nextOffset}, but ${JOURNAL_FILE} records ` +
        `that this store has already burned through offset ${journal.maxNextOffset - 1}. This header is older than ` +
        `its own history — a restored backup or a copy taken before a commit. Loading it would reuse burned ` +
        `offsets. Nothing was burned.`
    };
  }

  // Attempt counts, failureCount, clearedAtFailureCount: cache-lag is the
  // expected state (§12.3 O3 permits deferring the header refresh), so these
  // resolve as the elementwise maximum and never refuse.
  const attempts = new Map<number, number>();
  for (const [key, value] of Object.entries(head.verification.perSequenceAttempts)) {
    attempts.set(Number(key), value);
  }
  for (const [sequence, count] of journal.attemptCounts) {
    attempts.set(sequence, Math.max(attempts.get(sequence) ?? 0, count));
  }

  const effective: EffectiveState = {
    // The header is at-or-above the journal here, and being ahead is the
    // crash signature of dying between the header rename and the journal
    // append: the header is the later truth.
    nextOffset: head.encryption.nextOffset,
    nextSequence: head.authentication.nextSequence,
    attempts,
    failureCount: Math.max(head.verification.failureCount, journal.failureCount),
    clearedAtFailureCount: Math.max(head.verification.clearedAtFailureCount, journal.lastClearedAt)
  };
  return { ok: true, head, effective };
}

/* ---- secret body reads ---------------------------------------------------- */

// Read `length` bytes of the encryption slice starting at pad offset
// `offset`. A positioned read only: whether those bytes are LIVE is the
// caller's decision from the effective counters — content never decides
// liveness. Throws on a domain violation (callers pre-validate).
export function readEncryption(dir: string, head: HeadV2, offset: number, length: number): Uint8Array {
  if (!isSafeCount(offset) || !isSafeCount(length) || offset + length > head.encryption.capacity) {
    throw new Error(
      `readEncryption out of range: [${offset}, ${offset + length}) with capacity ${head.encryption.capacity}`
    );
  }
  const fd = openSync(join(dir, SECRET_FILE), "r");
  try {
    return readExactly(fd, length, offset);
  } finally {
    closeSync(fd);
  }
}

// Read auth record `sequence`: K (16 bytes) then R (16 bytes), at
// E + 32*sequence (§1.2). Returns copies. Same liveness caveat as
// readEncryption.
export function readAuthRecord(dir: string, head: HeadV2, sequence: number): { key: Uint8Array; mask: Uint8Array } {
  if (!isSafeCount(sequence) || sequence >= head.authentication.capacityRecords) {
    throw new Error(
      `readAuthRecord out of range: sequence ${sequence} with capacityRecords ${head.authentication.capacityRecords}`
    );
  }
  const base = head.encryption.capacity + AUTH_RECORD_BYTES * sequence;
  const fd = openSync(join(dir, SECRET_FILE), "r");
  let record: Uint8Array;
  try {
    record = readExactly(fd, AUTH_RECORD_BYTES, base);
  } finally {
    closeSync(fd);
  }
  return { key: record.slice(0, KEY_BYTES), mask: record.slice(KEY_BYTES, AUTH_RECORD_BYTES) };
}

/* ---- durable transitions --------------------------------------------------- */

// OPEN O3: journal the attempt reservation, durably, and nothing else.
// Verification MUST NOT begin until this returns — the reservation preceding
// the verification is what stops a crash from granting a free attempt.
export function reserveAttempt(dir: string, sequence: number): void {
  if (!isSafeCount(sequence)) {
    throw new Error(`reserveAttempt: sequence ${sequence} is not a safe integer >= 0`);
  }
  const record: JournalRecord = { op: "attempt", sequence, at: new Date().toISOString() };
  appendLineDurably(dir, JOURNAL_FILE, JSON.stringify(record));
}

// OPEN O4 failure: append the auth-fail journal line FIRST, then atomically
// rewrite the header with failureCount+1 and the O3 reservation folded into
// perSequenceAttempts — the one deliberate inversion of the advance order
// (§12.1's maximum rule absorbs a crash between the two halves). The caller
// supplies the head it loaded and must NOT pre-increment either counter;
// this function owns both updates and returns the head it durably wrote.
// The caller emits the auth-failed refusal only after this returns.
export function persistAuthFail(dir: string, head: HeadV2, sequence: number): HeadV2 {
  if (!isSafeCount(sequence)) {
    throw new Error(`persistAuthFail: sequence ${sequence} is not a safe integer >= 0`);
  }
  const key = String(sequence);
  const perSequenceAttempts = { ...head.verification.perSequenceAttempts };
  perSequenceAttempts[key] = (perSequenceAttempts[key] ?? 0) + 1;
  const newHead: HeadV2 = {
    ...head,
    verification: {
      ...head.verification,
      failureCount: head.verification.failureCount + 1,
      perSequenceAttempts
    }
  };
  const record: JournalRecord = {
    op: "auth-fail",
    sequence,
    failureCount: newHead.verification.failureCount,
    at: new Date().toISOString()
  };
  appendLineDurably(dir, JOURNAL_FILE, JSON.stringify(record));
  writeFileDurably(dir, HEAD_FILE, JSON.stringify(newHead));
  return newHead;
}

// SEND S2 / OPEN O5 / operator actions: atomically rewrite the advanced
// header, THEN append the journal line, each durable. Only after this
// returns may the caller emit anything — a crash between the two halves
// leaves the header ahead of the journal, which load accepts as the later
// truth (§12.1). secret.bin is deliberately untouched: the newly retired
// ranges stay physically present, retired by these counters alone (§1.2).
export function commitAdvance(dir: string, newHead: HeadV2, line: JournalRecord): void {
  writeFileDurably(dir, HEAD_FILE, JSON.stringify(newHead));
  appendLineDurably(dir, JOURNAL_FILE, JSON.stringify(line));
}
