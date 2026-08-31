/* ============================================================================
 * Suite 0x0001 — key derivation, sealing, and opening
 * ----------------------------------------------------------------------------
 * docs/SEALED-PAD-TRANSFER.md §7.3, §7.4 and §20.
 *
 * WHAT THIS LAYER IS, AND WHAT IT IS NOT
 * --------------------------------------
 * `sealPayloadV1` and `openPayloadV1` are LOW-LEVEL, PURE operations over
 * opaque bytes. They exist so the cryptography can be composed and given
 * reference vectors. They are NOT the product's authorization boundary.
 *
 * The Browser operation stays `seal(body, pairId)` — it names the PAD and reads
 * the live store inside the worker. §18 forbids exporting pad material in
 * plaintext so a caller can encrypt it, and taking pad bytes from a caller
 * would also make the §10.6 genesis check evaluate a snapshot the CALLER chose:
 * sealing weeks-old genesis bytes to a second recipient would pass every check
 * and produce a two-time pad. There must never be an RPC named
 * `seal(body, padFileBytes)`. The byte-taking functions below are for
 * cryptographic composition and tests, and Phase 1B wraps them; it does not
 * expose them.
 *
 * WHY HKDF IS COMPOSED HERE AND NOT TAKEN FROM `subtle.deriveBits`
 * ----------------------------------------------------------------
 * WebCrypto's HKDF would have been the obvious choice — deriveBits({salt, info})
 * IS Expand(Extract(salt, IKM), info) — but it cannot express this protocol on
 * Node: `algorithm.info` is capped at 1024 bytes there, and §7.3's info for the
 * AEAD key is `uint8(len(DS_AEAD_KEY)) ‖ DS_AEAD_KEY ‖ AAD` = 1 + 23 + 1195 =
 * 1219 bytes. That is a demonstrated portability problem, not a preference, and
 * the AAD's size is frozen.
 *
 * So RFC 5869 is composed here over the platform's HMAC-SHA-256, which has no
 * such limit. The primitives all remain the platform's: SHA-256, HMAC-SHA-256
 * and AES-256-GCM. Only the RFC 5869 composition is ours, and hkdf-rfc5869
 * pins it to the RFC's own Appendix A vectors so "our composition" is not
 * something anyone has to take on trust.
 *
 * The cost is that PRK now materialises as a JavaScript array, so it joins the
 * buffers this module wipes.
 *
 * ORDERING, WHICH IS NOT FREE TO CHOOSE
 * -------------------------------------
 * The nonce depends on padHash alone; the AEAD key and the confirmation value
 * depend on the AAD, which CONTAINS the nonce. So: padHash → nonce → header →
 * aeadKey and confirmValue. Any other order is a different protocol.
 * ========================================================================= */

import { concatBytes, equalBytes, type BinarySource, wipe } from "./bytes.ts";
import {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  CONFIRM_VALUE_BYTES,
  DS_AEAD_KEY,
  DS_CONFIRM,
  DS_NONCE,
  DS_PAD,
  MAX_PLAINTEXT_BYTES,
  REQUEST_HASH_BYTES,
  TPS2_HEADER_BYTES,
  XWING_SHARED_SECRET_BYTES
} from "./constants.ts";
import { confirmationIndices88, domainPrefix, hashDomain, requestFingerprint } from "./fingerprint.ts";
import { hkdfExpand, hkdfExtract } from "./hkdf.ts";
import { buildHeader, packageIdentity, parseSealedPackage, type PackageParseError } from "./sealed-package.ts";
import { decapsulate, encapsulate, encapsulateDerand } from "./xwing-v1.ts";

/* ---- the derivations of §7.3 / §7.4 -------------------------------------- */

/** info = uint8(len(DS)) ‖ DS ‖ context — the same measured prefix as H_ds, and
 *  the ONLY place any of the three infos is built. Three near-identical
 *  builders would be three chances to reorder a field. */
const info = (separator: string, context: Uint8Array) => concatBytes(domainPrefix(separator), context);

/** PRK = HKDF-Extract(salt = requestHash, IKM = ss). §7.3. The caller owns it
 *  and must wipe it. */
export async function derivePrk(sharedSecret: Uint8Array, requestHash: Uint8Array): Promise<Uint8Array> {
  return hkdfExtract(requestHash, sharedSecret);
}

export async function derivePadHash(payload: Uint8Array): Promise<Uint8Array> {
  return hashDomain(DS_PAD, payload);
}

export const nonceFromPrk = (prk: Uint8Array, padHash: Uint8Array) =>
  hkdfExpand(prk, info(DS_NONCE, padHash), AEAD_NONCE_BYTES);

export const aeadKeyFromPrk = (prk: Uint8Array, aad: Uint8Array) =>
  hkdfExpand(prk, info(DS_AEAD_KEY, aad), AEAD_KEY_BYTES);

export const confirmValueFromPrk = (prk: Uint8Array, aad: Uint8Array) =>
  hkdfExpand(prk, info(DS_CONFIRM, aad), CONFIRM_VALUE_BYTES);

/* Convenience wrappers that extract first. They exist for reference-vector
 * generation and for tests that want one value in isolation; the seal/open
 * paths extract ONCE and reuse the PRK, which is what §7.3 describes. Both
 * routes go through the same three `info` builders, so they cannot drift. */

async function withPrk<T>(
  sharedSecret: Uint8Array,
  requestHash: Uint8Array,
  use: (prk: Uint8Array) => Promise<T>
): Promise<T> {
  const prk = await derivePrk(sharedSecret, requestHash);
  try {
    return await use(prk);
  } finally {
    wipe(prk);
  }
}

export const deriveNonce = (sharedSecret: Uint8Array, requestHash: Uint8Array, padHash: Uint8Array) =>
  withPrk(sharedSecret, requestHash, (prk) => nonceFromPrk(prk, padHash));

export const deriveAeadKeyBytes = (sharedSecret: Uint8Array, requestHash: Uint8Array, aad: Uint8Array) =>
  withPrk(sharedSecret, requestHash, (prk) => aeadKeyFromPrk(prk, aad));

export const deriveConfirmValue = (sharedSecret: Uint8Array, requestHash: Uint8Array, aad: Uint8Array) =>
  withPrk(sharedSecret, requestHash, (prk) => confirmValueFromPrk(prk, aad));

/* ---- results -------------------------------------------------------------- */

export type SealResult = {
  /** The complete TPS2 bytes. */
  packageBytes: Uint8Array;
  confirmValue: Uint8Array;
  confirmationIndices: number[];
  requestHash: Uint8Array;
  packageIdentity: Uint8Array;
};

export type OpenResult = {
  /** The exact bytes that were sealed. Freshly allocated and owned by the
   *  caller from here on. */
  payload: Uint8Array;
  confirmValue: Uint8Array;
  confirmationIndices: number[];
  requestHash: Uint8Array;
  packageIdentity: Uint8Array;
};

export type OpenError =
  | PackageParseError
  /** The package is for a different request than the one supplied. */
  | "request-mismatch"
  /** ONE outcome for decapsulation failure AND AEAD verification failure. §11:
   *  the protocol offers no decapsulation oracle, so these are deliberately
   *  indistinguishable from outside. */
  | "cryptographic-open-failed"
  /** DISTINCT by design (§7.4, §20). padHash never travels and the nonce is
   *  carried rather than re-derived, so a wrong DS_PAD length octet would fork
   *  the nonce silently between builds and every package would still verify.
   *  Re-deriving and comparing turns that whole bug class into a refusal. */
  | "derived-nonce-mismatch";

export type OpenOutcome = { ok: true; result: OpenResult } | { ok: false; reason: OpenError; message: string };

const openFail = (reason: OpenError, message: string): OpenOutcome => ({ ok: false, reason, message });

/* ---- seal ---------------------------------------------------------------- */

export type SealOptions = {
  /** TEST ONLY. Supplying encapsulation randomness fixes the shared secret,
   *  which for a KEM means someone else chose your key. Production callers
   *  never pass this; §13 requires the platform CSPRNG. */
  eseedForVectorsOnly?: Uint8Array;
};

/** LOW-LEVEL. See the banner: this takes bytes, the product operation takes a
 *  pairId. `canonicalRequestBody` is the complete 1235-byte §5.1 body, and
 *  `payload` is whatever opaque bytes are being sealed — this layer never
 *  parses, normalizes, or reserializes them. */
export async function sealPayloadV1(
  canonicalRequestBody: Uint8Array,
  encapsulationKey: Uint8Array,
  payload: Uint8Array,
  options: SealOptions = {}
): Promise<SealResult> {
  if (payload.length > MAX_PLAINTEXT_BYTES) {
    throw new RangeError(`payload exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
  }
  const requestHash = await requestFingerprint(canonicalRequestBody);
  const { ciphertext: kemCiphertext, sharedSecret } = options.eseedForVectorsOnly
    ? encapsulateDerand(encapsulationKey, options.eseedForVectorsOnly)
    : encapsulate(encapsulationKey);

  let prk: Uint8Array | undefined;
  let aeadKeyBytes: Uint8Array | undefined;
  try {
    prk = await derivePrk(sharedSecret, requestHash);
    const padHash = await derivePadHash(payload);
    const nonce = await nonceFromPrk(prk, padHash);
    wipe(padHash);

    const header = buildHeader({
      requestId: canonicalRequestBody.slice(3, 19),
      requestHash,
      kemCiphertext,
      nonce,
      plaintextLength: payload.length
    });

    aeadKeyBytes = await aeadKeyFromPrk(prk, header);
    const aeadKey = await crypto.subtle.importKey(
      "raw",
      aeadKeyBytes as unknown as BinarySource,
      "AES-GCM",
      false,
      ["encrypt"]
    );
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce as unknown as BinarySource, additionalData: header as unknown as BinarySource, tagLength: AEAD_TAG_BYTES * 8 },
        aeadKey,
        payload as unknown as BinarySource
      )
    );
    const confirmValue = await confirmValueFromPrk(prk, header);
    const packageBytes = concatBytes(header, sealed);
    return {
      packageBytes,
      confirmValue,
      confirmationIndices: confirmationIndices88(confirmValue),
      requestHash,
      packageIdentity: await packageIdentity(packageBytes)
    };
  } finally {
    // Buffers this function owns. NOT `payload`, `encapsulationKey` or
    // `canonicalRequestBody` — those belong to the caller (§20 of the brief).
    wipe(sharedSecret, prk, aeadKeyBytes);
  }
}

/* ---- open ---------------------------------------------------------------- */

/** LOW-LEVEL. The request binding is supplied by the caller at this layer: the
 *  complete canonical request body, from which requestHash is recomputed and
 *  compared with the header. A higher layer looks that body up by requestId;
 *  this one is told. */
export async function openPayloadV1(
  packageBytes: Uint8Array,
  canonicalRequestBody: Uint8Array,
  decapsulationSeed: Uint8Array
): Promise<OpenOutcome> {
  const parsed = parseSealedPackage(packageBytes);
  if (!parsed.ok) return openFail(parsed.reason, parsed.message);
  const { header, aad, ciphertext, tag } = parsed.parsed;

  const requestHash = await requestFingerprint(canonicalRequestBody);
  const requestId = canonicalRequestBody.slice(3, 19);
  if (!equalBytes(header.requestId, requestId) || !equalBytes(header.requestHash, requestHash)) {
    return openFail("request-mismatch", "this package is for a different receive request");
  }

  let sharedSecret: Uint8Array | undefined;
  let prk: Uint8Array | undefined;
  let aeadKeyBytes: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    try {
      sharedSecret = decapsulate(header.kemCiphertext, decapsulationSeed);
    } catch {
      // Decapsulation and AEAD failures are ONE outcome. Reporting them apart
      // would be a decapsulation oracle.
      return openFail("cryptographic-open-failed", "this package could not be opened for this request");
    }
    prk = await derivePrk(sharedSecret, requestHash);
    aeadKeyBytes = await aeadKeyFromPrk(prk, aad);
    const aeadKey = await crypto.subtle.importKey(
      "raw",
      aeadKeyBytes as unknown as BinarySource,
      "AES-GCM",
      false,
      ["decrypt"]
    );
    try {
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: header.nonce as unknown as BinarySource, additionalData: aad as unknown as BinarySource, tagLength: AEAD_TAG_BYTES * 8 },
          aeadKey,
          concatBytes(ciphertext, tag) as unknown as BinarySource
        )
      );
    } catch {
      return openFail("cryptographic-open-failed", "this package could not be opened for this request");
    }

    // AFTER verification, never before: re-derive the nonce from the plaintext
    // we now hold and compare it with the one the package carried.
    const padHash = await derivePadHash(plaintext);
    const expectedNonce = await nonceFromPrk(prk, padHash);
    wipe(padHash);
    if (!equalBytes(expectedNonce, header.nonce)) {
      wipe(expectedNonce, plaintext);
      return openFail("derived-nonce-mismatch", "the package nonce is not the one this payload derives");
    }
    wipe(expectedNonce);

    const confirmValue = await confirmValueFromPrk(prk, aad);
    const result: OpenResult = {
      payload: plaintext,
      confirmValue,
      confirmationIndices: confirmationIndices88(confirmValue),
      requestHash,
      packageIdentity: await packageIdentity(packageBytes)
    };
    plaintext = undefined; // ownership passes to the caller; do not wipe it
    return { ok: true, result };
  } finally {
    wipe(sharedSecret, prk, aeadKeyBytes, plaintext);
  }
}

export { AEAD_KEY_BYTES, AEAD_NONCE_BYTES, CONFIRM_VALUE_BYTES, REQUEST_HASH_BYTES, TPS2_HEADER_BYTES, XWING_SHARED_SECRET_BYTES };
