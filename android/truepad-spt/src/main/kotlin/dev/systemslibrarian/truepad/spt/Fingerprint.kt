package dev.systemslibrarian.truepad.spt

import java.math.BigInteger
import java.security.MessageDigest

/* ============================================================================
 * Domain-separated hashing, requestHash, and the two word renderings.
 * Byte-exact twin of src/spt/fingerprint.ts (§6.2, §6.3, §8.2).
 *
 *   H_ds(DS, X) = SHA-256( uint8(len(DS)) ‖ DS ‖ X )   — the length is MEASURED.
 * ========================================================================= */

/** `uint8(len(DS)) ‖ DS`, length measured and asserted into 1..255. The HKDF
 *  `info` strings are built with the SAME builder so they cannot drift. */
internal fun domainPrefix(separator: String): ByteArray {
    val ds = asciiBytes(separator)
    require(ds.size in 1..255) { "domain separator length ${ds.size} outside 1..255" }
    return concat(byteArrayOf(ds.size.toByte()), ds)
}

private fun sha256(input: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(input)

/** H_ds(DS, X). One SHA-256 over the measured-prefix ‖ payload. */
internal fun hashDomain(separator: String, payload: ByteArray): ByteArray =
    sha256(concat(domainPrefix(separator), payload))

/** requestHash = H_ds(DS_REQUEST_FP, canonicalRequestBody) over the COMPLETE
 *  1235-byte body, never a subset. */
fun requestFingerprint(canonicalRequestBody: ByteArray): ByteArray = hashDomain(DS_REQUEST_FP, canonicalRequestBody)

private val MASK_11 = BigInteger.valueOf(0x7ff)

/** §6.3. requestHash[0..17) as a big-endian 136-bit integer, low 4 bits
 *  discarded, the remaining 132 split into twelve 11-bit indices, MSB first —
 *  shifts 121,110,…,11,0. BigInteger throughout: Long arithmetic would drop the
 *  high limbs of a 136-bit value silently. */
fun requestIndices132(requestHash: ByteArray): IntArray {
    require(requestHash.size >= 17) { "requestIndices132: expected at least 17 bytes, got ${requestHash.size}" }
    var n = BigInteger.ZERO
    for (i in 0 until 17) n = n.shiftLeft(8).or(BigInteger.valueOf((requestHash[i].toInt() and 0xFF).toLong()))
    val m = n.shiftRight(4)
    return IntArray(REQUEST_WORDS_COUNT) { i -> m.shiftRight(121 - 11 * i).and(MASK_11).toInt() }
}

/** §8.2. confirmValue[0..11) as a big-endian 88-bit integer split into eight
 *  11-bit indices, shifts 77,66,…,11,0. Nothing discarded: 88 = 8 × 11. */
fun confirmationIndices88(confirmValue: ByteArray): IntArray {
    require(confirmValue.size >= CONFIRM_VALUE_BYTES) {
        "confirmationIndices88: expected at least $CONFIRM_VALUE_BYTES bytes, got ${confirmValue.size}"
    }
    var n = BigInteger.ZERO
    for (i in 0 until CONFIRM_VALUE_BYTES) n = n.shiftLeft(8).or(BigInteger.valueOf((confirmValue[i].toInt() and 0xFF).toLong()))
    return IntArray(CONFIRM_WORDS_COUNT) { i -> n.shiftRight(77 - 11 * i).and(MASK_11).toInt() }
}
