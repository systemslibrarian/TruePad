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
            screens.contains("context.copySensitiveText(\"TruePad encrypted message\", shown, Egress.PUBLIC_TEXT)"),
        )
        assertTrue(
            "Share does not hand over the displayed value",
            screens.contains("context.shareEncryptedMessage(shown, Egress.PUBLIC_TEXT)"),
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
            sptScreens.contains("copySensitiveText(\"TruePad receive code\", request.tpr2Text, Egress.PUBLIC_TEXT)"),
        )
        assertTrue(
            "Share code does not hand over the displayed receive code",
            sptScreens.contains("shareReceiveCode(request.tpr2Text, Egress.PUBLIC_TEXT)"),
        )
    }

    /**
     * THE DECRYPTED MESSAGE HAS NO ROUTE OUT AT ALL — not Share, and no longer
     * Copy either.
     *
     * This used to assert "Copy only, as before": it required `btn-copy-plaintext`
     * to EXIST and only checked that no Share appeared beside it. The clipboard is
     * readable by any app with focus, is kept in a platform history and syncs
     * across devices, and this screen's own CLIPBOARD_WARNING conceded that the
     * sensitive-clip mark does not stop another app reading it. iOS refused this
     * from the start; the assertion is now the iOS rule.
     */
    @Test
    fun theDecryptedMessageHasNoRouteOut() {
        assertFalse("the open screen can copy the decrypted message again",
                    screens.contains("btn-copy-plaintext"))
        // `result.plaintext` must reach no egress helper at all.
        for (sink in listOf("copySensitiveText", "shareEncryptedMessage", "shareReceiveCode")) {
            assertFalse(
                "$sink is handed the decrypted message",
                Regex("$sink\\([^)]*result\\.plaintext").containsMatchIn(screens),
            )
        }
        // And the screen says why, in the words the other two editions use.
        assertTrue("the open screen does not say why there is no copy",
                   screens.contains("Claims.PLAINTEXT_STAYS_HERE"))
    }

    /**
     * AND THE POLICY IS STRUCTURAL, not a habit of not asking. Every egress helper
     * takes a required classification and refuses PLAINTEXT itself, so a new call
     * site cannot route the decrypted message out by forgetting.
     */
    /**
     * THE PLATFORM'S OWN COPY GESTURE IS CLOSED TOO, asserted in the suite Gradle
     * runs.
     *
     * Removing the Copy button is not the policy if a long-press and "Copy"
     * reaches the same clipboard — the screen says "there is no copy or save for
     * it", and that is only true if the gesture is declined as well. iOS refuses
     * `.textSelection(.enabled)` on plaintext for exactly this reason.
     *
     * There is a Node-side twin of this in tests/plaintext-egress.test.ts, but an
     * Android-only CI job runs Gradle and not vitest, so a guard that lives only
     * there proves nothing about this edition.
     */
    @Test
    fun theDecryptedMessageIsNotSelectable() {
        val code = screens.replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
            .lineSequence().map { it.substringBefore("//") }.joinToString("\n")
        val block = code.substringAfter("SectionTitle(\"Message\")").substringBefore("FullWidth {")
        assertTrue("the message block was not found", block.length > 50)
        assertTrue(block.contains("plaintext-output"))
        assertFalse(
            "the decrypted message is selectable again, so the platform can copy it",
            block.contains("SelectionContainer"),
        )
        // The ENVELOPE keeps its selection — public transport, and copying it is
        // the workflow. Without this the assertion above would also pass on an app
        // that had lost selection everywhere.
        assertTrue(
            "public transport lost its selection, which is the workflow",
            code.contains("SelectionContainer"),
        )
    }

    @Test
    fun theEgressHelpersRefusePlaintextThemselves() {
        val main = File("src/main/kotlin/dev/systemslibrarian/truepad/app/MainActivity.kt").readText()
        assertTrue(main.contains("fun Context.copySensitiveText(label: String, text: String, egress: Egress)"))
        assertTrue(main.contains("fun Context.shareEncryptedMessage(text: String, egress: Egress)"))
        assertTrue(main.contains("fun Context.shareReceiveCode(text: String, egress: Egress)"))
        assertTrue(main.contains("throw EgressRefused"))
        assertFalse("plaintext may reach the clipboard",
                    EgressPolicy.mayCopyToClipboard(Egress.PLAINTEXT_MESSAGE))
        assertFalse("plaintext may reach the share sheet",
                    EgressPolicy.mayShareAsText(Egress.PLAINTEXT_MESSAGE))
        assertTrue("public transport lost its clipboard route",
                   EgressPolicy.mayCopyToClipboard(Egress.PUBLIC_TEXT))
        assertTrue("public transport lost its share route",
                   EgressPolicy.mayShareAsText(Egress.PUBLIC_TEXT))
    }
}
