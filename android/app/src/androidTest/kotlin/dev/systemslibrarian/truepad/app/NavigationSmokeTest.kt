package dev.systemslibrarian.truepad.app

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import java.io.File

/**
 * THE THREE DESTINATIONS, AND THE STATE A TAB SWITCH MUST NOT DESTROY.
 *
 * The reachability half of this could be argued from source. The half that could
 * not is the one that matters: a live receive request is a ONE-TIME key already
 * written to disk, and if switching tabs went through `back()` — which drops the
 * transient session on purpose — then glancing at About would strand it. That is
 * a property of the running shell, so it is checked in the running shell.
 */
@RunWith(AndroidJUnit4::class)
class NavigationSmokeTest {

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

    private fun has(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun allThreeDestinationsAreReachableFromTheShell() {
        awaitTag("bottom-nav")
        awaitTag("title-home")

        compose.onNodeWithTag("tab-About").performClick()
        awaitTag("title-about")
        compose.onNodeWithTag("title-about").assertIsDisplayed()

        compose.onNodeWithTag("tab-Inbox").performClick()
        awaitTag("title-receive")

        compose.onNodeWithTag("tab-Pads").performClick()
        awaitTag("title-home")
    }

    /**
     * A PUBLISHED RECEIVE CODE SURVIVES A LOOK AT ANOTHER TAB.
     *
     * The request is a one-time key on disk. Losing the screen that shows it would
     * strand it — the operator would have a live key they could no longer give to
     * anyone, and the only way out would be to cancel and burn it.
     */
    @Test
    fun switchingTabsDoesNotCancelAPublishedReceiveCode() {
        awaitTag("bottom-nav")
        compose.onNodeWithTag("tab-Inbox").performClick()
        awaitTag("btn-create-receive-code")
        compose.onNodeWithTag("btn-create-receive-code").performClick()

        // The code is live once it is on screen with its controls.
        awaitTag("receive-code-output", 40_000)
        assertTrue("the receive code did not publish", has("btn-copy-receive-code"))

        compose.onNodeWithTag("tab-About").performClick()
        awaitTag("title-about")
        compose.onNodeWithTag("tab-Pads").performClick()
        awaitTag("title-home")
        compose.onNodeWithTag("tab-Inbox").performClick()

        awaitTag("receive-code-output")
        assertTrue(
            "the published receive code was lost by switching tabs — a one-time key is now " +
                "stranded on disk with no way to hand it over",
            has("btn-copy-receive-code"),
        )

        // Leave the device as it was found.
        if (has("btn-cancel-receive-code")) {
            compose.onNodeWithTag("btn-cancel-receive-code").performClick()
        }
    }

    /** Each destination keeps its own place. */
    @Test
    fun aTabRemembersWhereItWasLeft() {
        awaitTag("btn-create-pad")
        compose.onNodeWithTag("btn-create-pad").performClick()
        awaitTag("field-pad-name")

        compose.onNodeWithTag("tab-About").performClick()
        awaitTag("title-about")
        compose.onNodeWithTag("tab-Pads").performClick()

        awaitTag("field-pad-name")
        assertTrue(
            "the Pads tab forgot that it was on the create screen",
            has("field-pad-name"),
        )
    }
}
