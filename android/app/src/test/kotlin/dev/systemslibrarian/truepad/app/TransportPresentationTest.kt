package dev.systemslibrarian.truepad.app

import dev.systemslibrarian.truepad.core.COMPACT_PREFIX
import dev.systemslibrarian.truepad.core.EnvelopeDecode
import dev.systemslibrarian.truepad.core.decodeEnvelopeTransport2
import dev.systemslibrarian.truepad.core.encodeCompactEnvelope2
import dev.systemslibrarian.truepad.core.encodeEnvelope2
import dev.systemslibrarian.truepad.core.JsonArray
import dev.systemslibrarian.truepad.core.JsonObject
import dev.systemslibrarian.truepad.core.JsonString
import dev.systemslibrarian.truepad.core.parseJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * WHAT THE OPERATOR IS HANDED, AND WHAT THE BUTTONS HAND OVER.
 *
 * The compact `TP2:` codec has been fully ported and vector-tested in
 * :truepad-core since the port, and had ZERO callers in any main/kotlin source —
 * Android could read TP2 and never wrote it, so the send screen displayed several
 * hundred characters of canonical JSON.
 *
 * Two things must hold, and neither is visible from a screenshot: the compact form
 * is what is shown, and Copy and Share hand over EXACTLY that value rather than
 * re-deriving one. A screen that re-spells on the way to the clipboard can hand
 * over something the operator never saw.
 */
class TransportPresentationTest {

    private val screens =
        File("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Screens.kt").readText()
    private val sptScreens =
        File("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/SptScreens.kt").readText()

    /** The shared cross-edition corpus, the same file CompactEnvelopeTest drives.
     *
     * Parsed with the project's OWN reader, not `org.json`: on an Android unit
     * test `org.json` is the unmocked platform stub and every call throws. */
    private fun encodeCases(): List<JsonObject> {
        val root = parseJson(File("../vectors/compact-envelope-v1.json").readText()) as JsonObject
        return (root.members.getValue("encode") as JsonArray).items.map { it as JsonObject }
    }

    private fun JsonObject.str(key: String) = (members.getValue(key) as JsonString).value

    // MARK: the validated value

    @Test
    fun everyReleasedEnvelopeReSpellsToItsReleasedCompactForm() {
        val encode = encodeCases()
        // POSITIVE CONTROL: the corpus loaded and has content.
        assertTrue("the compact corpus did not load", encode.size >= 5)

        for (case in encode) {
            val json = case.str("json")
            val expected = case.str("compact")
            val material = PublicTransport.envelope(json)
            assertNotNull("a released envelope was refused: ${case.str("name")}", material)
            assertEquals(
                "the compact spelling does not match the released one",
                expected,
                material!!.text,
            )
            assertTrue(material.text.startsWith(COMPACT_PREFIX))
        }
    }

    @Test
    fun somethingThatIsNotACanonicalEnvelopeIsRefused() {
        for (text in listOf("", "hello", "{}", "{\"formatVersion\":2}", "TP2:not-base64!!")) {
            assertNull("\"$text\" was accepted as public transport", PublicTransport.envelope(text))
        }
    }

    /** Changing what is SHOWN must not change what is ACCEPTED. */
    @Test
    fun bothSpellingsStillDecodeToTheSameEnvelope() {
        var checked = 0
        for (case in encodeCases()) {
            val fromJson = decodeEnvelopeTransport2(case.str("json"))
            val fromCompact = decodeEnvelopeTransport2(case.str("compact"))
            assertTrue("canonical JSON no longer opens", fromJson is EnvelopeDecode.Ok)
            assertTrue("TP2 no longer opens", fromCompact is EnvelopeDecode.Ok)
            assertEquals(
                encodeEnvelope2((fromJson as EnvelopeDecode.Ok).envelope),
                encodeEnvelope2((fromCompact as EnvelopeDecode.Ok).envelope),
            )
            assertEquals(
                encodeCompactEnvelope2(fromJson.envelope),
                encodeCompactEnvelope2(fromCompact.envelope),
            )
            checked++
        }
        assertTrue("no vector carried both spellings, so this proved nothing", checked > 0)
    }

    // MARK: what the screen shows and what its buttons carry

    @Test
    fun theSendScreenShowsTheCompactFormAndDemotesTheJson() {
        // POSITIVE CONTROL.
        assertTrue(screens.contains("Encrypted message ready"))

        assertTrue(
            "the send screen no longer re-spells the envelope for display",
            screens.contains("PublicTransport.envelope(result.envelope)?.text ?: result.envelope"),
        )
        assertTrue(
            "the displayed text is not the compact form",
            screens.contains("Text(\n                shown,"),
        )
        assertTrue(
            "the canonical JSON is no longer offered under a disclosure",
            screens.contains("Details(\"Technical form\")"),
        )
        // Demoted, not deleted.
        assertTrue("the canonical JSON was removed rather than moved", screens.contains("envelope-json"))
    }

    @Test
    fun copyAndShareCarryExactlyWhatIsDisplayed() {
        assertTrue(
            "Copy does not hand over the displayed value",
            screens.contains("context.copySensitiveText(\"TruePad encrypted message\", shown)"),
        )
        assertTrue(
            "Share does not hand over the displayed value",
            screens.contains("context.shareEncryptedMessage(shown)"),
        )
        // And neither may go back to handing over the raw engine JSON.
        assertFalse(
            "Copy still hands over the canonical JSON, which is not what is on screen",
            screens.contains("copySensitiveText(\"TruePad encrypted message\", result.envelope)"),
        )
        assertFalse(
            "Share still hands over the canonical JSON, which is not what is on screen",
            screens.contains("shareEncryptedMessage(result.envelope)"),
        )
    }

    @Test
    fun theReceiveCodeKeepsItsExplicitCopyAndShare() {
        assertTrue("the receive screen lost Copy code", sptScreens.contains("PrimaryButton(\"Copy code\""))
        assertTrue("the receive screen lost Share code", sptScreens.contains("SecondaryButton(\"Share code\""))
        assertTrue(
            "Copy code does not hand over the displayed receive code",
            sptScreens.contains("copySensitiveText(\"TruePad receive code\", request.tpr2Text)"),
        )
        assertTrue(
            "Share code does not hand over the displayed receive code",
            sptScreens.contains("shareReceiveCode(request.tpr2Text)"),
        )
    }

    /** THE DECRYPTED MESSAGE IS NOT SHAREABLE. Copy only, as before. */
    @Test
    fun theDecryptedMessageStillHasNoShareControl() {
        val open = screens.indexOf("btn-copy-plaintext")
        assertTrue("the open screen no longer has a plaintext copy control", open > 0)
        val window = screens.substring(maxOf(0, open - 600), minOf(screens.length, open + 600))
        assertFalse(
            "the decrypted message gained a Share control",
            window.contains("shareEncryptedMessage") || window.contains("btn-share-plaintext"),
        )
    }
}
