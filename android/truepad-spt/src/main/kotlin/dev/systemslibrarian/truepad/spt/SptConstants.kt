package dev.systemslibrarian.truepad.spt

/* ============================================================================
 * Sealed Pad Transfer v1 — frozen constants (byte-exact twin of src/spt/constants.ts)
 * ----------------------------------------------------------------------------
 * Every value is normative in docs/SEALED-PAD-TRANSFER.md. Nothing here may be
 * "improved": a different byte is a different protocol, and suite 0x0001 is
 * defined by that document. The domain-separator LENGTHS are MEASURED at use
 * (see Fingerprint.domainPrefix), never written down — a wrong length octet does
 * not fail loudly, it silently forks requestHash between conforming builds.
 * ========================================================================= */

const val TRANSFER_VERSION = 0x01
const val SUITE_ID = 0x0001

const val TPR2_PREFIX = "TPR2:"
const val TPS2_MAGIC = "TPS2"
val TPS2_MAGIC_BYTES = byteArrayOf(0x54, 0x50, 0x53, 0x32)

// Domain separators (§6.2). The counts are INFORMATIVE; the byte length is
// measured at runtime and prefixed as one octet.
const val DS_REQUEST_FP = "TruePad/SPT/v1/request-fingerprint" //   34
const val DS_AEAD_KEY = "TruePad/SPT/v1/aead-key" //                23
const val DS_CONFIRM = "TruePad/SPT/v1/transfer-confirmation" //    36
const val DS_NONCE = "TruePad/SPT/v1/aead-nonce" //                 25
const val DS_PAD = "TruePad/SPT/v1/pad-commitment" //              29

// X-Wing suite 0x0001 sizes (§2.2) — the ML-KEM/X25519 split constants.
const val MLKEM_PUBLIC_KEY_BYTES = 1184
const val MLKEM_CIPHERTEXT_BYTES = 1088
const val X25519_BYTES = 32

// TPR2 — the receive request (§5.1, §5.2).
const val REQUEST_ID_BYTES = 16
const val TPR2_BODY_BYTES = 1235 // 1 + 2 + 16 + 1216
const val TPR2_TEXT_CHARS = 1652 // 5 prefix + ceil(1235 * 4 / 3)

// TPS2 — the sealed package (§7.1).
const val REQUEST_HASH_BYTES = 32
const val AEAD_NONCE_BYTES = 12
const val AEAD_TAG_BYTES = 16
const val AEAD_KEY_BYTES = 32
const val TPS2_HEADER_BYTES = 1195 // 4+1+2+16+32+1120+12+8 — also the AAD
const val TPS2_FIXED_OVERHEAD_BYTES = 1211 // header + tag
const val MAX_PLAINTEXT_BYTES = 16_777_216 // 16 MiB

// Field offsets into the TPS2 header, half-open [start, end).
object Tps2Offsets {
    const val MAGIC = 0
    const val VERSION = 4
    const val SUITE = 5
    const val REQUEST_ID = 7
    const val REQUEST_HASH = 23
    const val KEM_CIPHERTEXT = 55
    const val NONCE = 1175
    const val PLAINTEXT_LENGTH = 1187
    const val CIPHERTEXT = 1195
}

// Safety-word renderings (§6.3, §8.2).
const val REQUEST_WORDS_COUNT = 12
const val REQUEST_WORDS_BITS = 132
const val CONFIRM_WORDS_COUNT = 8
const val CONFIRM_WORDS_BITS = 88
const val CONFIRM_VALUE_BYTES = 11
const val WORDLIST_SIZE = 2048
