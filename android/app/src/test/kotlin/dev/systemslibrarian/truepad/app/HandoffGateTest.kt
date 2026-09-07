package dev.systemslibrarian.truepad.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A PAD THAT HAS ALREADY BEEN GIVEN AWAY IS NOT OFFERED AGAIN.
 *
 * The pad screen rendered "Share this pad" and BOTH of its routes for every pad,
 * with no reference to the pad's durable handoff state — the only edition of the
 * three whose interface never asked. What that cost differs by route, and the
 * cheaper-sounding half is the one that matters:
 *
 *   · SEALED — the engine refuses under the pair lock, so nothing was ever
 *     duplicated. But the refusal arrives only after the other person has
 *     generated a receive code, sent it, and both have compared twelve words out
 *     loud. Nothing is unsafe; a good deal is wasted, and the operator is told
 *     "no" at the last possible moment.
 *
 *   · PHYSICAL — NOT backstopped. `exportPair` refuses `Sealed` and
 *     `UnreadableSpent` and lets a pad carrying a `Physical` marker through, so a
 *     second raw pad file really is written. The sentence under that very button
 *     reads "A pad can be given only once, whichever way you choose", and for
 *     that case it was a promise the engine does not keep. Withholding the offer
 *     is what makes the sentence true.
 *
 * `PadViewModel` is an `AndroidViewModel` and cannot be constructed on the JVM, so
 * the wiring is read from the sources. [HandoffPolicy] is pure and is exercised
 * directly. Every source assertion carries a positive control.
 */
class HandoffGateTest {

    private fun read(rel: String) = File(rel).readText()
    private fun code(text: String) =
        text.lineSequence().map { it.substringBefore("//") }.joinToString("\n")

    private val viewModel = code(read("src/main/kotlin/dev/systemslibrarian/truepad/app/PadViewModel.kt"))
    private val screens = code(read("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Screens.kt"))
    private val policy = read("src/main/kotlin/dev/systemslibrarian/truepad/app/HandoffPolicy.kt")
    private val iosPolicy = read("../../ios/TruePadKit/Sources/TruePadUI/Presentation.swift")

    @Test
    fun `this test read the files it thinks it read`() {
        assertTrue(viewModel.length > 5000)
        assertTrue(screens.length > 5000)
        assertTrue(policy.contains("object HandoffPolicy"))
        assertTrue(iosPolicy.contains("public enum HandoffPolicy"))
    }

    /* ---- the policy itself -------------------------------------------------- */

    @Test
    fun `a pad that has been handed over may not be exported again`() {
        assertTrue(HandoffPolicy.mayExportRawPad(handedOver = false, imported = false))
        assertFalse(HandoffPolicy.mayExportRawPad(handedOver = true, imported = false))
    }

    @Test
    fun `an imported pad is never passed on by either route`() {
        assertFalse(HandoffPolicy.mayExportRawPad(handedOver = false, imported = true))
        assertFalse(HandoffPolicy.mayReshareSealedPackage(sealed = true, imported = true))
    }

    @Test
    fun `only a sealed pad may re-offer its committed package`() {
        assertTrue(HandoffPolicy.mayReshareSealedPackage(sealed = true, imported = false))
        // Never for one handed over physically, and never for one whose state
        // cannot be read — both reach here as sealed = false.
        assertFalse(HandoffPolicy.mayReshareSealedPackage(sealed = false, imported = false))
    }

    @Test
    fun `the two questions stay separate, because collapsing them stranded pads`() {
        // Sealing writes the package to disk. An operator who dismissed the sheet
        // before saving the file needs it back; the RAW pad stays blocked either
        // way, which is the part that matters for reuse.
        val sealed = true
        assertFalse("the raw pad must stay blocked after a seal",
                    HandoffPolicy.mayExportRawPad(handedOver = sealed, imported = false))
        assertTrue("the committed package must stay reachable after a seal",
                   HandoffPolicy.mayReshareSealedPackage(sealed = sealed, imported = false))
    }

    /* ---- the wiring --------------------------------------------------------- */

    @Test
    fun `eligibility is asked of the engine and fails closed`() {
        assertTrue("the view model never asks the engine for the handoff state",
                   viewModel.contains("engine.handoffState("))
        assertTrue("a handoff state that could not be read must not permit a handoff",
                   viewModel.contains("val mayHandOff = handoff is HandoffState.Absent &&"))
        assertTrue(viewModel.contains("val mayReshareSealed = handoff is HandoffState.Sealed &&"))
        // FAIL-CLOSED DEFAULTS. A state that has not been computed yet must not
        // read as permission.
        assertTrue(viewModel.contains("val mayHandOff: Boolean = false"))
        assertTrue(viewModel.contains("val mayReshareSealed: Boolean = false"))
    }

    @Test
    fun `every handoff state gets its own sentence`() {
        for (state in listOf("HandoffState.Physical", "HandoffState.Sealed", "HandoffState.UnreadableSpent")) {
            assertTrue("no refusal sentence for $state", viewModel.contains(state))
        }
        assertTrue(viewModel.contains("was already handed over on"))
        assertTrue(viewModel.contains("was already sent by sealed transfer"))
        // THE ADVICE, NOT THE EXCEPTION. `UnreadableSpent.message` is
        // UNREADABLE_ADVICE with a platform exception string appended, and a
        // platform string can carry a path, and a path can carry a pairId —
        // exactly what `operate`'s own catch refuses to put on screen. The advice
        // is the part that tells the operator what TruePad will not do.
        assertTrue("an unreadable marker must speak the engine's standing advice",
                   viewModel.contains("handoff is HandoffState.UnreadableSpent -> UNREADABLE_ADVICE"))
        assertFalse("a raw platform exception string reaches the pad screen",
                    viewModel.contains("UnreadableSpent -> handoff.message"))
    }

    @Test
    fun `the pad screen gates both routes on that answer`() {
        assertTrue("the share section is unconditional again",
                   screens.contains("if (state.mayHandOff) {"))
        // The one-handoff sentence may appear ONLY inside the gated branch: it is
        // the claim the gate exists to make true.
        val gated = screens.substringAfter("if (state.mayHandOff) {").substringBefore("} else {")
        assertTrue(gated.contains("btn-share-sealed"))
        assertTrue(gated.contains("btn-give-pad"))
        assertTrue(gated.contains("A pad can be given only once, whichever way you choose"))
        assertEquals(
            "the one-handoff promise appears outside the branch that makes it true",
            1,
            screens.split("A pad can be given only once, whichever way you choose").size - 1,
        )
        // And the refused branch says why, and still reaches a committed package.
        // ANCHORED TO THIS SECTION. `substringAfter("} else {")` finds the FIRST
        // else in the file, which is a different screen entirely — the same
        // file-scoped-search defect this candidate found in the iOS sibling.
        val refused = screens.substringAfter("if (state.mayHandOff) {")
            .substringAfter("} else {").substringBefore("Rule()")
        assertTrue(refused.contains("state.handOffRefusal"))
        assertTrue(refused.contains("state.mayReshareSealed"))
        assertTrue(refused.contains("btn-reshare-sealed"))
    }

    @Test
    fun `the screen that performs the handoff is gated too`() {
        // THE GATE WAS ON THE OFFER, NOT ON THE ACT. `GivePadScreen` is what
        // actually writes the pad file, and nothing in it read `mayHandOff`;
        // `exportPad` did not navigate away on success either. So: save, banner,
        // screen unchanged, save again under a second name. `exportPair` lets a
        // re-export through under an existing Physical marker, so two
        // byte-identical raw copies really were produced — under a callout
        // promising the pad "can be handed over a single time". No race needed.
        val spt = code(read("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/SptScreens.kt"))
        val give = spt.substringAfter("fun GivePadScreen(").substringBefore("\nfun ")
        assertTrue("GivePadScreen is ungated", give.contains("if (!state.mayHandOff) {"))
        assertTrue("the refused branch does not say why", give.contains("state.handOffRefusal"))
        // The gate must come BEFORE the controls it guards, or it guards nothing.
        assertTrue(
            "the file control is offered above the gate",
            give.indexOf("if (!state.mayHandOff)") < give.indexOf("btn-give-file"),
        )
        assertTrue(
            "the sealed control is offered above the gate",
            give.indexOf("if (!state.mayHandOff)") < give.indexOf("btn-give-sealed"),
        )
        // And a completed export leaves the screen that performed it.
        assertTrue(
            "exportPad leaves the operator on the Give screen with its save control live",
            viewModel.contains("dropLastWhile { it != Screen.Pad }"),
        )
    }

    @Test
    fun `a failed delivery is not turned into permanent loss`() {
        // The engine deliberately permits a re-export under an existing Physical
        // marker — a save can be cancelled at the picker or land on a full disk —
        // and keeps the time of the FIRST handoff. Gating the screen without an
        // equivalent would impose loss the engine had chosen not to.
        assertTrue(viewModel.contains("val mayResavePhysical = handoff is HandoffState.Physical"))
        assertTrue(viewModel.contains("val mayResavePhysical: Boolean = false"))
        val spt = code(read("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/SptScreens.kt"))
        assertTrue("there is no way back to a delivery that failed",
                   spt.contains("btn-resave-file"))
        // And it must not be dressed up as a second handoff.
        val give = spt.substringAfter("fun GivePadScreen(").substringBefore("\nfun ")
        assertTrue(give.contains("this is not a second handoff"))
    }

    @Test
    fun `eligibility does not survive a change of pad`() {
        // The flags are single global slots and `refresh()` is asynchronous, so
        // without this the new pad's screen drew with the OLD pad's answer — a pad
        // already handed over could show a live "Give this pad to someone" for as
        // long as the reload took.
        val openPad = viewModel.substringAfter("fun openPad(").substringBefore("\n    /**")
        for (reset in listOf("current = null", "mayHandOff = false",
                             "mayReshareSealed = false", "handOffRefusal = null")) {
            assertTrue("openPad does not clear $reset", openPad.contains(reset))
        }
        // And a slower reload must not land under a newer selection.
        assertTrue("refresh writes unconditionally; a stale reload can overwrite a newer pad",
                   viewModel.contains("if (_state.value.currentPairId != open) return@launch"))
    }

    /* ---- one rule, two editions --------------------------------------------- */

    @Test
    fun `the policy says the same thing on both mobile editions`() {
        // The RULE is the part that must not drift. Both spell it as two separate
        // predicates with the same names and the same bodies.
        assertTrue(policy.contains("!handedOver && !imported"))
        assertTrue(iosPolicy.contains("!handedOver && !imported"))
        assertTrue(policy.contains("sealed && !imported"))
        assertTrue(iosPolicy.contains("sealed && !imported"))
        assertTrue(policy.contains("fun mayExportRawPad("))
        assertTrue(iosPolicy.contains("func mayExportRawPad("))
    }
}

/**
 * THE CREATE FORM MUST NOT SILENTLY BECOME A DIFFERENT FORM.
 *
 * Every field of `CreatePadScreen` was a `remember { }`. The tab shell parks BACK
 * STACKS, not compositions: leaving the Pads tab removes the screen from the tree
 * and discards everything remembered in it, and returning restores a stack whose
 * top still reads `Screen.CreatePad`. So the operator came back to what looked
 * like the screen they left, with every value at its default.
 *
 * One of those defaults decides where the pad's material comes from. An operator
 * who had selected "Use external random material", chosen their files and ticked
 * the declaration returned to a form set to "Generate for me" — with the Create
 * button live, because `ready` only demands the declaration and the files WHEN
 * `external` is true. Material must never be quietly substituted for what the
 * operator selected.
 *
 * `CreateForm` is a plain data class and is exercised directly. The wiring is read
 * from the sources, because `PadViewModel` is an `AndroidViewModel`.
 */
class CreateFormLifetimeTest {

    private fun read(rel: String) = File(rel).readText()
    private fun code(text: String) =
        text.lineSequence().map { it.substringBefore("//") }.joinToString("\n")

    private val screens = code(read("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Screens.kt"))
    private val viewModel = code(read("src/main/kotlin/dev/systemslibrarian/truepad/app/PadViewModel.kt"))

    /** Just the create screen: `AddPadScreen` carries some of the same lines. */
    private val createScreen = screens
        .substringAfter("fun CreatePadScreen(state: UiState, vm: PadViewModel) {")
        .substringBefore("fun AddPadScreen(")

    @Test
    fun `this test read the screen it thinks it read`() {
        assertTrue(createScreen.length > 2000)
        assertTrue(createScreen.contains("btn-submit-create"))
        assertTrue(viewModel.contains("data class CreateForm("))
    }

    @Test
    fun `the default form generates nothing until the operator has chosen`() {
        val f = CreateForm()
        assertFalse("a fresh form must not start out claiming external material", f.external)
        assertFalse(f.declared)
        assertTrue(f.picked.isEmpty())
        assertEquals("", f.label)
        assertEquals(PadSize.Medium, f.size)
        assertFalse(f.fixedLength)
    }

    @Test
    fun `an external selection is not a device selection`() {
        // The exact state a tab switch used to discard, and what it used to
        // become. `external` going false is the whole defect: `ready` stops
        // demanding the declaration and the files, and Create makes a
        // device-CSPRNG pad.
        val chosen = CreateForm(external = true, declared = true, origin = "dice")
        assertTrue(chosen.external)
        assertFalse("the default form is indistinguishable from a chosen one",
                    chosen == CreateForm())
    }

    @Test
    fun `the create screen holds no remembered form state of its own`() {
        for (field in listOf("var label by remember", "var external by remember",
                             "var declared by remember", "var picked by remember",
                             "var fixedLength by remember", "var size by remember")) {
            assertFalse(
                "CreatePadScreen keeps \"$field\" in the composition, which a tab switch discards",
                createScreen.contains(field),
            )
        }
        assertTrue("the screen no longer reads the form from the view model",
                   createScreen.contains("val form = state.create"))
        assertTrue("the screen no longer writes the form back",
                   createScreen.contains("vm.updateCreate {"))
    }

    @Test
    fun `the form survives a tab switch and does not survive the pad it made`() {
        // `selectTab` and `movedTo` copy UiState, so anything held there is
        // carried across a park by construction — and neither may clear it.
        for (verb in listOf("fun selectTab(", "private fun UiState.movedTo(")) {
            val body = viewModel.substringAfter(verb).substringBefore("\n    }")
            assertFalse("$verb resets the create form; a tab switch must not",
                        body.contains("create = CreateForm()"))
        }
        // But a completed create must clear it, or the next one starts pre-filled
        // with the last pad's name and the last pad's source files.
        assertEquals(
            "both create paths must spend the form",
            2,
            viewModel.split("resetCreateForm()").size - 1 - 1,
        )
        assertTrue(viewModel.contains("fun resetCreateForm()"))
    }
}
