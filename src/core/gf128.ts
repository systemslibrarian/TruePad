/* ============================================================================
 * TruePad GF(2^128) / POLYVAL core
 * ----------------------------------------------------------------------------
 * Pure functions only. No DOM, no node: builtins, no imports at all.
 *
 * POLYVAL exactly as specified in RFC 8452 Section 3, with every constant
 * pinned by FORMAT-V2.md §2.2:
 *
 *   - field: GF(2^128) defined by x^128 + x^127 + x^126 + x^121 + 1;
 *   - encoding: little-endian in both bytes and bits — the least
 *     significant bit of the first byte is the coefficient of x^0, so a
 *     field element as a 128-bit integer is a little-endian read of its
 *     16 bytes;
 *   - dot(a, b) = a · b · x^-128, with x^-128 = x^127 + x^124 + x^121 +
 *     x^114 + 1;
 *   - evaluation: S_0 = 0; S_j = dot(S_{j-1} XOR X_j, H); result S_m.
 *
 * The arithmetic is bit-serial ON PURPOSE: this module is written to be
 * held against RFC 8452 line by line, not to be fast. The largest input
 * the format allows (65,540 blocks, the max-ciphertext canonical string)
 * hashes in roughly a second, and nothing here is on a per-keystroke path.
 *
 * This module is NOT a security argument (FORMAT-V2.md §5 is, by
 * citation), NOT a general-purpose field library (only what POLYVAL
 * needs), and makes no timing claims: BigInt arithmetic in a JS engine is
 * not constant-time, and gfMul branches on the KEY's bits, so POLYVAL
 * timing depends on the key. The one-time mask R protects the tag VALUE
 * only — it does nothing for timing. What bounds the exposure is the
 * durable attempt reservation (at most verifyAttemptLimit timed
 * verifications per record, each a whole CLI run dominated by fsyncs),
 * and the spec claims no timing resistance anywhere.
 * ========================================================================= */

// The field: x^128 + x^127 + x^126 + x^121 + 1 (RFC 8452 Section 3).
const POLY = (1n << 128n) | (1n << 127n) | (1n << 126n) | (1n << 121n) | 1n;

// The field element x^-128 (RFC 8452 Section 3):
// x^127 + x^124 + x^121 + x^114 + 1.
const X_NEG_128 = (1n << 127n) | (1n << 124n) | (1n << 121n) | (1n << 114n) | 1n;

const BIT_128 = 1n << 128n;

// 16 bytes -> field element: little-endian 128-bit integer read, which is
// exactly RFC 8452's bit/byte mapping (bit i of the integer = coefficient
// of x^i). Anything but 16 bytes is a programmer error, so it throws.
export function bytesToField(bytes: Uint8Array): bigint {
  if (bytes.length !== 16) {
    throw new Error(`a field element is exactly 16 bytes, not ${bytes.length}`);
  }
  let fe = 0n;
  for (let i = 15; i >= 0; i -= 1) {
    fe = (fe << 8n) | BigInt(bytes[i]);
  }
  return fe;
}

// Field element -> 16 bytes, the same little-endian mapping. Inputs are
// field elements produced by this module (below 2^128); higher bits of a
// foreign bigint would be silently dropped, so do not feed it one.
export function fieldToBytes(fe: bigint): Uint8Array {
  const out = new Uint8Array(16);
  let rest = fe;
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

// Product of two field elements. Bit-serial: for each set bit i of b,
// accumulate a · x^i, keeping the running a · x^i reduced modulo POLY.
export function gfMul(a: bigint, b: bigint): bigint {
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

// dot(a, b) = a · b · x^-128 (RFC 8452 Section 3).
export function dot(a: bigint, b: bigint): bigint {
  return gfMul(gfMul(a, b), X_NEG_128);
}

// POLYVAL(H, X_1, ..., X_m): the LITERAL RFC 8452 Section 3 iteration —
// S_0 = 0; S_j = dot(S_{j-1} XOR X_j, H); the result is S_m. No hoisted
// H·x^-128, no precomputed tables: one dot per block, exactly as written
// in the RFC. `message` must be a whole number of 16-byte blocks; the
// canonical encoding (wc-one-time.ts) never produces anything else, so a
// partial block here is a programmer error and throws.
export function polyval(h: Uint8Array, message: Uint8Array): Uint8Array {
  if (message.length % 16 !== 0) {
    throw new Error(`POLYVAL input must be a whole number of 16-byte blocks, not ${message.length} bytes`);
  }
  const key = bytesToField(h);
  let s = 0n;
  for (let offset = 0; offset < message.length; offset += 16) {
    const block = bytesToField(message.subarray(offset, offset + 16));
    s = dot(s ^ block, key);
  }
  return fieldToBytes(s);
}
