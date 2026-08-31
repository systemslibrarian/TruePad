/* ============================================================================
 * Sealed Pad Transfer v1 — frozen constants
 * ----------------------------------------------------------------------------
 * Every value here is normative in docs/SEALED-PAD-TRANSFER.md. Nothing in this
 * file may be "improved": a different byte here is a different protocol, and
 * suite 0x0001 is defined by that document rather than by this code.
 *
 * The domain-separator LENGTHS are computed, never written down. §6.2 states
 * the rule and says why: a wrong length octet does not fail loudly, it silently
 * forks requestHash — and therefore the safety words, the HKDF salt, and AAD
 * bytes [23, 55) — between two conforming builds, producing exactly the symptom
 * of an active attack. For DS_PAD it is worse still, because padHash never
 * reaches the wire, so two builds would derive different nonces for the same
 * pad and every package would still verify. The document records that this
 * mistake has been made twice; the counts below are asserted by tests against
 * the measured strings, and appear here only as comments.
 * ========================================================================= */

export const TRANSFER_VERSION = 0x01;
export const SUITE_ID = 0x0001;

export const TPR2_PREFIX = "TPR2:";
export const TPS2_MAGIC = "TPS2";
export const TPS2_MAGIC_BYTES = Uint8Array.from([0x54, 0x50, 0x53, 0x32]);

/* ---- domain separators (§6.2) --------------------------------------------
 * The parenthesised counts are INFORMATIVE. constants.test.ts asserts each
 * against the measured UTF-8 length; no code path reads them.
 */
export const DS_REQUEST_FP = "TruePad/SPT/v1/request-fingerprint"; /*    34 */
export const DS_AEAD_KEY = "TruePad/SPT/v1/aead-key"; /*                 23 */
export const DS_CONFIRM = "TruePad/SPT/v1/transfer-confirmation"; /*     36 */
export const DS_NONCE = "TruePad/SPT/v1/aead-nonce"; /*                  25 */
export const DS_PAD = "TruePad/SPT/v1/pad-commitment"; /*                29 */

/* ---- X-Wing suite 0x0001 sizes (§2.2) ----------------------------------- */
export const XWING_SEED_BYTES = 32;
export const XWING_PUBLIC_KEY_BYTES = 1216;
export const XWING_CIPHERTEXT_BYTES = 1120;
export const XWING_SHARED_SECRET_BYTES = 32;
export const XWING_ESEED_BYTES = 64;
/** ML-KEM-768 halves of the concatenations, for the split checks. */
export const MLKEM_PUBLIC_KEY_BYTES = 1184;
export const MLKEM_CIPHERTEXT_BYTES = 1088;
export const X25519_BYTES = 32;

/* ---- TPR2 — the receive request (§5.1, §5.2) ---------------------------- */
export const REQUEST_ID_BYTES = 16;
export const TPR2_BODY_BYTES = 1235; // 1 + 2 + 16 + 1216
export const TPR2_TEXT_CHARS = 1652; // 5 prefix + ceil(1235 * 4 / 3)

/* ---- TPS2 — the sealed package (§7.1) ----------------------------------- */
export const REQUEST_HASH_BYTES = 32;
export const AEAD_NONCE_BYTES = 12;
export const AEAD_TAG_BYTES = 16;
export const AEAD_KEY_BYTES = 32;
export const TPS2_HEADER_BYTES = 1195; // 4+1+2+16+32+1120+12+8 — also the AAD
export const TPS2_FIXED_OVERHEAD_BYTES = 1211; // header + tag
export const MAX_PLAINTEXT_BYTES = 16_777_216; // 16 MiB

/** Field offsets into the TPS2 header, half-open [start, end). */
export const TPS2_OFFSETS = Object.freeze({
  magic: 0,
  version: 4,
  suite: 5,
  requestId: 7,
  requestHash: 23,
  kemCiphertext: 55,
  nonce: 1175,
  plaintextLength: 1187,
  ciphertext: 1195
});

/* ---- safety-word renderings (§6.3, §8.2) -------------------------------- */
export const REQUEST_WORDS_COUNT = 12;
export const REQUEST_WORDS_BITS = 132;
export const CONFIRM_WORDS_COUNT = 8;
export const CONFIRM_WORDS_BITS = 88;
export const CONFIRM_VALUE_BYTES = 11;
export const WORDLIST_SIZE = 2048;
