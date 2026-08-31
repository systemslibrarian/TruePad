import type { Vfs } from "../../src/browser/engine/vfs";

/* ============================================================================
 * A Vfs that fails the way the real one can
 * ----------------------------------------------------------------------------
 * MemoryVfs's `writeFileAtomic` is a map assignment: it either happens or it
 * does not, and no crash can leave half of it. That makes it useless for
 * testing the case Phase 1B exists to survive.
 *
 * `OpfsVfs.writeFileAtomic()` is genuinely atomic only where
 * `FileSystemFileHandle.move()` works. Everywhere else it falls back to
 *
 *     truncate(0) → write → flush
 *
 * on the TARGET file, so a crash mid-write leaves a target that exists and is
 * wrong — zero-length, half-written, or complete-but-unacknowledged. Claiming
 * crash safety from MemoryVfs alone would be claiming it from a backing that
 * cannot exhibit the failure.
 *
 * `nonAtomic: true` models that fallback: a fault mutates the target in place,
 * exactly as truncate-then-write does. With `nonAtomic: false` the target is
 * left untouched, modelling a backing where `move()` works — a fault there can
 * only leave a `.writing` temp file behind, which this wrapper also models.
 * ========================================================================= */

export type FaultMode =
  /** Throw before touching the target at all. */
  | "throw-before"
  /** Target exists at zero length, then throw. The truncate landed; the write did not. */
  | "truncate-then-throw"
  /** Target holds the first `bytes` bytes of the new content, then throw. */
  | "partial-then-throw"
  /** Target holds the complete new content, but the caller is told it failed. */
  | "complete-then-throw";

export type Fault = {
  path: string;
  mode: FaultMode;
  /** For "partial-then-throw": how many bytes land before the throw. */
  bytes?: number;
  /** Fire this many times, then stop. Default 1, so a retry can succeed. */
  times?: number;
};

export class FaultVfs implements Vfs {
  readonly #inner: Vfs;
  readonly #nonAtomic: boolean;
  readonly #writeFaults: Fault[] = [];
  readonly #readFaults: { path: string; times: number }[] = [];
  /** Every write that actually reached the backing, in order. */
  readonly writes: string[] = [];

  constructor(inner: Vfs, options: { nonAtomic?: boolean } = {}) {
    this.#inner = inner;
    this.#nonAtomic = options.nonAtomic ?? false;
  }

  /** Schedule a write fault on `path`. */
  failWrite(fault: Fault): this {
    this.#writeFaults.push({ times: 1, ...fault });
    return this;
  }

  /** Make `readFile(path)` throw — the "present but unreadable" case, which is
   *  NOT the same as absent and must never be collapsed into it. */
  failRead(path: string, times = 1): this {
    this.#readFaults.push({ path, times });
    return this;
  }

  /** Leave a `.writing` temp file behind, as an interrupted move()-path write
   *  would. Nothing in the engine should ever mistake it for real state. */
  async leaveTempFile(path: string, data: Uint8Array): Promise<void> {
    await this.#inner.writeFileAtomic(`${path}.writing`, data);
  }

  #takeWriteFault(path: string): Fault | null {
    const i = this.#writeFaults.findIndex((f) => f.path === path && (f.times ?? 1) > 0);
    if (i === -1) return null;
    const fault = this.#writeFaults[i];
    fault.times = (fault.times ?? 1) - 1;
    return fault;
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const i = this.#readFaults.findIndex((f) => f.path === path && f.times > 0);
    if (i !== -1) {
      this.#readFaults[i].times -= 1;
      throw new Error(`simulated read failure for ${path}`);
    }
    return this.#inner.readFile(path);
  }

  async writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
    const fault = this.#takeWriteFault(path);
    if (fault === null) {
      this.writes.push(path);
      return this.#inner.writeFileAtomic(path, data);
    }
    if (fault.mode === "throw-before") {
      // move()-path or pre-truncate failure: the target keeps its old contents.
      throw new Error(`simulated write failure before touching ${path}`);
    }
    if (!this.#nonAtomic) {
      // A backing with a working move(): the target is never partially written.
      // The most an interrupted write leaves is a temp file.
      await this.#inner.writeFileAtomic(`${path}.writing`, data);
      throw new Error(`simulated write failure (atomic backing) for ${path}`);
    }
    // The truncate → write → flush fallback, interrupted.
    switch (fault.mode) {
      case "truncate-then-throw":
        this.writes.push(path);
        await this.#inner.writeFileAtomic(path, new Uint8Array(0));
        throw new Error(`simulated crash after truncating ${path}`);
      case "partial-then-throw": {
        const n = Math.min(fault.bytes ?? Math.floor(data.length / 2), data.length);
        this.writes.push(path);
        await this.#inner.writeFileAtomic(path, data.slice(0, n));
        throw new Error(`simulated crash after writing ${n} bytes of ${path}`);
      }
      case "complete-then-throw":
        this.writes.push(path);
        await this.#inner.writeFileAtomic(path, data);
        throw new Error(`simulated failure reported after ${path} was fully written`);
    }
  }

  appendFile(path: string, data: Uint8Array): Promise<void> {
    return this.#inner.appendFile(path, data);
  }
  readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    return this.#inner.readRange(path, offset, length);
  }
  writeRange(path: string, offset: number, data: Uint8Array): Promise<void> {
    return this.#inner.writeRange(path, offset, data);
  }
  exists(path: string): Promise<boolean> {
    return this.#inner.exists(path);
  }
  remove(path: string): Promise<void> {
    return this.#inner.remove(path);
  }
  size(path: string): Promise<number | null> {
    return this.#inner.size(path);
  }
  list(prefix: string): Promise<string[]> {
    return this.#inner.list(prefix);
  }
  withLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    return this.#inner.withLock(scope, fn);
  }
}
