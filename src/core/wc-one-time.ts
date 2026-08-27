/* ============================================================================
 * TruePad wc-one-time-v1 — canonical bytes, hash, tag
 * ----------------------------------------------------------------------------
 * Pure functions only. No DOM, no node: builtins; imports only src/core.
 *
 * wc-one-time-v1 is TruePad's instantiation and encoding of POLYVAL
 * (RFC 8452) under a Wegman–Carter one-time mask. It is NOT a new hash,
 * and this module is NOT the security argument — FORMAT-V2.md §5 is, by
 * citation. For the record with sequence s and auth record (K_s, R_s):
 *
 *   tag = POLYVAL(K_s, canonical bytes) XOR R_s
 *
 * where the canonical bytes are the §6.1 layout built here: a fixed
 * 64-byte header (domain separator, pairId, formatVersion, direction,
 * reserved zeros, sequence, startOffset, ciphertextLength — all integers
 * u64 LE), then the ciphertext, then 0x00 padding to a 16-byte boundary.
 * Tags are computed over these bytes and NEVER over JSON or any
 * re-serialization of JSON.
 *
 * Each (K_s, R_s) authenticates exactly one canonical byte string, ever;
 * enforcing that one-time discipline (sequence windows, attempt limits,
 * durable reservation) is the store's and the CLI's job, not this
 * module's. This module also does no wire parsing — envelope2.ts owns the
 * strict parse and projects into CanonicalFields; callers pre-validate,
 * so every domain violation here throws (programmer error), it never
 * returns a typed refusal.
 *
 * All 2^128 key values are legal, including zero — the §5 bound accounts
 * for every key, so there is no rejection step and no conditioning of any
 * kind between pad material and key. The flip side is documented in §9.4:
 * POLYVAL under an all-zero key hashes everything to zero, which is why a
 * mismatched per-file restore over zeroized auth records is fatal to the
 * bound, and why that stands as a named operator assumption.
 * ========================================================================= */

import type { PadDirection } from "./pad.ts";
import { polyval } from "./gf128.ts";

/* ---- pinned constants (FORMAT-V2.md §§2.2, 4, 6.1, 8) -------------------- */

// §4: the one v2 ciphertext ceiling; §5.2 evaluates ε exactly here.
export const MAX_CIPHERTEXT_BYTES = 1048576;

// §8.2: how far past nextSequence an envelope may reach (default).
export const MAX_AUTH_LOOKAHEAD_DEFAULT = 64;

// §8.3: verification attempts per sequence, permanently (default).
export const VERIFY_ATTEMPT_LIMIT_DEFAULT = 8;

// §8.4: auth failures before the pair freezes (default).
export const FREEZE_THRESHOLD_DEFAULT = 32;

// §1.2/§7: one auth record is K (16 bytes) then R (16 bytes).
export const AUTH_RECORD_BYTES = 32;

// §2.2: 128-bit tags are the only v2 width; 64-bit tags are forbidden.
export const TAG_BYTES = 16;

// §6.1: the fixed-width canonical header preceding the ciphertext.
export const CANONICAL_HEADER_BYTES = 64;

// §2.2: canonical block 1 — ASCII "wc-one-time-v1" then two 0x00 bytes
// (77632d6f6e652d74696d652d76310000). Fixed, nonzero, and first; the
// nonzero part is what §5.1's cross-length injectivity argument uses.
export const DOMAIN_SEPARATOR: Uint8Array = new Uint8Array([
  0x77, 0x63, 0x2d, 0x6f, 0x6e, 0x65, 0x2d, 0x74, 0x69, 0x6d, 0x65, 0x2d, 0x76, 0x31, 0x00, 0x00
]);

/* ---- canonical authenticated bytes (FORMAT-V2.md §6.1) ------------------- */

// The authenticated fields, post-parse: raw bytes and in-domain numbers,
// never wire spellings. envelope2.ts projects the wire form into this.
export type CanonicalFields = {
  pairId: Uint8Array; // exactly 16 bytes
  direction: PadDirection; // "A->B" -> 0x00, "B->A" -> 0x01
  sequence: number; // safe integer >= 0
  startOffset: number; // safe integer >= 0
  ciphertext: Uint8Array; // length <= MAX_CIPHERTEXT_BYTES
};

// A non-negative safe integer as 8 little-endian bytes. Safe integers are
// below 2^53, so plain division is exact and no BigInt is needed.
function u64le(out: Uint8Array, offset: number, value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer, not ${value}`);
  }
  let rest = value;
  for (let i = 0; i < 8; i += 1) {
    out[offset + i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
}

// The exact byte string tags are computed over: the §6.1 layout, byte for
// byte. Total length 64 + C + p where p pads C to a 16-byte boundary; an
// empty ciphertext yields exactly the 64-byte header. Callers pre-validate
// domains (§6.2's strict parse), so violations here throw.
export function canonicalBytes(fields: CanonicalFields): Uint8Array {
  const { pairId, direction, sequence, startOffset, ciphertext } = fields;
  if (pairId.length !== 16) {
    throw new Error(`pairId is exactly 16 bytes, not ${pairId.length}`);
  }
  if (direction !== "A->B" && direction !== "B->A") {
    throw new Error(`direction is "A->B" or "B->A", not ${String(direction)}`);
  }
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new Error(
      `ciphertext of ${ciphertext.length} bytes exceeds MAX_CIPHERTEXT_BYTES = ${MAX_CIPHERTEXT_BYTES}`
    );
  }
  const padded = Math.ceil(ciphertext.length / 16) * 16;
  const out = new Uint8Array(CANONICAL_HEADER_BYTES + padded); // trailing bytes are already 0x00
  out.set(DOMAIN_SEPARATOR, 0);
  out.set(pairId, 16);
  out[32] = 0x02; // formatVersion
  out[33] = direction === "A->B" ? 0x00 : 0x01;
  // bytes 34..39 are reserved and stay 0x00 — supplied here, never by the wire
  u64le(out, 40, sequence, "sequence");
  u64le(out, 48, startOffset, "startOffset");
  u64le(out, 56, ciphertext.length, "ciphertextLength");
  out.set(ciphertext, CANONICAL_HEADER_BYTES);
  return out;
}

/* ---- hash and tag -------------------------------------------------------- */

// The unmasked hash: POLYVAL(K, canonical bytes). Not a tag — without the
// mask it is not safe to emit anywhere. Exposed for the verifier and for
// the frozen vectors' hash-only case.
export function wcHash(key: Uint8Array, fields: CanonicalFields): Uint8Array {
  return polyval(key, canonicalBytes(fields));
}

// The tag: POLYVAL(K, canonical bytes) XOR R. The mask R is a one-time
// pad on the hash output — uniform, fresh, used once — which is what
// keeps the observed tag from revealing anything about K.
export function wcTag(key: Uint8Array, mask: Uint8Array, fields: CanonicalFields): Uint8Array {
  if (mask.length !== TAG_BYTES) {
    throw new Error(`the mask R is exactly ${TAG_BYTES} bytes, not ${mask.length}`);
  }
  const hash = wcHash(key, fields);
  const tag = new Uint8Array(TAG_BYTES);
  for (let i = 0; i < TAG_BYTES; i += 1) {
    tag[i] = hash[i] ^ mask[i];
  }
  return tag;
}

// Tag comparison without a byte-position-dependent early return: one pass
// over all 16 bytes with an OR-accumulator, one comparison at the end.
// Anything that is not 16 bytes on either side is false up front — a
// length check, not a byte-wise walk. The claim is scoped honestly: a JS
// engine makes true constant-time unprovable; what this code guarantees
// is the shape (no early exit inside the byte loop), not a cycle count.
export function tagsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== TAG_BYTES || b.length !== TAG_BYTES) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < TAG_BYTES; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
