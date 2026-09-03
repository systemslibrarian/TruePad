package dev.systemslibrarian.truepad.app

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.systemslibrarian.truepad.core.Direction
import dev.systemslibrarian.truepad.storage.Party2
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
 * THE DAILY JOURNEY, driven through the real UI on a real device.
 *
 * These are not unit tests of the engine — that is covered, twice over, on the
 * JVM and again on the device. What they check is that the UI is WIRED to it:
 * that a tap reaches the verb, that the verb's refusal reaches the screen, that
 * a double tap cannot spend twice, and that the screen a person is looking at
 * reflects what is actually on disk rather than what the UI last drew.
 */
@RunWith(AndroidJUnit4::class)
class UiJourneyTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    /**
     * Storage is wiped BEFORE the activity launches, not after.
     *
     * The Compose rule starts the activity as it is applied, and the app reads
     * its pad list on the way up. Cleaning in @Before would therefore run too
     * late — the activity would already be showing the previous test's pads —
     * and calling recreate() to fix that detaches the composition the rule is
     * holding. Ordering an outer rule around the Compose rule is the mechanism
     * that actually exists for this.
     */
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

    private fun engine() = (context.applicationContext as TruePadApp).engine

    private fun waitForTag(tag: String, timeoutMs: Long = 30_000) {
        compose.waitUntil(timeoutMs) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun tagGone(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty()

    private fun createPad(name: String) {
        waitForTag("title-home")
        compose.onNodeWithTag("btn-create-pad").performScrollTo().performClick()
        waitForTag("title-create")
        compose.onNodeWithTag("field-pad-name").performScrollTo().performTextInput(name)
        compose.onNodeWithTag("size-Small").performScrollTo().performClick()
        compose.onNodeWithTag("btn-submit-create").performScrollTo().performClick()
        // Wait for the CONTROL, not just the heading. The pad screen draws its
        // title as soon as a pad is selected, but its actions appear only once
        // the engine has returned a summary — waiting on the title alone races
        // that and fails intermittently.
        waitForTag("btn-send")
    }

    /** Return to the pad screen from wherever the last action left us. */
    private fun backToPad() {
        while (tagGone("btn-send")) {
            compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            compose.waitForIdle()
        }
    }

    /* ---- launch --------------------------------------------------------------- */

    @Test
    fun theAppLaunchesToHomeWithNoPads() {
        waitForTag("title-home")
        compose.onNodeWithTag("title-home").assertIsDisplayed()
        compose.onNodeWithTag("btn-create-pad").assertIsDisplayed()
        compose.onNodeWithTag("btn-add-pad").assertIsDisplayed()
        assertTrue("a clean install shows no pads", tagGone("pad-row"))
    }

    /* ---- the whole journey ------------------------------------------------------ */

    @Test
    fun createSendAndDisableTheWholeJourney() {
        createPad("Chat with Sam")
        val pairId = engine().listPairs().single()

        // --- send -----------------------------------------------------------
        compose.onNodeWithTag("btn-send").performScrollTo().performClick()
        waitForTag("title-send")
        compose.onNodeWithTag("field-message").performScrollTo().performTextInput("meet at six")
        compose.onNodeWithTag("btn-encrypt").performScrollTo().performClick()
        waitForTag("envelope-output")

        // The material really moved, on disk, and by exactly one record.
        val afterSend = engine().status(pairId).meters.getValue(Direction.A_TO_B)
        assertEquals(1L, afterSend.nextSequence)
        assertEquals("meet at six".toByteArray().size.toLong(), afterSend.nextOffset)

        // Copy is an explicit action and it works.
        compose.onNodeWithTag("btn-copy-envelope").performScrollTo().performClick()

        // --- back, then disable ----------------------------------------------
        backToPad()
        compose.onNodeWithTag("btn-disable").performScrollTo().performClick()
        waitForTag("title-disable")

        // The irreversible button is INERT until the box is ticked.
        compose.onNodeWithTag("btn-confirm-disable").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("checkbox-understood").performScrollTo().performClick()
        compose.onNodeWithTag("btn-confirm-disable").performScrollTo().assertIsEnabled().performClick()
        waitForTag("title-home")

        // The tombstone is real and permanent; the pad is gone from view.
        assertTrue(
            "the tombstone must be durable",
            File(AndroidStorage.storeRoot(context), "$pairId/destroyed.json").isFile,
        )
        assertTrue("and the pad hidden from the product", HiddenPads(context).isHidden(pairId))
        compose.waitUntil(10_000) { tagGone("pad-row") }
    }

    /**
     * LEAVING THE SCREEN LOSES THE MESSAGE, and the pad does not get it back.
     *
     * The material was spent durably before the envelope existed, so navigating
     * away is a real loss — the honest consequence, which the screen warns about
     * rather than papering over. What must NOT happen is the loss being silent
     * about the cost: the record stays spent, and the next send takes the NEXT
     * one rather than re-using the abandoned message's region.
     */
    @Test
    fun leavingTheSendScreenLosesTheMessageButNotThePadsIntegrity() {
        createPad("Transient")
        val pairId = engine().listPairs().single()

        compose.onNodeWithTag("btn-send").performScrollTo().performClick()
        waitForTag("title-send")
        compose.onNodeWithTag("field-message").performScrollTo().performTextInput("abandoned")
        compose.onNodeWithTag("btn-encrypt").performScrollTo().performClick()
        waitForTag("envelope-output")
        val spent = engine().status(pairId).meters.getValue(Direction.A_TO_B)

        // Walk away without copying or sharing it.
        backToPad()
        assertTrue("the envelope is gone from the UI", tagGone("envelope-output"))

        // The record stays spent — that is the loss — and the next send takes the
        // NEXT region rather than reusing the abandoned one.
        assertEquals("the material is still spent", 1L, spent.nextSequence)
        compose.onNodeWithTag("btn-send").performScrollTo().performClick()
        waitForTag("title-send")
        compose.onNodeWithTag("field-message").performScrollTo().performTextInput("the next one")
        compose.onNodeWithTag("btn-encrypt").performScrollTo().performClick()
        waitForTag("envelope-output")

        val after = engine().status(pairId).meters.getValue(Direction.A_TO_B)
        assertEquals("the next send took the next record", 2L, after.nextSequence)
        assertEquals(
            "and the next region, never the abandoned one",
            spent.nextOffset + "the next one".toByteArray().size,
            after.nextOffset,
        )
    }

    /* ---- refusals ------------------------------------------------------------- */

    @Test
    fun aRefusalReachesTheScreenWithTheEnginesOwnReason() {
        createPad("Refusals")
        compose.onNodeWithTag("btn-open").performScrollTo().performClick()
        waitForTag("title-open")
        compose.onNodeWithTag("field-envelope").performScrollTo().performTextInput("this is not an envelope")
        compose.onNodeWithTag("btn-do-open").performScrollTo().performClick()
        waitForTag("banner-refused")
        compose.onNodeWithTag("banner-refused").assertIsDisplayed()
        // Nothing was consumed by a malformed paste.
        val pairId = engine().listPairs().single()
        assertEquals(0L, engine().status(pairId).meters.getValue(Direction.B_TO_A).nextSequence)
    }

    /* ---- duplicate invocation --------------------------------------------------- */

    /**
     * DOUBLE TAP. Six taps as fast as the framework can deliver them must produce
     * exactly one send.
     *
     * Note what this proves and what it does not: the ViewModel's mutex stops the
     * later taps from queueing, but the GUARANTEE does not rest on it — the
     * engine's per-pair lock is what makes concurrent burns impossible, and the
     * JVM suite proves that directly with eight threads racing. This is the UI
     * half of the same property.
     */
    @Test
    fun aDoubleTapCannotSpendThePadTwice() {
        createPad("Double tap")
        val pairId = engine().listPairs().single()

        compose.onNodeWithTag("btn-send").performScrollTo().performClick()
        waitForTag("title-send")
        compose.onNodeWithTag("field-message").performScrollTo().performTextInput("only once")

        compose.onNodeWithTag("btn-encrypt").performScrollTo()
        repeat(6) { runCatching { compose.onNodeWithTag("btn-encrypt").performClick() } }
        waitForTag("envelope-output")
        compose.waitForIdle()

        val meters = engine().status(pairId).meters.getValue(Direction.A_TO_B)
        assertEquals("six taps must spend exactly one message slot", 1L, meters.nextSequence)
        assertEquals("only once".toByteArray().size.toLong(), meters.nextOffset)
    }

    /**
     * THE MUTEX ITSELF, tested where the button cannot mask it.
     *
     * `aDoubleTapCannotSpendThePadTwice` above drives the real UI, and it passes
     * whether or not the ViewModel holds a mutex — because the button disables
     * itself as soon as `busy` recomposes, and the test framework dispatches
     * clicks on the main thread, so the second tap never reaches the ViewModel.
     * That is a real defence, but it is the BUTTON's, and a future screen that
     * calls a verb from somewhere else would not have it.
     *
     * So this bypasses the button and issues two calls back to back, inside one
     * main-thread message, which is the window the mutex exists to close. The
     * engine would serialise them and spend TWO records — no reuse, but a
     * one-time pad two slots poorer for one message. Exactly one operation must
     * result.
     *
     * (Discovered by the falsification round: removing the mutex broke nothing,
     * which meant nothing was testing it.)
     */
    @Test
    fun twoCallsInOneInstantProduceOneOperation() {
        createPad("Mutex")
        val pairId = engine().listPairs().single()

        compose.activityRule.scenario.onActivity { activity ->
            val vm = androidx.lifecycle.ViewModelProvider(activity)[PadViewModel::class.java]
            // Both issued before either can complete: the mutex is the only
            // thing standing between this and two spent records.
            vm.send(pairId, Party2.A, "first")
            vm.send(pairId, Party2.A, "second")
        }
        compose.waitForIdle()
        compose.waitUntil(20_000) {
            engine().status(pairId).meters.getValue(Direction.A_TO_B).nextSequence >= 1L
        }
        // Give any second operation time to land before concluding it did not.
        Thread.sleep(1_500)

        val meters = engine().status(pairId).meters.getValue(Direction.A_TO_B)
        assertEquals("two immediate calls must spend exactly one message slot", 1L, meters.nextSequence)
        assertEquals("first".toByteArray().size.toLong(), meters.nextOffset)
    }

    /* ---- lifecycle ---------------------------------------------------------------- */

    /**
     * Activity recreation — rotation, theme change, the system reclaiming the
     * activity. The UI must come back from the ENGINE, not from a saved bundle.
     * Here the engine is moved BEHIND the UI's back, so a screen that restored
     * itself from its own memory would show the wrong number.
     */
    @Test
    fun stateComesBackFromTheEngineAfterRecreation() {
        createPad("Recreation")
        val pairId = engine().listPairs().single()
        engine().burn(pairId, Party2.A, "spent outside the UI".toByteArray())

        compose.activityRule.scenario.recreate()
        compose.waitForIdle()

        // The ViewModel legitimately survives recreation — that is what it is
        // for — so the operator comes back to the screen they were on. What must
        // NOT survive is a stale idea of how much pad is left: the counters are
        // reloaded from the engine on every resume.
        waitForTag("btn-send")
        assertEquals(1L, engine().status(pairId).meters.getValue(Direction.A_TO_B).nextSequence)
        compose.onNodeWithTag("title-pad").assertIsDisplayed()

        // And going Home lists the pad from the engine, not from memory.
        backToHome()
        compose.waitUntil(20_000) { compose.onAllNodesWithTag("pad-row").fetchSemanticsNodes().isNotEmpty() }
    }

    private fun backToHome() {
        while (tagGone("btn-create-pad")) {
            compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            compose.waitForIdle()
        }
    }

    /**
     * WHERE A PRODUCED ENVELOPE MAY AND MAY NOT LIVE.
     *
     * Surviving a rotation is correct — the ViewModel holds it in memory and
     * losing a just-encrypted message to a screen rotation would be a bug. What
     * must never happen is it reaching DURABLE storage: not the saved-instance
     * bundle, which the system persists and which outlives the process, and not
     * any file. It is spent material's only output, and it dies with the process.
     */
    @Test
    fun aProducedEnvelopeReachesNoDurableStore() {
        createPad("Not persisted")
        compose.onNodeWithTag("btn-send").performScrollTo().performClick()
        waitForTag("title-send")
        val secret = "a distinctive plaintext nobody else would write"
        compose.onNodeWithTag("field-message").performScrollTo().performTextInput(secret)
        compose.onNodeWithTag("btn-encrypt").performScrollTo().performClick()
        waitForTag("envelope-output")

        // 1. The saved-instance bundle is empty. onSaveInstanceState is written
        //    to disk by the system and survives into places this app does not
        //    control, so nothing at all is put in it.
        val bundle = android.os.Bundle()
        compose.activityRule.scenario.onActivity { activity ->
            activity.onSaveInstanceState(bundle, android.os.PersistableBundle())
        }
        assertTrue("nothing may be written to the saved-instance bundle", bundle.isEmpty)

        // 2. Neither the plaintext nor the envelope appears anywhere on disk.
        //    (The pad store holds ciphertext-producing MATERIAL, never the
        //    message and never the emitted envelope.)
        val dataDir = java.io.File(context.applicationInfo.dataDir)
        val offenders = dataDir.walkTopDown()
            .filter { it.isFile && it.length() < 4L * 1024 * 1024 }
            .filter { f -> runCatching { f.readBytes().toString(Charsets.ISO_8859_1) }.getOrDefault("").contains(secret) }
            .map { it.path }
            .toList()
        assertTrue("the plaintext must not be on disk anywhere: $offenders", offenders.isEmpty())

        // 3. It does survive a rotation, which is the correct behaviour.
        compose.activityRule.scenario.recreate()
        compose.waitForIdle()
        waitForTag("envelope-output")
    }

    /* ---- FLAG_SECURE ---------------------------------------------------------------- */

    @Test
    fun theWindowIsSecureAndStaysSecure() {
        compose.activityRule.scenario.onActivity { activity ->
            assertTrue(
                "FLAG_SECURE must be set before the first frame",
                activity.window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE != 0,
            )
        }
        compose.activityRule.scenario.recreate()
        compose.waitForIdle()
        compose.activityRule.scenario.onActivity { activity ->
            assertTrue(
                "FLAG_SECURE must survive recreation",
                activity.window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE != 0,
            )
        }
    }

    /* ---- accessibility ---------------------------------------------------------------- */

    /**
     * Every interactive control on the primary journey must carry a label a
     * screen reader can announce and a target big enough to hit.
     */
    @Test
    fun thePrimaryJourneyIsLabelledAndReachable() {
        waitForTag("title-home")
        val density = compose.activity.resources.displayMetrics.density
        for (tag in listOf("btn-create-pad", "btn-add-pad")) {
            val node = compose.onNodeWithTag(tag).fetchSemanticsNode()
            val text = node.config.getOrNull(SemanticsProperties.Text)
            val desc = node.config.getOrNull(SemanticsProperties.ContentDescription)
            assertTrue("$tag must carry a label", !text.isNullOrEmpty() || !desc.isNullOrEmpty())
            val heightDp = node.size.height / density
            assertTrue("$tag must be at least 48dp tall, was ${heightDp}dp", heightDp >= 47.5f)
        }
        // Headings are marked as headings, so TalkBack can navigate by them.
        assertTrue(
            "the screen title must be a heading",
            compose.onNodeWithTag("title-home").fetchSemanticsNode().config.contains(SemanticsProperties.Heading),
        )
    }

    /**
     * The whole row of a radio choice is the target, not the 20dp dot inside it,
     * and it announces as a radio button. A label you can read but not tap is an
     * accessibility failure and an ordinary usability one.
     */
    @Test
    fun choiceRowsAreFullWidthTargetsWithARole() {
        waitForTag("title-home")
        compose.onNodeWithTag("btn-create-pad").performScrollTo().performClick()
        waitForTag("title-create")

        val density = compose.activity.resources.displayMetrics.density
        for (tag in listOf("size-Small", "size-Medium", "size-Large", "radio-device", "radio-external")) {
            val node = compose.onNodeWithTag(tag).fetchSemanticsNode()
            assertEquals(
                "$tag must announce as a radio button",
                androidx.compose.ui.semantics.Role.RadioButton,
                node.config.getOrNull(SemanticsProperties.Role),
            )
            assertTrue("$tag must be at least 48dp tall", node.size.height / density >= 47.5f)
            // Full width, not a 20dp dot: at least half the screen.
            assertTrue(
                "$tag must be a full-width target",
                node.size.width > compose.activity.resources.displayMetrics.widthPixels / 2,
            )
        }
        // Tapping the LABEL selects the option.
        compose.onNodeWithTag("size-Large").performScrollTo().performClick()
        assertEquals(
            true,
            compose.onNodeWithTag("size-Large").fetchSemanticsNode()
                .config.getOrNull(SemanticsProperties.Selected),
        )
    }

    /**
     * The long, raw envelope is NOT read out character by character; it is
     * offered as one labelled unit and the buttons are how it is used.
     */
    @Test
    fun theEnvelopeIsNotSpelledOutToAScreenReader() {
        createPad("Semantics")
        compose.onNodeWithTag("btn-send").performScrollTo().performClick()
        waitForTag("title-send")
        compose.onNodeWithTag("field-message").performScrollTo().performTextInput("hello")
        compose.onNodeWithTag("btn-encrypt").performScrollTo().performClick()
        waitForTag("envelope-output")

        val node = compose.onNodeWithTag("envelope-output").fetchSemanticsNode()
        val desc = node.config.getOrNull(SemanticsProperties.ContentDescription)
        assertTrue("the envelope must have a summary description", !desc.isNullOrEmpty())
        assertTrue(
            "and must not expose the raw envelope as readable text",
            node.config.getOrNull(SemanticsProperties.Text).isNullOrEmpty(),
        )
        assertFalse(desc!!.first().contains("formatVersion"))
    }
}

private fun <T> androidx.compose.ui.semantics.SemanticsConfiguration.getOrNull(
    key: androidx.compose.ui.semantics.SemanticsPropertyKey<T>,
): T? = if (contains(key)) this[key] else null
