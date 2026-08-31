/* ============================================================================
 * TPR2 — the Receive Request codec
 * ----------------------------------------------------------------------------
 * docs/SEALED-PAD-TRANSFER.md §5. A 1235-byte canonical body, rendered as
 * `TPR2:` plus canonical unpadded base64url — exactly 1652 characters.
 *
 * The body carries FOUR things and nothing else: the transfer version, the
 * suite, a 16-byte public requestId, and the 1216-byte X-Wing encapsulation
 * key. No pairId, no pad metadata, no device or account identity, no secret.
 *
 * There is NO algorithm negotiation. A request that names a version or suite
 * this build does not implement is refused, never downgraded and never
 * "best-effort" decoded — the whole point of freezing suite 0x0001 in a
 * document is that the wire cannot ask for something else.
 *
 * `requestId` is a receiver-side LOOKUP HANDLE and carries no uniqueness
 * guarantee: the requester chooses those bytes and an attacker may choose them
 * to collide. §5.1 is explicit that sender-side state must be keyed by the
 * complete body (or its hash), never by requestId, and this module keeps that
 * possible by always handing back the exact canonical bytes it decoded.
 * ========================================================================= */

import { fromBase64Url, readUint16BE, toBase64Url, writeUint16BE } from "./bytes.ts";
import {
  REQUEST_ID_BYTES,
  SUITE_ID,
  TPR2_BODY_BYTES,
  TPR2_PREFIX,
  TPR2_TEXT_CHARS,
  TRANSFER_VERSION,
  XWING_PUBLIC_KEY_BYTES
} from "./constants.ts";

export type ReceiveRequest = {
  version: number;
  suite: number;
  requestId: Uint8Array;
  encapsulationKey: Uint8Array;
};

/** What can be wrong with the 1235 BINARY bytes, independent of how they were
 *  transported. */
export type RequestBodyError = "wrong-body-length" | "unsupported-version" | "unsupported-suite";

export type RequestBodyParse =
  | { ok: true; request: ReceiveRequest; canonicalBody: Uint8Array }
  | { ok: false; reason: RequestBodyError; message: string };

export type RequestDecodeError =
  | "wrong-prefix"
  | "not-base64url"
  | "noncanonical-base64url"
  | RequestBodyError;

export type RequestDecode =
  | { ok: true; request: ReceiveRequest; canonicalBody: Uint8Array }
  | { ok: false; reason: RequestDecodeError; message: string };

const fail = (reason: RequestDecodeError, message: string): RequestDecode => ({ ok: false, reason, message });

/** **The single authority on what a canonical request body is.**
 *
 *  Every path that treats 1235 bytes as a request goes through here: the TPR2
 *  text decoder, `sealPayloadV1`, and `openPayloadV1`. There is deliberately no
 *  second place that reads byte 0 for a version or bytes [1,3) for a suite —
 *  two parsers are two chances to disagree about what a request *is*, and the
 *  first thing that would disagree is which key the sender encapsulates to.
 *
 *  The returned `requestId` and `encapsulationKey` are COPIES, not views: a
 *  caller that writes through one must not be able to change what the body
 *  said afterwards. `canonicalBody` is likewise a copy, so the hash a caller
 *  computes over it cannot drift from the fields it was handed. */
export function parseRequestBody(body: Uint8Array): RequestBodyParse {
  if (body.length !== TPR2_BODY_BYTES) {
    return {
      ok: false,
      reason: "wrong-body-length",
      message: `a request body is ${TPR2_BODY_BYTES} bytes, got ${body.length}`
    };
  }
  const version = body[0];
  if (version !== TRANSFER_VERSION) {
    return {
      ok: false,
      reason: "unsupported-version",
      message: `unsupported transfer version 0x${version.toString(16)}`
    };
  }
  const suite = readUint16BE(body, 1);
  if (suite !== SUITE_ID) {
    return {
      ok: false,
      reason: "unsupported-suite",
      message: `unsupported suite 0x${suite.toString(16).padStart(4, "0")}`
    };
  }
  return {
    ok: true,
    request: {
      version,
      suite,
      requestId: body.slice(3, 19),
      encapsulationKey: body.slice(19)
    },
    canonicalBody: body.slice()
  };
}

const B64URL_CHAR = /^[A-Za-z0-9_-]*$/;

/** RFC 4648 §5 alphabet only. `=`, `+`, `/` and every whitespace character —
 *  including the interior ones a wrapped paste introduces — fall outside it. */
function isBase64UrlAlphabet(text: string): boolean {
  return B64URL_CHAR.test(text);
}

/** Build the canonical 1235-byte body. The caller owns `requestId` and
 *  `encapsulationKey`; both are copied in, never retained or mutated. */
export function encodeRequestBody(requestId: Uint8Array, encapsulationKey: Uint8Array): Uint8Array {
  if (requestId.length !== REQUEST_ID_BYTES) {
    throw new RangeError(`requestId: expected ${REQUEST_ID_BYTES} bytes, got ${requestId.length}`);
  }
  if (encapsulationKey.length !== XWING_PUBLIC_KEY_BYTES) {
    throw new RangeError(
      `encapsulationKey: expected ${XWING_PUBLIC_KEY_BYTES} bytes, got ${encapsulationKey.length}`
    );
  }
  const body = new Uint8Array(TPR2_BODY_BYTES);
  body[0] = TRANSFER_VERSION;
  writeUint16BE(body, 1, SUITE_ID);
  body.set(requestId, 3);
  body.set(encapsulationKey, 19);
  return body;
}

export function encodeReceiveRequest(requestId: Uint8Array, encapsulationKey: Uint8Array): string {
  return TPR2_PREFIX + toBase64Url(encodeRequestBody(requestId, encapsulationKey));
}

/** Decode a pasted request.
 *
 *  Surrounding whitespace is trimmed because a paste picks it up; whitespace
 *  INSIDE is invalid, and so are `=` padding, `+` and `/`. The decoded body is
 *  re-encoded and compared character-for-character, which is what actually
 *  makes the encoding canonical: without it, a final group with non-zero
 *  trailing bits decodes to the same 1235 bytes under a different spelling, and
 *  one request would have several texts. */
export function decodeReceiveRequest(text: string): RequestDecode {
  const trimmed = text.trim();
  if (!trimmed.startsWith(TPR2_PREFIX)) {
    return fail("wrong-prefix", `a receive request starts with "${TPR2_PREFIX}"`);
  }
  // Bound a hostile paste before doing anything per-character with it. The
  // text length is fixed, so the slack is only enough to let the checks below
  // report WHY a near-miss is wrong rather than just "wrong length".
  if (trimmed.length > TPR2_TEXT_CHARS + 64) {
    return fail(
      "wrong-body-length",
      `a receive request is exactly ${TPR2_TEXT_CHARS} characters, got ${trimmed.length}`
    );
  }
  const encoded = trimmed.slice(TPR2_PREFIX.length);
  // Alphabet before length, so `=` padding, `+`, `/` and interior whitespace
  // are named for what they are. Padding in particular changes the length, and
  // reporting a padded request as "wrong length" would send an implementer
  // looking for the wrong bug.
  if (!isBase64UrlAlphabet(encoded)) {
    return fail("not-base64url", "the request is not canonical unpadded base64url");
  }
  if (trimmed.length !== TPR2_TEXT_CHARS) {
    return fail(
      "wrong-body-length",
      `a receive request is exactly ${TPR2_TEXT_CHARS} characters, got ${trimmed.length}`
    );
  }
  const body = fromBase64Url(encoded);
  if (body === null) {
    return fail("not-base64url", "the request is not canonical unpadded base64url");
  }
  if (toBase64Url(body) !== encoded) {
    return fail("noncanonical-base64url", "the request has a non-canonical base64url spelling");
  }
  // Transport is done; the SEMANTIC validation belongs to the one binary
  // parser, so a request that arrives as text and a request handed straight to
  // seal() are judged by identical rules.
  return parseRequestBody(body);
}
