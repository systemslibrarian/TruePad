/* ============================================================================
 * truepad-pad lock — one process per pad directory
 * ----------------------------------------------------------------------------
 * Node only. The lockfile is created with O_CREAT|O_EXCL ("wx"), which is
 * atomic on local POSIX filesystems: two processes cannot both succeed. The
 * file holds the holder's pid and start time for the operator's benefit.
 *
 * Released on normal exit and on SIGINT/SIGTERM (Ctrl-C, kill). Fail closed
 * on a leftover lock: after a crash or SIGKILL the lockfile survives, and
 * this module does NOT decide whether the recorded pid is dead (pids are
 * reused). It refuses and tells the operator exactly what to remove once
 * they have confirmed nothing else holds the pad. Tested on a local Linux
 * ext4 filesystem only; O_EXCL semantics on network filesystems were not
 * tested.
 * ========================================================================= */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE = "lock";

export type LockRefusal = { ok: false; reason: "locked"; holder: string; message: string };
export type LockResult = { ok: true; release: () => void } | LockRefusal;

export function acquireLock(dir: string): LockResult {
  const path = join(dir, LOCK_FILE);
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`no such pad directory: ${dir}`);
    }
    if (code !== "EEXIST") {
      throw error;
    }
    let holder = "(unreadable)";
    try {
      holder = readFileSync(path, "utf8").trim();
    } catch {
      /* keep the placeholder */
    }
    return {
      ok: false,
      reason: "locked",
      holder,
      message:
        `${dir} is locked by ${holder}. Two processes must never hold the same pad. If that process is ` +
        `gone (a crash or SIGKILL leaves this file behind), confirm nothing else is using the pad and remove ${path}.`
    };
  }
  try {
    writeSync(fd, `pid ${process.pid} since ${new Date().toISOString()}`);
  } finally {
    closeSync(fd);
  }

  let released = false;
  // Node does not emit "exit" for a default-handled signal, so Ctrl-C would
  // otherwise leave the lock behind. Release, then exit with the
  // conventional 128+signal code.
  const onSignal = (signal: NodeJS.Signals): void => {
    release();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    process.off("exit", release);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
  process.once("exit", release);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { ok: true, release };
}
