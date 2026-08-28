/* ============================================================================
 * TruePad v2 fixed-size record frame (FORMAT-V2.md §16.1)
 * ----------------------------------------------------------------------------
 * Pure byte movement, nothing else. No DOM, no node builtins, no imports.
 *
 * A fixed-size store freezes every record at one ciphertext size F (§16).
 * The message length moves INSIDE the encrypted-and-authenticated region so
 * the channel observes record count and timing but never message length:
 *
 *   frame = plaintextLength (u32 LE) || plaintext || 0x00 padding, exactly F bytes
 *
 * Plaintext capacity per record is F − 4. The frame is what §12.2 encrypts
 * and authenticates (C = F); the length prefix is recovered only after the
 * tag verifies and the record is committed (§16.2), and it selects the
 * released bytes. The padding is 0x00 with no other meaning — it is never
 * inspected on parse; only the prefix decides the plaintext boundary.
 *
 * This module is a codec of the frame, not a store or a policy: it does not
 * read a header, decide whether a store is fixed, or judge F against §16's
 * bounds (32 ≤ F ≤ maxCiphertextBytes, multiple of 16) — gen and the store
 * loader own that. buildFrame throws on a domain violation (its callers
 * pre-validate F and the plaintext length); parseFrame returns null for a
 * length field that cannot come from a conforming sender — the caller maps
 * that null to the §16.2 `record-frame-invalid` error on the post-commit
 * path, never a refusal.
 * ========================================================================= */

// The u32 little-endian length prefix: four bytes ahead of the plaintext.
const LENGTH_PREFIX_BYTES = 4;

// Plaintext capacity of an F-byte record: the bytes left after the prefix.
export function frameCapacity(recordBytes: number): number {
  return recordBytes - LENGTH_PREFIX_BYTES;
}

// Build the exactly-F-byte frame for `plaintext`: u32 LE length prefix, the
// plaintext, then 0x00 padding to F. The fresh allocation is already zeroed,
// so the padding is written by construction. Throws when F cannot hold the
// prefix or the plaintext does not fit (F − 4) — a programmer/caller error,
// not a wire condition.
export function buildFrame(plaintext: Uint8Array, recordBytes: number): Uint8Array {
  if (!Number.isSafeInteger(recordBytes) || recordBytes < LENGTH_PREFIX_BYTES) {
    throw new Error(`buildFrame: recordBytes ${recordBytes} must be a safe integer >= ${LENGTH_PREFIX_BYTES}`);
  }
  const capacity = recordBytes - LENGTH_PREFIX_BYTES;
  if (plaintext.length > capacity) {
    throw new Error(
      `buildFrame: plaintext is ${plaintext.length} bytes but a ${recordBytes}-byte record holds at most ${capacity} (F-4)`
    );
  }
  const frame = new Uint8Array(recordBytes);
  new DataView(frame.buffer).setUint32(0, plaintext.length, true); // u32 LE
  frame.set(plaintext, LENGTH_PREFIX_BYTES);
  return frame;
}

// Recover the plaintext from a decrypted frame. Returns a COPY of the bytes
// the prefix selects, or null when the length field exceeds frame.length − 4
// — a value no conforming sender writes and that cannot be forged into
// existence below the §5 probability. The padding after the plaintext is not
// examined; the prefix alone is the boundary.
export function parseFrame(frame: Uint8Array): Uint8Array | null {
  if (frame.length < LENGTH_PREFIX_BYTES) {
    return null;
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const declared = view.getUint32(0, true); // u32 LE
  if (declared > frame.length - LENGTH_PREFIX_BYTES) {
    return null;
  }
  return frame.slice(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + declared); // a copy
}
