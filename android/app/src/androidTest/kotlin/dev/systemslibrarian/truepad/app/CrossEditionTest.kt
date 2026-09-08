package dev.systemslibrarian.truepad.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.SystemClock
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.systemslibrarian.truepad.core.COMPACT_PREFIX
import dev.systemslibrarian.truepad.storage.Party2
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/**
 * THE ANDROID HALF OF THE ANDROID↔iPHONE EXCHANGE.
 *
 * THE INVARIANT, which an earlier version of this file got exactly backwards:
 *
 *   All Android steps whose accumulated state is part of the proof execute in ONE
 *   instrumentation invocation. Host orchestration may bracket that invocation to
 *   exchange artifacts with the physical iOS device.
 *
 * This file previously said "STORAGE IS NOT WIPED. Each step is a separate
 * `connectedAndroidTest` invocation, and the state they build up is the point."
 * That is false and cost a run: every invocation reinstalls the app, which wipes
 * its data, so a pad received in one step was gone by the next. The whole Android
 * half therefore lives in `crossEditionExchange`, which pauses at file-based
 * checkpoints while the iPhone does its parts.
 *
 * WHAT IS REAL HERE AND WHAT IS SCRIPTED. Every decision that carries security
 * happens in the actual interface on the actual handset: publishing a one-time
 * receive code, reading the eight confirmation words, committing the pad, writing
 * and opening messages. The ONE thing scripted is carrying bytes between the two
 * phones — handing a sealed file from an iPhone to an Android is a courier's job,
 * and in this test the courier is the harness rather than a person with AirDrop.
 * The bytes one edition produced are the bytes the other consumes; nothing is
 * re-created on either side, and `scripts/cross-edition-physical.sh` hashes each
 * artifact before and after the carry to prove it.
 *
 * THIS IS NOT A RERUN OF THE SPT VALIDATION CAMPAIGN. It performs one ordinary
 * transfer because the two devices need a pad in common before a message written
 * on one can be opened on the other.
 */
@RunWith(AndroidJUnit4::class)
class CrossEditionTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val args = InstrumentationRegistry.getArguments()

    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    // A GENEROUS DEFAULT. This handset re-reads the store from the engine after
    // every operation, and a pad screen rebuilt after a send can take longer than
    // thirty seconds when the store has accumulated pads from earlier runs.
    private fun awaitTag(tag: String, timeoutMs: Long = 90_000) {
        compose.waitUntil(timeoutMs) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun has(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()

    /**
     * The courier's drop box: one tagged log line, read back with `adb logcat`.
     *
     * Not a file. This handset carries a managed profile, and the package is not
     * visible to `run-as` from the shell's user, so a file written by the app is
     * unreachable by the harness that has to carry it. Android 11 onwards also
     * blocks `adb shell` from `/sdcard/Android/data/<pkg>`.
     *
     * THIS IS TEST CODE, NOT SHIPPING CODE. `AppSourceAuditTest` bans every
     * logging call in `src/main/kotlin` and that ban is untouched; this file is in
     * `androidTest`. And ONLY PUBLIC TRANSPORT MATERIAL is ever passed here — a
     * `TPR2:` request or a `TP2:` envelope, both of which are public by
     * classification. No plaintext and no pad material: an opened message is
     * checked in memory and only its verdict leaves this process.
     */
    private fun out(name: String, text: String) {
        android.util.Log.i("TP-COURIER", "$name=$text")
    }

    /**
     * What is on the clipboard right now. `null` means it could not be READ — no
     * primary clip, or no item — which on Android is a different thing from an
     * empty string: an app without window focus is refused the read rather than
     * handed nothing.
     */
    private fun readClipboard(): String? {
        var text: String? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
        }
        return text
    }

    /** Best effort; a platform that refuses the write is reported, not fatal. */
    private fun seedClipboard(sentinel: String): Boolean =
        try {
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("truepad-test-sentinel", sentinel))
            }
            readClipboard() == sentinel
        } catch (t: Throwable) {
            false
        }

    /**
     * Click a real Copy control and wait, WITH A DEADLINE, for the clipboard to
     * actually change into something carrying [expectedPrefix].
     *
     * THE SAME REPAIR `FixedRecordSmokeTest` ALREADY CARRIES, applied here because
     * this file had the identical defect. `performClick` returns when the click is
     * DISPATCHED, not when the handler's clipboard write has landed; the immediate
     * read this replaces came back EMPTY on a CI emulator and failed a release for
     * a reason that was not about TruePad.
     *
     * AND WHY IT COMPARES AGAINST THE PRE-CLICK VALUE, not just the sentinel. This
     * ceremony copies SEVERAL times — a receive code, then an envelope, then
     * another envelope. If the seed were the only guard and the platform ever
     * refused it, a later wait would find an EARLIER copy still sitting there,
     * correctly prefixed and completely wrong, and return it as though Copy had
     * just delivered it. Requiring a change from what was there before the click
     * catches a missing Copy either way.
     */
    private fun copyAndAwait(
        tag: String,
        expectedPrefix: String,
        timeoutMs: Long = 15_000,
    ): String {
        val sentinel = "truepad-clipboard-sentinel-" + UUID.randomUUID()
        val seeded = seedClipboard(sentinel)
        val before = readClipboard()

        compose.onNodeWithTag(tag).performScrollTo().performClick()
        compose.waitForIdle()

        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = before
        while (SystemClock.uptimeMillis() < deadline) {
            last = readClipboard()
            val value = last
            val changed = value != null && value.isNotEmpty() && value != before && value != sentinel
            if (changed && value.startsWith(expectedPrefix)) return value
            SystemClock.sleep(50)
        }

        // NEVER THE CONTENT. What is here should be public transport, but a
        // harness that prints clipboards into a log is one product defect away
        // from printing a plaintext into one. Report the SHAPE only.
        fail(
            "$tag did not deliver a $expectedPrefix value within ${timeoutMs}ms. " +
                "sentinel seeded=$seeded, " +
                "clipboard unreadable=${last == null}, " +
                "clipboard unchanged since before the click=${last == before}, " +
                "clipboard still the sentinel=${last == sentinel}, " +
                "clipboard empty=${last?.isEmpty()}, " +
                "length=${last?.length}, " +
                "carries $expectedPrefix=${last?.startsWith(expectedPrefix)}",
        )
        error("unreachable")
    }

    /** The same instance the composition uses: `viewModel()` stores it on the activity. */
    private fun viewModel(): PadViewModel =
        ViewModelProvider(compose.activity)[PadViewModel::class.java]

    // ---- THE WHOLE ANDROID HALF, IN ONE INVOCATION -------------------------

    /**
     * ONE INVOCATION, BECAUSE EVERY INVOCATION REINSTALLS.
     *
     * Invoked by name from `scripts/cross-edition-physical.sh`, which installs the
     * app ONCE and then runs this through `am instrument` — not through
     * `connectedAndroidTest`, which would reinstall and wipe the pad this test
     * spends most of its time acquiring.
     *
     * WHAT IS REAL AND WHAT IS SCRIPTED. Publishing a one-time code, reading the
     * eight confirmation words, committing the pad, writing messages and opening
     * them all happen in the interface on the handset. The harness is the courier
     * and nothing else: it carries public transport material between two phones,
     * which is the job a person does with AirDrop.
     */
    @Test
    @CrossEditionStep
    fun crossEditionExchange() {
        val drop = args.getString("drop") ?: "/data/local/tmp"
        val waitMs = (args.getString("waitSeconds") ?: "900").toLong() * 1000

        fun awaitFile(name: String): File {
            val f = File(drop, name)
            val deadline = System.currentTimeMillis() + waitMs
            while (System.currentTimeMillis() < deadline && !f.isFile) Thread.sleep(2_000)
            assertTrue("the courier never delivered $name", f.isFile)
            return f
        }

        // ---- 1. publish ONE fresh receive code ----
        awaitTag("bottom-nav")
        compose.onNodeWithTag("tab-Inbox").performClick()
        var guard = 0
        while (has("btn-cancel-receive-code") && guard < 6) {
            compose.onNodeWithTag("btn-cancel-receive-code").performClick()
            compose.waitForIdle()
            guard += 1
        }
        awaitTag("btn-create-receive-code")
        compose.onNodeWithTag("btn-create-receive-code").performClick()
        awaitTag("receive-code-output", 60_000)
        val code = copyAndAwait("btn-copy-receive-code", "TPR2:")
        // Redundant by construction — the wait only returns on this prefix — and
        // kept because it bites again the moment the wait's condition is loosened.
        assertTrue("Copy code did not hand over a TPR2 request", code.startsWith("TPR2:"))
        out("tpr2", code)

        // ---- 2. take delivery of the sealed pad ----
        val pkg = awaitFile("transfer.tps2")
        compose.runOnUiThread { viewModel().openReceivedPackage(Uri.fromFile(pkg)) }

        val until = System.currentTimeMillis() + 120_000
        while (System.currentTimeMillis() < until && !has("receive-confirm-words")) {
            viewModel().state.value.banner?.let {
                out("open-refusal", it.toString().take(300)); return@let
            }
            Thread.sleep(1_000)
        }
        assertTrue(
            "the eight confirmation words were not shown; banner=" +
                viewModel().state.value.banner.toString().take(200),
            has("receive-confirm-words"),
        )
        compose.onNodeWithTag("field-receive-name").performScrollTo().performTextInput("from-iphone")
        compose.onNodeWithTag("btn-commit-receive").performScrollTo().performClick()

        // COMMIT OPENS THE PAD; it does not return to the list.
        awaitTag("btn-send", 120_000)
        val received = viewModel().state.value
        assertTrue("no pad arrived", received.pads.isNotEmpty())
        // THE ROLE IS DERIVED FROM HOW THE PAD ARRIVED, never defaulted. A pad that
        // came by sealed transfer makes this device party B.
        assertTrue("the received pad derived no role", received.roleWasDerived)
        assertEquals("a received pad must be party B", Party2.B, received.role)
        out("role", received.role?.name ?: "UNKNOWN")

        // ---- 3. Android → iPhone, as TP2 and as canonical JSON ----
        val (tp2, _) = sendAndCopy("hello from the Samsung")
        assertTrue("the displayed message is not the compact form", tp2.startsWith(COMPACT_PREFIX))
        out("android-tp2", tp2)

        // A SECOND MESSAGE for the canonical spelling. A record is one-time, so
        // opening both spellings of the SAME message would be refused — correctly
        // — and would prove nothing about the spelling.
        //
        // THE APP'S OWN CANONICAL ENVELOPE, the same string its "Technical form"
        // disclosure displays. Not rebuilt by the harness.
        val (_, json) = sendAndCopy("the second one, in canonical form")
        assertTrue("no canonical envelope was produced", json.startsWith("{"))
        out("android-json", json)

        // ---- 4. iPhone → Android, in BOTH spellings ----
        val fromPhone = awaitFile("iphone-tp2.txt").readText().trim()
        assertTrue("the iPhone did not send a compact envelope", fromPhone.startsWith(COMPACT_PREFIX))
        assertEquals(
            "the iPhone's compact message did not open to what it sent",
            args.getString("expect") ?: "hello from the iPhone",
            openEnvelope(fromPhone),
        )
        out("opened-tp2", "ok")

        val phoneJson = awaitFile("iphone-json.txt").readText().trim()
        assertTrue("the iPhone did not send a canonical envelope", phoneJson.startsWith("{"))
        assertEquals(
            "the iPhone's canonical JSON did not open to what it sent",
            args.getString("expectJson") ?: "the iPhone in canonical form",
            openEnvelope(phoneJson),
        )
        out("opened-json", "ok")
    }

    /** Open one envelope through the real UI and return the plaintext it yielded. */
    private fun openEnvelope(envelope: String): String? {
        awaitTag("btn-open")
        compose.onNodeWithTag("btn-open").performClick()
        awaitTag("field-envelope")
        compose.onNodeWithTag("field-envelope").performTextInput(envelope)
        compose.onNodeWithTag("btn-do-open").performScrollTo().performClick()
        awaitTag("plaintext-output", 90_000)
        val opened = (viewModel().state.value.lastResult as? OpResult.Opened)?.plaintext
        // BY TEXT, NOT BY TAG. Only the SEND screen's "Back to pad" carries a test
        // tag; the OPEN screen has its own untagged one, and reaching for the tag
        // here failed after a perfectly successful open — losing the result of the
        // very thing this step exists to prove. Adding a second product tag to suit
        // a test is the wrong direction, so this matches what is on screen.
        compose.onAllNodesWithText("Back to pad", substring = true).onFirst()
            .performScrollTo().performClick()
        awaitTag("btn-send", 90_000)
        return opened
    }

    /**
     * Write a message through the UI and return BOTH spellings of it: exactly what
     * Copy handed over, and the canonical envelope the same screen offers under
     * "Technical form".
     *
     * BOTH ARE READ BEFORE LEAVING. "Back to pad" calls `clearResult()`, so the
     * canonical envelope is gone the moment the screen is left — reading it
     * afterwards returned nothing and cost this exchange a run.
     */
    private fun sendAndCopy(message: String): Pair<String, String> {
        awaitTag("btn-send")
        compose.onNodeWithTag("btn-send").performClick()
        awaitTag("field-message")
        compose.onNodeWithTag("field-message").performTextInput(message)
        compose.onNodeWithTag("btn-encrypt").performScrollTo().performClick()
        awaitTag("envelope-output", 60_000)
        val copied = copyAndAwait("btn-copy-envelope", COMPACT_PREFIX)
        val canonical = (viewModel().state.value.lastResult as? OpResult.Sent)?.envelope ?: ""
        compose.onNodeWithTag("btn-back-to-pad").performScrollTo().performClick()
        awaitTag("btn-send", 90_000)
        return copied to canonical
    }
}
