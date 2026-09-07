package dev.systemslibrarian.truepad.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * THE CLAIMS BOUNDARY IS THE SAME THREE SENTENCES ON BOTH EDITIONS.
 *
 * `Claims.kt` says this test exists and that it fails if the two apps drift.
 * It did not exist. A comment asserting a guarantee that nothing enforces is
 * worse than no comment, because it is read as evidence — so here is the test
 * the comment promised.
 *
 * The boundary is a standing project rule: post-quantum cryptography protects
 * pad DELIVERY, the one-time pad encrypts messages, and Wegman-Carter
 * authenticates them. Two apps that state it differently are two products.
 */
class AboutParityTest {

    private val iosAbout =
        File("../../ios/TruePadKit/Sources/TruePadUI/RootView.swift").readText()

    /** THE NEAR SIDE. Comparing the constants against the iPhone proved the two
     *  editions agree about the WORDS while proving nothing about whether THIS
     *  edition still says them: Android's About destination could stop rendering
     *  the claims boundary entirely and every assertion here stayed green. */
    private val androidAbout =
        File("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/AboutScreen.kt").readText()

    @Test
    fun theClaimsBoundaryIsWordForWordTheIphoneEditions() {
        // POSITIVE CONTROL: both About destinations really loaded.
        assertTrue("the iOS About screen did not load", iosAbout.contains("struct AboutView"))
        assertTrue("the Android About screen did not load", androidAbout.contains("fun AboutScreen("))

        // THIS EDITION STILL STATES THE BOUNDARY. By constant name, so a screen
        // that stopped rendering one is caught even while the sentence is still
        // defined in Claims.kt for the far-side comparison below.
        for (name in listOf("CLAIM_DELIVERY", "CLAIM_ENCRYPTION", "CLAIM_AUTHENTICATION")) {
            assertTrue(
                "the Android About screen no longer renders Claims.$name",
                androidAbout.contains(name),
            )
        }

        // THE SYSTEM-LOG CLAIM CARRIES ITS SCOPE, on BOTH editions, in the same
        // words. "Nothing written to the system log" is contradicted by the first
        // line of a logcat during a scan — the camera and barcode libraries write
        // their own. What is true is that none of it is about the operator, and
        // that is said next to the claim rather than in a comment.
        assertTrue("the Android About screen states the log claim without its scope",
                   androidAbout.contains("Claims.LOG_SCOPE"))
        // WORD FOR WORD, across a language boundary. Swift wraps a long literal
        // as `"..." + "..."`, so the sentence is not contiguous in the source;
        // joining those back together is what makes a whole-sentence comparison
        // possible instead of a fragment hunt that drifts with the line breaks.
        val iosJoined = iosAbout.replace(Regex("\"\\s*\\+\\s*\""), "")
        assertTrue(
            "the iPhone edition no longer states the log scope in the same words",
            iosJoined.contains(Claims.LOG_SCOPE),
        )
        // POSITIVE CONTROL for the join: it must actually have joined something,
        // or the assertion above would be comparing against the raw file.
        assertTrue("the literal-joining step did nothing", iosJoined.length < iosAbout.length)

        for (claim in listOf(
            Claims.CLAIM_DELIVERY,
            Claims.CLAIM_ENCRYPTION,
            Claims.CLAIM_AUTHENTICATION,
        )) {
            assertTrue(
                "the iPhone edition does not state \"$claim\"; the two apps have drifted on the " +
                    "claims boundary",
                iosAbout.contains("\"$claim\""),
            )
        }
    }

    /** The boundary says what protects what — and never more than that. */
    @Test
    fun theBoundaryDoesNotOverstateWhatIsProtected() {
        assertEquals("Post-quantum cryptography protects pad DELIVERY.", Claims.CLAIM_DELIVERY)
        assertEquals("The one-time pad encrypts messages.", Claims.CLAIM_ENCRYPTION)
        assertEquals("Wegman–Carter authenticates messages.", Claims.CLAIM_AUTHENTICATION)

        // SCANNED OVER THE SCREENS, NOT OVER THE THREE PINNED CONSTANTS.
        //
        // This used to lowercase the concatenation of the same three constants the
        // three `assertEquals` above had just fixed to exact literals — so the
        // loop ran over a value that could not vary, and could never fire. What
        // an overclaim scan is for is the sentences AROUND the boundary: a fourth
        // line added to either About screen is exactly where "unbreakable" would
        // appear, and neither the constants nor this test saw those at all.
        val all = (androidAbout + "\n" + iosAbout).lowercase()
        // POSITIVE CONTROL: both screens really are in scope.
        assertTrue("the About screens did not load into the overclaim scan", all.length > 4000)
        assertTrue(all.contains("one-time pad encrypts messages"))
        for (overclaim in listOf(
            "unbreakable", "perfect secrecy", "proven secure", "cannot be broken",
            "military grade", "quantum proof", "guaranteed",
        )) {
            assertTrue("an About screen says \"$overclaim\"", !all.contains(overclaim))
        }
        // PQC protects DELIVERY, never the message itself.
        assertTrue(
            "the delivery claim no longer scopes itself to delivery",
            Claims.CLAIM_DELIVERY.contains("DELIVERY"),
        )
    }
}
