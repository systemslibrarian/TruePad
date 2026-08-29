package dev.systemslibrarian.truepad.core

/*
 * TruePad GF(2^128) / POLYVAL — the byte-exact Kotlin twin of src/core/gf128.ts.
 *
 * POLYVAL exactly as RFC 8452 §3, every constant pinned by FORMAT-V2.md §2.2:
 *   - field GF(2^128) by x^128 + x^127 + x^126 + x^121 + 1;
 *   - little-endian in bytes AND bits: the least significant bit of the first
 *     byte is the coefficient of x^0, so a field element as a 128-bit integer
 *     is a little-endian read of its 16 bytes;
 *   - dot(a,b) = a·b·x^-128, with x^-128 = x^127 + x^124 + x^121 + x^114 + 1;
 *   - S_0 = 0; S_j = dot(S_{j-1} XOR X_j, H); result S_m.
 *
 * A field element is a 128-bit value held as two Longs — (lo, hi), each read as
 * an UNSIGNED little-endian u64. This is a FIXED-WIDTH implementation with an
 * explicit bit-serial multiply and a fixed 128-iteration loop, deliberately NOT
 * a BigInteger port: BigInteger's sign/representation would add ambiguity and a
 * data-dependent iteration count. Like the TS reference, the multiply branches
 * on the KEY's bits, so this makes NO timing claim (FORMAT-V2.md §5 / the TS
 * header); the one-time mask R protects the tag VALUE, nothing about timing.
 *
 * A 128-bit value is (lo, hi): bit i (0..63) is bit i of `lo`; bit i (64..127)
 * is bit i-64 of `hi`. "Bit 128" of an intermediate is the carry out of hi's
 * bit 63.
 */
internal object Gf128 {
    // The reduction polynomial x^128 mod field = x^127 + x^126 + x^121 + 1,
    // as the low-128-bit value to XOR when a shift pushes a bit past bit 127.
    //   x^0   -> lo bit 0
    //   x^121 -> hi bit 57 ; x^126 -> hi bit 62 ; x^127 -> hi bit 63
    private const val POLY_LO = 1L
    private const val POLY_HI = (1L shl 63) or (1L shl 62) or (1L shl 57)

    // x^-128 = x^127 + x^124 + x^121 + x^114 + 1.
    //   x^0 -> lo bit 0 ; x^114 -> hi 50 ; x^121 -> hi 57 ; x^124 -> hi 60 ; x^127 -> hi 63
    private const val XNEG_LO = 1L
    private const val XNEG_HI = (1L shl 63) or (1L shl 60) or (1L shl 57) or (1L shl 50)

    fun bytesToFieldLo(b: ByteArray, off: Int): Long {
        var lo = 0L
        for (i in 0 until 8) lo = lo or ((b[off + i].toLong() and 0xFF) shl (8 * i))
        return lo
    }

    fun bytesToFieldHi(b: ByteArray, off: Int): Long {
        var hi = 0L
        for (i in 0 until 8) hi = hi or ((b[off + 8 + i].toLong() and 0xFF) shl (8 * i))
        return hi
    }

    fun fieldToBytes(lo: Long, hi: Long): ByteArray {
        val out = ByteArray(16)
        for (i in 0 until 8) out[i] = ((lo ushr (8 * i)) and 0xFF).toByte()
        for (i in 0 until 8) out[8 + i] = ((hi ushr (8 * i)) and 0xFF).toByte()
        return out
    }

    // Product of two field elements, bit-serial, mirroring gfMul in gf128.ts:
    // for each iteration i in 0..127, if bit i of b is set accumulate the running
    // a·x^i, then multiply the running value by x (shift left, reduce on overflow).
    fun mul(aLo: Long, aHi: Long, bLo: Long, bHi: Long): LongArray {
        var resLo = 0L
        var resHi = 0L
        var shLo = aLo
        var shHi = aHi
        for (i in 0 until 128) {
            val bit = if (i < 64) (bLo ushr i) and 1L else (bHi ushr (i - 64)) and 1L
            if (bit == 1L) {
                resLo = resLo xor shLo
                resHi = resHi xor shHi
            }
            // shifted <<= 1 across the 128-bit value; carry = old bit 127
            val carry = (shHi ushr 63) and 1L
            shHi = (shHi shl 1) or (shLo ushr 63)
            shLo = shLo shl 1
            if (carry == 1L) { // shifted had bit 128 -> reduce mod POLY
                shLo = shLo xor POLY_LO
                shHi = shHi xor POLY_HI
            }
        }
        return longArrayOf(resLo, resHi)
    }

    // dot(a, b) = a · b · x^-128 (RFC 8452 §3).
    fun dot(aLo: Long, aHi: Long, bLo: Long, bHi: Long): LongArray {
        val ab = mul(aLo, aHi, bLo, bHi)
        return mul(ab[0], ab[1], XNEG_LO, XNEG_HI)
    }
}

/**
 * POLYVAL(H, X_1..X_m): S_0 = 0; S_j = dot(S_{j-1} XOR X_j, H). `message` must be
 * a whole number of 16-byte blocks (the canonical encoding never produces else).
 */
fun polyval(h: ByteArray, message: ByteArray): ByteArray {
    require(h.size == 16) { "POLYVAL key H is exactly 16 bytes, not ${h.size}" }
    require(message.size % 16 == 0) {
        "POLYVAL input must be a whole number of 16-byte blocks, not ${message.size} bytes"
    }
    val hLo = Gf128.bytesToFieldLo(h, 0)
    val hHi = Gf128.bytesToFieldHi(h, 0)
    var sLo = 0L
    var sHi = 0L
    var off = 0
    while (off < message.size) {
        val bLo = Gf128.bytesToFieldLo(message, off)
        val bHi = Gf128.bytesToFieldHi(message, off)
        val d = Gf128.dot(sLo xor bLo, sHi xor bHi, hLo, hHi)
        sLo = d[0]
        sHi = d[1]
        off += 16
    }
    return Gf128.fieldToBytes(sLo, sHi)
}
