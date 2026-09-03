package dev.systemslibrarian.truepad.core

/*
 * wc-one-time-v1 — canonical bytes, hash, tag. Byte-exact twin of
 * src/core/wc-one-time.ts.
 *
 *   tag = POLYVAL(K_s, canonical bytes) XOR R_s
 *
 * Canonical bytes (§6.1): a fixed 64-byte header (domain separator, pairId,
 * formatVersion, direction, reserved zeros, sequence, startOffset,
 * ciphertextLength — all u64 LE), then the ciphertext, then 0x00 padding to a
 * 16-byte boundary. Tags are computed over these bytes and NEVER over JSON.
 */

// §4: the one v2 ciphertext ceiling.
const val MAX_CIPHERTEXT_BYTES: Int = 1_048_576

// §8 defaults.
const val MAX_AUTH_LOOKAHEAD_DEFAULT: Int = 64
const val VERIFY_ATTEMPT_LIMIT_DEFAULT: Int = 8
const val FREEZE_THRESHOLD_DEFAULT: Int = 32

// §1.2/§7: one auth record is K (16 bytes) then R (16 bytes).
const val AUTH_RECORD_BYTES: Int = 32

// §2.2: 128-bit tags are the only v2 width.
const val TAG_BYTES: Int = 16

// §6.1: the fixed-width canonical header preceding the ciphertext.
const val CANONICAL_HEADER_BYTES: Int = 64

// §2.2: canonical block 1 — ASCII "wc-one-time-v1" then two 0x00 bytes.
val DOMAIN_SEPARATOR: ByteArray = byteArrayOf(
    0x77, 0x63, 0x2d, 0x6f, 0x6e, 0x65, 0x2d, 0x74,
    0x69, 0x6d, 0x65, 0x2d, 0x76, 0x31, 0x00, 0x00,
)

/** The authenticated fields, post-parse: raw bytes and in-domain numbers. */
class CanonicalFields(
    val pairId: ByteArray, // exactly 16 bytes
    val direction: Direction,
    val sequence: Long, // >= 0
    val startOffset: Long, // >= 0
    val ciphertext: ByteArray, // length <= MAX_CIPHERTEXT_BYTES
)

/** Write a non-negative value as 8 little-endian bytes at `out[off..off+8)`. */
private fun u64le(out: ByteArray, off: Int, value: Long, name: String) {
    require(value >= 0) { "$name must be non-negative, not $value" }
    for (i in 0 until 8) out[off + i] = ((value ushr (8 * i)) and 0xFF).toByte()
}

/** The exact byte string tags are computed over: the §6.1 layout, byte for byte. */
fun canonicalBytes(fields: CanonicalFields): ByteArray {
    require(fields.pairId.size == 16) { "pairId is exactly 16 bytes, not ${fields.pairId.size}" }
    require(fields.ciphertext.size <= MAX_CIPHERTEXT_BYTES) {
        "ciphertext of ${fields.ciphertext.size} bytes exceeds MAX_CIPHERTEXT_BYTES = $MAX_CIPHERTEXT_BYTES"
    }
    val padded = ((fields.ciphertext.size + 15) / 16) * 16
    val out = ByteArray(CANONICAL_HEADER_BYTES + padded) // trailing bytes already 0x00
    System.arraycopy(DOMAIN_SEPARATOR, 0, out, 0, 16)
    System.arraycopy(fields.pairId, 0, out, 16, 16)
    out[32] = 0x02 // formatVersion
    out[33] = fields.direction.canonicalByte.toByte()
    // bytes 34..39 reserved, stay 0x00
    u64le(out, 40, fields.sequence, "sequence")
    u64le(out, 48, fields.startOffset, "startOffset")
    u64le(out, 56, fields.ciphertext.size.toLong(), "ciphertextLength")
    System.arraycopy(fields.ciphertext, 0, out, CANONICAL_HEADER_BYTES, fields.ciphertext.size)
    return out
}

/** The unmasked hash: POLYVAL(K, canonical bytes). Not a tag — never emit it. */
fun wcHash(key: ByteArray, fields: CanonicalFields): ByteArray = polyval(key, canonicalBytes(fields))

/** The tag: POLYVAL(K, canonical bytes) XOR R. */
fun wcTag(key: ByteArray, mask: ByteArray, fields: CanonicalFields): ByteArray {
    require(mask.size == TAG_BYTES) { "the mask R is exactly $TAG_BYTES bytes, not ${mask.size}" }
    val hash = wcHash(key, fields)
    val tag = ByteArray(TAG_BYTES)
    for (i in 0 until TAG_BYTES) tag[i] = (hash[i].toInt() xor mask[i].toInt()).toByte()
    return tag
}

/**
 * Tag comparison without a byte-position-dependent early return: one pass with
 * an OR-accumulator, one comparison at the end. Non-16-byte inputs are false up
 * front. The claim is scoped honestly (twin of tagsEqual in wc-one-time.ts): a
 * JVM/ART engine makes true constant-time unprovable; this guarantees the shape
 * (no early exit inside the loop), not a cycle count.
 */
fun tagsEqual(a: ByteArray, b: ByteArray): Boolean {
    if (a.size != TAG_BYTES || b.size != TAG_BYTES) return false
    var diff = 0
    for (i in 0 until TAG_BYTES) diff = diff or (a[i].toInt() xor b[i].toInt())
    return diff == 0
}
