/* ============================================================================
 * HKDF-SHA-256 (RFC 5869) over the platform's HMAC
 * ----------------------------------------------------------------------------
 * Not a preference. `crypto.subtle.deriveBits({name:"HKDF", ...})` caps
 * `algorithm.info` at 1024 bytes on Node, and docs/SEALED-PAD-TRANSFER.md §7.3
 * derives the AEAD key with info = uint8(len(DS_AEAD_KEY)) ‖ DS_AEAD_KEY ‖ AAD
 * = 1 + 23 + 1195 = 1219 bytes. The AAD size is frozen, so the derivation
 * cannot be reshaped to fit; the composition moves down one layer instead.
 *
 * `crypto.subtle.sign("HMAC", …)` has no such limit, and HMAC-SHA-256 is still
 * the platform's. What is written here is only the RFC 5869 arithmetic:
 *
 *     Extract(salt, IKM) = HMAC(key = salt, msg = IKM)
 *     Expand(PRK, info, L):
 *         T(0) = ""
 *         T(i) = HMAC(PRK, T(i-1) ‖ info ‖ uint8(i))
 *         OKM  = first L bytes of T(1) ‖ T(2) ‖ …
 *
 * tests/spt-hkdf.test.ts runs RFC 5869 Appendix A's own SHA-256 vectors
 * against this file, including the case with a zero-length salt, so the
 * composition is checked against the standard rather than against itself.
 * ========================================================================= */

import { concatBytes, type BinarySource, type SubtleKey, wipe } from "./bytes.ts";

const HASH_LEN = 32;

async function hmacKey(keyBytes: Uint8Array): Promise<SubtleKey> {
  return crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as BinarySource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function hmac(key: SubtleKey, message: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, message as unknown as BinarySource));
}

/** HMAC-SHA-256(salt, IKM). A zero-length salt is valid and means "HashLen
 *  zero bytes" per RFC 5869 §2.2 — WebCrypto refuses a zero-length HMAC key,
 *  so that substitution is made explicitly here rather than left to throw. */
export async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  const key = await hmacKey(salt.length === 0 ? new Uint8Array(HASH_LEN) : salt);
  return hmac(key, ikm);
}

export async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length < 0 || length > 255 * HASH_LEN) {
    throw new RangeError(`hkdfExpand: length ${length} outside 0..${255 * HASH_LEN}`);
  }
  const key = await hmacKey(prk);
  const out = new Uint8Array(length);
  // Typed as backed by a plain ArrayBuffer: `previous` is reassigned from the
  // HMAC result, and TypeScript will not widen a SharedArrayBuffer into it.
  let previous: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let at = 0;
  let counter = 1;
  while (at < length) {
    const block = await hmac(key, concatBytes(previous, info, Uint8Array.of(counter)));
    const take = Math.min(HASH_LEN, length - at);
    out.set(block.subarray(0, take), at);
    wipe(previous);
    previous = block;
    at += take;
    counter += 1;
  }
  wipe(previous);
  return out;
}

/** Extract-then-Expand in one step, wiping the intermediate PRK. Callers that
 *  need several outputs from ONE PRK — which §7.3 does — should extract once
 *  and expand repeatedly rather than calling this three times; it is here for
 *  the RFC vectors and for single-output uses. */
export async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  const prk = await hkdfExtract(salt, ikm);
  try {
    return await hkdfExpand(prk, info, length);
  } finally {
    wipe(prk);
  }
}
