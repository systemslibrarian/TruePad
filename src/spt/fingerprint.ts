/* ============================================================================
 * Domain-separated hashing, requestHash, and the two word renderings
 * ----------------------------------------------------------------------------
 * docs/SEALED-PAD-TRANSFER.md §6.2, §6.3 and §8.2.
 *
 *   H_ds(DS, X) = SHA-256( uint8(len(DS)) ‖ DS ‖ X )
 *
 * The length octet is MEASURED. §6.2 states the rule and the reason: a wrong
 * constant here does not fail loudly, it silently forks requestHash — and with
 * it the safety words, the HKDF salt, and AAD bytes [23, 55) — between two
 * conforming builds, producing exactly the symptom of an active attack. There
 * is one function that builds the prefix, it takes the string, and it measures.
 *
 * The two renderings are named apart on purpose. `requestWords132` authenticates
 * the receive request against an OFFLINE, known-target grind and carries 132
 * bits. `confirmationWords88` authenticates the sealed package in an ONLINE,
 * unknown-target ceremony and carries 88. They are different values at
 * different strengths for different threat models, and §8.2 says confusing
 * them would be easy and bad.
 *
 * Bit extraction is BigInt throughout. A 136-bit value shifted through Number
 * arithmetic would lose the low limbs silently and produce indices that look
 * perfectly plausible.
 * ========================================================================= */

import { asciiBytes, concatBytes, type BinarySource } from "./bytes.ts";
import {
  CONFIRM_VALUE_BYTES,
  CONFIRM_WORDS_COUNT,
  DS_REQUEST_FP,
  REQUEST_WORDS_COUNT
} from "./constants.ts";

/** `uint8(len(DS)) ‖ DS`, with the length measured from the encoded bytes and
 *  asserted into 1..255. Exported because the HKDF `info` strings of §7.3 are
 *  built the same way and must not grow a second, subtly different builder. */
export function domainPrefix(separator: string): Uint8Array {
  const ds = asciiBytes(separator);
  if (ds.length < 1 || ds.length > 255) {
    throw new RangeError(`domain separator length ${ds.length} outside 1..255`);
  }
  return concatBytes(Uint8Array.of(ds.length), ds);
}

/** H_ds(DS, X). Async because it is WebCrypto's SHA-256: one SHA-256 in the
 *  build, the platform's. */
export async function hashDomain(separator: string, payload: Uint8Array): Promise<Uint8Array> {
  const input = concatBytes(domainPrefix(separator), payload);
  const digest = await crypto.subtle.digest("SHA-256", input as unknown as BinarySource);
  return new Uint8Array(digest);
}

/** requestHash = H_ds(DS_REQUEST_FP, canonicalRequestBody) — over the COMPLETE
 *  1235-byte body of §5.1, never a subset. Substituting the version, the suite,
 *  the requestId or the encapsulation key changes the fingerprint. */
export async function requestFingerprint(canonicalRequestBody: Uint8Array): Promise<Uint8Array> {
  return hashDomain(DS_REQUEST_FP, canonicalRequestBody);
}

/** §6.3. requestHash[0..17) as a big-endian 136-bit integer, low 4 bits
 *  discarded, the remaining 132 split into twelve 11-bit indices,
 *  most-significant first — shifts 121, 110, …, 11, 0. An exact,
 *  non-overlapping partition: every one of the 132 bits lands in exactly one
 *  index, and the four discarded bits land in none. */
export function requestIndices132(requestHash: Uint8Array): number[] {
  if (requestHash.length < 17) {
    throw new RangeError(`requestIndices132: expected at least 17 bytes, got ${requestHash.length}`);
  }
  let n = 0n;
  for (let i = 0; i < 17; i += 1) n = (n << 8n) | BigInt(requestHash[i]);
  const m = n >> 4n;
  const out: number[] = [];
  for (let i = 0; i < REQUEST_WORDS_COUNT; i += 1) {
    out.push(Number((m >> BigInt(121 - 11 * i)) & 0x7ffn));
  }
  return out;
}

/** §8.2. confirmValue[0..11) as a big-endian 88-bit integer split into eight
 *  11-bit indices, shifts 77, 66, …, 11, 0. Nothing is discarded here: 88 is
 *  already 8 × 11. */
export function confirmationIndices88(confirmValue: Uint8Array): number[] {
  if (confirmValue.length < CONFIRM_VALUE_BYTES) {
    throw new RangeError(
      `confirmationIndices88: expected at least ${CONFIRM_VALUE_BYTES} bytes, got ${confirmValue.length}`
    );
  }
  let n = 0n;
  for (let i = 0; i < CONFIRM_VALUE_BYTES; i += 1) n = (n << 8n) | BigInt(confirmValue[i]);
  const out: number[] = [];
  for (let i = 0; i < CONFIRM_WORDS_COUNT; i += 1) {
    out.push(Number((n >> BigInt(77 - 11 * i)) & 0x7ffn));
  }
  return out;
}
