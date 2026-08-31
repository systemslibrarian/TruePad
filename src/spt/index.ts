/* ============================================================================
 * Sealed Pad Transfer v1 — public surface of the Phase 1A cryptographic core
 * ----------------------------------------------------------------------------
 * STATUS: this module implements suite 0x0001 — the KEM wrapper, the TPR2 and
 * TPS2 codecs, the key schedule and the AEAD. It implements NONE of the product
 * transfer flow: no persisted receive requests, no sender handoff enforcement,
 * no provenance enforcement, no receive state machine, no cross-tab session, no
 * UI, no courier integration. Nothing in the shipped product offers sealed
 * transfer, and this file existing does not change that.
 *
 * Nothing here owns product state, so both the Browser worker and Node can use
 * it later without either inheriting the other's assumptions.
 *
 * The derandomized X-Wing entry points are deliberately NOT re-exported: they
 * are test/conformance surfaces (§2.2 calls them "for test vectors ONLY") and
 * tests import them from ./xwing-v1.ts by their full path, where the TEST-ONLY
 * banner is impossible to miss.
 * ========================================================================= */

export {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  CONFIRM_VALUE_BYTES,
  CONFIRM_WORDS_BITS,
  CONFIRM_WORDS_COUNT,
  DS_AEAD_KEY,
  DS_CONFIRM,
  DS_NONCE,
  DS_PAD,
  DS_REQUEST_FP,
  MAX_PLAINTEXT_BYTES,
  REQUEST_HASH_BYTES,
  REQUEST_ID_BYTES,
  REQUEST_WORDS_BITS,
  REQUEST_WORDS_COUNT,
  SUITE_ID,
  TPR2_BODY_BYTES,
  TPR2_PREFIX,
  TPR2_TEXT_CHARS,
  TPS2_FIXED_OVERHEAD_BYTES,
  TPS2_HEADER_BYTES,
  TPS2_MAGIC,
  TRANSFER_VERSION,
  WORDLIST_SIZE,
  XWING_CIPHERTEXT_BYTES,
  XWING_PUBLIC_KEY_BYTES,
  XWING_SEED_BYTES,
  XWING_SHARED_SECRET_BYTES
} from "./constants.ts";

export { concatBytes, equalBytes, fromBase64Url, toBase64Url } from "./bytes.ts";

export {
  confirmationIndices88,
  hashDomain,
  requestFingerprint,
  requestIndices132
} from "./fingerprint.ts";

export { decapsulate, encapsulate, generateKeyPair } from "./xwing-v1.ts";
export type { XWingEncapsulation, XWingKeyPair } from "./xwing-v1.ts";

export {
  decodeReceiveRequest,
  encodeReceiveRequest,
  encodeRequestBody
} from "./receive-request.ts";
export type { ReceiveRequest, RequestDecode, RequestDecodeError } from "./receive-request.ts";

export { buildHeader, packageIdentity, parseSealedPackage } from "./sealed-package.ts";
export type { PackageParse, PackageParseError, ParsedPackage, SealedHeader } from "./sealed-package.ts";

export { openPayloadV1, sealPayloadV1 } from "./crypto-v1.ts";
export type { OpenError, OpenOutcome, OpenResult, SealResult } from "./crypto-v1.ts";

/** A fresh public requestId (§5.1): 16 CSPRNG bytes, no structure, no identity.
 *  §13 — the platform CSPRNG, and no path that lets a caller choose it. */
export function generateRequestId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}
