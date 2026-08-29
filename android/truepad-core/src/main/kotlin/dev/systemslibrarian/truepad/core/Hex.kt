package dev.systemslibrarian.truepad.core

/*
 * TruePad hex codec — the byte-exact Kotlin twin of src/core/hex.ts.
 *
 * v2 pins ONE wire spelling for bytes: lowercase hex, two characters per byte
 * (FORMAT-V2.md §6.2). [bytesToHex] emits exactly that; [hexToBytes] accepts
 * exactly `^(?:[0-9a-f]{2})*$` and nothing else — uppercase, odd length,
 * whitespace, and 0x prefixes are refused as null, never normalized.
 */

private val HEX_DIGITS = "0123456789abcdef".toCharArray()

fun bytesToHex(bytes: ByteArray): String {
    val sb = StringBuilder(bytes.size * 2)
    for (b in bytes) {
        val v = b.toInt() and 0xFF
        sb.append(HEX_DIGITS[v ushr 4])
        sb.append(HEX_DIGITS[v and 0x0F])
    }
    return sb.toString()
}

/** Strict inverse of [bytesToHex]. Returns null for anything outside the grammar. */
fun hexToBytes(hex: String): ByteArray? {
    if (hex.length % 2 != 0) return null
    val out = ByteArray(hex.length / 2)
    var i = 0
    while (i < hex.length) {
        val hi = hexNibble(hex[i]) ?: return null
        val lo = hexNibble(hex[i + 1]) ?: return null
        out[i / 2] = ((hi shl 4) or lo).toByte()
        i += 2
    }
    return out
}

private fun hexNibble(c: Char): Int? = when (c) {
    in '0'..'9' -> c - '0'
    in 'a'..'f' -> c - 'a' + 10
    else -> null // uppercase A-F included: refused, never normalized
}
