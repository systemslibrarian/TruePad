/* ============================================================================
 * TruePad cipher core
 * ----------------------------------------------------------------------------
 * Pure functions only. No DOM, no localStorage, no CSS imports.
 *
 * Cipher protocol, letter mode (A-Z):
 *
 *   plaintext  -> uppercase A-Z only          (normalizeAZ)
 *              -> numbers 0..25               (lettersToNumbers)
 *              -> add pad symbol mod 26       (encryptLetters)
 *              -> ciphertext letters A-Z
 *
 *   Decrypt subtracts the same pad symbols mod 26.
 *
 * Cipher protocol, byte mode (the honest version):
 *
 *   cipher[i] = plain[i] XOR pad[i]   — XOR is its own inverse.
 *
 * Both modes REFUSE, before consuming a single symbol, whenever the pad
 * holds fewer symbols than the message needs. Refusal is a first-class
 * result (ok: false), not an exception: the exhausted pad is one of the
 * states this exhibit exists to show. There is no wraparound, no
 * truncation, no borrowing — ever.
 * ========================================================================= */

import { Pad } from "./pad";

// Strip everything that is not an A-Z letter and uppercase the rest.
export function normalizeAZ(text: string): string {
  return text.toUpperCase().replace(/[^A-Z]/g, "");
}

// 'A' (char code 65) -> 0, ..., 'Z' (char code 90) -> 25.
export function lettersToNumbers(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0) - 65);
}

// 0 -> 'A', ..., 25 -> 'Z'. Inverse of lettersToNumbers.
export function numbersToLetters(values: number[]): string {
  return values.map((value) => String.fromCharCode(value + 65)).join("");
}

// Cosmetic grouping: "HELLOWORLD" -> "HELLO WORLD".
export function groupedFive(text: string): string {
  return text.match(/.{1,5}/g)?.join(" ") ?? "";
}

export type OtpRefusal = {
  ok: false;
  reason: "pad-exhausted" | "mode-mismatch";
  required: number;
  remaining: number;
  message: string;
};

export type OtpTextResult =
  | { ok: true; text: string; padLabel: string; startOffset: number; consumed: number }
  | OtpRefusal;

export type OtpBytesResult =
  | { ok: true; bytes: Uint8Array; padLabel: string; startOffset: number; consumed: number }
  | OtpRefusal;

function refusePadExhausted(required: number, remaining: number): OtpRefusal {
  return {
    ok: false,
    reason: "pad-exhausted",
    required,
    remaining,
    message:
      `Pad exhausted. This message needs ${required} symbols but only ${remaining} remain. ` +
      "A one-time pad cannot borrow, wrap, or reuse — generate more randomness, " +
      "and physically deliver it, before you can send this."
  };
}

function refuseModeMismatch(expected: "letters" | "bytes", pad: Pad, required: number): OtpRefusal {
  return {
    ok: false,
    reason: "mode-mismatch",
    required,
    remaining: pad.remaining,
    message: `This operation needs a ${expected}-mode pad, but ${pad.label} is a ${pad.mode}-mode pad.`
  };
}

// Letter mode encrypt: cipher[i] = ( plain[i] + pad[i] ) mod 26.
// Consumes (burns) exactly normalized.length symbols — or none at all.
export function encryptLetters(plaintext: string, pad: Pad): OtpTextResult {
  const normalized = normalizeAZ(plaintext);
  if (pad.mode !== "letters") {
    return refuseModeMismatch("letters", pad, normalized.length);
  }
  if (normalized.length > pad.remaining) {
    return refusePadExhausted(normalized.length, pad.remaining);
  }
  const startOffset = pad.nextOffset;
  const symbols = pad.consume(normalized.length);
  const plainNums = lettersToNumbers(normalized);
  const cipherNums = plainNums.map((value, index) => (value + symbols[index].value) % 26);
  return {
    ok: true,
    text: numbersToLetters(cipherNums),
    padLabel: pad.label,
    startOffset,
    consumed: symbols.length
  };
}

// Letter mode decrypt: plain[i] = ( cipher[i] - pad[i] + 26 ) mod 26.
// The receiver burns the SAME offsets from their own copy of the pad.
export function decryptLetters(ciphertext: string, pad: Pad): OtpTextResult {
  const normalized = normalizeAZ(ciphertext);
  if (pad.mode !== "letters") {
    return refuseModeMismatch("letters", pad, normalized.length);
  }
  if (normalized.length > pad.remaining) {
    return refusePadExhausted(normalized.length, pad.remaining);
  }
  const startOffset = pad.nextOffset;
  const symbols = pad.consume(normalized.length);
  const cipherNums = lettersToNumbers(normalized);
  const plainNums = cipherNums.map((value, index) => (value - symbols[index].value + 26) % 26);
  return {
    ok: true,
    text: numbersToLetters(plainNums),
    padLabel: pad.label,
    startOffset,
    consumed: symbols.length
  };
}

// Byte mode: XOR with one fresh pad byte per plaintext byte.
export function encryptBytes(plain: Uint8Array, pad: Pad): OtpBytesResult {
  if (pad.mode !== "bytes") {
    return refuseModeMismatch("bytes", pad, plain.length);
  }
  if (plain.length > pad.remaining) {
    return refusePadExhausted(plain.length, pad.remaining);
  }
  const startOffset = pad.nextOffset;
  const symbols = pad.consume(plain.length);
  const cipher = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i += 1) {
    cipher[i] = plain[i] ^ symbols[i].value;
  }
  return { ok: true, bytes: cipher, padLabel: pad.label, startOffset, consumed: symbols.length };
}

// XOR is an involution: decrypt is the same operation with the same pad
// offsets. Kept as its own export so call sites read honestly.
export function decryptBytes(cipher: Uint8Array, pad: Pad): OtpBytesResult {
  return encryptBytes(cipher, pad);
}
