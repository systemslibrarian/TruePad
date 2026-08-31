import { hexToBytes } from "../../src/core/hex";

/* A hex literal in a frozen reference vector must never decode to null and be
 * quietly asserted away with `!`. A typo in a vector is a broken vector, and it
 * should say so at the point it is written rather than fail somewhere downhill
 * as a length or comparison mismatch. */
export function hx(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes === null) throw new Error(`malformed hex in a test vector: ${hex.slice(0, 32)}…`);
  return bytes;
}
