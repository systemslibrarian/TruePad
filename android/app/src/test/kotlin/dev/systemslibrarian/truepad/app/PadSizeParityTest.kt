package dev.systemslibrarian.truepad.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * SMALL, MEDIUM AND LARGE MEAN THE SAME THING IN EVERY EDITION.
 *
 * They did not. This edition shipped Small 16 KB/128, Medium 64 KB/512 and Large
 * 256 KB/2048 while Browser and iOS used 16384/64, 262144/512 and 4194304/4096 —
 * so two people who both chose "Medium" got pads of different capacities
 * depending on which app they were holding. Nothing was unsafe about it; the
 * product simply meant two things by one word.
 *
 * The presets are convenience defaults: they write E and N and nothing else. What
 * this file protects is the PRODUCT RULE that the three names carry one meaning.
 *
 * Two assertions, deliberately both:
 *
 *   1. The values are pinned literally, so the intended contract is readable
 *      here without opening another edition.
 *   2. They are ALSO read out of the Browser Edition's own source, so drift in
 *      EITHER direction fails — pinning alone would let Browser move and leave
 *      Android quietly "correct" against a stale constant.
 *
 * This is a TEST reading another edition's source. No runtime Android code
 * depends on the browser tree.
 */
class PadSizeParityTest {

    /** The module directory is the working directory for these tests. */
    private val repoRoot = File("../..")

    private data class Canonical(val bytes: Long, val records: Long)

    private val canonical = mapOf(
        "small" to Canonical(16_384, 64),
        "medium" to Canonical(262_144, 512),
        "large" to Canonical(4_194_304, 4_096),
    )

    @Test
    fun `the presets carry the canonical cross-edition capacities`() {
        assertEquals(canonical["small"]!!.bytes, PadSize.Small.encryptionBytes)
        assertEquals(canonical["small"]!!.records, PadSize.Small.authRecords)
        assertEquals(canonical["medium"]!!.bytes, PadSize.Medium.encryptionBytes)
        assertEquals(canonical["medium"]!!.records, PadSize.Medium.authRecords)
        assertEquals(canonical["large"]!!.bytes, PadSize.Large.encryptionBytes)
        assertEquals(canonical["large"]!!.records, PadSize.Large.authRecords)
        assertEquals(3, PadSize.entries.size)
    }

    /**
     * AND THE BROWSER EDITION STILL AGREES. Read from its actual source, so this
     * fails if either side moves.
     */
    @Test
    fun `the Browser Edition declares the same three presets`() {
        val source = File(repoRoot, "src/browser/ui/create-pair.ts")
        assertTrue("the Browser create screen is not where this test expects it: $source",
                   source.isFile)
        val text = source.readText()

        var matched = 0
        for (size in PadSize.entries) {
            val key = size.name.lowercase()
            // { key: "small", title: "Small", blurb: "...", e: 16384, n: 64 }
            val re = Regex("""key:\s*"$key"[^}]*?e:\s*(\d+)[^}]*?n:\s*(\d+)""")
            val m = re.find(text)
            assertTrue("the Browser Edition no longer declares a \"$key\" preset in the shape " +
                       "this test reads — check src/browser/ui/create-pair.ts before changing this",
                       m != null)
            assertEquals("$key: encryption bytes differ from the Browser Edition",
                         m!!.groupValues[1].toLong(), size.encryptionBytes)
            assertEquals("$key: record count differs from the Browser Edition",
                         m.groupValues[2].toLong(), size.authRecords)
            matched++
        }
        // POSITIVE CONTROL: all three were actually found and compared. Without
        // this a regex that matched nothing would pass the loop vacuously.
        assertEquals("all three presets must have been located in the Browser source", 3, matched)
    }

    /**
     * THE MATERIAL REQUIREMENT IS DERIVED, NOT TABULATED. L = 2 * (E + 32 * N) is
     * the four-slice rule; these expectations are written out only so a change to
     * either the presets or the formula has to be deliberate.
     */
    @Test
    fun `each preset derives the expected total source material`() {
        assertEquals(36_864L, PadSize.Small.requiredSourceLength())
        assertEquals(557_056L, PadSize.Medium.requiredSourceLength())
        assertEquals(8_650_752L, PadSize.Large.requiredSourceLength())

        // And it really is derived from the two fields, for every preset.
        for (size in PadSize.entries) {
            assertEquals(2 * (size.encryptionBytes + 32 * size.authRecords),
                         size.requiredSourceLength())
        }
    }

    /**
     * The visible description states the CAP, and states it correctly. N is the
     * number of one-time authentication records, which is a hard ceiling — the
     * previous wording said "about N messages", which understated how exact it is.
     */
    @Test
    fun `each preset describes its true message ceiling`() {
        assertEquals("Occasional messages. Up to 64 messages each way.", PadSize.Small.describe())
        assertEquals("Regular conversation. Up to 512 messages each way.", PadSize.Medium.describe())
        assertEquals("Messages and files. Up to 4096 messages each way.", PadSize.Large.describe())

        for (size in PadSize.entries) {
            assertTrue("${size.name} must state its ceiling",
                       size.describe().contains("${size.authRecords}"))
            assertTrue("${size.name} must not describe a hard ceiling as approximate",
                       !size.describe().contains("about "))
        }
    }
}
