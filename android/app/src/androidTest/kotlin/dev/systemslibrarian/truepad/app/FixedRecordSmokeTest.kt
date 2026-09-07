package dev.systemslibrarian.truepad.app

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.systemslibrarian.truepad.core.COMPACT_PREFIX
import dev.systemslibrarian.truepad.core.EnvelopeDecode
import dev.systemslibrarian.truepad.core.decodeEnvelopeTransport2
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import java.io.File

/**
 * THE FIXED-RECORD PROPERTY, OBSERVED ON A HANDSET.
 *
 * Everything about §16 records is already proven on the JVM. What is NOT proven
 * there is that the property survives the real screen: that ticking a checkbox in
 * the create flow actually produces a pad whose messages are all the same
 * ciphertext length, and that the string the operator is handed by the Copy button
 * is the compact form they were looking at.
 *
 * WHY THE CLIPBOARD IS THE PROBE. The envelope node carries
 * `clearAndSetSemantics`, so its text is deliberately invisible to the semantics
 * tree — a screen reader must not spell out 400 characters of transport. That
 * leaves the Copy button as the only way to observe what the screen is actually
 * offering, which is convenient: reading the clipboard tests the DISPLAYED value
 * and the COPY path at once. A test that read the envelope from the engine
 * instead would prove nothing about either.
 *
 * WHAT THIS DOES NOT COVER. It is one handset, so it says nothing about opening a
 * message written by the other edition. That needs the same pad on two devices.
 */
@RunWith(AndroidJUnit4::class)
class FixedRecordSmokeTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private val cleanStorage = object : ExternalResource() {
        override fun before() = wipe()
        override fun after() = wipe()
        private fun wipe() {
            AndroidStorage.storeRoot(context).deleteRecursively()
            AndroidStorage.witnessRoot(context).deleteRecursively()
            File(context.filesDir, "hidden-pads.txt").delete()
        }
    }

    private val compose = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val chain: RuleChain = RuleChain.outerRule(cleanStorage).around(compose)

    private fun awaitTag(tag: String, timeoutMs: Long = 20_000) {
        compose.waitUntil(timeoutMs) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    }

    /** What the Copy button actually put on the clipboard. */
    private fun clipboard(): String {
        var text = ""
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            text = cm.primaryClip?.getItemAt(0)?.text?.toString() ?: ""
        }
        return text
    }

    private fun sendAndCopy(message: String): String {
        awaitTag("btn-send")
        compose.onNodeWithTag("btn-send").performClick()
        awaitTag("field-message")
        compose.onNodeWithTag("field-message").performTextInput(message)
        compose.onNodeWithTag("btn-encrypt").performScrollTo().performClick()
        awaitTag("envelope-output")

        // THE TRANSPORT FORM IS OFFERED UNDER A DISCLOSURE, and the compact form
        // is what is on screen. Both controls must be present before either is used.
        compose.onNodeWithTag("btn-copy-envelope").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("btn-share-envelope").assertIsDisplayed()

        compose.onNodeWithTag("btn-copy-envelope").performClick()
        val copied = clipboard()
        compose.onNodeWithTag("btn-back-to-pad").performScrollTo().performClick()
        return copied
    }

    @Test
    fun aFixedRecordPadGivesEveryMessageTheSameCiphertextLength() {
        // ---- create a 256-byte fixed-record pad, through the real screen ----
        awaitTag("btn-create-pad")
        compose.onNodeWithTag("btn-create-pad").performClick()
        awaitTag("field-pad-name")
        compose.onNodeWithTag("field-pad-name").performTextInput("fixed-smoke")
        compose.onNodeWithTag("size-Small").performScrollTo().performClick()

        // LENGTH PRIVACY IS UNDER "ADVANCED", COLLAPSED BY DEFAULT — which is the
        // point of putting it there, and is why the first run of this test could
        // not find the checkbox at all: a Details body is not merely off-screen
        // when closed, it is absent from the tree.
        compose.onNodeWithText("\u25B8  Advanced").performScrollTo().performClick()
        awaitTag("checkbox-fixed-length")
        compose.onNodeWithTag("checkbox-fixed-length").performScrollTo().performClick()
        awaitTag("field-fixed-size")
        // CLEARED FIRST. The field already offers 256, so typing into it produced
        // "256256" — which the screen then correctly refused as larger than a
        // Small pad's capacity, and the first run of this test timed out waiting
        // for a pad that the UI was right not to create.
        compose.onNodeWithTag("field-fixed-size").performTextClearance()
        compose.onNodeWithTag("field-fixed-size").performTextInput("256")
        compose.onNodeWithTag("btn-submit-create").performScrollTo().performClick()

        // CREATION OPENS THE PAD DIRECTLY. `createPadFromDevice` ends with
        // `openPad(...)`, so the home list is never shown and waiting for a
        // `pad-row` waits forever — the mistake the first runs of this test made.
        // Wait for the CONTROL, not a heading: the pad screen draws its title as
        // soon as a pad is selected, but its actions appear only once the engine
        // has returned a summary.
        awaitTag("btn-send", 60_000)

        // ---- two plaintexts of clearly different lengths, both of which fit ----
        val short = "hi"
        val long = "this one is a great deal longer than the other, on purpose"
        assertNotEquals("the fixtures must differ in length", short.length, long.length)

        val firstCopied = sendAndCopy(short)
        val secondCopied = sendAndCopy(long)

        // ---- what the operator was handed is the compact form ----
        for (copied in listOf(firstCopied, secondCopied)) {
            assertTrue(
                "Copy handed over something that is not the compact transport form: " +
                    copied.take(40),
                copied.startsWith(COMPACT_PREFIX),
            )
        }
        assertNotEquals("the two messages produced identical transport", firstCopied, secondCopied)

        // ---- and the fixed-record property holds on the handset ----
        val a = decodeEnvelopeTransport2(firstCopied)
        val b = decodeEnvelopeTransport2(secondCopied)
        assertTrue("the first copied message does not decode", a is EnvelopeDecode.Ok)
        assertTrue("the second copied message does not decode", b is EnvelopeDecode.Ok)
        val lenA = (a as EnvelopeDecode.Ok).envelope.ciphertextLength
        val lenB = (b as EnvelopeDecode.Ok).envelope.ciphertextLength
        assertEquals(
            "two messages of different lengths produced different ciphertext lengths, so the " +
                "fixed-record property does not hold on this device",
            lenA,
            lenB,
        )
        assertEquals("the record is not the 256 bytes that was asked for", 256, lenA)
    }
}
