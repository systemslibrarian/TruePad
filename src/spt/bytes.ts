/* ============================================================================
 * Sealed Pad Transfer v1 — byte utilities
 * ----------------------------------------------------------------------------
 * Dependency-free and platform-neutral: no Buffer, no atob/btoa, no Node or DOM
 * API. The same bytes in the browser, in Node, and in the tests.
 *
 * The base64url codec is deliberately a copy of the discipline in
 * src/core/compact-envelope2.ts rather than an import of it: Sealed Pad
 * Transfer must not become a dependency of the frozen message core, and the
 * arrow only ever points that way (see docs/SEALED-PAD-TRANSFER.md §0). The
 * rules are the same — RFC 4648 §5 alphabet, no padding, no `+`, no `/`, no
 * internal whitespace — because a transport that admits several spellings of
 * one request is a transport that will eventually be asked which spelling was
 * "the" request, and there is no good answer.
 * ========================================================================= */

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_INDEX: Record<string, number> = {};
for (let i = 0; i < B64URL.length; i += 1) {
  B64URL_INDEX[B64URL[i]] = i;
}

/** WebCrypto's `BufferSource` under a name that does not need the DOM lib:
 *  tsconfig.cli.json (which the tests project extends) has `lib: ["ES2022"]`,
 *  so `BufferSource` and `CryptoKey` are not in scope for a type position
 *  there. Structurally identical, and assignable to `BufferSource` where the
 *  DOM lib IS loaded. */
export type BinarySource = ArrayBuffer | ArrayBufferView<ArrayBuffer>;

/** The opaque key handle `subtle.importKey` returns, named without `CryptoKey`
 *  for the same reason. */
export type SubtleKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Compare in time independent of WHERE the first difference is. Length is not
 *  secret here — every value compared has a fixed, public length — so an early
 *  return on a length mismatch leaks nothing. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Best-effort in-memory hygiene for buffers THIS module owns. It does not
 *  prove a garbage-collected copy is gone, that the engine forgot the bytes, or
 *  that physical RAM was erased — the same limitation the worker records. Never
 *  called on a caller-owned array (§20 of the Phase 1A brief). */
export function wipe(...buffers: (Uint8Array | undefined)[]): void {
  for (const buffer of buffers) {
    if (!buffer) continue;
    try {
      buffer.fill(0);
    } catch {
      /* detached or non-writable — nothing to do */
    }
  }
}

export function writeUint16BE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 8) & 0xff;
  out[offset + 1] = value & 0xff;
}

export function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/** uint64 big-endian. BigInt throughout: a length near 2^53 read through Number
 *  arithmetic would round, and a rounded length is a length check that passes
 *  for a package it should refuse. The caller range-checks the BigInt BEFORE
 *  converting it. */
export function writeUint64BE(out: Uint8Array, offset: number, value: bigint): void {
  let v = value;
  for (let i = 7; i >= 0; i -= 1) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

export function readUint64BE(bytes: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i += 1) v = (v << 8n) | BigInt(bytes[offset + i]);
  return v;
}

/* ---- canonical unpadded base64url --------------------------------------- */

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i;
    const b0 = bytes[i];
    const b1 = remaining > 1 ? bytes[i + 1] : 0;
    const b2 = remaining > 2 ? bytes[i + 2] : 0;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (remaining > 1) out += B64URL[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (remaining > 2) out += B64URL[b2 & 0x3f];
  }
  return out;
}

/** Strict decode. Returns null rather than throwing: at this layer a bad paste
 *  is an ordinary outcome, not an exception. A group of length 1 is impossible
 *  in base64; `=`, `+`, `/` and any whitespace are outside the alphabet and are
 *  rejected by the same lookup that rejects any other stray character.
 *
 *  This does NOT by itself make the encoding canonical: trailing bits in the
 *  final group can be non-zero and would decode to the same bytes. Callers
 *  re-encode and compare — see decodeReceiveRequest. */
export function fromBase64Url(text: string): Uint8Array | null {
  const groups = Math.floor(text.length / 4);
  const remainder = text.length % 4;
  if (remainder === 1) return null;
  const out = new Uint8Array(groups * 3 + (remainder === 0 ? 0 : remainder - 1));
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.length - i;
    const c0 = B64URL_INDEX[text[i]];
    const c1 = B64URL_INDEX[text[i + 1]];
    if (c0 === undefined || c1 === undefined) return null;
    out[at] = (c0 << 2) | (c1 >> 4);
    at += 1;
    if (chunk > 2) {
      const c2 = B64URL_INDEX[text[i + 2]];
      if (c2 === undefined) return null;
      out[at] = ((c1 & 0x0f) << 4) | (c2 >> 2);
      at += 1;
      if (chunk > 3) {
        const c3 = B64URL_INDEX[text[i + 3]];
        if (c3 === undefined) return null;
        out[at] = ((c2 & 0x03) << 6) | c3;
        at += 1;
      }
    }
  }
  return out;
}

const ASCII = /^[\x20-\x7e]*$/;

/** ASCII-only, so `uint8(len(DS))` is the character count and cannot drift from
 *  the byte count for any separator this protocol uses. */
export function asciiBytes(text: string): Uint8Array {
  if (!ASCII.test(text)) throw new Error("expected printable ASCII");
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
  return out;
}
