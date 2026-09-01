/* ============================================================================
 * QR image-file decoding — the desktop / screenshot fallback, bounded
 * ----------------------------------------------------------------------------
 * A user-chosen image is decoded locally into candidate text and nothing else.
 * These tests drive the real `decodeQrFromImageFile` through injected image and
 * canvas seams: a real receive-code symbol is decoded to its exact text, an
 * oversize file is refused before any work, and a QR-free image yields null
 * (never a fake success). No network, no persistence.
 * ========================================================================= */

import { describe, expect, it } from "vitest";
import {
  decodeQrFromImageFile,
  MAX_IMAGE_FILE_BYTES,
  type DecodeCanvas,
  type ImageDecodeDeps
} from "../src/browser/ui/qr/decode.ts";
import { encodeReceiveCodeToMatrix } from "../src/browser/ui/qr/encode.ts";
import { encodeReceiveRequest } from "../src/spt/receive-request.ts";

function sampleReceiveCode(): string {
  const requestId = new Uint8Array(16).map((_, i) => (i * 5 + 7) & 0xff);
  const key = new Uint8Array(1216).map((_, i) => (i * 31 + 21) & 0xff);
  return encodeReceiveRequest(requestId, key);
}

/** Build injected deps whose "image" is a rasterised QR (or a blank field). */
function depsFor(pixels: { data: Uint8ClampedArray; width: number; height: number }): ImageDecodeDeps {
  return {
    loadImage: () => Promise.resolve({ width: pixels.width, height: pixels.height }),
    makeCanvas: (w, h): DecodeCanvas => ({
      width: w,
      height: h,
      getContext: () => ({
        // The "image" is already the target size in these tests, so drawImage is
        // a no-op and getImageData returns the prepared pixels.
        drawImage: () => {},
        getImageData: () => ({ data: pixels.data, width: pixels.width, height: pixels.height })
      })
    })
  };
}

function rasterise(text: string, scale = 4, quiet = 4) {
  const matrix = encodeReceiveCodeToMatrix(text);
  const dim = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (!matrix.isDark(r, c)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const idx = (((r + quiet) * scale + dy) * dim + ((c + quiet) * scale + dx)) * 4;
          data[idx] = data[idx + 1] = data[idx + 2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

const fakeFile = (bytes: number): Blob => ({ size: bytes, type: "image/png" }) as Blob;

describe("QR image-file decoding", () => {
  it("decodes a receive-code image to its exact text", async () => {
    const code = sampleReceiveCode();
    const text = await decodeQrFromImageFile(fakeFile(50_000), depsFor(rasterise(code)));
    expect(text).toBe(code);
  });

  it("returns null for a QR-free image — no fake success", async () => {
    const dim = 240;
    const blank = { data: new Uint8ClampedArray(dim * dim * 4).fill(255), width: dim, height: dim };
    expect(await decodeQrFromImageFile(fakeFile(20_000), depsFor(blank))).toBeNull();
  });

  it("refuses an oversize file before doing any work", async () => {
    let loaded = false;
    const deps: ImageDecodeDeps = {
      loadImage: () => {
        loaded = true;
        return Promise.resolve({ width: 1, height: 1 });
      },
      makeCanvas: () => {
        throw new Error("should not reach canvas");
      }
    };
    await expect(decodeQrFromImageFile(fakeFile(MAX_IMAGE_FILE_BYTES + 1), deps)).rejects.toThrow(/too large/);
    expect(loaded).toBe(false);
  });
});
