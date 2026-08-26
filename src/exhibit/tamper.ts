/* ============================================================================
 * TruePad tamper core — malleability
 * ----------------------------------------------------------------------------
 * Pure functions only. This module is the integrity station's engine, and it
 * exists to teach the theorem the rest of the exhibit deliberately does not:
 * perfect secrecy is NOT integrity.
 *
 * A one-time pad is perfectly malleable. In letter mode,
 *
 *   c[i] = p[i] + k[i]  (mod 26)
 *
 * so adding any delta to a ciphertext letter adds the SAME delta to what the
 * receiver decrypts at that position — the key drops out of the difference.
 * An attacker who knows (or guesses) the plaintext at some position can
 * therefore rewrite it to anything of the same length,
 *
 *   c'[i] = c[i] + (desired[i] - known[i])  (mod 26)
 *
 * without knowing a single key symbol, and the receiver sees a clean
 * decryption with no alarm. Byte mode is identical with XOR in place of
 * addition. Detecting this costs extra key: an information-theoretic MAC
 * must spend pad symbols of its own.
 * ========================================================================= */

import { lettersToNumbers, normalizeAZ, numbersToLetters } from "../core/cipher-otp";

// Shift one ciphertext letter by `delta` (mod 26). The receiver's decryption
// changes at exactly that position, by exactly that delta — every other
// position is untouched. Locality is what makes OTP tampering surgical.
export function shiftCipherLetter(ciphertext: string, position: number, delta: number): string {
  const nums = lettersToNumbers(normalizeAZ(ciphertext));
  if (!Number.isInteger(position) || position < 0 || position >= nums.length) {
    throw new Error(`position ${position} is outside the ciphertext (length ${nums.length})`);
  }
  if (!Number.isInteger(delta)) {
    throw new Error("delta must be an integer");
  }
  nums[position] = (((nums[position] + delta) % 26) + 26) % 26;
  return numbersToLetters(nums);
}

// Known-plaintext forgery, letter mode. Rewrites the ciphertext so the
// receiver decrypts `desired` where the sender wrote `known`, using no key
// knowledge at all: c'[i] = c[i] + (desired[i] - known[i]) mod 26.
export function forgeLetters(
  ciphertext: string,
  position: number,
  known: string,
  desired: string
): string {
  const nums = lettersToNumbers(normalizeAZ(ciphertext));
  const knownNums = lettersToNumbers(normalizeAZ(known));
  const desiredNums = lettersToNumbers(normalizeAZ(desired));
  if (knownNums.length !== desiredNums.length) {
    throw new Error("known and desired fragments must be the same length");
  }
  if (!Number.isInteger(position) || position < 0 || position + knownNums.length > nums.length) {
    throw new Error(`fragment does not fit the ciphertext at position ${position}`);
  }
  for (let i = 0; i < knownNums.length; i += 1) {
    nums[position + i] = (nums[position + i] + desiredNums[i] - knownNums[i] + 26) % 26;
  }
  return numbersToLetters(nums);
}

// Known-plaintext forgery, byte mode: c'[i] = c[i] XOR known[i] XOR desired[i].
export function forgeBytes(
  cipher: Uint8Array,
  position: number,
  known: Uint8Array,
  desired: Uint8Array
): Uint8Array {
  if (known.length !== desired.length) {
    throw new Error("known and desired fragments must be the same length");
  }
  if (!Number.isInteger(position) || position < 0 || position + known.length > cipher.length) {
    throw new Error(`fragment does not fit the ciphertext at position ${position}`);
  }
  const forged = Uint8Array.from(cipher);
  for (let i = 0; i < known.length; i += 1) {
    forged[position + i] = cipher[position + i] ^ known[i] ^ desired[i];
  }
  return forged;
}

// Positions where two equal-length texts differ — the UI highlights these in
// the receiver's decryption, and the tests assert tampering is surgical.
export function diffPositions(a: string, b: string): number[] {
  if (a.length !== b.length) {
    throw new Error("texts must be the same length to diff");
  }
  const positions: number[] = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      positions.push(i);
    }
  }
  return positions;
}
