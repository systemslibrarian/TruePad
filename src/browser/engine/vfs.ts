/* ============================================================================
 * TruePad Browser Edition — the virtual filesystem the store runs on
 * ----------------------------------------------------------------------------
 * The frozen v2 store state machine (§1, §12) is defined over a handful of
 * durable-file operations: atomic replace, append, positioned read, a
 * single-writer lock. This module abstracts exactly those, so the SAME store
 * logic (store2.ts's browser twin) runs unchanged over three backings:
 *
 *   - OpfsVfs   — the product: OPFS + worker sync access handles + Web Locks.
 *   - MemoryVfs — fast, deterministic unit tests (this file).
 *   - a Node-fs Vfs (tests/ only) — writes REAL FORMAT-V2 files so the actual
 *     truepad2 CLI can open a browser-generated store, proving byte-for-byte
 *     protocol interop.
 *
 * "durable" here means the browser sense of §BROWSER-SECURITY.md — the bytes
 * reached OPFS and were flushed; a tab/worker crash after flush is survived.
 * It is deliberately NOT the CLI's Linux-ext4 power-loss claim, and the
 * browser claims ledger says so. This layer never interprets file contents;
 * it only moves bytes durably.
 * ========================================================================= */

// A path is a pair-relative POSIX-style path, e.g. "a-to-b/head.json". The
// store never escapes its pair directory; the Vfs roots each pair.
export interface Vfs {
  // Read a whole file, or null if it does not exist.
  readFile(path: string): Promise<Uint8Array | null>;
  // Replace a file's entire contents durably. Backings that offer an atomic
  // replace do so — NodeVfs writes a temp file then renames; MemoryVfs swaps a
  // value; OpfsVfs writes a temp file then move()s it over the target where the
  // OPFS implementation supports move. Where a backing cannot (OpfsVfs's move()
  // fallback), it is a durable in-place rewrite whose torn write leaves a
  // partial file every reader in this engine detects and refuses CLOSED, never
  // a silently-accepted mix (BROWSER-SECURITY.md §2). The rollback witness does
  // NOT depend on this atomicity — it is an append-only journal (witness.ts).
  writeFileAtomic(path: string, data: Uint8Array): Promise<void>;
  // Append to a file (creating it if absent) and flush. The journal's only
  // write shape (§12.1).
  appendFile(path: string, data: Uint8Array): Promise<void>;
  // Positioned read of `length` bytes from `offset` (secret.bin reads, §1.2).
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  // Remove a file (destruction, §17). Idempotent: removing an absent file is ok.
  remove(path: string): Promise<void>;
  // Overwrite `length` bytes at `offset` with the given bytes and flush — the
  // secret.bin zero-overwrite of destruction (§17.2 step 3), best-effort.
  writeRange(path: string, offset: number, data: Uint8Array): Promise<void>;
  // Size of a file in bytes, or null if absent.
  size(path: string): Promise<number | null>;
  // Direct children (one level) under a prefix directory, names only.
  list(prefix: string): Promise<string[]>;
  // Run `fn` while holding an exclusive lock named `scope`. The browser's
  // single-writer enforcement (§10.3's twin): OPFS uses navigator.locks;
  // MemoryVfs a promise chain. Never a mere UI isBusy flag.
  withLock<T>(scope: string, fn: () => Promise<T>): Promise<T>;
}

/* ---- MemoryVfs: deterministic in-memory backing for unit tests ------------ */

export class MemoryVfs implements Vfs {
  readonly #files = new Map<string, Uint8Array>();
  readonly #locks = new Map<string, Promise<unknown>>();

  async readFile(path: string): Promise<Uint8Array | null> {
    const f = this.#files.get(path);
    return f === undefined ? null : f.slice();
  }

  async writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
    this.#files.set(path, data.slice());
  }

  async appendFile(path: string, data: Uint8Array): Promise<void> {
    const prev = this.#files.get(path) ?? new Uint8Array(0);
    const next = new Uint8Array(prev.length + data.length);
    next.set(prev, 0);
    next.set(data, prev.length);
    this.#files.set(path, next);
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const f = this.#files.get(path);
    if (f === undefined) {
      throw new Error(`readRange: no such file ${path}`);
    }
    if (offset < 0 || offset + length > f.length) {
      throw new Error(`readRange: [${offset}, ${offset + length}) out of range for ${path} (${f.length} bytes)`);
    }
    return f.slice(offset, offset + length);
  }

  async writeRange(path: string, offset: number, data: Uint8Array): Promise<void> {
    const f = this.#files.get(path);
    if (f === undefined) {
      throw new Error(`writeRange: no such file ${path}`);
    }
    if (offset < 0 || offset + data.length > f.length) {
      throw new Error(`writeRange: [${offset}, ${offset + data.length}) out of range for ${path}`);
    }
    f.set(data, offset);
  }

  async exists(path: string): Promise<boolean> {
    return this.#files.has(path);
  }

  async remove(path: string): Promise<void> {
    this.#files.delete(path);
  }

  async size(path: string): Promise<number | null> {
    const f = this.#files.get(path);
    return f === undefined ? null : f.length;
  }

  async list(prefix: string): Promise<string[]> {
    const norm = prefix === "" ? "" : prefix.replace(/\/+$/, "") + "/";
    const names = new Set<string>();
    for (const key of this.#files.keys()) {
      if (norm === "" || key.startsWith(norm)) {
        const rest = key.slice(norm.length);
        const first = rest.split("/")[0];
        if (first.length > 0) {
          names.add(first);
        }
      }
    }
    return [...names];
  }

  async withLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    // Chain on the previous holder so only one fn runs per scope at a time.
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
