/* ============================================================================
 * QR camera scanner — the lifecycle, proven against the real controller
 * ----------------------------------------------------------------------------
 * The camera is a borrowed capability. These tests drive the ACTUAL
 * `startCameraScan` state machine through injected seams (open, grab, decode,
 * schedule) and assert the property that matters on every exit path: the tracks
 * are stopped and nothing scanned bypasses the caller's onText. No production
 * behaviour is weakened to test it — the seams are the same ones the browser
 * wiring fills in.
 * ========================================================================= */

import { describe, expect, it } from "vitest";
import {
  startCameraScan,
  classifyCameraError,
  type CameraScannerDeps,
  type CameraSession,
  type FrameData
} from "../src/browser/ui/qr/scanner.ts";

const FRAME: FrameData = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A fake camera session that records whether it was released and stopped. */
function fakeSession(frames: (FrameData | null)[] = []): CameraSession & {
  released: boolean;
  trackStopped: boolean;
  triggerEnded(): void;
} {
  const queue = [...frames];
  let ended: (() => void) | null = null;
  return {
    released: false,
    trackStopped: false,
    grabFrame() {
      return queue.length ? (queue.shift() as FrameData | null) : null;
    },
    onEnded(cb) {
      ended = cb;
    },
    release() {
      this.released = true;
      this.trackStopped = true;
    },
    triggerEnded() {
      ended?.();
    }
  };
}

/** A manual scheduler: callbacks queue and are run on demand, so the frame loop
 *  is deterministic and a "stale" tick can be fired after a stop. */
function manualScheduler() {
  const pending: { id: number; cb: () => void; cancelled: boolean }[] = [];
  let nextId = 1;
  return {
    schedule(cb: () => void): number {
      const id = nextId++;
      pending.push({ id, cb, cancelled: false });
      return id;
    },
    cancel(handle: unknown) {
      const item = pending.find((p) => p.id === handle);
      if (item) item.cancelled = true;
    },
    runNext(): boolean {
      const item = pending.shift();
      if (!item) return false;
      if (!item.cancelled) item.cb();
      return true;
    },
    get liveCount() {
      return pending.filter((p) => !p.cancelled).length;
    }
  };
}

function makeDeps(session: CameraSession | Promise<CameraSession> | Error, decode: (f: FrameData) => string | null) {
  const sched = manualScheduler();
  let opens = 0;
  const deps: CameraScannerDeps = {
    openCamera() {
      opens++;
      if (session instanceof Error) return Promise.reject(session);
      return Promise.resolve(session);
    },
    decode,
    schedule: (cb) => sched.schedule(cb),
    cancelSchedule: (h) => sched.cancel(h)
  };
  return { deps, sched, opens: () => opens };
}

describe("camera scanner lifecycle", () => {
  it("opens the camera exactly once when a scan starts, and not again", async () => {
    const session = fakeSession();
    const { deps, opens } = makeDeps(session, () => null);
    startCameraScan({ onText: () => {}, onError: () => {} }, deps);
    await flush();
    expect(opens()).toBe(1);
  });

  it("a successful decode fires onText once and releases the camera", async () => {
    const session = fakeSession([FRAME]);
    const { deps, sched } = makeDeps(session, () => "TPR2:decoded");
    const texts: string[] = [];
    const ctrl = startCameraScan({ onText: (t) => texts.push(t), onError: () => {} }, deps);
    await flush();
    sched.runNext(); // the first frame look decodes
    expect(texts).toEqual(["TPR2:decoded"]);
    expect(session.released).toBe(true);
    expect(session.trackStopped).toBe(true);
    expect(ctrl.stopped).toBe(true);
    expect(sched.liveCount).toBe(0); // no further looks scheduled
  });

  it("cancel stops the tracks and no later decode can advance", async () => {
    const session = fakeSession([FRAME]);
    const { deps, sched } = makeDeps(session, () => "TPR2:decoded");
    const texts: string[] = [];
    const ctrl = startCameraScan({ onText: (t) => texts.push(t), onError: () => {} }, deps);
    await flush();
    ctrl.stop("cancelled");
    expect(session.released).toBe(true);
    // A stale scheduled tick fired after stop must be inert.
    sched.runNext();
    expect(texts).toEqual([]);
  });

  it("cancel during camera acquisition releases the just-granted camera", async () => {
    const session = fakeSession();
    let resolve!: (s: CameraSession) => void;
    const pending = new Promise<CameraSession>((r) => (resolve = r));
    const { deps } = makeDeps(pending, () => null);
    const ctrl = startCameraScan({ onText: () => {}, onError: () => {} }, deps);
    ctrl.stop("cancelled"); // before the camera resolves
    resolve(session);
    await flush();
    expect(session.released).toBe(true); // not left running
  });

  it("keeps looking while frames are not ready, without decoding", async () => {
    const session = fakeSession([null, null, FRAME]);
    let decodeCalls = 0;
    const { deps, sched } = makeDeps(session, () => {
      decodeCalls++;
      return null;
    });
    const texts: string[] = [];
    startCameraScan({ onText: (t) => texts.push(t), onError: () => {} }, deps);
    await flush();
    sched.runNext(); // null frame → no decode, reschedule
    sched.runNext(); // null frame → no decode, reschedule
    expect(decodeCalls).toBe(0);
    sched.runNext(); // real frame → decode (returns null here)
    expect(decodeCalls).toBe(1);
    expect(texts).toEqual([]);
  });

  it("an openCamera rejection becomes a classified error, with no session", async () => {
    const err = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const { deps } = makeDeps(err, () => null);
    const errors: string[] = [];
    startCameraScan({ onText: () => {}, onError: (e) => errors.push(e.kind) }, deps);
    await flush();
    expect(errors).toEqual(["permission-denied"]);
  });

  it("a stream that ends externally releases the camera and reports it", async () => {
    const session = fakeSession();
    const { deps } = makeDeps(session, () => null);
    const errors: string[] = [];
    startCameraScan({ onText: () => {}, onError: (e) => errors.push(e.kind) }, deps);
    await flush();
    session.triggerEnded();
    expect(errors).toEqual(["stream-ended"]);
    expect(session.released).toBe(true);
  });

  it("stop() is idempotent and safe before the camera even opens", async () => {
    const session = fakeSession();
    const { deps } = makeDeps(session, () => null);
    const ctrl = startCameraScan({ onText: () => {}, onError: () => {} }, deps);
    ctrl.stop();
    ctrl.stop(); // no throw, still stopped
    expect(ctrl.stopped).toBe(true);
    await flush();
    expect(session.released).toBe(true);
  });
});

describe("getUserMedia errors map to stable, non-sensitive kinds", () => {
  it("classifies the common DOMException names", () => {
    const cases: [string, string][] = [
      ["NotAllowedError", "permission-denied"],
      ["SecurityError", "permission-denied"],
      ["NotFoundError", "no-camera"],
      ["OverconstrainedError", "no-camera"],
      ["NotReadableError", "camera-busy"],
      ["TrackStartError", "camera-busy"],
      ["TypeError", "unsupported"],
      ["SomethingElse", "internal"]
    ];
    for (const [name, kind] of cases) {
      expect(classifyCameraError({ name }).kind).toBe(kind);
    }
  });
});
