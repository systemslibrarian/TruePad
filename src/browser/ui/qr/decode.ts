/* ============================================================================
 * QR decode — an image to candidate text, and nothing more
 * ----------------------------------------------------------------------------
 * Wraps jsQR (Apache-2.0, cozmo/jsQR; see THIRD-PARTY-NOTICES.md). Its ONLY
 * output that matters is a candidate string. That string is NOT trusted: it is
 * handed to the same worker receive-code parser that pasted text goes to, which
 * is the single authority on whether it is a real request. This module never
 * parses TPR2, never repairs input, and never decides anything about
 * authenticity — a decode means only "I read some text off an image".
 *
 * Everything here is bounded so a hostile or noisy image cannot monopolise the
 * UI thread or the memory:
 *   · camera frames are decoded at a downscaled working size;
 *   · a chosen image file is size-checked, then drawn onto a bounded canvas
 *     before decoding;
 *   · candidate text longer than a receive code could ever be is dropped.
 * ========================================================================= */

import jsQR from "jsqr";

/** Longest candidate text worth returning. A receive code is 1652 chars; well
 *  past that is not a near-miss to be reported, it is noise to be dropped. */
export const MAX_CANDIDATE_TEXT_CHARS = 4096;

/** Largest QR image file we will attempt to decode (bytes). A receive-code QR
 *  screenshot is tens of KB; megabytes is a resource trap, not a code. */
export const MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024;

/** Longest side, in pixels, a decode canvas is scaled to. Enough resolution for
 *  a version-40 symbol, bounded so decoding cost stays flat. */
export const MAX_DECODE_DIMENSION = 1024;

/**
 * Decode QR text from raw RGBA pixels. Returns the candidate string, or null if
 * no QR was found or the text is implausibly long. Never throws for "no code".
 */
export function decodeQrFromImageData(data: Uint8ClampedArray, width: number, height: number): string | null {
  if (width <= 0 || height <= 0) return null;
  // jsQR does not invert by default; a receive-code symbol is dark-on-light, but
  // a photographed screen can end up inverted, so allow both.
  const result = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  if (!result) return null;
  const text = result.data;
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_CANDIDATE_TEXT_CHARS) {
    return null;
  }
  return text;
}

/** RGBA pixels, structurally — what both a browser `ImageData` and a fake
 *  satisfy. Kept DOM-global-free so the decode logic is unit-testable in Node. */
export interface RgbaPixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A drawable image (a bitmap or an <img>), narrowed to what the decoder uses. */
export interface DrawableImage {
  width: number;
  height: number;
  close?: () => void;
}

/** The 2D-canvas surface the file decoder needs, narrowed so it can be faked in
 *  a test without a DOM. A real `HTMLCanvasElement`/`OffscreenCanvas` satisfies it. */
export interface DecodeCanvas {
  width: number;
  height: number;
  getContext(id: "2d"): {
    drawImage(image: DrawableImage, dx: number, dy: number, dw: number, dh: number): void;
    getImageData(sx: number, sy: number, sw: number, sh: number): RgbaPixels;
  } | null;
}

export interface ImageDecodeDeps {
  /** Decode the file's bytes into something drawable (browser: createImageBitmap). */
  loadImage(file: Blob): Promise<DrawableImage>;
  /** A fresh drawing surface (browser: an OffscreenCanvas or <canvas>). */
  makeCanvas(width: number, height: number): DecodeCanvas;
}

/**
 * Decode a user-chosen local image file to candidate QR text, using injected
 * image/canvas seams (the browser wiring lives in `decode-browser.ts`). Bounds
 * the file size and working resolution; never fetches, never persists the image,
 * never reads metadata as data. Returns null when no QR is present.
 */
export async function decodeQrFromImageFile(file: Blob, deps: ImageDecodeDeps): Promise<string | null> {
  if (file.size > MAX_IMAGE_FILE_BYTES) {
    throw new Error(`image is too large to scan (${file.size} bytes; limit ${MAX_IMAGE_FILE_BYTES})`);
  }
  const image = await deps.loadImage(file);
  try {
    const { width, height } = image;
    if (width <= 0 || height <= 0) return null;
    const scale = Math.min(1, MAX_DECODE_DIMENSION / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = deps.makeCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h);
    return decodeQrFromImageData(pixels.data, pixels.width, pixels.height);
  } finally {
    image.close?.();
  }
}
