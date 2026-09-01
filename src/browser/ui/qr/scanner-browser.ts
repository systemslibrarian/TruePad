/* ============================================================================
 * QR camera scanner — the browser seams
 * ----------------------------------------------------------------------------
 * The DOM/getUserMedia wiring that fills in the scanner's injected seams:
 * open the camera into a <video>, draw bounded frames onto a <canvas>, decode
 * them with jsQR. Kept separate from scanner.ts so the lifecycle state machine
 * stays unit-testable in Node without a DOM, while this thin adapter is
 * exercised by the browser e2e.
 * ========================================================================= */

import { decodeQrFromImageData, MAX_DECODE_DIMENSION } from "./decode.ts";
import type { CameraScannerDeps, CameraSession, FrameData } from "./scanner.ts";

/* ---- production seams ----------------------------------------------------- */

/** The browser wiring: getUserMedia into a <video>, frames onto a bounded
 *  <canvas>, decoded by jsQR. Constructed only when a scan actually starts.
 *  Pass the viewfinder `<video>` the UI is showing so frames come from what the
 *  operator sees; omit it and a detached element is used. */
export function browserCameraDeps(video?: HTMLVideoElement): CameraScannerDeps {
  return {
    openCamera: () => openBrowserCamera(video),
    decode: (frame) => decodeQrFromImageData(frame.data, frame.width, frame.height),
    schedule: (cb, delayMs) => setTimeout(cb, delayMs),
    cancelSchedule: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  };
}

async function openBrowserCamera(providedVideo?: HTMLVideoElement): Promise<CameraSession> {
  const media = navigator.mediaDevices;
  if (!media || typeof media.getUserMedia !== "function") {
    throw Object.assign(new Error("getUserMedia unavailable"), { name: "TypeError" });
  }
  // Prefer the rear camera; a platform that ignores or rejects the preference
  // still gets a working front camera because facingMode is not `exact`.
  const stream = await media.getUserMedia({ video: { facingMode: "environment" }, audio: false });

  const video = providedVideo ?? document.createElement("video");
  video.setAttribute("playsinline", "true");
  video.muted = true;
  video.srcObject = stream;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  try {
    await video.play();
  } catch {
    // Autoplay can reject; the frames still arrive, so this is not fatal.
  }

  return {
    grabFrame(): FrameData | null {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh || !ctx) return null;
      const scale = Math.min(1, MAX_DECODE_DIMENSION / Math.max(vw, vh));
      const w = Math.max(1, Math.round(vw * scale));
      const h = Math.max(1, Math.round(vh * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const pixels = ctx.getImageData(0, 0, w, h);
      return { data: pixels.data, width: pixels.width, height: pixels.height };
    },
    onEnded(cb: () => void) {
      const track = stream.getVideoTracks()[0];
      if (track) track.addEventListener("ended", cb);
    },
    release
  };
}
