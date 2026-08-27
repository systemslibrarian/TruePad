/* ============================================================================
 * TruePad v2 source-material partition (FORMAT-V2.md §7, §1.2)
 * ----------------------------------------------------------------------------
 * Pure byte movement, nothing else. This module combines declared sources by
 * bytewise XOR and carves the combined material into the four secret slices
 * of a pair:
 *
 *   M[0        .. E)          A->B encryption slice  (byte e ↦ offset e)
 *   M[E        .. E+32N)      A->B authentication slice
 *   M[E+32N    .. 2E+32N)     B->A encryption slice  (byte E+32N+e ↦ offset e)
 *   M[2E+32N   .. 2E+64N)     B->A authentication slice
 *
 * with E = encryption.capacity, N = authentication.capacityRecords, and
 * L = 2·(E + 32·N) the length every declared source must supply. Every
 * combined byte lands in exactly one slice at exactly one position; the XOR
 * and this partition are the only operations between declared sources and
 * secret body — no KDF, no extractor, no hash conditioner, ever (§7).
 * Within an authentication slice, record s is bytes [32s, 32s+16) as K_s
 * and [32s+16, 32s+32) as R_s (§1.2) — the key first, then the mask.
 *
 * What this module is NOT: it does not read files, judge uniformity, or
 * enforce the one-file-one-source rule — gen's UX (Phase 1) owns those,
 * and the verdict for combined material is gen's to state ("Uniform if at
 * least one declared source was uniform and independent of the others").
 * It also never zeroizes: partition() returns fresh copies precisely so
 * the caller can zero the combined buffer (and each slice) on its own
 * schedule without the copies aliasing it.
 *
 * Domain violations here are programmer errors and throw; the operator-
 * facing refusal for short material (`source-too-short`) is gen's, built on
 * requiredSourceLength() and combineSources()'s length check.
 * ========================================================================= */

import { AUTH_RECORD_BYTES } from "./wc-one-time.ts";

// K_s is the first 16 bytes of a 32-byte auth record; R_s the second 16
// (FORMAT-V2.md §1.2).
const KEY_BYTES = 16;

function assertBudget(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer, not ${value}`);
  }
}

// L = 2·(E + 32·N): the exact byte count every declared source must supply
// (§7). Surplus beyond L is never used — saying so is gen's job.
export function requiredSourceLength(capacity: number, capacityRecords: number): number {
  assertBudget("capacity", capacity);
  assertBudget("capacityRecords", capacityRecords);
  const length = 2 * (capacity + AUTH_RECORD_BYTES * capacityRecords);
  if (!Number.isSafeInteger(length)) {
    throw new Error(`required source length 2*(${capacity} + 32*${capacityRecords}) exceeds the safe-integer range`);
  }
  return length;
}

export type PairSlices = {
  abEncryption: Uint8Array;
  abAuthentication: Uint8Array;
  baEncryption: Uint8Array;
  baAuthentication: Uint8Array;
};

// Bytewise XOR of the first `length` bytes of every source. All-or-nothing:
// a source shorter than `length` (or no sources at all) throws before any
// byte is combined. Bytes beyond `length` are not read.
export function combineSources(sources: Uint8Array[], length: number): Uint8Array {
  assertBudget("length", length);
  if (sources.length === 0) {
    throw new Error("combineSources needs at least one source");
  }
  for (let i = 0; i < sources.length; i += 1) {
    if (sources[i].length < length) {
      throw new Error(`source ${i} supplies ${sources[i].length} bytes but ${length} are required`);
    }
  }
  const combined = new Uint8Array(length);
  for (const source of sources) {
    for (let i = 0; i < length; i += 1) {
      combined[i] ^= source[i];
    }
  }
  return combined;
}

// The §7 partition, exactly: [abEnc E][abAuth 32N][baEnc E][baAuth 32N].
// `combined` must be exactly L = 2·(E + 32·N) bytes. The returned slices
// are COPIES, never subarray views of `combined`, so the caller can zero
// the combined buffer without wiping the slices (and vice versa).
export function partition(combined: Uint8Array, capacity: number, capacityRecords: number): PairSlices {
  const length = requiredSourceLength(capacity, capacityRecords);
  if (combined.length !== length) {
    throw new Error(
      `combined material is ${combined.length} bytes but the partition needs exactly ` +
        `${length} (2*(${capacity} + 32*${capacityRecords}))`
    );
  }
  const authBytes = AUTH_RECORD_BYTES * capacityRecords;
  let cursor = 0;
  const take = (count: number): Uint8Array => {
    const copy = combined.slice(cursor, cursor + count); // slice() copies; subarray() would alias
    cursor += count;
    return copy;
  };
  return {
    abEncryption: take(capacity),
    abAuthentication: take(authBytes),
    baEncryption: take(capacity),
    baAuthentication: take(authBytes)
  };
}

// Auth record `sequence` out of a direction's authentication slice: bytes
// [32s, 32s+16) as the hash key K_s, [32s+16, 32s+32) as the mask R_s —
// slice-local offsets (§1.2). Returns copies, for the same zeroization
// independence as partition(). A sequence past the slice throws: no record
// beyond capacityRecords exists, and this module never invents one.
export function authRecordAt(authSlice: Uint8Array, sequence: number): { key: Uint8Array; mask: Uint8Array } {
  assertBudget("sequence", sequence);
  const start = sequence * AUTH_RECORD_BYTES;
  if (start + AUTH_RECORD_BYTES > authSlice.length) {
    throw new Error(
      `auth record ${sequence} needs slice bytes [${start}, ${start + AUTH_RECORD_BYTES}) ` +
        `but the slice holds ${authSlice.length}`
    );
  }
  return {
    key: authSlice.slice(start, start + KEY_BYTES),
    mask: authSlice.slice(start + KEY_BYTES, start + AUTH_RECORD_BYTES)
  };
}
