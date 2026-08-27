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
 *             { "encryptionNextOffset": n, "authenticationNextSequence": n } } }
 *           One file may witness several pairs. It holds counters and nothing
 *           else — never a pad byte, key, mask, plaintext, or ciphertext
 *           (§15.1, ledger N17).
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
 * Strength caveat, stated rather than flattened (§15.2): a separate state
 * file is an independent backup/failure domain, NOT intrinsically monotonic —
 * a second device can be restored too, and an emptied witness knows nothing.
 * A witness is only as monotonic as the mechanism enforcing its
 * non-regression; that mechanism here is the operator's assumption that the
 * path lives in a domain the pair's backup does not cover.
 * ========================================================================= */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { PadDirection } from "../../core/pad.ts";

export type WitnessCounters = { encryptionNextOffset: number; authenticationNextSequence: number };

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
    if (keys.length !== 2 || !isSafeCount(value.encryptionNextOffset) || !isSafeCount(value.authenticationNextSequence)) {
      return {
        why: `witness["${key}"] must be exactly { encryptionNextOffset, authenticationNextSequence } with safe integers >= 0`
      };
    }
    witness[key] = {
      encryptionNextOffset: value.encryptionNextOffset,
      authenticationNextSequence: value.authenticationNextSequence
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

/* ---- the two touchpoints -------------------------------------------------- */

// PREFLIGHT read (§15.3). Fail closed: a witness that cannot be read is
// `witness-unreachable`, never a silent downgrade. A file that parses but
// violates its own shape is `witness-inconsistent`. A file with no entry for
// this (pair, direction) is a fresh witness — null counters, which the caller
// treats as pass (protection begins at the first witnessed commit, §15.2).
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
        "downgrade. Provision the witness file (an empty one accepts a fresh pair) or restore its medium. " +
        "Nothing was burned."
    };
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

// ADVANCE write (§15.3). Read-modify-write the entry for this (pair,
// direction) to the new high-waters, MONOTONE: the elementwise maximum, so an
// out-of-order or replayed advance never lowers the recorded position.
// Creates the file if absent (a fresh witness, first commit). Atomic replace +
// fsync + directory fsync (§10). Throws on any I/O failure — the caller has
// already committed the store durably, so a throw is the §15.3 loss row.
export function advanceWitness(path: string, pairId: string, direction: PadDirection, counters: WitnessCounters): void {
  let file: WitnessFile;
  let existing: string | null;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = null; // absent: a fresh witness, created below
  }
  if (existing === null) {
    file = { formatVersion: 2, witness: {} };
  } else {
    const validated = validateWitnessFile(JSON.parse(existing));
    if ("why" in validated) {
      throw new Error(`the rollback witness at ${path} is inconsistent (${validated.why}); refusing to advance over it`);
    }
    file = validated.file;
  }
  const key = keyOf(pairId, direction);
  const prev = file.witness[key];
  file.witness[key] =
    prev === undefined
      ? { encryptionNextOffset: counters.encryptionNextOffset, authenticationNextSequence: counters.authenticationNextSequence }
      : {
          encryptionNextOffset: Math.max(prev.encryptionNextOffset, counters.encryptionNextOffset),
          authenticationNextSequence: Math.max(prev.authenticationNextSequence, counters.authenticationNextSequence)
        };
  writeWitnessDurably(path, JSON.stringify(file));
}
