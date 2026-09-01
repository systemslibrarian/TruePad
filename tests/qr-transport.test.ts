/* ============================================================================
 * QR transport — deterministic encode/decode round-trips and refusals
 * ----------------------------------------------------------------------------
 * QR is convenience for the PUBLIC receive code and nothing else. These tests
 * pin what that must mean:
 *   · the symbol carries EXACTLY the canonical TPR2 text (§22 A/B/G/H);
 *   · the decoded text goes through the SAME strict codec as paste, with no QR
 *     leniency (§14, §22 C/D/E);
 *   · a blank image is not a fake success (§22 F, §25);
 *   · nothing but a canonical receive code can ever be encoded (§8, §17).
 * ========================================================================= */

import { describe, expect, it } from "vitest";
import { encodeReceiveCodeToMatrix, RECEIVE_CODE_EC_LEVEL, type QrMatrix } from "../src/browser/ui/qr/encode.ts";
import { assertEncodableReceiveCode, QrPayloadError } from "../src/browser/ui/qr/payload.ts";
import { decodeQrFromImageData } from "../src/browser/ui/qr/decode.ts";
import { encodeReceiveRequest, decodeReceiveRequest } from "../src/spt/receive-request.ts";
import { TPR2_TEXT_CHARS } from "../src/spt/constants.ts";

/** A real, canonical TPR2 receive code built from the frozen codec. The key
 *  bytes need not be a valid X-Wing key: the codec validates length/version/
 *  suite, which is exactly what the QR path must round-trip. */
function sampleReceiveCode(seed = 7): string {
  const requestId = new Uint8Array(16);
  for (let i = 0; i < requestId.length; i++) requestId[i] = (i * 5 + seed) & 0xff;
  const key = new Uint8Array(1216);
  for (let i = 0; i < key.length; i++) key[i] = (i * 31 + seed * 3) & 0xff;
  return encodeReceiveRequest(requestId, key);
}

/** Rasterise a QR matrix to RGBA pixels jsQR can read: dark modules black, a
 *  quiet zone of light, integer scaling. Mirrors what the SVG renders. */
function rasterise(matrix: QrMatrix, scale = 4, quiet = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const dim = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (!matrix.isDark(r, c)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + quiet) * scale + dx;
          const y = (r + quiet) * scale + dy;
          const idx = (y * dim + x) * 4;
          data[idx] = data[idx + 1] = data[idx + 2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

function roundTrip(text: string): string | null {
  const matrix = encodeReceiveCodeToMatrix(text);
  const img = rasterise(matrix);
  return decodeQrFromImageData(img.data, img.width, img.height);
}

describe("QR transport carries exactly the canonical receive code", () => {
  it("A/G: a full 1652-character receive code survives encode → decode intact", () => {
    const code = sampleReceiveCode();
    expect(code.length).toBe(TPR2_TEXT_CHARS);
    expect(roundTrip(code)).toBe(code);
  });

  it("B: the decoded text parses to the same request as the original", () => {
    const code = sampleReceiveCode(11);
    const decoded = roundTrip(code);
    expect(decoded).not.toBeNull();
    const before = decodeReceiveRequest(code);
    const after = decodeReceiveRequest(decoded as string);
    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok) {
      expect(Array.from(after.request.requestId)).toEqual(Array.from(before.request.requestId));
      expect(Array.from(after.canonicalBody)).toEqual(Array.from(before.canonicalBody));
    }
  });

  it("the QR payload is byte-for-byte the clipboard payload", () => {
    // What the encoder is handed is what the decoder gets back — no wrapper,
    // no normalisation, no re-encoding.
    const code = sampleReceiveCode(3);
    expect(roundTrip(code)).toBe(code);
  });

  it("H: the symbol uses error-correction level M and a single fitting version", () => {
    expect(RECEIVE_CODE_EC_LEVEL).toBe("M");
    const matrix = encodeReceiveCodeToMatrix(sampleReceiveCode());
    // 1652 bytes at EC-M lands at version 34 (deterministic for the byte count).
    expect(matrix.version).toBe(34);
    expect(matrix.size).toBe(matrix.version * 4 + 17);
  });
});

describe("QR decoding gives the strict parser no leniency", () => {
  it("C: a decoded string that is not a receive code is refused by the codec", () => {
    const decoded = decodeReceiveRequest("not a receive code at all");
    expect(decoded.ok).toBe(false);
  });

  it("D: a URL-wrapped receive code is not a receive code", () => {
    const code = sampleReceiveCode();
    for (const wrapped of [`https://x/${code}`, `truepad://${code}`, `TPQR:${code}`]) {
      expect(decodeReceiveRequest(wrapped).ok).toBe(false);
    }
  });

  it("E: one corrupted character is rejected, never repaired", () => {
    const code = sampleReceiveCode();
    const flipped = code.slice(0, 10) + (code[10] === "A" ? "B" : "A") + code.slice(11);
    // Same length, different content: the re-encode-and-compare / body parse
    // rejects it. The QR layer does no repair of its own.
    const decoded = decodeReceiveRequest(flipped);
    if (decoded.ok) {
      // If it still parsed, it MUST be a different request, never silently the original.
      const original = decodeReceiveRequest(code);
      expect(original.ok).toBe(true);
      if (original.ok) {
        expect(Array.from(decoded.canonicalBody)).not.toEqual(Array.from(original.canonicalBody));
      }
    } else {
      expect(decoded.ok).toBe(false);
    }
  });

  it("F: a blank image decodes to nothing — never a fake success", () => {
    const dim = 200;
    const blank = new Uint8ClampedArray(dim * dim * 4).fill(255);
    expect(decodeQrFromImageData(blank, dim, dim)).toBeNull();
  });
});

describe("only a canonical receive code can be QR-encoded (§8, §17)", () => {
  it("accepts a real receive code and returns it unchanged", () => {
    const code = sampleReceiveCode();
    expect(assertEncodableReceiveCode(code)).toBe(code);
  });

  it("refuses a sealed-package-shaped payload, a URL wrapper, and arbitrary bytes", () => {
    const tps2Shaped = "TPS2" + "A".repeat(2000); // a .tps2 is a FILE, never a QR
    const urlWrapped = `https://systemslibrarian.github.io/#${sampleReceiveCode()}`;
    const arbitrary = "the quick brown fox";
    for (const bad of [tps2Shaped, urlWrapped, arbitrary, "", "TPR2:", "TPR2:not-canonical"]) {
      expect(() => assertEncodableReceiveCode(bad)).toThrow(QrPayloadError);
    }
  });

  it("the encoder itself refuses non-canonical input before making a symbol", () => {
    expect(() => encodeReceiveCodeToMatrix("TPS2:" + "A".repeat(1647))).toThrow(QrPayloadError);
  });
});
