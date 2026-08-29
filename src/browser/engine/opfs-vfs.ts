/* ============================================================================
 * TruePad Browser Edition — the Vfs over the Origin Private File System
 * ----------------------------------------------------------------------------
 * The product backing: OPFS (`navigator.storage.getDirectory()`), reached in
 * the worker through FileSystemSyncAccessHandle (worker-only synchronous
 * read/write/truncate/getSize/flush) and the Web Locks API. This is the
 * strongest file-like primitive a browser offers and the durability it gives
 * is the browser sense of docs/BROWSER-SECURITY.md §2 — the bytes reached
 * OPFS and were flushed; a tab/worker crash after flush is survived. It is
 * deliberately NOT the CLI's Linux-ext4 power-loss claim.
 *
 * The Vfs is rooted at the OPFS root: a path like "<pairId>/a-to-b/head.json"
 * maps to nested directory handles, and the append-only rollback witness lives
 * at a distinct root path "witness/<pairId>.log". Each method opens a sync access handle,
 * does its work, flushes where it writes and closes — OPFS permits one open
 * sync handle per file at a time, and `withLock(pairId)` serialises the
 * mutators per pair, so the handles never collide. `withLock` is real mutual
 * exclusion via `navigator.locks.request`, the browser twin of the CLI's
 * O_EXCL lock — never a UI flag.
 * ========================================================================= */

import type { Vfs } from "./vfs.ts";

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "NotFoundError";
}

function splitPath(path: string): { dirs: string[]; name: string } {
  const parts = path.split("/").filter((p) => p.length > 0);
  const name = parts.pop();
  if (name === undefined) {
    throw new Error(`invalid Vfs path: ${JSON.stringify(path)}`);
  }
  return { dirs: parts, name };
}

// Read exactly `length` bytes at `position` into a fresh buffer, looping until
// filled; a short read before the end is a broken invariant callers pre-check.
function readExactly(handle: FileSystemSyncAccessHandle, length: number, position: number): Uint8Array {
  const buffer = new Uint8Array(length);
  let done = 0;
  while (done < length) {
    const got = handle.read(buffer.subarray(done), { at: position + done });
    if (got <= 0) {
      throw new Error(`short read: ${done} of ${length} bytes at offset ${position}`);
    }
    done += got;
  }
  return buffer;
}

// Write every byte of `bytes` at `position`, looping over short writes.
function writeAll(handle: FileSystemSyncAccessHandle, bytes: Uint8Array, position: number): void {
  let done = 0;
  while (done < bytes.length) {
    const written = handle.write(bytes.subarray(done), { at: position + done });
    if (written <= 0) {
      throw new Error(`short write: ${done} of ${bytes.length} bytes at offset ${position}`);
    }
    done += written;
  }
}

export class OpfsVfs implements Vfs {
  #rootHandle: Promise<FileSystemDirectoryHandle> | null = null;

  #root(): Promise<FileSystemDirectoryHandle> {
    if (this.#rootHandle === null) {
      this.#rootHandle = navigator.storage.getDirectory();
    }
    return this.#rootHandle;
  }

  async #dir(dirs: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let handle = await this.#root();
    for (const part of dirs) {
      try {
        handle = await handle.getDirectoryHandle(part, { create });
      } catch (error) {
        if (!create && isNotFound(error)) {
          return null;
        }
        throw error;
      }
    }
    return handle;
  }

  async #fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const { dirs, name } = splitPath(path);
    const dir = await this.#dir(dirs, create);
    if (dir === null) {
      return null;
    }
    try {
      return await dir.getFileHandle(name, { create });
    } catch (error) {
      if (!create && isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const file = await this.#fileHandle(path, false);
    if (file === null) {
      return null;
    }
    const handle = await file.createSyncAccessHandle();
    try {
      const size = handle.getSize();
      return size === 0 ? new Uint8Array(0) : readExactly(handle, size, 0);
    } finally {
      handle.close();
    }
  }

  // Replace a file's whole contents durably. Where the OPFS implementation
  // supports FileSystemFileHandle.move (Chromium), this is genuinely atomic:
  // the bytes are written to a sibling temp file and flushed, then MOVED over
  // the target, so a reader sees the old bytes or the new, never a torn mix.
  // Where move() is unavailable it falls back to a durable in-place rewrite
  // (truncate → write → flush): a crash mid-rewrite leaves a truncated/partial
  // file, but every reader in this engine detects that and refuses closed
  // (corrupt-head / corrupt-secret-body / corrupt-journal), never a silently-
  // accepted partial. The rollback witness does NOT rely on this — it is an
  // append-only journal (witness.ts) that is never truncated.
  async writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
    const { dirs, name } = splitPath(path);
    const dir = await this.#dir(dirs, true);
    if (dir === null) {
      throw new Error(`writeFileAtomic: could not create directory for ${path}`);
    }
    const tmpName = `${name}.writing`;
    const tmp = await dir.getFileHandle(tmpName, { create: true });
    const handle = await tmp.createSyncAccessHandle();
    try {
      handle.truncate(0);
      writeAll(handle, data, 0);
      handle.flush();
    } finally {
      handle.close();
    }
    const move = (tmp as { move?: (destination: FileSystemDirectoryHandle, name: string) => Promise<void> }).move;
    if (typeof move === "function") {
      try {
        await move.call(tmp, dir, name); // atomic replace: overwrites the target
        return;
      } catch {
        /* move unsupported for this target — fall back to a durable rewrite */
      }
    }
    const target = await dir.getFileHandle(name, { create: true });
    const th = await target.createSyncAccessHandle();
    try {
      th.truncate(0);
      writeAll(th, data, 0);
      th.flush();
    } finally {
      th.close();
    }
    try {
      await dir.removeEntry(tmpName);
    } catch {
      /* best-effort temp cleanup; an orphaned .writing file is inert */
    }
  }

  async appendFile(path: string, data: Uint8Array): Promise<void> {
    const file = await this.#fileHandle(path, true);
    if (file === null) {
      throw new Error(`appendFile: could not create ${path}`);
    }
    const handle = await file.createSyncAccessHandle();
    try {
      writeAll(handle, data, handle.getSize());
      handle.flush();
    } finally {
      handle.close();
    }
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const file = await this.#fileHandle(path, false);
    if (file === null) {
      throw new Error(`readRange: no such file ${path}`);
    }
    const handle = await file.createSyncAccessHandle();
    try {
      if (offset < 0 || offset + length > handle.getSize()) {
        throw new Error(`readRange: [${offset}, ${offset + length}) out of range for ${path} (${handle.getSize()} bytes)`);
      }
      return length === 0 ? new Uint8Array(0) : readExactly(handle, length, offset);
    } finally {
      handle.close();
    }
  }

  async writeRange(path: string, offset: number, data: Uint8Array): Promise<void> {
    const file = await this.#fileHandle(path, false);
    if (file === null) {
      throw new Error(`writeRange: no such file ${path}`);
    }
    const handle = await file.createSyncAccessHandle();
    try {
      if (offset < 0 || offset + data.length > handle.getSize()) {
        throw new Error(`writeRange: [${offset}, ${offset + data.length}) out of range for ${path}`);
      }
      writeAll(handle, data, offset);
      handle.flush();
    } finally {
      handle.close();
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.#fileHandle(path, false)) !== null;
  }

  async remove(path: string): Promise<void> {
    const { dirs, name } = splitPath(path);
    const dir = await this.#dir(dirs, false);
    if (dir === null) {
      return; // parent already gone: idempotent
    }
    try {
      await dir.removeEntry(name, { recursive: true });
    } catch (error) {
      if (isNotFound(error)) {
        return; // already gone: idempotent
      }
      throw error;
    }
  }

  async size(path: string): Promise<number | null> {
    const file = await this.#fileHandle(path, false);
    if (file === null) {
      return null;
    }
    const handle = await file.createSyncAccessHandle();
    try {
      return handle.getSize();
    } finally {
      handle.close();
    }
  }

  async list(prefix: string): Promise<string[]> {
    const dirs = prefix.split("/").filter((p) => p.length > 0);
    const dir = await this.#dir(dirs, false);
    if (dir === null) {
      return [];
    }
    const names: string[] = [];
    for await (const name of dir.keys()) {
      names.push(name);
    }
    return names;
  }

  async withLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    return navigator.locks.request(scope, { mode: "exclusive" }, async () => fn());
  }
}
