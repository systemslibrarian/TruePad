/* ============================================================================
 * NodeVfs — the browser Vfs, backed by REAL FORMAT-V2 files on node:fs
 * ----------------------------------------------------------------------------
 * TEST-ONLY. This is the one place the browser `Vfs` contract is implemented
 * over node:fs, so the browser engine (src/browser/engine/*, which itself
 * never touches node:) can write its store to an ordinary directory the actual
 * truepad2 CLI can open — and vice versa. It is the load-bearing fixture of
 * tests/browser-interop.test.ts: because src/browser writes through this Vfs
 * exactly as it writes through OpfsVfs, and the CLI writes the same three
 * files through node:fs, "a browser store is CLI-readable" reduces to bytes on
 * disk, not to a re-implementation.
 *
 * It lives in tests/helpers (NOT src/browser), so the src/browser → core-only
 * layering invariant (tests/layering.test.ts) is untouched: this file MAY
 * import node:fs, the engine never does.
 *
 * The Vfs is rooted at `root`; a pair-relative POSIX path like
 * "<pairId>/a-to-b/head.json" maps to nested directories under it. The browser
 * store roots each pair under its pairId, so the CLI's pair directory is
 * `<root>/<pairId>` — the subdirectory the CLI opens directly.
 * ========================================================================= */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from "node:fs";
import { dirname, join } from "node:path";
import type { Vfs } from "../../src/browser/engine/vfs.ts";

export class NodeVfs implements Vfs {
  readonly root: string;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = root;
  }

  // A pair-relative POSIX path -> an absolute host path under root.
  #full(path: string): string {
    return join(this.root, ...path.split("/"));
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(readFileSync(this.#full(path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  // Write-in-full then rename: a crash leaves the old bytes or the new, never a
  // torn mix — the browser sense of "atomic" (BROWSER-SECURITY.md §2).
  async writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
    const full = this.#full(path);
    mkdirSync(dirname(full), { recursive: true });
    const tmp = `${full}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, data, 0, data.length);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, full);
  }

  async appendFile(path: string, data: Uint8Array): Promise<void> {
    const full = this.#full(path);
    mkdirSync(dirname(full), { recursive: true });
    appendFileSync(full, data);
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length < 0) {
      throw new Error(`readRange: negative [${offset}, ${offset + length}) for ${path}`);
    }
    const full = this.#full(path);
    const fd = openSync(full, "r");
    try {
      const buf = Buffer.allocUnsafe(length);
      const read = readSync(fd, buf, 0, length, offset);
      if (read !== length) {
        throw new Error(`readRange: [${offset}, ${offset + length}) out of range for ${path} (read ${read})`);
      }
      return new Uint8Array(buf);
    } finally {
      closeSync(fd);
    }
  }

  async writeRange(path: string, offset: number, data: Uint8Array): Promise<void> {
    if (offset < 0) {
      throw new Error(`writeRange: negative offset ${offset} for ${path}`);
    }
    const full = this.#full(path);
    const fd = openSync(full, "r+");
    try {
      const written = writeSync(fd, data, 0, data.length, offset);
      if (written !== data.length) {
        throw new Error(`writeRange: short write ${written} of ${data.length} at ${offset} for ${path}`);
      }
    } finally {
      closeSync(fd);
    }
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(this.#full(path));
  }

  // Idempotent: removing an absent file/dir is not an error (§17 destruction).
  async remove(path: string): Promise<void> {
    rmSync(this.#full(path), { recursive: true, force: true });
  }

  async size(path: string): Promise<number | null> {
    try {
      return statSync(this.#full(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const dir = prefix === "" ? this.root : this.#full(prefix);
    try {
      return readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  // Real per-scope serialisation via a promise chain — the same shape as
  // MemoryVfs. Node's fs calls here are synchronous, so within one process
  // this is genuine mutual exclusion, the twin of OpfsVfs's Web Locks.
  async withLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.#locks.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(
      scope,
      prior.then(() => gate)
    );
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
