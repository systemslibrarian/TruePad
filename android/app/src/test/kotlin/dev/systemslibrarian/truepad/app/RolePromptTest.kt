package dev.systemslibrarian.truepad.app

import dev.systemslibrarian.truepad.storage.PartyRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * WHAT TRUEPAD SAYS WHEN IT CANNOT TELL WHICH HALF IS YOURS.
 *
 * The refusal is honest in code — `send` and `open` both fail closed on a null
 * role — and it used to be DELEGATING in words: "Choose the role you were given
 * when this pad was created." There was a control to choose with, on the Security
 * screen, and it was the defect: a picked role is a guess, and a guess spends the
 * material the other person is spending. The control is gone.
 *
 * A sentence naming a control that does not exist is worse than no sentence. The
 * operator hunts for it, concludes the app is broken, and the one action TruePad
 * is trying to prevent starts to look like the only way forward. Both sibling
 * editions had this exact sentence and both corrected it; this edition kept it,
 * and after the radios came out it was being rendered in four places at once.
 *
 * So: every route the prompt names must be a real, visible control in THIS app,
 * spelled as the operator sees it. This holds each one against the interface.
 */
class RolePromptTest {

    private val screens = File("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Screens.kt").readText()
    private val sptScreens = File("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/SptScreens.kt").readText()
    private val ui = screens + "\n" + sptScreens
    private val prompt = PartyRole.UNKNOWN_ORIGIN_PROMPT

    /** The typographically-quoted spans, which is how the prompt names a control. */
    private fun quotedControls(): List<String> {
        val out = mutableListOf<String>()
        var rest = prompt
        while (true) {
            val open = rest.indexOf('“')
            if (open < 0) break
            val close = rest.indexOf('”', open + 1)
            if (close < 0) break
            out += rest.substring(open + 1, close)
            rest = rest.substring(close + 1)
        }
        return out
    }

    @Test
    fun `this test read the interface it thinks it read`() {
        // POSITIVE CONTROL: without it every assertion below passes over "".
        assertTrue("the interface sources did not load", ui.length > 8000)
        assertTrue("a known affordance is missing", ui.contains("\"Create a pad\""))
        assertTrue(prompt.length > 200)
    }

    @Test
    fun `every control the refusal names exists in this app`() {
        val quoted = quotedControls()
        assertTrue("the refusal names no controls the operator can act on", quoted.size >= 2)
        for (label in quoted) {
            assertTrue(
                "the refusal tells the operator to use \"$label\", which appears nowhere in the " +
                    "Android interface",
                ui.contains("\"$label\""),
            )
        }
    }

    @Test
    fun `every destination the refusal names is one this app declares`() {
        for (tab in listOf("Pads", "Inbox", "About")) {
            if (!prompt.contains(tab)) continue
            assertTrue(
                "the refusal sends the operator to \"$tab\", which is not a destination this app has",
                Tab.entries.any { it.label == tab },
            )
        }
        assertFalse(
            "the refusal names a Receive destination; this edition calls it the Inbox",
            prompt.contains("Receive screen") || prompt.contains("Receive tab"),
        )
    }

    @Test
    fun `the refusal does not ask the operator to choose a role`() {
        val lower = prompt.lowercase()
        assertTrue("the prompt no longer says TruePad will not guess", lower.contains("will not guess"))
        assertFalse(
            "the prompt asks the operator to choose a role — that is the guess it just refused to " +
                "make, moved to a human, and there is no control to make it with",
            lower.contains("choose the role"),
        )
        assertTrue(
            "the prompt does not say there is nothing to set by hand",
            lower.contains("nothing for you to set by hand"),
        )
    }

    @Test
    fun `the two mobile editions say it in the same words`() {
        // The RULE is the part that must not drift, and this sentence IS the rule
        // as the operator meets it. Swift wraps a long literal as "..." + "...",
        // so the joins are removed before comparing.
        val ios = File("../../ios/TruePadKit/Sources/TruePadUI/Presentation.swift").readText()
        assertTrue("the iOS source did not load", ios.contains("unknownOriginPrompt"))
        val joined = ios.replace(Regex("\"\\s*\\+\\s*\""), "")
        // Swift spells the two non-ASCII characters as escapes; Kotlin does too,
        // and both compile to the same text — compare the compiled Kotlin against
        // the joined Swift with those escapes resolved.
        val iosResolved = joined.replace("\\u{2014}", "—")
            .replace("\\u{201C}", "“").replace("\\u{201D}", "”")
        assertTrue(
            "the two editions have drifted on the unknown-origin refusal",
            iosResolved.contains(prompt),
        )
        assertTrue("the literal-joining step did nothing", joined.length < ios.length)
    }

    @Test
    fun `the prompt is what the refusals carry`() {
        val vm = File("src/main/kotlin/dev/systemslibrarian/truepad/app/PadViewModel.kt").readText()
        assertEquals(
            "both role-unknown refusals must carry the corrected sentence",
            2,
            vm.split("PartyRole.UNKNOWN_ORIGIN_PROMPT").size - 1 -
                // the Screens.kt renderings are counted separately below
                0,
        )
        assertTrue(screens.contains("PartyRole.UNKNOWN_ORIGIN_PROMPT"))
    }
}
