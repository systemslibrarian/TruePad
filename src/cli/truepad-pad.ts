/* ============================================================================
 * truepad-pad — reuse-safe pad handling on disk
 * ----------------------------------------------------------------------------
 * Node only. Imports core; never imports the exhibit. Runs from source under
 * Node's built-in type stripping (>= 22.18.0); bin/truepad-pad.mjs checks
 * the runtime before importing this file.
 *
 *   gen    <dir> [--mode letters|bytes] [--size N] [--external FILE] [--label PAD-XXXX]
 *   burn   <dir> (TEXT | --in FILE)        encrypt: burn pad symbols, emit an envelope
 *   open   <dir> (ENVELOPE | --in FILE)    decrypt: seek + burn, emit plaintext
 *   status <dir>
 *
 * The verbs name what happens to the PAD. There is no "send": this tool is
 * not secure messaging (see BANNER).
 * ========================================================================= */

import { readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decodeEnvelope,
  decryptBytes,
  decryptLetters,
  encodeEnvelope,
  encryptBytes,
  encryptLetters
} from "../core/cipher-otp.ts";
import { Pad, type PadMode } from "../core/pad.ts";
import { acquireLock } from "./lock.ts";
import { initStore, loadPad, persistBurn } from "./store.ts";

export const BANNER =
  "truepad-pad: reuse-safe pad handling. NOT secure messaging — envelopes are unauthenticated: an attacker who\n" +
  "knows the plaintext format can flip chosen bits undetectably, and a forged startOffset burns the receiver's pad.";

export const USAGE = `usage:
  truepad-pad gen    <dir> [--mode letters|bytes] [--size N] [--external FILE] [--label PAD-XXXX]
  truepad-pad burn   <dir> (TEXT | --in FILE)
  truepad-pad open   <dir> (ENVELOPE-JSON | --in FILE)
  truepad-pad status <dir>
exit codes: 0 ok · 2 refused (nothing burned) · 1 usage or I/O error`;

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

// Hold the lock for the duration of `fn`; release on every exit path.
function withPad<T>(dir: string, fn: (pad: Pad, mark: number) => T): T {
  const lock = acquireLock(dir);
  if (!lock.ok) {
    throw new Refused(lock.message);
  }
  try {
    const loaded = loadPad(dir);
    if (!loaded.ok) {
      throw new Refused(loaded.message);
    }
    return fn(loaded.pad, loaded.mark);
  } finally {
    lock.release();
  }
}

function statusOf(pad: Pad, mark: number): Record<string, unknown> {
  return {
    label: pad.label,
    mode: pad.mode,
    source: pad.source,
    size: pad.size,
    remaining: pad.remaining,
    nextOffset: pad.nextOffset,
    highWaterMark: pad.highWaterMark,
    recordedMark: mark
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
  let pad: Pad;
  if (external !== undefined) {
    const bytes = new Uint8Array(readFileSync(external));
    pad = Pad.fromExternal(bytes, mode, { size, label });
    err(
      `external material: ${bytes.length} bytes -> ${pad.size} ${mode} symbols` +
        (mode === "letters" ? " after rejection" : "") +
        ". Provenance is YOUR assertion; this tool did not verify it."
    );
  } else {
    pad = Pad.generate(size ?? 4096, mode, { label });
    err("source: crypto.getRandomValues() — a DRBG. The pad is bounded by the generator's state entropy.");
  }
  initStore(dir, pad);
  out(JSON.stringify(statusOf(pad, pad.nextOffset)));
}

export function burn(args: Args): void {
  const dir = dirArg(args, "burn");
  const input = readInput(args, 2);
  withPad(dir, (pad) => {
    const result =
      pad.mode === "letters" ? encryptLetters(input, pad) : encryptBytes(new TextEncoder().encode(input), pad);
    if (!result.ok) {
      throw new Refused(result.message);
    }
    const { envelope } = result;
    // (1)+(2) before (3): the burn is durable before the envelope exists
    // outside this process. A crash here loses these symbols, never reuses them.
    persistBurn(dir, pad, { op: "burn", startOffset: envelope.startOffset, consumed: envelope.consumed, skipped: 0 });
    out(encodeEnvelope(envelope));
  });
}

export function open(args: Args): void {
  const dir = dirArg(args, "open");
  const input = readInput(args, 2);
  withPad(dir, (pad) => {
    if (pad.mode === "letters") {
      const envelope = decodeEnvelope(input, "letters");
      if (!envelope) {
        throw new Refused("not a wire envelope for a letters pad (expected {label, startOffset, consumed, payload A-Z})");
      }
      const result = decryptLetters(envelope, pad);
      if (!result.ok) {
        throw new Refused(result.message);
      }
      persistBurn(dir, pad, { op: "open", startOffset: result.startOffset, consumed: result.consumed, skipped: result.skipped });
      if (result.skipped > 0) {
        err(`seek: ${result.skipped} skipped offsets were burned to reach ${result.startOffset}.`);
      }
      out(result.text);
    } else {
      const envelope = decodeEnvelope(input, "bytes");
      if (!envelope) {
        throw new Refused("not a wire envelope for a bytes pad (expected {label, startOffset, consumed, payload hex})");
      }
      const result = decryptBytes(envelope, pad);
      if (!result.ok) {
        throw new Refused(result.message);
      }
      persistBurn(dir, pad, { op: "open", startOffset: result.startOffset, consumed: result.consumed, skipped: result.skipped });
      if (result.skipped > 0) {
        err(`seek: ${result.skipped} skipped offsets were burned to reach ${result.startOffset}.`);
      }
      out(new TextDecoder().decode(result.bytes));
    }
  });
}

export function status(args: Args): void {
  const dir = dirArg(args, "status");
  withPad(dir, (pad, mark) => {
    out(JSON.stringify(statusOf(pad, mark)));
  });
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
