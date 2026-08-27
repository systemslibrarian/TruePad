/* ============================================================================
 * wc-one-time-v1 test-vector generator (Phase 0)
 * ----------------------------------------------------------------------------
 * The single named command that produces the vectors frozen into
 * docs/FORMAT-V2.md §11:
 *
 *   node spec/reference/vectors.mjs
 *
 * Output is deterministic JSON on stdout: no clock, no randomness, no
 * environment. Before emitting anything it asserts the examples published
 * in RFC 8452 (field operations, Section 7; the worked POLYVAL evaluation,
 * Appendix A); if those fail, the implementation is wrong and no vectors
 * are printed.
 *
 * The keys and masks below are TEST CONSTANTS. They exist so two
 * implementations can compare outputs; nothing shaped like them is ever
 * real pad material. The protocol uses each (K, R) for one sequence number
 * only; these cases reuse one pair across several messages because they are
 * hash tests, not a protocol transcript, and say so.
 * ========================================================================= */

import {
  bytesToField,
  bytesToHex,
  canonicalBytes,
  dot,
  fieldToBytes,
  gfMul,
  hexToBytes,
  MAX_CIPHERTEXT_BYTES,
  polyval,
  wcOneTimeHash,
  wcOneTimeTag
} from "./wc-one-time-v1.mjs";

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: got ${actual}, expected ${expected} — the reference implementation is wrong; no vectors emitted`);
  }
}

/* ---- 1. RFC 8452 cross-checks --------------------------------------------- */
// These values are copied from the RFC (field operations from Section 7,
// the POLYVAL evaluation from Appendix A), not computed here. They pin the
// field, the byte order, and the dot operation to the published function.

const rfcA = hexToBytes("66e94bd4ef8a2c3b884cfa59ca342b2e");
const rfcB = hexToBytes("ff000000000000000000000000000000");
assertEqual(
  bytesToHex(fieldToBytes(gfMul(bytesToField(rfcA), bytesToField(rfcB)))),
  "37856175e9dc9df26ebc6d6171aa0ae9",
  "RFC 8452 Section 7: a * b"
);
assertEqual(
  bytesToHex(fieldToBytes(dot(bytesToField(rfcA), bytesToField(rfcB)))),
  "ebe563401e7e91ea3ad6426b8140c394",
  "RFC 8452 Section 7: dot(a, b)"
);
assertEqual(
  bytesToHex(
    polyval(
      hexToBytes("25629347589242761d31f826ba4b757b"),
      hexToBytes("4f4f95668c83dfb6401762bb2d01a262" + "d1a24ddd2721d006bbe45f20d3c9f362")
    )
  ),
  "f7a3b47b846119fae5b7866cf5e5b77e",
  "RFC 8452 Appendix A: POLYVAL(H, X_1, X_2)"
);

/* ---- 2. frozen wc-one-time-v1 vectors ------------------------------------- */

const PAIR_ID = hexToBytes("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf");
const K1 = hexToBytes("000102030405060708090a0b0c0d0e0f");
const R1 = hexToBytes("101112131415161718191a1b1c1d1e1f");
const K2 = hexToBytes("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
const R2 = hexToBytes("e0e1e2e3e4e5e6e7e8e9eaebecedeeef");

function pattern(length, base) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (base + i) & 0xff;
  }
  return out;
}

function smallCase(name, note, key, mask, fields) {
  const canonical = canonicalBytes(fields);
  const record = {
    name,
    note,
    key: bytesToHex(key),
    mask: mask === null ? null : bytesToHex(mask),
    pairId: bytesToHex(fields.pairId),
    direction: fields.direction,
    sequence: fields.sequence,
    startOffset: fields.startOffset,
    ciphertextLength: fields.ciphertext.length,
    ciphertext: bytesToHex(fields.ciphertext),
    canonicalBytes: bytesToHex(canonical),
    canonicalBlocks: canonical.length / 16,
    hash: bytesToHex(wcOneTimeHash(key, fields))
  };
  if (mask !== null) {
    record.tag = bytesToHex(wcOneTimeTag(key, mask, fields));
  }
  return record;
}

const cases = [];

// Case 1 — hash-only: the unmasked POLYVAL of a two-block ciphertext record.
cases.push(
  smallCase(
    "hash-only",
    "POLYVAL(K, canonical bytes) with no mask applied; every other case is this plus an XOR",
    K1,
    null,
    { pairId: PAIR_ID, direction: 0, sequence: 7, startOffset: 4096, ciphertext: pattern(32, 0x40) }
  )
);

// Case 2 — full-tag: the same record, masked. tag = hash XOR R.
cases.push(
  smallCase(
    "full-tag",
    "same fields as hash-only; tag = hash XOR mask",
    K1,
    R1,
    { pairId: PAIR_ID, direction: 0, sequence: 7, startOffset: 4096, ciphertext: pattern(32, 0x40) }
  )
);

// Case 3 — empty-ciphertext: C = 0. The canonical string is the bare
// 64-byte header (4 blocks), no padding.
cases.push(
  smallCase(
    "empty-ciphertext",
    "C = 0: canonical bytes are exactly the 64-byte header, 4 blocks",
    K1,
    R1,
    { pairId: PAIR_ID, direction: 0, sequence: 8, startOffset: 4128, ciphertext: new Uint8Array(0) }
  )
);

// Case 4 — partial-block: C = 5, so the last block carries 11 bytes of 0x00
// padding. The padding is disambiguated by the authenticated
// ciphertextLength field, never by the padding itself.
cases.push(
  smallCase(
    "partial-block",
    "C = 5: one padded ciphertext block; ciphertextLength (not the padding) fixes the boundary",
    K1,
    R1,
    { pairId: PAIR_ID, direction: 0, sequence: 9, startOffset: 4128, ciphertext: pattern(5, 0xc0) }
  )
);

// Case 5 — max-ciphertext: C = MAX_CIPHERTEXT_BYTES. The ciphertext is too
// large to embed, so it is given by rule: byte i is (i mod 256). 65,540
// blocks — the block count the exact forgery bound in FORMAT-V2.md §5 is
// evaluated at.
{
  const fields = {
    pairId: PAIR_ID,
    direction: 1,
    sequence: 10,
    startOffset: 4133,
    ciphertext: pattern(MAX_CIPHERTEXT_BYTES, 0x00)
  };
  const canonicalLength = 64 + MAX_CIPHERTEXT_BYTES;
  cases.push({
    name: "max-ciphertext",
    note: "C = MAX_CIPHERTEXT_BYTES; ciphertext byte i = i mod 256, not embedded",
    key: bytesToHex(K2),
    mask: bytesToHex(R2),
    pairId: bytesToHex(PAIR_ID),
    direction: fields.direction,
    sequence: fields.sequence,
    startOffset: fields.startOffset,
    ciphertextLength: MAX_CIPHERTEXT_BYTES,
    ciphertextRule: "byte[i] = i mod 256, for i in [0, 1048576)",
    canonicalLength,
    canonicalBlocks: canonicalLength / 16,
    hash: bytesToHex(wcOneTimeHash(K2, fields)),
    tag: bytesToHex(wcOneTimeTag(K2, R2, fields))
  });
}

/* ---- 3. emit -------------------------------------------------------------- */

console.log(
  JSON.stringify(
    {
      command: "node spec/reference/vectors.mjs",
      profile: "wc-one-time-v1",
      construction: "tag = POLYVAL(K, canonical bytes) XOR R (RFC 8452 POLYVAL; FORMAT-V2.md Sections 2 and 6)",
      rfc8452CrossChecks: "passed (asserted before emission)",
      noteOnKeys: "test constants only; the protocol uses each (K, R) for exactly one sequence number",
      cases
    },
    null,
    2
  )
);
