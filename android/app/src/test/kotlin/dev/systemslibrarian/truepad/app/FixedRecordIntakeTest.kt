package dev.systemslibrarian.truepad.app

import dev.systemslibrarian.truepad.core.MAX_CIPHERTEXT_BYTES
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * THE FIXED-RECORD CEILING, which the create screen got wrong.
 *
 * The screen validated the typed size against the selected preset's encryption
 * capacity alone while the engine refuses anything above MAX_CIPHERTEXT_BYTES.
 * On the Large preset that is 4,194,304 against 1,048,576, so a whole band of
 * values enabled the Create button and were then refused by the engine — and the
 * sentence that explained the range quoted the wrong number too.
 *
 * These tests pin the reported case and the rules around it. The whole predicate
 * was previously untested at every level, which is the other half of why it
 * survived to be reported.
 */
class FixedRecordIntakeTest {

    private val large = PadSize.Large.encryptionBytes      // 4_194_304
    private val small = PadSize.Small.encryptionBytes      // 16_384

    // MARK: the reported defect

    /**
     * THE REPORTED CASE. 2,000,000 is a multiple of 16 and is comfortably under
     * the Large preset's capacity, so the old capacity-only rule accepted it. The
     * engine refuses it.
     */
    @Test
    fun theLargePadCaseThatUsedToPassTheScreenAndFailTheEngine() {
        // The fixture must actually have the shape the defect needed, or this
        // test proves nothing about it.
        assertEquals(0, 2_000_000 % FixedRecordIntake.MULTIPLE_OF)
        assertTrue("the value must be under the pad's capacity", 2_000_000 < large)
        assertTrue("the value must be over the engine's limit", 2_000_000 > MAX_CIPHERTEXT_BYTES)

        assertFalse(
            "the screen accepted a size the engine refuses",
            FixedRecordIntake.isUsable(true, "2000000", large),
        )
        assertNull(FixedRecordIntake.recordBytes(true, "2000000", large))
    }

    @Test
    fun theCeilingIsTheLowerOfTheCapacityAndTheEngineLimit() {
        assertEquals(MAX_CIPHERTEXT_BYTES.toLong(), FixedRecordIntake.ceiling(large))
        assertEquals(small, FixedRecordIntake.ceiling(small))
        // POSITIVE CONTROL: the two bounds really are different on Large, so the
        // minimum above is choosing rather than returning the only value present.
        assertNotEquals(large, MAX_CIPHERTEXT_BYTES.toLong())
    }

    @Test
    fun theExplanationStatesTheEffectiveCeilingRatherThanTheCapacity() {
        val text = FixedRecordIntake.explanation(large)
        assertTrue("it does not state the real limit: $text", text.contains("$MAX_CIPHERTEXT_BYTES bytes"))
        assertFalse("it still quotes the pad capacity as the limit: $text", text.contains("$large"))
        assertTrue(text.contains("multiple of 16"))
        assertTrue(text.contains("at least 32"))
        // On a small pad the capacity IS the limit, and must be the number shown.
        assertTrue(FixedRecordIntake.explanation(small).contains("$small bytes"))
    }

    // MARK: the rules that were already right and must stay right

    @Test
    fun anUntickedCheckboxNeverBlocksCreation() {
        for (typed in listOf("", "0", "banana", "7")) {
            assertTrue("\"$typed\" blocked creation", FixedRecordIntake.isUsable(false, typed, large))
            assertNull(FixedRecordIntake.recordBytes(false, typed, large))
        }
    }

    @Test
    fun theBoundsAreInclusiveAtBothEnds() {
        assertTrue(FixedRecordIntake.isUsable(true, "32", large))
        assertEquals(32, FixedRecordIntake.recordBytes(true, "32", large))
        assertFalse(FixedRecordIntake.isUsable(true, "16", large))

        assertTrue(FixedRecordIntake.isUsable(true, "$MAX_CIPHERTEXT_BYTES", large))
        assertFalse(FixedRecordIntake.isUsable(true, "${MAX_CIPHERTEXT_BYTES + 16}", large))
        // On a small pad the pad's own capacity binds first.
        assertTrue(FixedRecordIntake.isUsable(true, "$small", small))
        assertFalse(FixedRecordIntake.isUsable(true, "${small + 16}", small))
    }

    @Test
    fun aNonMultipleIsRefusedRatherThanRounded() {
        assertFalse(FixedRecordIntake.isUsable(true, "100", large))
        assertNull(FixedRecordIntake.recordBytes(true, "100", large))
        // And it is NOT quietly turned into either neighbour that would work.
        assertEquals(96, FixedRecordIntake.recordBytes(true, "96", large))
        assertEquals(112, FixedRecordIntake.recordBytes(true, "112", large))
    }

    @Test
    fun somethingThatIsNotANumberIsNotUsable() {
        for (typed in listOf("", "   ", "banana", "25.6", "-64")) {
            assertFalse("\"$typed\" was read as a size", FixedRecordIntake.isUsable(true, typed, large))
        }
    }

    /**
     * A RULE THE SCREEN DOES NOT CONSULT IS NOT A RULE. The defect this file
     * exists for was an inline predicate in a Composable; moving it here fixes
     * nothing unless the Composable actually calls it.
     */
    @Test
    fun theCreateScreenUsesThisRuleRatherThanItsOwn() {
        val screens = File("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Screens.kt").readText()
        // POSITIVE CONTROL: the file loaded and is the create screen.
        assertTrue("the create screen no longer offers fixed lengths",
            screens.contains("Hide exact message lengths"))

        assertTrue("the screen does not use the shared usability rule",
            screens.contains("FixedRecordIntake.isUsable(fixedLength, fixedSize, size.encryptionBytes)"))
        assertTrue("the screen does not use the shared record-size rule",
            screens.contains("FixedRecordIntake.recordBytes(fixedLength, fixedSize, size.encryptionBytes)"))
        assertTrue("the screen does not use the shared explanation",
            screens.contains("FixedRecordIntake.explanation(size.encryptionBytes)"))

        // And the old capacity-only predicate must be gone, not merely bypassed.
        assertFalse("the old capacity-only ceiling is still in the screen",
            screens.contains("parsedF.toLong() <= size.encryptionBytes"))
    }

    @Test
    fun theOfferedDefaultWorksOnEveryShippedPreset() {
        for (size in PadSize.entries) {
            assertTrue(
                "256 bytes was refused on the ${size.name} preset",
                FixedRecordIntake.isUsable(true, "256", size.encryptionBytes),
            )
        }
    }
}
