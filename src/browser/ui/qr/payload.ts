/* ============================================================================
 * QR payload guard — only a canonical TPR2 receive code may become a QR symbol
 * ----------------------------------------------------------------------------
 * QR is transport convenience for the PUBLIC receive request and nothing else.
 * The whole security of this feature rests on the QR carrying EXACTLY the same
 * TPR2 the clipboard carries — never a sealed package, never pad or key
 * material, never a URL wrapper, never anything the receive-code parser would
 * reject.
 *
 * So the encoder does not trust its caller. Before any text is handed to the QR
 * library, it must be a receive code the SAME strict codec used everywhere else
 * (`decodeReceiveRequest`, from the frozen src/spt) actually accepts. TPS2 bytes,
 * a `.tps2` package as text, a `truepad://`/`https://` wrapper, or arbitrary
 * bytes all fail that parse and are refused here, loudly, before they can reach
 * a rendered symbol. This module imports the codec read-only; it changes no
 * protocol byte and adds no RPC.
 * ========================================================================= */

import { decodeReceiveRequest } from "../../../spt/receive-request.ts";

/** Thrown when something other than a canonical TPR2 receive code is offered
 *  to the QR encoder. It is a programming/guard error, not an operator error:
 *  the UI only ever passes the engine's own published receive code. */
export class QrPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrPayloadError";
  }
}

/**
 * Return `text` unchanged iff it is a canonical TPR2 receive code the strict
 * codec accepts; otherwise throw. The returned value is byte-for-byte what was
 * passed in, so the QR payload is identical to the clipboard payload — no
 * trimming, no re-encoding, no normalisation happens here.
 */
export function assertEncodableReceiveCode(text: string): string {
  const decoded = decodeReceiveRequest(text);
  if (!decoded.ok) {
    throw new QrPayloadError(
      `refusing to QR-encode text that is not a canonical TPR2 receive code (${decoded.reason})`
    );
  }
  // decodeReceiveRequest trims surrounding whitespace before validating; a
  // canonical receive code has none, so the accepted text and the original are
  // identical. Encode the ORIGINAL so the symbol matches the clipboard exactly.
  return text;
}
