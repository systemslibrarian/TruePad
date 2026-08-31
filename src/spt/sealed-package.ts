/* ============================================================================
 * TPS2 — the Sealed Package header and parser
 * ----------------------------------------------------------------------------
 * docs/SEALED-PAD-TRANSFER.md §7.1 and §7.2. A 1195-byte header that is ALSO
 * the AAD in its entirety, then the AES-256-GCM ciphertext, then the 16-byte
 * tag. Fixed overhead 1211 bytes.
 *
 * Every public field is authenticated. There is no unauthenticated routing
 * metadata, because unauthenticated metadata that later changes semantics is
 * how protocols get confused.
 *
 * This module is STRUCTURE ONLY. It never decapsulates, never derives a key,
 * and never decrypts — so a caller can reject a malformed or hostile package
 * without having touched a private key, and without having allocated anything
 * proportional to what the package CLAIMS. The declared plaintext length is
 * read as a BigInt and range-checked before it is ever converted to a Number:
 * a value near 2^53 read through Number arithmetic would round, and a rounded
 * length is a bounds check that passes for a package it should refuse.
 * ========================================================================= */

import { equalBytes, readUint16BE, readUint64BE, type BinarySource, writeUint16BE, writeUint64BE } from "./bytes.ts";
import {
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  MAX_PLAINTEXT_BYTES,
  REQUEST_HASH_BYTES,
  REQUEST_ID_BYTES,
  SUITE_ID,
  TPS2_FIXED_OVERHEAD_BYTES,
  TPS2_HEADER_BYTES,
  TPS2_MAGIC_BYTES,
  TPS2_OFFSETS,
  TRANSFER_VERSION,
  XWING_CIPHERTEXT_BYTES
} from "./constants.ts";

export type SealedHeader = {
  version: number;
  suite: number;
  requestId: Uint8Array;
  requestHash: Uint8Array;
  kemCiphertext: Uint8Array;
  nonce: Uint8Array;
  plaintextLength: number;
};

export type ParsedPackage = {
  header: SealedHeader;
  /** Bytes [0, 1195) — the AAD, verbatim. */
  aad: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
};

export type PackageParseError =
  | "wrong-magic"
  | "unsupported-version"
  | "unsupported-suite"
  | "too-short"
  | "declared-length-too-large"
  | "length-mismatch";

export type PackageParse =
  | { ok: true; parsed: ParsedPackage }
  | { ok: false; reason: PackageParseError; message: string };

const fail = (reason: PackageParseError, message: string): PackageParse => ({ ok: false, reason, message });

export type HeaderFields = {
  requestId: Uint8Array;
  requestHash: Uint8Array;
  kemCiphertext: Uint8Array;
  nonce: Uint8Array;
  plaintextLength: number;
};

/** Build the 1195-byte header. It is returned as its own buffer because it is
 *  used twice — as the package prefix and as the AAD — and the two must be the
 *  same bytes by construction rather than by a later copy that could drift. */
export function buildHeader(fields: HeaderFields): Uint8Array {
  const { requestId, requestHash, kemCiphertext, nonce, plaintextLength } = fields;
  if (requestId.length !== REQUEST_ID_BYTES) throw new RangeError("requestId: expected 16 bytes");
  if (requestHash.length !== REQUEST_HASH_BYTES) throw new RangeError("requestHash: expected 32 bytes");
  if (kemCiphertext.length !== XWING_CIPHERTEXT_BYTES) {
    throw new RangeError(`kemCiphertext: expected ${XWING_CIPHERTEXT_BYTES} bytes`);
  }
  if (nonce.length !== AEAD_NONCE_BYTES) throw new RangeError("nonce: expected 12 bytes");
  if (!Number.isSafeInteger(plaintextLength) || plaintextLength < 0 || plaintextLength > MAX_PLAINTEXT_BYTES) {
    throw new RangeError(`plaintextLength out of range: ${plaintextLength}`);
  }
  const header = new Uint8Array(TPS2_HEADER_BYTES);
  header.set(TPS2_MAGIC_BYTES, TPS2_OFFSETS.magic);
  header[TPS2_OFFSETS.version] = TRANSFER_VERSION;
  writeUint16BE(header, TPS2_OFFSETS.suite, SUITE_ID);
  header.set(requestId, TPS2_OFFSETS.requestId);
  header.set(requestHash, TPS2_OFFSETS.requestHash);
  header.set(kemCiphertext, TPS2_OFFSETS.kemCiphertext);
  header.set(nonce, TPS2_OFFSETS.nonce);
  writeUint64BE(header, TPS2_OFFSETS.plaintextLength, BigInt(plaintextLength));
  return header;
}

/** Structural parse. Ordered so that the cheapest and most discriminating
 *  checks run first and nothing large is allocated on the strength of a number
 *  the package chose for itself. */
export function parseSealedPackage(bytes: Uint8Array): PackageParse {
  if (bytes.length < TPS2_FIXED_OVERHEAD_BYTES) {
    return fail(
      "too-short",
      `a sealed package is at least ${TPS2_FIXED_OVERHEAD_BYTES} bytes, got ${bytes.length}`
    );
  }
  if (!equalBytes(bytes.subarray(0, 4), TPS2_MAGIC_BYTES)) {
    return fail("wrong-magic", "not a sealed transfer package");
  }
  const version = bytes[TPS2_OFFSETS.version];
  if (version !== TRANSFER_VERSION) {
    return fail("unsupported-version", `unsupported transfer version 0x${version.toString(16)}`);
  }
  const suite = readUint16BE(bytes, TPS2_OFFSETS.suite);
  if (suite !== SUITE_ID) {
    return fail("unsupported-suite", `unsupported suite 0x${suite.toString(16).padStart(4, "0")}`);
  }
  // BigInt first, range second, Number last — in that order, always.
  const declared = readUint64BE(bytes, TPS2_OFFSETS.plaintextLength);
  if (declared > BigInt(MAX_PLAINTEXT_BYTES)) {
    return fail("declared-length-too-large", `declared plaintext length exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
  }
  const plaintextLength = Number(declared);
  // Exact, not ">=": trailing bytes are a length disagreement, and a package
  // with something appended is not this package.
  const expected = TPS2_FIXED_OVERHEAD_BYTES + plaintextLength;
  if (bytes.length !== expected) {
    return fail(
      "length-mismatch",
      `declared plaintext ${plaintextLength} implies ${expected} bytes, got ${bytes.length}`
    );
  }
  return {
    ok: true,
    parsed: {
      header: {
        version,
        suite,
        requestId: bytes.slice(TPS2_OFFSETS.requestId, TPS2_OFFSETS.requestHash),
        requestHash: bytes.slice(TPS2_OFFSETS.requestHash, TPS2_OFFSETS.kemCiphertext),
        kemCiphertext: bytes.slice(TPS2_OFFSETS.kemCiphertext, TPS2_OFFSETS.nonce),
        nonce: bytes.slice(TPS2_OFFSETS.nonce, TPS2_OFFSETS.plaintextLength),
        plaintextLength
      },
      aad: bytes.slice(0, TPS2_HEADER_BYTES),
      ciphertext: bytes.slice(TPS2_HEADER_BYTES, TPS2_HEADER_BYTES + plaintextLength),
      tag: bytes.slice(TPS2_HEADER_BYTES + plaintextLength)
    }
  };
}

/** SHA-256 over the COMPLETE package — magic through the final GCM tag.
 *
 *  Not SHA-256(AAD): the AAD is only the 1195-byte header and commits to
 *  neither the ciphertext nor the tag, so two packages differing solely in one
 *  of those would have shared an identity (§10.1, repaired in Phase 0.6).
 *
 *  This is local bookkeeping AFTER AEAD verification — "which package was
 *  this" — and never a security substitute for the tag. */
export async function packageIdentity(packageBytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", packageBytes as unknown as BinarySource);
  return new Uint8Array(digest);
}

export { AEAD_TAG_BYTES };
