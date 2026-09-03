package dev.systemslibrarian.truepad.spt

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

/**
 * The comparison wordlist is conformance-critical: the confirmation ceremony is
 * only meaningful if an Android build and the Browser Edition render the SAME
 * word for the same 11-bit index. This pins the vendored bytes and the shape so
 * a divergence fails the build instead of silently making two conforming devices
 * disagree about a fingerprint they both display as "correct".
 */
class ComparisonWordsTest {

    /** The SHA-256 recorded in COMPARISON-WORDS-PROVENANCE.md (upstream
     *  bitcoin/bips bip-0039/english.txt, 13116 bytes, 2048 lines). */
    private val PINNED_SHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"

    @Test
    fun theVendoredResourceMatchesItsPinnedHash() {
        val bytes = ComparisonWords::class.java.getResourceAsStream("/comparison-words.txt")!!
            .use { it.readBytes() }
        assertEquals("the vendored wordlist is 13116 bytes", 13116, bytes.size)
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val hex = digest.joinToString("") { "%02x".format(it) }
        assertEquals("the vendored wordlist must match its pinned SHA-256", PINNED_SHA256, hex)
    }

    @Test
    fun theListHasExactlyTheProtocolShape() {
        val w = ComparisonWords.words
        assertEquals("exactly 2048 words", 2048, w.size)
        assertEquals("index 0", "abandon", w[0])
        assertEquals("index 1", "ability", w[1])
        assertEquals("index 2047", "zoo", w[2047])
        assertEquals("all words are unique", w.size, w.toSet().size)
        assertTrue("all words are lowercase ASCII letters", w.all { it.isNotEmpty() && it.all { c -> c in 'a'..'z' } })
    }

    @Test
    fun wordsForRendersIndicesInOrder() {
        assertEquals(
            listOf("zoo", "abandon", "ability"),
            ComparisonWords.wordsFor(intArrayOf(2047, 0, 1)),
        )
    }

    @Test
    fun anOutOfRangeIndexIsRefused() {
        for (bad in listOf(-1, 2048, 9999)) {
            try {
                ComparisonWords.wordAt(bad)
                error("index $bad should have been refused")
            } catch (_: IllegalArgumentException) {
                // expected
            }
        }
    }
}
