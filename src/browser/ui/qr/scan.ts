/* ============================================================================
 * "Scan QR code" — the sender's optional alternative to pasting
 * ----------------------------------------------------------------------------
 * An OPTIONAL way to get the receive code in. Paste is never removed. The camera
 * is requested only when the operator clicks Scan — never on load, never just
 * because scanning exists — and is released on decode, Cancel, error, or when
 * the screen goes away.
 *
 * A scan produces TEXT and nothing more. That text is handed straight to the
 * caller's `onText`, which feeds it to the SAME worker receive-code parser that
 * pasted text goes to. This panel makes no decision about whether the code is
 * real, and never advances the twelve-word ceremony itself.
 * ========================================================================= */

import { card, callout, filePicker } from "../components.ts";
import { h, icon } from "../dom.ts";
import type { CameraScanController, CameraScanError } from "./scanner.ts";

// jsQR is a large decoder and only the scan/image paths need it, so it is
// dynamically imported the first time the operator actually scans — never at
// page load. The chunk is precached by the service worker, so it is available
// offline after the first visit and makes no network call at scan time.
const loadScanner = () =>
  Promise.all([import("./scanner.ts"), import("./scanner-browser.ts")]).then(([s, b]) => ({
    startCameraScan: s.startCameraScan,
    browserCameraDeps: b.browserCameraDeps
  }));
const loadDecoder = () =>
  Promise.all([import("./decode.ts"), import("./decode-browser.ts")]).then(([d, b]) => ({
    decodeQrFromImageFile: d.decodeQrFromImageFile,
    browserImageDecodeDeps: b.browserImageDecodeDeps
  }));

export interface ScanControl {
  el: HTMLElement;
  /** Stop any live camera and release it. Call on screen change / disposal. */
  dispose(): void;
}

export interface ScanControlOptions {
  /** Called with decoded candidate text. The caller sends it to the worker
   *  parser exactly as it would pasted text. */
  onText(text: string): void;
}

function friendlyCameraError(error: CameraScanError): string {
  switch (error.kind) {
    case "permission-denied":
      return "Camera access was not granted. You can paste the code instead, or choose a QR image.";
    case "no-camera":
      return "No camera was found. Paste the code instead, or choose a QR image.";
    case "camera-busy":
      return "The camera is being used by something else. Close the other app, or paste the code instead.";
    case "unsupported":
      return "This browser cannot open the camera here. Paste the code instead, or choose a QR image.";
    case "stream-ended":
      return "The camera stopped. Try scanning again, or paste the code instead.";
    default:
      return "The camera could not be started. Paste the code instead, or choose a QR image.";
  }
}

/**
 * Build the scan control. Returns the element plus a `dispose()` the sender
 * screen registers with `ctx.onLeave` so leaving the route stops the camera.
 */
export function scanReceiveCodeControl(opts: ScanControlOptions): ScanControl {
  const container = h("div", { class: "qr-scan" });
  let controller: CameraScanController | null = null;

  const stopCamera = (reason: "cancelled" | "disposed" | "decoded" | "error"): void => {
    if (controller && !controller.stopped) controller.stop(reason);
    controller = null;
  };

  // --- idle view: the two entry points, camera and image ---
  const scanBtn = h(
    "button",
    { class: "btn", type: "button" },
    icon("camera"),
    h("span", { text: "Scan QR code" })
  ) as HTMLButtonElement;

  const picker = filePicker({
    action: "Choose QR image",
    hint: "a photo or screenshot of a QR code",
    onChange: (files) => {
      const file = files[0];
      if (file) void scanImageFile(file);
    }
  });

  const idleView = h(
    "div",
    { class: "qr-scan-idle" },
    h("div", { class: "actions" }, scanBtn),
    h("p", { class: "faint small", text: "Optional. You can also paste the code above." }),
    picker.el
  );

  const messageSlot = h("div");

  const showIdle = (): void => {
    container.replaceChildren(idleView, messageSlot);
  };

  const showMessage = (text: string, tone: "danger" | "info"): void => {
    messageSlot.replaceChildren(callout({ tone, title: text }));
  };

  const clearMessage = (): void => messageSlot.replaceChildren();

  // --- scanning view: viewfinder + status + cancel ---
  let starting = false;
  let disposed = false;

  const startScan = async (): Promise<void> => {
    // Guard against a second stream if Scan is clicked repeatedly or while the
    // decoder chunk is still loading.
    if (starting || (controller && !controller.stopped) || disposed) return;
    starting = true;
    clearMessage();

    const video = h("video", { class: "qr-viewfinder" }) as HTMLVideoElement;
    const status = h("p", { class: "faint small", attrs: { "aria-live": "polite" }, text: "Starting the camera…" });
    const cancel = h("button", { class: "btn", type: "button", text: "Cancel" }) as HTMLButtonElement;
    const scanningView = card(
      h("div", { class: "qr-viewfinder-frame" }, video),
      status,
      h("div", { class: "actions" }, cancel)
    );
    container.replaceChildren(scanningView);

    let cancelled = false;
    cancel.addEventListener("click", () => {
      cancelled = true;
      starting = false;
      stopCamera("cancelled"); // no-op if the camera never started
      showIdle();
    });

    try {
      const { startCameraScan, browserCameraDeps } = await loadScanner();
      // The operator may have cancelled or left while the chunk loaded; if so,
      // never open the camera.
      if (cancelled || disposed) return;
      controller = startCameraScan(
        {
          onStatus: (s) => {
            status.textContent = s === "starting" ? "Starting the camera…" : "Point the camera at the QR code.";
          },
          onText: (text) => {
            controller = null; // already released by the controller
            opts.onText(text);
          },
          onError: (error) => {
            controller = null;
            showIdle();
            showMessage(friendlyCameraError(error), "danger");
          }
        },
        browserCameraDeps(video)
      );
    } catch {
      if (!cancelled && !disposed) {
        showIdle();
        showMessage("The scanner could not be loaded. Paste the code instead, or choose a QR image.", "info");
      }
    } finally {
      starting = false;
    }
  };

  scanBtn.addEventListener("click", () => void startScan());

  const scanImageFile = async (file: File): Promise<void> => {
    clearMessage();
    picker.setName(file.name);
    try {
      const { decodeQrFromImageFile, browserImageDecodeDeps } = await loadDecoder();
      const text = await decodeQrFromImageFile(file, browserImageDecodeDeps());
      if (disposed) return;
      if (text) {
        opts.onText(text);
      } else {
        showMessage("No QR code was found in that image. Try another, or paste the code.", "info");
      }
    } catch {
      if (!disposed) showMessage("That image could not be scanned. Try another, or paste the code.", "info");
    }
  };

  showIdle();
  return {
    el: container,
    dispose: () => {
      disposed = true;
      stopCamera("disposed");
    }
  };
}
