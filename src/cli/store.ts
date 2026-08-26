/* ============================================================================
 * truepad-pad store — pad state on disk, burned durably
 * ----------------------------------------------------------------------------
 * Node only. Imports core; never imports the exhibit. Owns one directory
 * per pad:
 *
 *   <dir>/pad.json    the pad (Pad.serialize()). Rewritten atomically:
 *                     write pad.json.tmp.<pid> in full (short writes are
 *                     detected), fsync, rename over pad.json, fsync the
 *                     directory. Created 0600.
 *   <dir>/marks.log   append-only, fsynced, 0600. One JSON line per init,
 *                     burn or open, recording the pad's nextOffset AFTER the
 *                     operation — one past the core's highWaterMark (the last
 *                     burned offset). The highest nextOffset per label is
 *                     that label's recorded mark. Kept separate from pad.json
 *                     on purpose: restoring an old pad.json alone regresses
 *                     the pad but not the mark, and loadPad refuses the
 *                     mismatch.
 *   <dir>/lock        exclusive lockfile (O_CREAT|O_EXCL), see lock.ts.
 *
 * Order of operations on every burn, non-negotiable:
 *   (1) write the new pad.json and append the mark record,
 *   (2) fsync both (and the directory),
 *   (3) only then does the caller emit the envelope / plaintext.
 * A crash between (1) and (3) loses pad symbols and never reuses them.
 * Losing pad is the correct failure direction.
 *
 * Limitation, stated rather than papered over: this defends against crashes
 * and against loading a stale copy of pad.json. It does not defend against
 * an operator restoring the whole directory from a backup, which regresses
 * the pad and the mark together. Tested on Linux ext4 only (the test suite
 * writes under os.tmpdir()). fsync on a directory handle is POSIX behaviour;
 * where a directory cannot be opened it is skipped, and the file fsyncs
 * still run.
 * ========================================================================= */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Pad } from "../core/pad.ts";

export const PAD_FILE = "pad.json";
export const MARKS_FILE = "marks.log";

// Pad material and its history are the operator's secret: owner-only.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export type MarkRecord = {
  label: string;
  // The pad's nextOffset after the operation: every offset below it is gone.
  nextOffset: number;
  startOffset: number;
  consumed: number;
  skipped: number;
  op: "init" | "burn" | "open";
  at: string;
};

export type LoadRefusal = {
  ok: false;
  reason: "no-pad" | "corrupt-pad" | "regressed-below-mark" | "corrupt-marks";
  message: string;
};

// `mark` is the highest recorded nextOffset for the pad's label (-1 if none).
export type LoadResult = { ok: true; pad: Pad; mark: number } | LoadRefusal;

/* ---- durability primitives ----------------------------------------------- */

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
function writeAll(fd: number, data: string): void {
  const bytes = Buffer.from(data, "utf8");
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
    writeAll(fd, data);
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
    writeAll(fd, `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDir(dir);
}

/* ---- marks ---------------------------------------------------------------- */

// label -> highest nextOffset ever recorded for that label (monotonic: a
// later, lower record never lowers it).
export function readMarks(dir: string): Map<string, number> | LoadRefusal {
  const marks = new Map<string, number>();
  const path = join(dir, MARKS_FILE);
  if (!existsSync(path)) {
    return marks;
  }
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    let record: Partial<MarkRecord> | null = null;
    try {
      record = JSON.parse(line) as Partial<MarkRecord>;
    } catch {
      /* fall through to the malformed-line refusal */
    }
    if (
      record === null ||
      typeof record.label !== "string" ||
      !Number.isInteger(record.nextOffset) ||
      (record.nextOffset as number) < 0
    ) {
      const isLast = index === lines.length - 1;
      return {
        ok: false,
        reason: "corrupt-marks",
        message: isLast
          ? `${MARKS_FILE} ends in a malformed line — the expected signature of a crash between an append and its ` +
            `fsync. Every earlier record is intact. Remove only that last line and retry; the pad is still checked ` +
            `against the surviving records. Refusing until then. Bad line: ${line}`
          : `${MARKS_FILE} holds a malformed record in the middle of the file (line ${index + 1}), which is not a ` +
            `crash signature. Refusing; inspect the file by hand. Bad line: ${line}`
      };
    }
    marks.set(record.label, Math.max(marks.get(record.label) ?? -1, record.nextOffset as number));
  }
  return marks;
}

/* ---- store lifecycle ------------------------------------------------------ */

// Create <dir> and put a fresh pad in it. Refuses to overwrite an existing
// pad: a pad directory is written once and burned forward, never replaced.
// The caller holds the directory lock (see truepad-pad.ts gen) so two gens
// cannot race the exists check.
export function initStore(dir: string, pad: Pad): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (existsSync(join(dir, PAD_FILE))) {
    throw new Error(`${join(dir, PAD_FILE)} already exists; a pad directory is never overwritten`);
  }
  writeFileDurably(dir, PAD_FILE, pad.serialize());
  const record: MarkRecord = {
    label: pad.label,
    nextOffset: pad.nextOffset,
    startOffset: pad.nextOffset,
    consumed: 0,
    skipped: 0,
    op: "init",
    at: new Date().toISOString()
  };
  appendLineDurably(dir, MARKS_FILE, JSON.stringify(record));
}

// Load the pad and refuse it if it has regressed below its label's mark.
export function loadPad(dir: string): LoadResult {
  const path = join(dir, PAD_FILE);
  if (!existsSync(path)) {
    return { ok: false, reason: "no-pad", message: `no ${PAD_FILE} in ${dir}` };
  }
  let pad: Pad;
  try {
    pad = Pad.deserialize(readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, reason: "corrupt-pad", message: `${path}: ${(error as Error).message}` };
  }
  const marks = readMarks(dir);
  if (!(marks instanceof Map)) {
    return marks;
  }
  const mark = marks.get(pad.label) ?? -1;
  if (pad.nextOffset < mark) {
    return {
      ok: false,
      reason: "regressed-below-mark",
      message:
        `Refusing ${pad.label}: ${PAD_FILE} says nextOffset ${pad.nextOffset}, but ${MARKS_FILE} records that ` +
        `this label has already burned through offset ${mark - 1}. This pad file is older than its own history — ` +
        "a restored backup or a copy taken before a burn. Opening it would reuse burned offsets. Nothing was burned."
    };
  }
  return { ok: true, pad, mark };
}

// Persist a burn that has ALREADY happened in memory. Returns only after
// pad.json and marks.log are both durable. The caller must not emit the
// envelope or the plaintext until this returns.
export function persistBurn(
  dir: string,
  pad: Pad,
  record: { op: "burn" | "open"; startOffset: number; consumed: number; skipped: number }
): void {
  writeFileDurably(dir, PAD_FILE, pad.serialize());
  const mark: MarkRecord = { label: pad.label, nextOffset: pad.nextOffset, ...record, at: new Date().toISOString() };
  appendLineDurably(dir, MARKS_FILE, JSON.stringify(mark));
}
