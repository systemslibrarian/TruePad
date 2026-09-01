/* ============================================================================
 * QR camera scanner — a temporary capability, released the moment it is done
 * ----------------------------------------------------------------------------
 * The camera is treated as borrowed, never held. Every exit path — a successful
 * decode, Cancel, an error, the screen changing, disposal — stops every
 * MediaStreamTrack. There is no code path that leaves a stream running behind
 * another screen, and no frame is recorded, saved, uploaded, or logged.
 *
 * WHAT A SCAN MEANS
 *   A successful scan means only "I acquired some text from a QR image". It is
 *   NOT authentication. The text is handed to the same worker receive-code
 *   parser that pasted text goes to, and the twelve-word comparison still
 *   happens afterwards. Nothing here shortcuts that.
 *
 * TESTABILITY
 *   The lifecycle is a small state machine over injected seams (open the camera,
 *   grab a frame, decode it, schedule the next look). Production wires those to
 *   getUserMedia + a <video>/<canvas> + jsQR; a test wires them to fakes and
 *   drives the exact same code, so "cancel stops the tracks" is proven against
 *   the real controller, not a mock of it.
 * ========================================================================= */

/** Milliseconds between frame looks. ~8/s is plenty for a human holding a code
 *  up to a camera, and it keeps a noisy feed from monopolising the UI thread. */
export const SCAN_INTERVAL_MS = 120;

export type ScanStopReason = "decoded" | "cancelled" | "error" | "disposed" | "stream-ended";

export type CameraScanErrorKind =
  | "permission-denied"
  | "no-camera"
  | "camera-busy"
  | "unsupported"
  | "stream-ended"
  | "internal";

export interface CameraScanError {
  kind: CameraScanErrorKind;
  message: string;
}

export interface CameraScannerCallbacks {
  /** Fired at most once, with the decoded candidate text. The camera is already
   *  released by the time this runs. */
  onText(text: string): void;
  /** Fired at most once on a terminal error. The camera is released first. */
  onError(error: CameraScanError): void;
  /** Optional progress: "starting" while acquiring, "scanning" once live. */
  onStatus?(status: "starting" | "scanning"): void;
}

/** One frame of RGBA pixels. */
export interface FrameData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A live camera session: pull frames, be told if it ends, and release it. */
export interface CameraSession {
  grabFrame(): FrameData | null;
  onEnded(cb: () => void): void;
  release(): void;
}

export type ScheduleHandle = unknown;

/** The seams the controller drives. Production defaults live in
 *  `browserCameraDeps`; tests pass fakes. */
export interface CameraScannerDeps {
  openCamera(): Promise<CameraSession>;
  decode(frame: FrameData): string | null;
  schedule(cb: () => void, delayMs: number): ScheduleHandle;
  cancelSchedule(handle: ScheduleHandle): void;
}

/** Handle returned to the UI: stop scanning and release the camera. */
export interface CameraScanController {
  stop(reason?: ScanStopReason): void;
  readonly stopped: boolean;
}

/**
 * Start a camera scan. The camera is acquired only inside this call (never
 * before), and released on the first of: a decode, `stop()`, an error, or the
 * stream ending. Returns a controller whose `stop()` is idempotent.
 */
export function startCameraScan(callbacks: CameraScannerCallbacks, deps: CameraScannerDeps): CameraScanController {
  let stopped = false;
  let session: CameraSession | null = null;
  let scheduled: ScheduleHandle | null = null;

  const releaseCamera = (): void => {
    if (scheduled !== null) {
      deps.cancelSchedule(scheduled);
      scheduled = null;
    }
    if (session) {
      const s = session;
      session = null;
      s.release();
    }
  };

  const controller: CameraScanController = {
    get stopped() {
      return stopped;
    },
    stop(_reason: ScanStopReason = "cancelled") {
      if (stopped) return;
      stopped = true;
      releaseCamera();
    }
  };

  const finishWithText = (text: string): void => {
    if (stopped) return;
    stopped = true;
    releaseCamera();
    callbacks.onText(text);
  };

  const finishWithError = (error: CameraScanError): void => {
    if (stopped) return;
    stopped = true;
    releaseCamera();
    callbacks.onError(error);
  };

  const tick = (): void => {
    scheduled = null;
    if (stopped || !session) return;
    let frame: FrameData | null = null;
    try {
      frame = session.grabFrame();
    } catch {
      frame = null; // a not-yet-ready frame is not an error; try again
    }
    if (frame) {
      const text = deps.decode(frame);
      if (text) {
        finishWithText(text);
        return;
      }
    }
    if (!stopped) {
      scheduled = deps.schedule(tick, SCAN_INTERVAL_MS);
    }
  };

  callbacks.onStatus?.("starting");
  deps.openCamera().then(
    (opened) => {
      // The user may have cancelled while the permission prompt was up. If so,
      // release the camera we were just granted rather than leaving it live.
      if (stopped) {
        opened.release();
        return;
      }
      session = opened;
      opened.onEnded(() => finishWithError({ kind: "stream-ended", message: "the camera stopped" }));
      callbacks.onStatus?.("scanning");
      scheduled = deps.schedule(tick, 0);
    },
    (err: unknown) => finishWithError(classifyCameraError(err))
  );

  return controller;
}

/** Map a getUserMedia rejection to a stable, non-sensitive error kind. */
export function classifyCameraError(err: unknown): CameraScanError {
  const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return { kind: "permission-denied", message: "camera access was not granted" };
    case "NotFoundError":
    case "OverconstrainedError":
      return { kind: "no-camera", message: "no usable camera was found" };
    case "NotReadableError":
    case "TrackStartError":
      return { kind: "camera-busy", message: "the camera is in use by something else" };
    case "TypeError":
      return { kind: "unsupported", message: "this browser cannot open a camera here" };
    default:
      return { kind: "internal", message: "the camera could not be started" };
  }
}
