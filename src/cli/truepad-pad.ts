/* ============================================================================
 * truepad-pad — reuse-safe pad handling on disk
 * ----------------------------------------------------------------------------
 * Node only. Imports core; never imports the exhibit. Runs from source under
 * Node's built-in type stripping (>= 22.18.0); bin/truepad-pad.mjs checks
 * the runtime before importing this file.
 *
 *   gen    <dir> [--mode letters|bytes] [--size N | --external FILE] [--label PAD-XXXX]
 *   burn   <dir> --as A|B (TEXT | --in FILE)        encrypt with your SENDING pad, emit an envelope
 *   open   <dir> --as A|B (ENVELOPE | --in FILE)    decrypt with your RECEIVING pad: seek + burn
 *   status <dir>
 *
 * A pad directory holds the PAIR: <dir>/a-to-b/ and <dir>/b-to-a/, each a
 * store of its own (pad.json + marks.log), under one <dir>/lock. gen writes
 * both; the courier copies the whole directory to the peer. --as names the
 * caller's role: A burns a-to-b and opens b-to-a; B the reverse. The core
 * checks the pad's own direction against the role as well, so a swapped
 * subdirectory is refused rather than burned.
 *
 * The verbs name what happens to the PAD. There is no "send": this tool is
 * not secure messaging (see BANNER).
 * ========================================================================= */

import { existsSync, mkdirSync, readFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decodeEnvelope,
  decryptBytes,
  decryptLetters,
  encodeEnvelope,
  encryptBytes,
  encryptLetters
} from "../core/cipher-otp.ts";
import { Pad, type PadDirection, type PadMode, type PadPair, type Party } from "../core/pad.ts";
import { acquireLock } from "./lock.ts";
import { initStore, loadPad, persistBurn } from "./store.ts";

export const BANNER =
  "truepad-pad: reuse-safe pad handling. NOT secure messaging — envelopes are unauthenticated: an attacker who\n" +
  "knows the plaintext format can flip chosen bits (or shift chosen letters) undetectably, and a forged startOffset\n" +
  "burns the receiver's pad.";

export const USAGE = `usage:
  truepad-pad gen    <dir> [--mode letters|bytes] [--size N | --external FILE] [--label PAD-XXXX]
  truepad-pad burn   <dir> --as A|B (TEXT | --in FILE)
  truepad-pad open   <dir> --as A|B (ENVELOPE-JSON | --in FILE)
  truepad-pad status <dir>
<dir> holds the pair: a-to-b/ and b-to-a/. --as is your role: A burns a-to-b and opens b-to-a; B the reverse.
exit codes: 0 ok · 2 refused (nothing burned) · 1 usage or I/O error`;

export const SUBDIR: Record<PadDirection, string> = { "A->B": "a-to-b", "B->A": "b-to-a" };

// Which half of the pair a role uses for each operation.
export function directionFor(role: Party, op: "burn" | "open"): PadDirection {
  if (op === "burn") {
    return role === "A" ? "A->B" : "B->A";
  }
  return role === "A" ? "B->A" : "A->B";
}

export type Args = { positional: string[]; flags: Map<string, string> };

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`flag ${arg} needs a value`);
      }
      flags.set(arg.slice(2), value);
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// stdout carries exactly one machine-readable line per command; everything
// human-facing (banner, refusals, notes) goes to stderr.
const out = (text: string): void => {
  writeSync(1, text.endsWith("\n") ? text : `${text}\n`);
};
const err = (text: string): void => {
  writeSync(2, text.endsWith("\n") ? text : `${text}\n`);
};

// A refusal: the operation did not happen and nothing was burned.
export class Refused extends Error {}

function dirArg(args: Args, verb: string): string {
  const dir = args.positional[1];
  if (dir === undefined) {
    throw new Error(`${verb} needs <dir>`);
  }
  return resolve(dir);
}

function roleArg(args: Args): Party {
  const role = args.flags.get("as");
  if (role !== "A" && role !== "B") {
    throw new Error("--as A or --as B is required: it names YOUR role, and picks which half of the pair is burned");
  }
  return role;
}

function readInput(args: Args, index: number): string {
  const file = args.flags.get("in");
  if (file !== undefined) {
    return readFileSync(file, "utf8");
  }
  const text = args.positional[index];
  if (text === undefined) {
    throw new Error("missing input: pass it as an argument or with --in FILE");
  }
  return text;
}

// A pair directory must hold BOTH halves. A lone half is what a crash in
// the middle of gen leaves behind; refusing it keeps a half-pair from being
// courier-copied and used as if it were whole.
function requirePair(dir: string): void {
  const missing = (["A->B", "B->A"] as const).filter((d) => !existsSync(join(dir, SUBDIR[d], "pad.json")));
  if (missing.length === 2) {
    throw new Refused(`${dir} holds no pad pair (no a-to-b/ or b-to-a/); run gen first`);
  }
  if (missing.length === 1) {
    throw new Refused(
      `${dir} is a half-pair: ${SUBDIR[missing[0]]}/ is missing. gen did not complete. Remove the directory and ` +
        "run gen again; do not use the surviving half."
    );
  }
}

// Hold the pair directory's lock for the duration of `fn`; release on every
// exit path. Both halves must exist before anything is loaded.
function withLock<T>(dir: string, fn: () => T): T {
  const lock = acquireLock(dir);
  if (!lock.ok) {
    throw new Refused(lock.message);
  }
  try {
    requirePair(dir);
    return fn();
  } finally {
    lock.release();
  }
}

function loadHalf(dir: string, direction: PadDirection): { pad: Pad; mark: number } {
  const loaded = loadPad(join(dir, SUBDIR[direction]));
  if (!loaded.ok) {
    throw new Refused(loaded.message);
  }
  return loaded;
}

// Lock, load one half, run `fn` on it.
function withPad<T>(dir: string, direction: PadDirection, fn: (pad: Pad, mark: number) => T): T {
  return withLock(dir, () => {
    const { pad, mark } = loadHalf(dir, direction);
    return fn(pad, mark);
  });
}

function statusOf(pad: Pad, mark: number): Record<string, unknown> {
  return {
    label: pad.label,
    mode: pad.mode,
    source: pad.source,
    direction: pad.direction,
    size: pad.size,
    remaining: pad.remaining,
    nextOffset: pad.nextOffset,
    highWaterMark: pad.highWaterMark,
    // The highest nextOffset marks.log holds for this label (one past the mark
    // it implies); -1 when no record exists.
    recordedNextOffset: mark
  };
}

export function gen(args: Args): void {
  const dir = dirArg(args, "gen");
  const mode = (args.flags.get("mode") ?? "letters") as PadMode;
  if (mode !== "letters" && mode !== "bytes") {
    throw new Error(`--mode must be letters or bytes, not ${mode}`);
  }
  const label = args.flags.get("label");
  const external = args.flags.get("external");
  const sizeFlag = args.flags.get("size");
  const size = sizeFlag === undefined ? undefined : Number(sizeFlag);
  let pair: PadPair;
  if (external !== undefined) {
    if (size !== undefined) {
      throw new Error("--size and --external do not combine: the material is split in half, first half A->B, second half B->A");
    }
    const bytes = new Uint8Array(readFileSync(external));
    pair = Pad.pairFromExternal(bytes, mode, { label });
    err(
      `external material: ${bytes.length} bytes split at the midpoint -> A->B ${pair["A->B"].size} and B->A ` +
        `${pair["B->A"].size} ${mode} symbols` +
        (mode === "letters" ? " after rejection" : "") +
        ". Provenance is YOUR assertion; this tool did not verify it."
    );
  } else {
    pair = Pad.generatePair(size ?? 4096, mode, { label });
    err("source: crypto.getRandomValues() — a DRBG. Each pad is bounded by the generator's state entropy.");
  }
  // Hold the pair directory's lock while both halves are written, so two
  // gens cannot race the exists check or share a temp file. gen is NOT
  // atomic across the two halves: a crash between them leaves a half-pair,
  // which burn/open/status refuse (see requirePair) until the operator
  // removes the directory and runs gen again.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = acquireLock(dir);
  if (!lock.ok) {
    throw new Refused(lock.message);
  }
  try {
    initStore(join(dir, SUBDIR["A->B"]), pair["A->B"]);
    initStore(join(dir, SUBDIR["B->A"]), pair["B->A"]);
  } finally {
    lock.release();
  }
  out(JSON.stringify({ "A->B": statusOf(pair["A->B"], 0), "B->A": statusOf(pair["B->A"], 0) }));
}

export function burn(args: Args): void {
  const dir = dirArg(args, "burn");
  const role = roleArg(args);
  const input = readInput(args, 2);
  withPad(dir, directionFor(role, "burn"), (pad) => {
    const result =
      pad.mode === "letters"
        ? encryptLetters(input, pad, role)
        : encryptBytes(new TextEncoder().encode(input), pad, role);
    if (!result.ok) {
      throw new Refused(result.message);
    }
    const { envelope } = result;
    // (1)+(2) before (3): the burn is durable before the envelope exists
    // outside this process. A crash here loses these symbols, never reuses them.
    persistBurn(join(dir, SUBDIR[pad.direction]), pad, {
      op: "burn",
      startOffset: envelope.startOffset,
      consumed: envelope.consumed,
      skipped: 0
    });
    out(encodeEnvelope(envelope));
  });
}

export function open(args: Args): void {
  const dir = dirArg(args, "open");
  const role = roleArg(args);
  const input = readInput(args, 2);
  withPad(dir, directionFor(role, "open"), (pad) => {
    const store = join(dir, SUBDIR[pad.direction]);
    if (pad.mode === "letters") {
      const envelope = decodeEnvelope(input, "letters");
      if (!envelope) {
        throw new Refused("not a wire envelope for a letters pad (expected {label, startOffset, consumed, payload A-Z})");
      }
      const result = decryptLetters(envelope, pad, role);
      if (!result.ok) {
        throw new Refused(result.message);
      }
      persistBurn(store, pad, { op: "open", startOffset: result.startOffset, consumed: result.consumed, skipped: result.skipped });
      if (result.skipped > 0) {
        err(`seek: ${result.skipped} skipped offsets were burned to reach ${result.startOffset}.`);
      }
      out(result.text);
    } else {
      const envelope = decodeEnvelope(input, "bytes");
      if (!envelope) {
        throw new Refused("not a wire envelope for a bytes pad (expected {label, startOffset, consumed, payload hex})");
      }
      const result = decryptBytes(envelope, pad, role);
      if (!result.ok) {
        throw new Refused(result.message);
      }
      persistBurn(store, pad, { op: "open", startOffset: result.startOffset, consumed: result.consumed, skipped: result.skipped });
      if (result.skipped > 0) {
        err(`seek: ${result.skipped} skipped offsets were burned to reach ${result.startOffset}.`);
      }
      out(new TextDecoder().decode(result.bytes));
    }
  });
}

export function status(args: Args): void {
  const dir = dirArg(args, "status");
  // One lock for both halves, so the snapshot is consistent.
  const snapshot = withLock(dir, () => {
    const ab = loadHalf(dir, "A->B");
    const ba = loadHalf(dir, "B->A");
    return { "A->B": statusOf(ab.pad, ab.mark), "B->A": statusOf(ba.pad, ba.mark) };
  });
  out(JSON.stringify(snapshot));
}

export function main(argv: string[]): number {
  err(BANNER);
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    err((error as Error).message);
    err(USAGE);
    return 1;
  }
  const command = args.positional[0];
  const commands: Record<string, (a: Args) => void> = { gen, burn, open, status };
  if (command === undefined || !Object.hasOwn(commands, command)) {
    err(USAGE);
    return 1;
  }
  try {
    commands[command](args);
    return 0;
  } catch (error) {
    if (error instanceof Refused) {
      err(`refused: ${error.message}`);
      return 2;
    }
    err(`error: ${(error as Error).message}`);
    return 1;
  }
}

// Run only when this file is the process entry (node src/cli/truepad-pad.ts).
// Through bin/truepad-pad.mjs, argv[1] is the launcher and this is a no-op.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
