/* ============================================================================
 * TruePad Browser Edition — one v2 direction store over the Vfs
 * ----------------------------------------------------------------------------
 * The browser twin of src/cli/v2/store2.ts. Same frozen Store Format v2 (§1,
 * §12): the SAME three files per direction, the SAME canonical JSON bytes, the
 * SAME §12.1 reconciliation and §12.4 write order — but expressed over the
 * async `Vfs` interface instead of node:fs, so it runs unchanged over OPFS
 * (the product), MemoryVfs (unit tests) and a NodeVfs (interop). It reuses
 * src/core for every byte of crypto and never reimplements it.
 *
 *   <prefix>/head.json    non-secret header (§1.1). No secret ever appears
 *                         here. Rewritten via Vfs.writeFileAtomic (atomic
 *                         temp+move where the backing supports it, else a
 *                         durable in-place rewrite). A torn rewrite leaves a
 *                         partial header that loadStore refuses as corrupt-head
 *                         — fail-closed, never a silently-accepted mix.
 *   <prefix>/secret.bin   the secret body (§1.2): E + 32·N bytes,
 *                         [encryption slice E][per sequence: K(16) then R(16)].
 *                         Written durably at gen BEFORE head.json or any
 *                         journal line (§12.4) and NEVER rewritten afterwards
 *                         (retirement is logical — the counters decide
 *                         liveness, not content). Only destruction overwrites
 *                         it (§17.2).
 *   <prefix>/journal.log  append-only (Vfs.appendFile), one JSON line per
 *                         event (§12.1) — the durable authority the header's
 *                         counters merely cache.
 *
 * Commit orders, non-negotiable and identical to the CLI:
 *   advance (SEND S2 / OPEN O5 / operator actions): rewrite head.json, then
 *     append the journal line — only then may the caller emit anything.
 *   attempt reservation (OPEN O3): journal append only, before any verify.
 *   auth failure (OPEN O4): journal append FIRST, header rewrite second — the
 *     one deliberate inversion the §12.1 maximum rule absorbs.
 *
 * "durable" here is the browser sense of docs/BROWSER-SECURITY.md §2: the
 * bytes reached OPFS and were flushed; a tab/worker crash after flush is
 * survived. It is deliberately NOT the CLI's Linux-ext4 power-loss claim.
 * This module is storage and reconciliation only: it computes no tag and
 * decides no window, budget, freeze or verification outcome — those are the
 * verbs' (verbs.ts), and the single-writer lock is the Vfs's (withLock).
 * ========================================================================= */

import type { PadDirection } from "../../core/pad.ts";
import { AUTH_RECORD_BYTES, MAX_CIPHERTEXT_BYTES } from "../../core/wc-one-time.ts";
import type { Vfs } from "./vfs.ts";

export const HEAD_FILE = "head.json";
export const SECRET_FILE = "secret.bin";
export const JOURNAL_FILE = "journal.log";

// The v1 store's pad file: its presence without head.json marks a v1 store.
const V1_PAD_FILE = "pad.json";

// The pair-relative subdirectory for each direction store.
export const SUBDIR: Record<PadDirection, string> = { "A->B": "a-to-b", "B->A": "b-to-a" };

const KEY_BYTES = 16;

const enc = new TextEncoder();
const dec = new TextDecoder();

const path = (prefix: string, name: string): string => `${prefix}/${name}`;

/* ---- a thrown, typed refusal (shared by store, witness and verbs) ---------
 * store's load path returns refusal OBJECTS (like store2.ts); the verbs and
 * the witness THROW this so a refusal short-circuits a verb and the worker
 * turns it into the protocol's structured { ok:false, kind:"refused" }.
 */

export class EngineRefused extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "EngineRefused";
    this.reason = reason;
  }
}

/* ---- header shape (§1.1) --------------------------------------------------
 * Mirrors FORMAT-V2.md §1.1 and the CLI's HeadV2 byte-for-byte. The rollback
 * field is NOT forked: a browser store's head.json ALWAYS serialises
 * rollback:{ witnessClass:"none", config:{} } — byte-identical to a CLI store,
 * so every browser-generated store is CLI-readable and the courier bundle
 * carries no browser-only header vocabulary (§BROWSER-SECURITY.md §2/§4). The
 * browser's own rollback witness is a PRODUCT layer keyed by the browser-only
 * pair.json (`witness`), living OUTSIDE the frozen store; it never touches
 * these bytes. A CLI store whose frozen witnessClass the browser cannot honour
 * (separate-state-file / platform-monotonic / remote-monotonic) is REFUSED on
 * load, never silently downgraded.
 */

export type SourceDeclaration = { name: string; declaredOrigin: string; lengthBytes: number };

export type BrowserRollback = { witnessClass: "none"; config: Record<string, never> };

export type RecordSpec = { kind: "variable" } | { kind: "fixed"; bytes: number };

export type HeadV2 = {
  formatVersion: 2;
  pairId: string; // 32 lowercase hex characters — an identifier, never a secret
  direction: PadDirection;
  mode: "bytes";
  sourceDeclarations: SourceDeclaration[];
  encryption: { capacity: number; nextOffset: number };
  authentication: {
    profile: "wc-one-time-v1";
    tagBits: number; // pinned 128 (§2.2)
    capacityRecords: number;
    nextSequence: number;
    verifyAttemptLimit: number;
    maxCiphertextBytes: number; // MUST equal 1048576 (§4)
    maxAuthLookahead: number;
  };
  recordPolicy: { authenticated: "required"; downgradeAllowed: false; record: RecordSpec };
  rollback: BrowserRollback;
  verification: {
    failurePolicy: { kind: "freeze"; threshold: number };
    failureCount: number;
    clearedAtFailureCount: number;
    perSequenceAttempts: Record<string, number>;
  };
};

/* ---- journal shape (§12.1) ------------------------------------------------ */

export type JournalRecord =
  | { op: "init"; pairId: string; direction: PadDirection; capacity: number; capacityRecords: number; at: string }
  | { op: "send"; sequence: number; startOffset: number; consumed: number; nextOffset: number; nextSequence: number; at: string }
  | { op: "attempt"; sequence: number; at: string }
  | { op: "auth-fail"; sequence: number; failureCount: number; at: string }
  | { op: "open"; sequence: number; startOffset: number; consumed: number; skipped: number; nextOffset: number; nextSequence: number; at: string }
  | { op: "retire"; toSequence: number; toOffset: number; reason: string; at: string }
  | { op: "clear-freeze"; atFailureCount: number; at: string };

/* ---- results -------------------------------------------------------------- */

export type StoreRefusalReason =
  | "no-store"
  | "v1-store"
  | "corrupt-head"
  | "corrupt-secret-body"
  | "corrupt-store"
  | "corrupt-journal"
  | "regressed-below-mark";

export type StoreRefusal = { ok: false; reason: StoreRefusalReason; message: string };

export type EffectiveState = {
  nextOffset: number;
  nextSequence: number;
  attempts: Map<number, number>;
  // Total verification attempts ever reserved (count of `attempt` journal
  // lines) — monotone, and the quantity the rollback witness records so a
  // backup-restore cannot refill the per-record attempt budget (§15.1).
  attemptsReserved: number;
  failureCount: number;
  clearedAtFailureCount: number;
};

export type LoadedStore = { ok: true; head: HeadV2; effective: EffectiveState };

/* ---- small validators ----------------------------------------------------- */

const HEX_32 = /^[0-9a-f]{32}$/;
const DECIMAL_KEY = /^(?:0|[1-9][0-9]*)$/;

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/* ---- header validation (§1.1) ---------------------------------------------
 * Strict, whole-header validation, ported from store2.validateHead. Returns a
 * freshly constructed HeadV2 in canonical key order (so a loaded-then-resaved
 * header is byte-identical), or the reason it fails.
 */

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
  const policyKeys = Object.hasOwn(raw.recordPolicy, "record")
    ? ["authenticated", "downgradeAllowed", "record"]
    : ["authenticated", "downgradeAllowed"];
  const policyMismatch = keyMismatch(raw.recordPolicy, policyKeys, "recordPolicy");
  if (policyMismatch) {
    return { why: policyMismatch };
  }
  if (raw.recordPolicy.authenticated !== "required" || raw.recordPolicy.downgradeAllowed !== false) {
    return { why: 'recordPolicy.authenticated must be "required" and downgradeAllowed must be false' };
  }
  // §16/§1.1: absent = variable, { kind:"variable" }, or { kind:"fixed", bytes }
  // with bytes a multiple of 16 and 32 <= F <= maxCiphertextBytes.
  let record: RecordSpec;
  if (!Object.hasOwn(raw.recordPolicy, "record")) {
    record = { kind: "variable" };
  } else {
    const rawRecord = raw.recordPolicy.record;
    if (!isRecord(rawRecord)) {
      return { why: "recordPolicy.record is not an object" };
    }
    if (rawRecord.kind === "variable") {
      const variableMismatch = keyMismatch(rawRecord, ["kind"], "recordPolicy.record");
      if (variableMismatch) {
        return { why: variableMismatch };
      }
      record = { kind: "variable" };
    } else if (rawRecord.kind === "fixed") {
      const fixedMismatch = keyMismatch(rawRecord, ["kind", "bytes"], "recordPolicy.record");
      if (fixedMismatch) {
        return { why: fixedMismatch };
      }
      const bytes = rawRecord.bytes;
      if (!isSafeCount(bytes) || bytes < 32 || bytes > MAX_CIPHERTEXT_BYTES || bytes % 16 !== 0) {
        return {
          why:
            `recordPolicy.record.bytes must be a multiple of 16 with 32 <= F <= ${MAX_CIPHERTEXT_BYTES} (§16) ` +
            `(found ${JSON.stringify(bytes)})`
        };
      }
      record = { kind: "fixed", bytes };
    } else {
      return { why: `recordPolicy.record.kind must be "variable" or "fixed" (found ${JSON.stringify(rawRecord.kind)})` };
    }
  }

  if (!isRecord(raw.rollback)) {
    return { why: "rollback is not an object" };
  }
  const rollbackMismatch = keyMismatch(raw.rollback, ["witnessClass", "config"], "rollback");
  if (rollbackMismatch) {
    return { why: rollbackMismatch };
  }
  if (!isRecord(raw.rollback.config)) {
    return { why: "rollback.config is not an object" };
  }
  // §BROWSER-SECURITY.md §2/§4: the frozen head carries EXACTLY the CLI's
  // { witnessClass:"none", config:{} } and nothing else — the browser does not
  // fork the format with a browser-only witness vocabulary. Its own rollback
  // witness lives in the browser-only pair.json, outside these bytes. A CLI
  // store whose frozen witnessClass the browser cannot honour (separate-state-
  // file / platform-monotonic / remote-monotonic) is REFUSED here, never
  // silently downgraded to none.
  const witnessClass = raw.rollback.witnessClass;
  let rollback: BrowserRollback;
  if (witnessClass === "none") {
    if (Object.keys(raw.rollback.config).length !== 0) {
      return { why: 'rollback.config must be {} for witnessClass "none"' };
    }
    rollback = { witnessClass: "none", config: {} };
  } else {
    return {
      why:
        `rollback.witnessClass must be "none": the Browser Edition keeps its rollback witness outside the frozen ` +
        `store (pair.json), so a store's head.json carries the CLI's { witnessClass:"none" }. A frozen witness class ` +
        `this edition cannot honour (separate-state-file / platform-monotonic / remote-monotonic) is refused, not ` +
        `downgraded (found ${JSON.stringify(witnessClass)})`
    };
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
    recordPolicy: { authenticated: "required", downgradeAllowed: false, record },
    rollback,
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
        return { op: "init", pairId: raw.pairId, direction: raw.direction, capacity: raw.capacity, capacityRecords: raw.capacityRecords, at: atOf(raw) };
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
        return { op: "send", sequence: raw.sequence, startOffset: raw.startOffset, consumed: raw.consumed, nextOffset: raw.nextOffset, nextSequence: raw.nextSequence, at: atOf(raw) };
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
        return { op: "open", sequence: raw.sequence, startOffset: raw.startOffset, consumed: raw.consumed, skipped: raw.skipped, nextOffset: raw.nextOffset, nextSequence: raw.nextSequence, at: atOf(raw) };
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

type JournalAggregates = {
  maxNextOffset: number;
  maxNextSequence: number;
  attemptCounts: Map<number, number>;
  attemptsReserved: number;
  failureCount: number;
  lastClearedAt: number;
};

function readJournal(text: string): JournalAggregates | StoreRefusal {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const aggregates: JournalAggregates = {
    maxNextOffset: 0,
    maxNextSequence: 0,
    attemptCounts: new Map<number, number>(),
    attemptsReserved: 0,
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
          ? `${JOURNAL_FILE} ends in a malformed line — the expected signature of a crash between an append and its ` +
            `flush. Every earlier record is intact. Remove only that last line and retry. Bad line: ${line}`
          : `${JOURNAL_FILE} holds a malformed record in the middle of the file (line ${index + 1}), which is not a ` +
            `crash signature. Refusing; inspect the file by hand. Bad line: ${line}`
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
        aggregates.attemptsReserved += 1;
        break;
      case "auth-fail":
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

export const secretLength = (head: HeadV2): number =>
  head.encryption.capacity + AUTH_RECORD_BYTES * head.authentication.capacityRecords;

// Write a fresh direction store under <prefix>, in the §12.4 order: secret.bin
// durable FIRST, THEN head.json, THEN the init journal line. Refuses to
// overwrite an existing store (written once, advanced forward, never replaced).
export async function initStore(vfs: Vfs, prefix: string, head: HeadV2, secret: Uint8Array): Promise<void> {
  if (await vfs.exists(path(prefix, HEAD_FILE))) {
    throw new Error(`${path(prefix, HEAD_FILE)} already exists; a v2 direction store is written once and never overwritten`);
  }
  const expected = secretLength(head);
  if (secret.length !== expected) {
    throw new Error(
      `secret material is ${secret.length} bytes but the header's budgets require exactly ${expected} ` +
        `(E + 32*N = ${head.encryption.capacity} + 32*${head.authentication.capacityRecords})`
    );
  }
  await vfs.writeFileAtomic(path(prefix, SECRET_FILE), secret);
  await vfs.writeFileAtomic(path(prefix, HEAD_FILE), enc.encode(JSON.stringify(head)));
  const record: JournalRecord = {
    op: "init",
    pairId: head.pairId,
    direction: head.direction,
    capacity: head.encryption.capacity,
    capacityRecords: head.authentication.capacityRecords,
    at: new Date().toISOString()
  };
  await vfs.appendFile(path(prefix, JOURNAL_FILE), enc.encode(`${JSON.stringify(record)}\n`));
}

// Load one direction store and reconcile header against journal (§12.1).
export async function loadStore(vfs: Vfs, prefix: string): Promise<LoadedStore | StoreRefusal> {
  const headPath = path(prefix, HEAD_FILE);
  const headBytes = await vfs.readFile(headPath);
  if (headBytes === null) {
    if (await vfs.exists(path(prefix, V1_PAD_FILE))) {
      return {
        ok: false,
        reason: "v1-store",
        message:
          `Refusing ${prefix}: this holds a v1 pad store (${V1_PAD_FILE}). v2 tooling cannot operate on a v1 store, ` +
          `and no conversion path exists. Nothing was burned.`
      };
    }
    // §12.4: secret.bin/journal without head.json is the crashed-gen shape.
    if ((await vfs.exists(path(prefix, SECRET_FILE))) || (await vfs.exists(path(prefix, JOURNAL_FILE)))) {
      return {
        ok: false,
        reason: "corrupt-store",
        message:
          `${prefix} holds ${SECRET_FILE} or ${JOURNAL_FILE} but no ${HEAD_FILE} — the signature of a gen that ` +
          `crashed between the secret body and the header. Do not use the surviving files. Nothing was burned.`
      };
    }
    return { ok: false, reason: "no-store", message: `no ${HEAD_FILE} in ${prefix}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(headBytes));
  } catch (error) {
    return { ok: false, reason: "corrupt-head", message: `Refusing ${prefix}: ${HEAD_FILE} does not parse as JSON (${(error as Error).message}). Nothing was burned.` };
  }
  const validated = validateHead(parsed);
  if ("why" in validated) {
    return {
      ok: false,
      reason: "corrupt-head",
      message: `Refusing ${prefix}: ${HEAD_FILE} fails validation — ${validated.why}. A header is refused whole rather than partially trusted. Nothing was burned.`
    };
  }
  const head = validated.head;

  const missing: string[] = [];
  if (!(await vfs.exists(path(prefix, SECRET_FILE)))) missing.push(SECRET_FILE);
  if (!(await vfs.exists(path(prefix, JOURNAL_FILE)))) missing.push(JOURNAL_FILE);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "corrupt-store",
      message:
        `Refusing ${prefix}: ${HEAD_FILE} is present but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} ` +
        `missing. A v2 direction store is three files written in a fixed order. Nothing was burned.`
    };
  }

  const expected = secretLength(head);
  const actual = await vfs.size(path(prefix, SECRET_FILE));
  if (actual !== expected) {
    return {
      ok: false,
      reason: "corrupt-secret-body",
      message:
        `Refusing ${prefix}: ${SECRET_FILE} is ${actual} bytes but the header's budgets require exactly ${expected} ` +
        `(E + 32*N). A secret body of the wrong length is refused before any of it is used. Nothing was burned.`
    };
  }

  const journalBytes = (await vfs.readFile(path(prefix, JOURNAL_FILE))) ?? new Uint8Array(0);
  const journal = readJournal(dec.decode(journalBytes));
  if (!("maxNextOffset" in journal)) {
    return journal;
  }

  if (head.authentication.nextSequence < journal.maxNextSequence) {
    return {
      ok: false,
      reason: "regressed-below-mark",
      message:
        `Refusing ${prefix}: ${HEAD_FILE} says nextSequence ${head.authentication.nextSequence}, but ${JOURNAL_FILE} ` +
        `records this store already retired every sequence below ${journal.maxNextSequence}. This header is older than ` +
        `its own history. Nothing was burned.`
    };
  }
  if (head.encryption.nextOffset < journal.maxNextOffset) {
    return {
      ok: false,
      reason: "regressed-below-mark",
      message:
        `Refusing ${prefix}: ${HEAD_FILE} says nextOffset ${head.encryption.nextOffset}, but ${JOURNAL_FILE} records ` +
        `this store already burned through offset ${journal.maxNextOffset - 1}. This header is older than its own ` +
        `history. Nothing was burned.`
    };
  }

  const attempts = new Map<number, number>();
  for (const [key, value] of Object.entries(head.verification.perSequenceAttempts)) {
    attempts.set(Number(key), value);
  }
  for (const [sequence, count] of journal.attemptCounts) {
    attempts.set(sequence, Math.max(attempts.get(sequence) ?? 0, count));
  }

  const effective: EffectiveState = {
    nextOffset: head.encryption.nextOffset,
    nextSequence: head.authentication.nextSequence,
    attempts,
    attemptsReserved: journal.attemptsReserved,
    failureCount: Math.max(head.verification.failureCount, journal.failureCount),
    clearedAtFailureCount: Math.max(head.verification.clearedAtFailureCount, journal.lastClearedAt)
  };
  return { ok: true, head, effective };
}

/* ---- secret body reads ---------------------------------------------------- */

export async function readEncryption(vfs: Vfs, prefix: string, head: HeadV2, offset: number, length: number): Promise<Uint8Array> {
  if (!isSafeCount(offset) || !isSafeCount(length) || offset + length > head.encryption.capacity) {
    throw new Error(`readEncryption out of range: [${offset}, ${offset + length}) with capacity ${head.encryption.capacity}`);
  }
  return vfs.readRange(path(prefix, SECRET_FILE), offset, length);
}

export async function readAuthRecord(vfs: Vfs, prefix: string, head: HeadV2, sequence: number): Promise<{ key: Uint8Array; mask: Uint8Array }> {
  if (!isSafeCount(sequence) || sequence >= head.authentication.capacityRecords) {
    throw new Error(`readAuthRecord out of range: sequence ${sequence} with capacityRecords ${head.authentication.capacityRecords}`);
  }
  const base = head.encryption.capacity + AUTH_RECORD_BYTES * sequence;
  const record = await vfs.readRange(path(prefix, SECRET_FILE), base, AUTH_RECORD_BYTES);
  return { key: record.slice(0, KEY_BYTES), mask: record.slice(KEY_BYTES, AUTH_RECORD_BYTES) };
}

/* ---- durable transitions --------------------------------------------------- */

// OPEN O3: journal the attempt reservation, durably, and nothing else.
export async function reserveAttempt(vfs: Vfs, prefix: string, sequence: number): Promise<void> {
  if (!isSafeCount(sequence)) {
    throw new Error(`reserveAttempt: sequence ${sequence} is not a safe integer >= 0`);
  }
  const record: JournalRecord = { op: "attempt", sequence, at: new Date().toISOString() };
  await vfs.appendFile(path(prefix, JOURNAL_FILE), enc.encode(`${JSON.stringify(record)}\n`));
}

// OPEN O4 failure: append the auth-fail line FIRST, then rewrite the header
// (failureCount+1 and the O3 reservation folded in) — the one inversion of the
// advance order. Owns BOTH increments; returns the head it durably wrote.
export async function persistAuthFail(vfs: Vfs, prefix: string, head: HeadV2, sequence: number): Promise<HeadV2> {
  if (!isSafeCount(sequence)) {
    throw new Error(`persistAuthFail: sequence ${sequence} is not a safe integer >= 0`);
  }
  const key = String(sequence);
  const perSequenceAttempts = { ...head.verification.perSequenceAttempts };
  perSequenceAttempts[key] = (perSequenceAttempts[key] ?? 0) + 1;
  const newHead: HeadV2 = {
    ...head,
    verification: { ...head.verification, failureCount: head.verification.failureCount + 1, perSequenceAttempts }
  };
  const record: JournalRecord = { op: "auth-fail", sequence, failureCount: newHead.verification.failureCount, at: new Date().toISOString() };
  await vfs.appendFile(path(prefix, JOURNAL_FILE), enc.encode(`${JSON.stringify(record)}\n`));
  await vfs.writeFileAtomic(path(prefix, HEAD_FILE), enc.encode(JSON.stringify(newHead)));
  return newHead;
}

// SEND S2 / OPEN O5 / operator actions: rewrite the advanced header, THEN
// append the journal line. secret.bin is deliberately untouched (§1.2).
export async function commitAdvance(vfs: Vfs, prefix: string, newHead: HeadV2, line: JournalRecord): Promise<void> {
  await vfs.writeFileAtomic(path(prefix, HEAD_FILE), enc.encode(JSON.stringify(newHead)));
  await vfs.appendFile(path(prefix, JOURNAL_FILE), enc.encode(`${JSON.stringify(line)}\n`));
}
