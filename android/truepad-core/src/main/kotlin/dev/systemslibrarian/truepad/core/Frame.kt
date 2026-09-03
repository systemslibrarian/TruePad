package dev.systemslibrarian.truepad.core

/*
 * TruePad v2 fixed-size record frame — byte-exact twin of src/core/frame2.ts.
 *
 *   frame = plaintextLength (u32 LE) || plaintext || 0x00 padding, exactly F bytes
 *
 * Plaintext capacity per record is F − 4. The length prefix is recovered only
 * after the tag verifies and the record commits (§16.2); the padding is 0x00
 * with no other meaning and is never inspected on parse.
 */

private const val LENGTH_PREFIX_BYTES = 4

fun frameCapacity(recordBytes: Int): Int = recordBytes - LENGTH_PREFIX_BYTES

/** Build the exactly-F-byte frame: u32 LE length prefix, plaintext, 0x00 padding. */
fun buildFrame(plaintext: ByteArray, recordBytes: Int): ByteArray {
    require(recordBytes >= LENGTH_PREFIX_BYTES) {
        "buildFrame: recordBytes $recordBytes must be >= $LENGTH_PREFIX_BYTES"
    }
    val capacity = recordBytes - LENGTH_PREFIX_BYTES
    require(plaintext.size <= capacity) {
        "buildFrame: plaintext is ${plaintext.size} bytes but a $recordBytes-byte record holds at most $capacity (F-4)"
    }
    val frame = ByteArray(recordBytes)
    val len = plaintext.size
    frame[0] = (len and 0xFF).toByte()
    frame[1] = ((len ushr 8) and 0xFF).toByte()
    frame[2] = ((len ushr 16) and 0xFF).toByte()
    frame[3] = ((len ushr 24) and 0xFF).toByte()
    System.arraycopy(plaintext, 0, frame, LENGTH_PREFIX_BYTES, plaintext.size)
    return frame
}

/**
 * Recover the plaintext from a decrypted frame: a COPY of the bytes the prefix
 * selects, or null when the length field exceeds F − 4 (a value no conforming
 * sender writes). The padding after the plaintext is not examined.
 */
fun parseFrame(frame: ByteArray): ByteArray? {
    if (frame.size < LENGTH_PREFIX_BYTES) return null
    val declared = (frame[0].toLong() and 0xFF) or
        ((frame[1].toLong() and 0xFF) shl 8) or
        ((frame[2].toLong() and 0xFF) shl 16) or
        ((frame[3].toLong() and 0xFF) shl 24) // u32 LE, as an unsigned value
    if (declared > (frame.size - LENGTH_PREFIX_BYTES).toLong()) return null
    return frame.copyOfRange(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + declared.toInt())
}
