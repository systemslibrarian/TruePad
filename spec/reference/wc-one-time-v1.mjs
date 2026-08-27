/* ============================================================================
 * wc-one-time-v1 — reference implementation (Phase 0)
 * ----------------------------------------------------------------------------
 * This file exists for exactly one purpose: to compute the test vectors that
 * docs/FORMAT-V2.md freezes (via spec/reference/vectors.mjs). It is NOT the
 * spec, it is NOT the security argument, and it never ships in the CLI or
 * the exhibit. Where this file and docs/FORMAT-V2.md disagree, the spec wins
 * and this file has a bug.
 *
 * Constraints, on purpose:
 *   - plain .mjs for Node >= 22, zero dependencies, zero imports — not even
 *     node: builtins, and never anything from src/;
 *   - the field arithmetic is bit-serial and obviously correct rather than
 *     fast (65,540 blocks still hash in under a second);
 *   - POLYVAL is implemented as the LITERAL iteration in RFC 8452 Section 3
 *     (S_j = dot(S_{j-1} + X_j, H)), so a reader can hold this file against
 *     the RFC line by line. vectors.mjs asserts the RFC's own published
 *     values (field examples, Section 7; the worked POLYVAL evaluation,
 *     Appendix A) before it emits anything.
 *
 * wc-one-time-v1 is TruePad's instantiation and encoding of POLYVAL
 * (RFC 8452) under a Wegman–Carter one-time mask. It is not a new hash.
 * ========================================================================= */

/* ---- GF(2^128), POLYVAL convention (RFC 8452 Section 3) ------------------ */

// The field is defined by the irreducible polynomial
// x^128 + x^127 + x^126 + x^121 + 1.
const POLY = (1n << 128n) | (1n << 127n) | (1n << 126n) | (1n << 121n) | 1n;

// The field element x^-128, given in RFC 8452 Section 3:
// x^127 + x^124 + x^121 + x^114 + 1.
const X_NEG_128 = (1n << 127n) | (1n << 124n) | (1n << 121n) | (1n << 114n) | 1n;

const BIT_128 = 1n << 128n;

/* ---- hex <-> bytes -------------------------------------------------------- */

export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error(`not lowercase hex of even length: ${hex}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/* ---- field element <-> 16 bytes ------------------------------------------- */

// RFC 8452 maps byte strings to field elements little-endian in both bytes
// and bits: the least significant bit of the first byte is the coefficient
// of x^0; the most significant bit of the last byte is the coefficient of
// x^127. As a BigInt whose bit i is the coefficient of x^i, that is exactly
// a little-endian 128-bit integer read of the 16 bytes.
export function bytesToField(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) {
    throw new Error("a field element is exactly 16 bytes");
  }
  let fe = 0n;
  for (let i = 15; i >= 0; i -= 1) {
    fe = (fe << 8n) | BigInt(bytes[i]);
  }
  return fe;
}

export function fieldToBytes(fe) {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number(fe & 0xffn);
    fe >>= 8n;
  }
  return out;
}

/* ---- field arithmetic ----------------------------------------------------- */

// Product of two field elements. Bit-serial: for each set bit i of b,
// accumulate a * x^i, keeping the running a * x^i reduced modulo POLY.
export function gfMul(a, b) {
  let result = 0n;
  let shifted = a;
  for (let i = 0n; i < 128n; i += 1n) {
    if ((b >> i) & 1n) {
      result ^= shifted;
    }
    shifted <<= 1n; // multiply by x ...
    if (shifted & BIT_128) {
      shifted ^= POLY; // ... and reduce: x^128 = x^127 + x^126 + x^121 + 1
    }
  }
  return result;
}

// dot(a, b) = a * b * x^-128 (RFC 8452 Section 3).
export function dot(a, b) {
  return gfMul(gfMul(a, b), X_NEG_128);
}

// POLYVAL(H, X_1, ..., X_s): S_0 = 0; S_j = dot(S_{j-1} + X_j, H); the
// result is S_s. `message` must already be a whole number of 16-byte blocks
// (the canonical encoding below never produces anything else).
export function polyval(hBytes, message) {
  if (!(message instanceof Uint8Array) || message.length % 16 !== 0) {
    throw new Error("POLYVAL input must be a whole number of 16-byte blocks");
  }
  const h = bytesToField(hBytes);
  let s = 0n;
  for (let offset = 0; offset < message.length; offset += 16) {
    const block = bytesToField(message.subarray(offset, offset + 16));
    s = dot(s ^ block, h);
  }
  return fieldToBytes(s);
}

/* ---- wc-one-time-v1 canonical authenticated bytes (FORMAT-V2.md §6) ------ */

export const MAX_CIPHERTEXT_BYTES = 1048576;

// Block 0: ASCII "wc-one-time-v1" followed by two 0x00 bytes. This block is
// never zero, which is what rules out leading-zero-block collisions between
// canonical strings of different lengths (see the injectivity argument in
// FORMAT-V2.md §5).
export const DOMAIN_SEPARATOR = new Uint8Array([
  0x77, 0x63, 0x2d, 0x6f, 0x6e, 0x65, 0x2d, 0x74, 0x69, 0x6d, 0x65, 0x2d, 0x76, 0x31, 0x00, 0x00
]);

const U64_MAX = (1n << 64n) - 1n;

function u64le(value, name) {
  const v = BigInt(value);
  if (v < 0n || v > U64_MAX) {
    throw new Error(`${name} must be an unsigned 64-bit integer, not ${value}`);
  }
  const out = new Uint8Array(8);
  let rest = v;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

// The exact byte string tags are computed over. Fixed 64-byte header, then
// the ciphertext, then 0x00 padding to the next 16-byte boundary. Never any
// JSON serialization.
export function canonicalBytes({ pairId, direction, sequence, startOffset, ciphertext }) {
  if (!(pairId instanceof Uint8Array) || pairId.length !== 16) {
    throw new Error("pairId is exactly 16 bytes");
  }
  if (direction !== 0 && direction !== 1) {
    throw new Error("direction is 0 (A->B) or 1 (B->A)");
  }
  if (!(ciphertext instanceof Uint8Array)) {
    throw new Error("ciphertext must be a Uint8Array");
  }
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new Error(`ciphertext of ${ciphertext.length} bytes exceeds MAX_CIPHERTEXT_BYTES = ${MAX_CIPHERTEXT_BYTES}`);
  }
  const padded = Math.ceil(ciphertext.length / 16) * 16;
  const out = new Uint8Array(64 + padded); // trailing bytes are already 0x00
  out.set(DOMAIN_SEPARATOR, 0);
  out.set(pairId, 16);
  out[32] = 0x02; // formatVersion
  out[33] = direction;
  // bytes 34..39 are reserved and MUST be 0x00
  out.set(u64le(sequence, "sequence"), 40);
  out.set(u64le(startOffset, "startOffset"), 48);
  out.set(u64le(ciphertext.length, "ciphertextLength"), 56);
  out.set(ciphertext, 64);
  return out;
}

// The unmasked hash: POLYVAL(K, canonical bytes).
export function wcOneTimeHash(keyBytes, fields) {
  return polyval(keyBytes, canonicalBytes(fields));
}

// The tag: POLYVAL(K, canonical bytes) XOR R. K and R together are one auth
// record; each is used for exactly one sequence number, ever.
export function wcOneTimeTag(keyBytes, maskBytes, fields) {
  if (!(maskBytes instanceof Uint8Array) || maskBytes.length !== 16) {
    throw new Error("the mask R is exactly 16 bytes");
  }
  const hash = wcOneTimeHash(keyBytes, fields);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    tag[i] = hash[i] ^ maskBytes[i];
  }
  return tag;
}
