/* ============================================================================
 * TruePad Browser Edition — the transient Sealed Pad Transfer runtime
 * ----------------------------------------------------------------------------
 * Everything here is IN-MEMORY AND WORKER-ONLY, and it is transient on purpose.
 * A worker that dies loses a review handle and a receive session, and that is
 * the correct outcome in both cases: the review is re-done, and the sealed file
 * is re-opened. Nothing durable is needed to make either safe, and adding a
 * durable "session is open" flag would survive the crash the session does not
 * and then need reaping.
 *
 * TWO KINDS OF HANDLE
 * -------------------
 * `reviewId` — the sender's. It holds the canonical request body the worker
 * itself decoded, so `spt-confirm-request` takes ONLY the handle. The page
 * never re-supplies the body it claims to have shown, which is what closes
 * "displayed B, sealed B′". Public material only.
 *
 * `sessionId` — the recipient's. It holds decrypted pad bytes, so it never
 * leaves the worker, and `spt-commit-receive` takes ONLY the handle. There is
 * no parameter through which a caller can substitute what gets imported.
 *
 * THE LOCK LEASE
 * --------------
 * A receive session must be exclusive across TABS, and must stay exclusive
 * across the RETURN of `spt-open-sealed` until a later RPC — so `vfs.withLock`,
 * which is scoped to one callback, cannot express it. The lease abstraction
 * below holds a Web Lock open by keeping its callback pending, and hands back
 * an object whose `release()` resolves it.
 *
 * It is `ifAvailable` and NEVER queues. Queueing would let a second
 * decapsulation begin the instant the first session ended, which is exactly the
 * substitution one-session-per-request exists to prevent.
 *
 * The abstraction exists so tests can model two tabs deterministically. It does
 * not weaken production: `WebLocksProvider` is the real thing, and the test
 * provider is a separate implementation of the same narrow interface.
 * ========================================================================= */

export interface LockLease {
  readonly name: string;
  release(): void;
}

export interface SessionLockProvider {
  /** Acquire, or return null immediately if held. NEVER queues. */
  tryAcquire(name: string): Promise<LockLease | null>;
}

/** Production: `navigator.locks`, held open across RPCs.
 *
 *  The callback returned to `navigator.locks.request` stays pending for the
 *  whole session; resolving it is what releases the lock. A worker that dies
 *  drops the lock naturally — no timeout, no lease record, no cleanup job. */
export class WebLocksProvider implements SessionLockProvider {
  async tryAcquire(name: string): Promise<LockLease | null> {
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    if (!locks) return null;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // `granted` settles as soon as we know whether we got it; `held` keeps the
    // lock until release() is called.
    const granted = new Promise<LockLease | null>((resolve) => {
      void locks
        .request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (lock === null) {
            resolve(null);
            return;
          }
          resolve({ name, release });
          await held;
        })
        .catch(() => resolve(null));
    });
    return granted;
  }
}

type LockManagerLike = {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown) => Promise<void>
  ): Promise<unknown>;
};

/** Deterministic provider for tests. Two runtimes sharing ONE instance model
 *  two tabs in one origin; two instances model two different origins. */
export class MemoryLockProvider implements SessionLockProvider {
  readonly #held = new Set<string>();

  async tryAcquire(name: string): Promise<LockLease | null> {
    if (this.#held.has(name)) return null;
    this.#held.add(name);
    let released = false;
    return {
      name,
      release: () => {
        if (released) return; // release is idempotent; double-release must not free someone else's lock
        released = true;
        this.#held.delete(name);
      }
    };
  }

  /** Test-only: model a tab disappearing without an orderly release. */
  forceRelease(name: string): void {
    this.#held.delete(name);
  }

  isHeld(name: string): boolean {
    return this.#held.has(name);
  }
}

/* ---- transient state ------------------------------------------------------ */

export type ReviewEntry = {
  /** The canonical 1235-byte body the WORKER decoded. */
  canonicalBody: Uint8Array;
  requestHash: Uint8Array;
};

export type ReceiveSession = {
  sessionId: string;
  requestId: string;
  requestHash: Uint8Array;
  packageIdentity: Uint8Array;
  /** The pairId inside the decrypted container. */
  pairId: string;
  /** The EXACT authenticated plaintext. Never leaves the worker, and never
   *  comes back in from a caller. */
  padFileBytes: Uint8Array;
  confirmValue: Uint8Array;
  lease: LockLease;
};

function wipe(...buffers: (Uint8Array | undefined)[]): void {
  for (const b of buffers) {
    if (!b) continue;
    try {
      b.fill(0);
    } catch {
      /* detached or non-writable */
    }
  }
}

/** One per worker. Tests make their own, so nothing is a module global. */
export class SptRuntime {
  readonly locks: SessionLockProvider;
  readonly #reviews = new Map<string, ReviewEntry>();
  /** At most one session per requestId — the Web Lock guarantees that across
   *  tabs, and this map keeps it true within one runtime. */
  readonly #sessions = new Map<string, ReceiveSession>();
  readonly #byRequest = new Map<string, string>();

  constructor(locks: SessionLockProvider = new WebLocksProvider()) {
    this.locks = locks;
  }

  putReview(reviewId: string, entry: ReviewEntry): void {
    this.#reviews.set(reviewId, entry);
  }

  getReview(reviewId: string): ReviewEntry | undefined {
    return this.#reviews.get(reviewId);
  }

  /** Dropped only after a confirmation has durably landed. If persistence
   *  failed, the handle survives so the same review can be retried in this
   *  worker without asking the operator to compare twelve words again. */
  dropReview(reviewId: string): void {
    const entry = this.#reviews.get(reviewId);
    if (entry) wipe(entry.canonicalBody, entry.requestHash);
    this.#reviews.delete(reviewId);
  }

  putSession(session: ReceiveSession): void {
    this.#sessions.set(session.sessionId, session);
    this.#byRequest.set(session.requestId, session.sessionId);
  }

  getSession(sessionId: string): ReceiveSession | undefined {
    return this.#sessions.get(sessionId);
  }

  sessionForRequest(requestId: string): ReceiveSession | undefined {
    const id = this.#byRequest.get(requestId);
    return id === undefined ? undefined : this.#sessions.get(id);
  }

  /** Wipe the plaintext, forget the session, release the lock. Used by commit,
   *  reject, abandon and every failure path — there is one teardown, so a new
   *  exit cannot forget half of it. */
  endSession(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    wipe(session.padFileBytes, session.confirmValue, session.packageIdentity, session.requestHash);
    this.#sessions.delete(sessionId);
    if (this.#byRequest.get(session.requestId) === sessionId) this.#byRequest.delete(session.requestId);
    session.lease.release();
  }

  /** Test/inspection only. */
  get openSessionCount(): number {
    return this.#sessions.size;
  }

  get openReviewCount(): number {
    return this.#reviews.size;
  }
}
