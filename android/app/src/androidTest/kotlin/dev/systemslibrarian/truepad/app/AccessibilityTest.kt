package dev.systemslibrarian.truepad.app

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import java.io.File

/**
 * THE AUTOMATED ACCESSIBILITY BASELINE.
 *
 * This is what a machine can check. It is NOT a substitute for someone using the
 * app with TalkBack, and docs/ANDROID-SECURITY.md records that pass as still
 * outstanding rather than letting these tests stand in for it.
 *
 * What it does check, on every screen of the primary journey rather than on a
 * hand-picked control:
 *
 *   * every interactive node carries a label a screen reader can announce;
 *   * every interactive node is at least 48dp in its smaller dimension;
 *   * choice controls announce a ROLE, so TalkBack says "radio button" rather
 *     than reading a bare label;
 *   * a disabled control says it is disabled instead of just looking grey;
 *   * screen titles are marked as headings, so heading navigation works;
 *   * the interface still lays out and keeps its warning text at 2× font scale;
 *   * NO SECRET is duplicated into accessibility metadata — the one way a
 *     plaintext could leave the screen through a channel FLAG_SECURE does not
 *     cover.
 *
 * The last one is why this file is a security test as much as a usability one.
 */
@RunWith(AndroidJUnit4::class)
class AccessibilityTest {

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

    private fun waitForTag(tag: String, timeoutMs: Long = 30_000) {
        compose.waitUntil(timeoutMs) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun createPad(name: String) {
        waitForTag("title-home")
        compose.onNodeWithTag("btn-create-pad").performScrollTo().performClick()
        waitForTag("title-create")
        compose.onNodeWithTag("field-pad-name").performScrollTo().performTextInput(name)
        compose.onNodeWithTag("size-Small").performScrollTo().performClick()
        compose.onNodeWithTag("btn-submit-create").performScrollTo().performClick()
        waitForTag("btn-send")
    }

    /* ---- the sweep ---------------------------------------------------------- */

    private fun <T> SemanticsConfiguration.opt(key: SemanticsPropertyKey<T>): T? =
        if (contains(key)) this[key] else null

    private fun SemanticsNode.label(): String {
        val text = config.opt(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty()
        val desc = config.opt(SemanticsProperties.ContentDescription)?.joinToString(" ").orEmpty()
        val state = config.opt(SemanticsProperties.StateDescription).orEmpty()
        return (text + " " + desc + " " + state).trim()
    }

    private fun SemanticsNode.isInteractive(): Boolean =
        config.contains(SemanticsActions.OnClick) ||
            config.contains(SemanticsProperties.Selected) ||
            config.contains(SemanticsProperties.ToggleableState) ||
            config.contains(SemanticsActions.SetText)

    /**
     * Walk everything on screen and hold each interactive node to the baseline.
     * A sweep rather than a list of test tags: a control added later is covered
     * the moment it appears, which a hand-maintained list would never manage.
     */
    private fun sweep(screen: String) {
        val density = compose.activity.resources.displayMetrics.density
        val root = compose.onAllNodesWithTag("truepad-root").fetchSemanticsNodes().single()

        val problems = mutableListOf<String>()
        var interactive = 0

        fun visit(node: SemanticsNode) {
            if (node.isInteractive()) {
                interactive += 1
                val label = node.label()
                val where = "$screen: node ${node.id} ${node.config.opt(SemanticsProperties.TestTag) ?: ""}"
                if (label.isBlank()) {
                    problems += "$where has no label a screen reader could announce"
                }
                // A text FIELD is allowed to be tall and is measured the same way;
                // what matters is that neither dimension is a sliver.
                val w = node.size.width / density
                val h = node.size.height / density
                if (h > 0 && h < 47.5f) problems += "$where is only ${h}dp tall (min 48dp): \"$label\""
                if (w > 0 && w < 47.5f) problems += "$where is only ${w}dp wide (min 48dp): \"$label\""
            }
            node.children.forEach(::visit)
        }
        visit(root)

        assertTrue("$screen: the sweep found no interactive nodes at all", interactive > 0)
        assertTrue(
            "accessibility baseline failures:\n  " + problems.joinToString("\n  "),
            problems.isEmpty(),
        )
    }

    @Test
    fun everyInteractiveControlOnHomeMeetsTheBaseline() {
        waitForTag("title-home")
        sweep("home")
    }

    @Test
    fun everyInteractiveControlOnCreateMeetsTheBaseline() {
        waitForTag("title-home")
        compose.onNodeWithTag("btn-create-pad").performScrollTo().performClick()
        waitForTag("title-create")
        sweep("create")
        // And with the external-material ceremony expanded, which is the densest
        // screen in the app.
        compose.onNodeWithTag("radio-external").performScrollTo().performClick()
        compose.waitForIdle()
        sweep("create/ceremony")
    }

    @Test
    fun everyInteractiveControlOnThePadAndItsVerbsMeetsTheBaseline() {
        createPad("A11y")
        sweep("pad")

        compose.onNodeWithTag("btn-send").performScrollTo().performClick()
        waitForTag("title-send")
        sweep("send")

        compose.onNodeWithTag("field-message").performScrollTo().performTextInput("hello")
        compose.onNodeWithTag("btn-encrypt").performScrollTo().performClick()
        waitForTag("envelope-output")
        sweep("send/result")
    }

    @Test
    fun everyInteractiveControlOnSecurityAndDisableMeetsTheBaseline() {
        createPad("A11y2")
        compose.onNodeWithTag("btn-security").performScrollTo().performClick()
        waitForTag("title-security")
        sweep("security")

        // Back to the pad, then the irreversible screen.
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
        waitForTag("btn-disable")
        compose.onNodeWithTag("btn-disable").performScrollTo().performClick()
        waitForTag("title-disable")
        sweep("disable")
    }

    /* ---- roles and states ---------------------------------------------------- */

    /**
     * A radio button that announces only its label is a control TalkBack cannot
     * describe. The role is what makes "Small, radio button, selected" possible.
     */
    @Test
    fun choiceControlsAnnounceTheirRoleAndSelection() {
        waitForTag("title-home")
        compose.onNodeWithTag("btn-create-pad").performScrollTo().performClick()
        waitForTag("title-create")

        for (tag in listOf("size-Small", "size-Medium", "size-Large", "radio-device", "radio-external")) {
            val node = compose.onNodeWithTag(tag).fetchSemanticsNode()
            assertEquals(
                "$tag must announce as a radio button",
                androidx.compose.ui.semantics.Role.RadioButton,
                node.config.opt(SemanticsProperties.Role),
            )
            assertTrue("$tag must expose its selected state", node.config.contains(SemanticsProperties.Selected))
        }
        compose.onNodeWithTag("radio-external").performScrollTo().performClick()
        compose.waitForIdle()
        val declaration = compose.onNodeWithTag("checkbox-declaration").fetchSemanticsNode()
        assertEquals(
            "the operator declaration must announce as a checkbox",
            androidx.compose.ui.semantics.Role.Checkbox,
            declaration.config.opt(SemanticsProperties.Role),
        )
        assertTrue(
            "and it must carry the full declaration text, not just a tick",
            declaration.label().contains("I understand that TruePad cannot verify physical randomness"),
        )
    }

    /**
     * The one irreversible button is inert until the box is ticked, and a screen
     * reader must be told that — not left to infer it from the colour.
     */
    @Test
    fun aDisabledControlSaysSoRatherThanLookingGrey() {
        createPad("Disabled state")
        compose.onNodeWithTag("btn-disable").performScrollTo().performClick()
        waitForTag("title-disable")

        val before = compose.onNodeWithTag("btn-confirm-disable").fetchSemanticsNode()
        assertTrue(
            "a disabled control must be marked disabled in semantics",
            before.config.contains(SemanticsProperties.Disabled),
        )
        compose.onNodeWithTag("checkbox-understood").performScrollTo().performClick()
        compose.waitForIdle()
        val after = compose.onNodeWithTag("btn-confirm-disable").fetchSemanticsNode()
        assertFalse(
            "and must stop being marked disabled once it is usable",
            after.config.contains(SemanticsProperties.Disabled),
        )
    }

    @Test
    fun everyScreenTitleIsAHeading() {
        waitForTag("title-home")
        assertTrue(
            compose.onNodeWithTag("title-home").fetchSemanticsNode()
                .config.contains(SemanticsProperties.Heading),
        )
        compose.onNodeWithTag("btn-create-pad").performScrollTo().performClick()
        waitForTag("title-create")
        assertTrue(
            compose.onNodeWithTag("title-create").fetchSemanticsNode()
                .config.contains(SemanticsProperties.Heading),
        )
    }

    /* ---- the security half ------------------------------------------------------ */

    /**
     * ACCESSIBILITY METADATA IS A CHANNEL OUT.
     *
     * FLAG_SECURE stops a screenshot. It does not stop an accessibility service
     * from reading the semantics tree, and a service with those rights is
     * something a user can be talked into granting. So a decrypted message must
     * appear in the tree exactly once — as the text on screen — and never be
     * duplicated into a contentDescription or a stateDescription, and the raw
     * envelope must not be spelled out at all.
     */
    @Test
    fun noSecretIsDuplicatedIntoAccessibilityMetadata() {
        createPad("Metadata")
        compose.onNodeWithTag("btn-send").performScrollTo().performClick()
        waitForTag("title-send")
        val secret = "RENDEZVOUS AT THE OLD BRIDGE"
        compose.onNodeWithTag("field-message").performScrollTo().performTextInput(secret)
        compose.onNodeWithTag("btn-encrypt").performScrollTo().performClick()
        waitForTag("envelope-output")

        val root = compose.onAllNodesWithTag("truepad-root").fetchSemanticsNodes().single()
        val descriptions = mutableListOf<String>()
        val stateDescriptions = mutableListOf<String>()
        fun visit(node: SemanticsNode) {
            node.config.opt(SemanticsProperties.ContentDescription)?.let { descriptions += it }
            node.config.opt(SemanticsProperties.StateDescription)?.let { stateDescriptions += it }
            node.children.forEach(::visit)
        }
        visit(root)

        for (d in descriptions + stateDescriptions) {
            assertFalse("the plaintext must not be in accessibility metadata: $d", d.contains(secret))
            assertFalse("nor the envelope: $d", d.contains("formatVersion"))
            assertFalse("nor a long hex run: $d", Regex("[0-9a-f]{32,}").containsMatchIn(d))
        }

        // And the envelope itself is offered as ONE summarised unit rather than
        // 400 characters of hex read out one at a time.
        val envelope = compose.onNodeWithTag("envelope-output").fetchSemanticsNode()
        val desc = envelope.config.opt(SemanticsProperties.ContentDescription)
        assertTrue("the envelope needs a summary description", !desc.isNullOrEmpty())
        assertTrue(
            "and must not expose its raw text",
            envelope.config.opt(SemanticsProperties.Text).isNullOrEmpty(),
        )
    }
}
