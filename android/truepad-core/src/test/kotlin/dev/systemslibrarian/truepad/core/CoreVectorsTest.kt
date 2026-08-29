package dev.systemslibrarian.truepad.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * The frozen FORMAT-V2 §11 wc-one-time-v1 vector, reproduced through the Kotlin
 * core. These EXACT values also appear in tests/browser-interop.test.ts and
 * docs/FORMAT-V2.md §11, so a match here pins the Kotlin port to the same frozen
 * construction the CLI and Browser Edition use. Any mismatch is a release blocker.
 */
class CoreVectorsTest {
    private fun h(s: String): ByteArray = hexToBytes(s) ?: error("bad hex fixture: $s")

    private val fields = CanonicalFields(
        pairId = h("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf"),
        direction = Direction.A_TO_B,
        sequence = 7,
        startOffset = 4096,
        ciphertext = h("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"),
    )
    private val key = h("000102030405060708090a0b0c0d0e0f")
    private val mask = h("101112131415161718191a1b1c1d1e1f")

    @Test
    fun canonicalBytesMatchesSection11() {
        assertEquals(
            "77632d6f6e652d74696d652d76310000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf" +
                "0200000000000000070000000000000000100000000000002000000000000000" +
                "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
            bytesToHex(canonicalBytes(fields)),
        )
    }

    @Test
    fun wcHashMatchesSection11() {
        assertEquals("4ba90e0dd06af1497c869bc334117ac6", bytesToHex(wcHash(key, fields)))
    }

    @Test
    fun wcTagMatchesSection11() {
        assertEquals("5bb81c1ec47fe75e649f81d8280c64d9", bytesToHex(wcTag(key, mask, fields)))
    }

    @Test
    fun emptyCiphertextIsExactlyTheHeader() {
        val empty = CanonicalFields(h("00".repeat(16)), Direction.A_TO_B, 0, 0, ByteArray(0))
        assertEquals(CANONICAL_HEADER_BYTES, canonicalBytes(empty).size)
    }

    @Test
    fun partialBlockPadsToSixteen() {
        // 1 ciphertext byte -> header(64) + one padded block(16).
        val oneByte = CanonicalFields(h("00".repeat(16)), Direction.A_TO_B, 0, 0, byteArrayOf(0xAB.toByte()))
        val cb = canonicalBytes(oneByte)
        assertEquals(CANONICAL_HEADER_BYTES + 16, cb.size)
        assertEquals(0xAB.toByte(), cb[CANONICAL_HEADER_BYTES])
        for (i in CANONICAL_HEADER_BYTES + 1 until cb.size) assertEquals(0.toByte(), cb[i])
    }

    @Test
    fun directionByteAndAllZeroKeyHashesToZero() {
        val ba = CanonicalFields(h("00".repeat(16)), Direction.B_TO_A, 1, 2, ByteArray(0))
        assertEquals(0x01.toByte(), canonicalBytes(ba)[33])
        // POLYVAL under an all-zero key hashes everything to zero (a fact the §5
        // bound prices; not a state the format manufactures).
        assertArrayEquals(ByteArray(16), wcHash(h("00".repeat(16)), ba))
    }

    @Test
    fun frameRoundTripsAndRejectsOversizePrefix() {
        val f = buildFrame("hi".toByteArray(), 64)
        assertEquals(64, f.size)
        assertArrayEquals("hi".toByteArray(), parseFrame(f))
        // A length prefix past F-4 cannot come from a conforming sender -> null.
        val bad = ByteArray(64)
        bad[0] = 0xFF.toByte(); bad[1] = 0xFF.toByte()
        assertNull(parseFrame(bad))
    }

    @Test
    fun hexIsStrictLowercase() {
        assertArrayEquals(byteArrayOf(0x0a, 0xbc.toByte()), hexToBytes("0abc"))
        assertNull(hexToBytes("0ABC")) // uppercase refused
        assertNull(hexToBytes("abc")) // odd length refused
        assertEquals("0abc", bytesToHex(byteArrayOf(0x0a, 0xbc.toByte())))
    }

    @Test
    fun tagsEqualIsShapeConstant() {
        assertTrue(tagsEqual(h("00".repeat(16)), h("00".repeat(16))))
        assertFalse(tagsEqual(h("00".repeat(16)), h("01" + "00".repeat(15))))
        assertFalse(tagsEqual(ByteArray(15), ByteArray(16)))
    }

    @Test
    fun combinerIsUnconditionalIncludingAllZero() {
        // Two identical sources XOR to all zeros — a legitimate draw, never rejected.
        val src = h("11".repeat(32))
        val combined = combineSources(listOf(src.copyOf(), src.copyOf()), 32)
        assertArrayEquals(ByteArray(32), combined)
    }
}
