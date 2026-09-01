/* ============================================================================
 * QR image decode — the browser seams
 * ----------------------------------------------------------------------------
 * The DOM wiring for `decodeQrFromImageFile`: turn a chosen file into a bitmap
 * with createImageBitmap, draw it onto a bounded canvas, read the pixels back.
 * Kept separate from decode.ts so the decode LOGIC stays unit-testable in Node
 * without a DOM, while this thin adapter is exercised by the browser e2e.
 * ========================================================================= */

import type { DecodeCanvas, ImageDecodeDeps } from "./decode.ts";

/** The browser implementation of the image-decode seams. */
export function browserImageDecodeDeps(): ImageDecodeDeps {
  return {
    loadImage: (file) => createImageBitmap(file),
    makeCanvas: (width, height) => {
      if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height) as unknown as DecodeCanvas;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas as unknown as DecodeCanvas;
    }
  };
}
