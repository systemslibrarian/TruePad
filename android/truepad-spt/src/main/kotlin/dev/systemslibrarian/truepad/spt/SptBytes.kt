package dev.systemslibrarian.truepad.spt

import java.util.Base64

/* ============================================================================
 * Byte helpers for the SPT wire — big-endian integers and canonical unpadded
 * base64url. Byte-exact twin of the parts of src/spt/bytes.ts the wire needs.
 * ========================================================================= */

internal fun concat(vararg arrays: ByteArray): ByteArray {
    val out = ByteArray(arrays.sumOf { it.size })
    var at = 0
    for (a in arrays) {
        System.arraycopy(a, 0, out, at, a.size)
        at += a.size
    }
    return out
}

internal fun bytesEqual(a: ByteArray, b: ByteArray): Boolean = a.contentEquals(b)

internal fun asciiBytes(s: String): ByteArray {
    // The domain separators and the TPR2 prefix are ASCII; encode as one byte
    // per char, matching the TS asciiBytes (which asserts code points < 128).
    val out = ByteArray(s.length)
    for (i in s.indices) {
        val c = s[i].code
        require(c < 0x80) { "asciiBytes: non-ASCII char at $i" }
        out[i] = c.toByte()
    }
    return out
}

internal fun writeUint16BE(buf: ByteArray, offset: Int, value: Int) {
    buf[offset] = ((value ushr 8) and 0xFF).toByte()
    buf[offset + 1] = (value and 0xFF).toByte()
}

internal fun readUint16BE(buf: ByteArray, offset: Int): Int =
    ((buf[offset].toInt() and 0xFF) shl 8) or (buf[offset + 1].toInt() and 0xFF)

/** Write a 64-bit big-endian value. `value` is a non-negative Long (the wire
 *  never needs more than MAX_PLAINTEXT_BYTES, which fits comfortably). */
internal fun writeUint64BE(buf: ByteArray, offset: Int, value: Long) {
    for (i in 0 until 8) {
        buf[offset + i] = ((value ushr (8 * (7 - i))) and 0xFF).toByte()
    }
}

/** Read a 64-bit big-endian value. Returns the exact value as a Long ONLY when
 *  it fits in a non-negative Long; a value with the top bit set (>= 2^63) would
 *  overflow, so callers must range-check separately. Here the high 4 bytes being
 *  non-zero already exceeds MAX_PLAINTEXT_BYTES; we surface that as a very large
 *  Long by clamping to Long.MAX_VALUE so the caller's range check refuses it. */
internal fun readUint64BE(buf: ByteArray, offset: Int): Long {
    var high = 0
    for (i in 0 until 4) high = high or (buf[offset + i].toInt() and 0xFF)
    if (high != 0) return Long.MAX_VALUE // beyond any plaintext length we accept
    var low = 0L
    for (i in 4 until 8) low = (low shl 8) or (buf[offset + i].toLong() and 0xFF)
    return low
}

private val B64URL_ALPHABET = Regex("^[A-Za-z0-9_-]*$")

internal fun isBase64UrlAlphabet(text: String): Boolean = B64URL_ALPHABET.matches(text)

/** Canonical UNPADDED base64url (RFC 4648 §5), matching src/spt/bytes.ts. */
internal fun toBase64Url(bytes: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

/** Decode canonical unpadded base64url. Returns null on any non-alphabet input
 *  or a decode failure. The CANONICAL check (re-encode and compare) is the
 *  caller's, exactly as in the TS decoder. */
internal fun fromBase64Url(text: String): ByteArray? {
    if (!isBase64UrlAlphabet(text)) return null
    return try {
        Base64.getUrlDecoder().decode(text)
    } catch (_: IllegalArgumentException) {
        null
    }
}
