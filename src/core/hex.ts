/* ============================================================================
 * TruePad hex codec
 * ----------------------------------------------------------------------------
 * Pure functions only. No DOM, no node: builtins, no imports at all.
 *
 * v2 pins ONE wire spelling for bytes: lowercase hex, two characters per
 * byte (FORMAT-V2.md §6.2 — "one accepted representation, byte for byte,
 * no alternates"). bytesToHex emits exactly that spelling; hexToBytes
 * accepts exactly that spelling and nothing else — uppercase, odd length,
 * whitespace, and 0x prefixes are all rejected as null, never normalized.
 *
 * This module is a codec, not a validator of meaning: it says nothing about
 * whether the bytes are a pairId, a tag, or garbage. Length and domain
 * checks belong to the callers (envelope parsing, canonical encoding).
 * ========================================================================= */

// One byte -> two lowercase hex characters, in order.
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

// Strict inverse of bytesToHex. Accepts /^(?:[0-9a-f]{2})*$/ only — the
// empty string decodes to an empty Uint8Array; anything outside the
// pattern returns null. Refusal is a value, not an exception, because
// "not hex" is an expected wire condition, not a programmer error.
export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}
