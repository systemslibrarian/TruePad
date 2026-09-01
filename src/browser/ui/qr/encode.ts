/* ============================================================================
 * QR encode — a canonical TPR2 receive code to a module matrix
 * ----------------------------------------------------------------------------
 * Wraps qrcode-generator (MIT, kazuhikoarase; see THIRD-PARTY-NOTICES.md). It
 * adds NO cryptography and NO protocol: it turns the exact public receive-code
 * string into a square of dark/light modules.
 *
 *   · Byte mode — base64url uses lowercase and `-`/`_`, which QR alphanumeric
 *     mode cannot carry, so byte mode is required (SEALED-PAD-TRANSFER §5.3).
 *   · EC level M — the released measurement: a 1652-byte payload fits a single
 *     symbol comfortably at M, and M tolerates more print/screen damage than L
 *     without the version-inflation of Q/H.
 *   · Automatic version — type number 0 asks the library for the SMALLEST
 *     version that fits, rather than hard-coding 40. For the current
 *     1652-character request that lands at version 34 (153×153 modules); a
 *     shorter request would use a smaller symbol.
 *
 * The payload is guarded first: only a receive code the strict codec accepts
 * can be encoded (see payload.ts), so a sealed package or any secret can never
 * reach this module.
 * ========================================================================= */

import qrcode from "qrcode-generator";
import { assertEncodableReceiveCode } from "./payload.ts";

/** Released default error-correction level for the receive-code symbol. */
export const RECEIVE_CODE_EC_LEVEL = "M" as const;

/** A finished QR symbol as a read-only grid of modules. */
export interface QrMatrix {
  /** Modules per side (the symbol is square). */
  readonly size: number;
  /** QR version 1–40 (size === version * 4 + 17). */
  readonly version: number;
  /** True where module (row, col) is dark. */
  isDark(row: number, col: number): boolean;
}

/**
 * Encode a canonical TPR2 receive code into a QR module matrix (byte mode,
 * EC level M, smallest fitting version). Throws `QrPayloadError` if `text` is
 * not a receive code the strict codec accepts.
 */
export function encodeReceiveCodeToMatrix(text: string): QrMatrix {
  const payload = assertEncodableReceiveCode(text);

  // typeNumber 0 = auto-select the smallest version that fits at this EC level.
  const qr = qrcode(0, RECEIVE_CODE_EC_LEVEL);
  qr.addData(payload, "Byte");
  qr.make();

  const size = qr.getModuleCount();
  return {
    size,
    version: (size - 17) / 4,
    isDark: (row, col) => qr.isDark(row, col)
  };
}
