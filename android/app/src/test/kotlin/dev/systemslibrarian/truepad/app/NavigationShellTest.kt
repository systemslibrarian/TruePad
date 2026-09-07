package dev.systemslibrarian.truepad.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * THE THREE PERSISTENT DESTINATIONS, AND THE ONE THING A TAB SWITCH MUST NOT DO.
 *
 * This edition had a single back stack and no About destination at all, so its
 * claims boundary was readable only in the documentation. Bringing it to the
 * iPhone's shape is mostly presentation — except for one part that is not.
 *
 * `back()` deliberately drops the transient sealed-transfer session, because that
 * session may hold a decrypted pad and must never outlive the flow that produced
 * it. `navigate()` clears the banner. If a tab switch went through either, then
 * glancing at About in the middle of receiving a pad would silently destroy the
 * ceremony — a one-time receive request is exactly the thing that must not be
 * thrown away by a stray tap. `selectTab` therefore parks and restores stacks and
 * touches nothing else, and that is what is asserted here.
 */
class NavigationShellTest {

    private val vmSource =
        File("src/main/kotlin/dev/systemslibrarian/truepad/app/PadViewModel.kt").readText()
    private val rootSource =
        File("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/TruePadRoot.kt").readText()
    private val components =
        File("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Components.kt").readText()

    // MARK: the destinations exist and are the iPhone's

    @Test
    fun thereAreExactlyThreeTopLevelDestinations() {
        assertEquals(3, Tab.entries.size)
        assertEquals(listOf("Pads", "Inbox", "About"), Tab.entries.map { it.label })
    }

    /**
     * THE LABELS ARE THE iOS ONES, VERBATIM. The two editions are meant to read as
     * one product, and iOS is the authority for what these destinations mean.
     */
    @Test
    fun theLabelsMatchTheIphoneEdition() {
        val ios = File("../../ios/TruePadKit/Sources/TruePadUI/RootView.swift").readText()
        // POSITIVE CONTROL: the iOS root really loaded.
        assertTrue("the iOS root view did not load", ios.contains("TruePadRootView"))
        for (tab in Tab.entries) {
            assertTrue(
                "iOS has no \"${tab.label}\" tab, so this edition invented a destination",
                ios.contains("Label(\"${tab.label}\""),
            )
        }
    }

    @Test
    fun eachDestinationHasItsOwnRoot() {
        assertEquals(Screen.Home, Tab.Pads.root)
        assertEquals(Screen.ReceivePad, Tab.Inbox.root)
        assertEquals(Screen.About, Tab.About.root)
        // Every root is a real destination the shell can render.
        for (tab in Tab.entries) {
            assertTrue(rootSource.contains("Screen.${tab.root.name} ->"))
        }
    }

    // MARK: the switch is not a navigation step

    @Test
    fun switchingTabsDoesNotClearTheCeremonyOrTheBanner() {
        // SLICED AT THE NEXT DECLARATION OF ANY KIND. `substringBefore("\n    fun ")`
        // does not match the `private fun UiState.movedTo(` that immediately
        // follows, so the slice swallowed that helper — and the helper says
        // `parked` three times, which made the "it parks the outgoing stack"
        // assertion below true whatever `selectTab` did.
        val body = vmSource.substringAfter("fun selectTab(")
            .substringBefore("\n    private fun ")
            .substringBefore("\n    fun ")
        assertTrue("selectTab is gone", body.isNotBlank())

        assertFalse(
            "selectTab resets the sealed-transfer session — a tab switch would cancel a receive " +
                "ceremony the operator is halfway through",
            body.contains("spt = SptUi()"),
        )
        assertFalse("selectTab clears the banner", body.contains("banner = null"))
        assertFalse("selectTab drops the last result", body.contains("lastResult = null"))
        assertFalse("selectTab forgets which pad is open", body.contains("currentPairId = null"))
        // It must park the outgoing stack rather than discard it.
        assertTrue("selectTab does not preserve the stack it is leaving", body.contains("parked"))
    }

    /**
     * ARRIVING AT THE INBOX SURFACES A REQUEST THAT SURVIVED.
     *
     * A receive request is durable and one-time. The old route in called
     * `startReceive()`, which restores it; the tab does not, and for one build
     * that stranded a live key — pending on disk, uncancellable, and unable to
     * open the sealed file that came back for it. The two-device run caught it.
     */
    @Test
    fun selectingTheInboxRestoresAPendingReceiveRequest() {
        // SLICED AT THE NEXT DECLARATION OF ANY KIND. `substringBefore("\n    fun ")`
        // does not match the `private fun UiState.movedTo(` that immediately
        // follows, so the slice swallowed that helper — and the helper says
        // `parked` three times, which made the "it parks the outgoing stack"
        // assertion below true whatever `selectTab` did.
        val body = vmSource.substringAfter("fun selectTab(")
            .substringBefore("\n    private fun ")
            .substringBefore("\n    fun ")
        assertTrue(
            "selecting the Inbox does not pick up a request that survived, so a live one-time " +
                "key can be stranded with no way to reach it",
            body.contains("restorePendingReceiveRequest()"),
        )
        // And the restore still refuses to displace a session in progress.
        val restore = vmSource.substringAfter("private fun restorePendingReceiveRequest()")
            .substringBefore("\n    /**")
        assertTrue(
            "the restore can overwrite a request the operator is looking at",
            restore.contains("if (_state.value.spt.receiveRequest == null)"),
        )
    }

    /**
     * THE TAB AND THE STACK CANNOT DISAGREE.
     *
     * `tab` was written in one place while five verbs replaced `backStack`
     * outright, so a Pads-rooted stack could be showing while `tab` still said
     * Inbox. `selectTab` early-returns when the tab already matches, so tapping
     * Inbox then did nothing and the receive destination was unreachable until the
     * app was relaunched — with a live one-time key possibly pending.
     */
    @Test
    fun everyWholesaleStackReplacementCarriesItsTab() {
        // POSITIVE CONTROL: the helper exists.
        assertTrue("the tab/stack helper is gone", vmSource.contains("fun UiState.movedTo("))

        // ENUMERATED BY SITE, NOT BY VALUE — and over the WHOLE triple.
        //
        // The first version of this guard listed three verbs by hand, so it could
        // only check the three already fixed. The second enumerated every write to
        // `backStack` and classified it by the expression assigned, which had two
        // holes of its own: it never looked at `tab` or `parked` at all, so the
        // identical divergence produced from the other side passed in silence; and
        // a wholesale replacement assigned from any local named `stack` was
        // accepted wherever it appeared, because the classifier could not see
        // WHERE it appeared.
        //
        // The three fields are one state. Whoever writes any of them wholesale
        // must write them together, which is what `movedTo` and `selectTab` do —
        // so those two are the only places a wholesale write may occur.
        val declarations = Regex("(?m)^    (?:private )?(?:fun|val|var) ([A-Za-z_.]+)")
        val bounds = declarations.findAll(vmSource).map { it.range.first to it.groupValues[1] }.toList()
        fun enclosing(at: Int): String =
            bounds.lastOrNull { it.first < at }?.second ?: "(top level)"

        val WHOLESALE_SITES = setOf("UiState.movedTo", "selectTab")
        var wholesale = 0
        var pushOrPop = 0
        for (m in Regex("(backStack|tab|parked) = ([^\n]+)").findAll(vmSource)) {
            val field = m.groupValues[1]
            val value = m.groupValues[2].trim().substringBefore(",").trim()
            val where = enclosing(m.range.first)
            // A PUSH or a POP derives from the stack already showing, so it cannot
            // move the operator to another tab and needs no tab of its own.
            val derived = value.contains("backStack +") || value.contains("dropLast") ||
                value == "popped"
            if (derived) { pushOrPop += 1; continue }
            // Everything else replaces state wholesale.
            wholesale += 1
            assertTrue(
                "`$field = $value` in `$where` replaces navigation state wholesale outside " +
                    "UiState.movedTo/selectTab. The tab, its stack and the parked stacks are one " +
                    "state: writing any of them alone is how a Pads stack ends up under the Inbox " +
                    "label, after which selectTab early-returns and the destination is gone.",
                where in WHOLESALE_SITES,
            )
        }
        assertTrue("no navigation writes were found; this guard is reading nothing",
                   wholesale >= 3 && pushOrPop >= 3)

        // The three verbs that produced the defect, still named, so the
        // classification above cannot silently stop covering them.
        for (verb in listOf("fun openPad(", "fun removePad(", "private fun endReceiveRequest(")) {
            val body = vmSource.substringAfter(verb).substringBefore("\n    fun ")
            assertTrue(
                "$verb replaces the back stack without saying which tab it belongs to",
                body.contains("movedTo("),
            )
        }
        // And `cancelSpt`'s Home branch, which bypassed the helper outright.
        val cancelBody = vmSource.substringAfter("fun cancelSpt(").substringBefore("\n    fun ")
        assertTrue("cancelSpt's Home branch writes a Pads stack without moving the tab",
                   cancelBody.contains("movedTo(Tab.Pads, listOf(Screen.Home))"))
    }

    /**
     * A CANCEL WHOSE TARGET IS NOT ON THE STACK MUST NOT EMPTY IT.
     *
     * `UiState.screen` is `backStack.last()`, so an empty stack is a crash on the
     * next recomposition. `dropLastWhile` removes every element when the target is
     * absent, which per-tab stacks made reachable.
     */
    @Test
    fun cancellingASealedTransferCannotEmptyTheStack() {
        val body = vmSource.substringAfter("fun cancelSpt(").substringBefore("\n    fun ")
        assertTrue("cancelSpt is gone", body.isNotBlank())
        assertTrue(
            "cancelSpt can leave the back stack empty, which crashes the shell",
            body.contains("ifEmpty"),
        )
    }

    @Test
    fun theShellRendersTheBottomNavigationAndCanHideItForModalScreens() {
        assertTrue("the shell does not render the bottom navigation", rootSource.contains("BottomNav(state.tab)"))
        assertTrue("the bottom navigation component is gone", components.contains("fun BottomNav("))
        // Modal/irreversible screens hide it; the ordinary shell shows it.
        // READ THE SET, NOT THE FILE. Every one of these names also appears in
        // the `when (state.screen)` render dispatch a few lines below, so a
        // whole-file search is satisfied by the shell merely being able to DRAW
        // those screens — however the modal set is narrowed underneath it.
        assertTrue("the modal set is gone", rootSource.contains("val modal = state.screen in setOf("))
        val modalSet = rootSource.substringAfter("val modal = state.screen in setOf(").substringBefore(")")
        for (screen in listOf("Screen.ScanQr", "Screen.SendSealed", "Screen.Remove")) {
            assertTrue("$screen no longer hides the bottom navigation", modalSet.contains(screen))
        }
        assertTrue("the bar is shown unconditionally", rootSource.contains("if (!modal) BottomNav"))
    }

    @Test
    fun backLeavesTheScreenBeforeItLeavesTheTab() {
        assertTrue(
            "back no longer returns to Pads from another tab's root",
            rootSource.contains("if (!vm.back()) vm.selectTab(Tab.Pads)"),
        )
    }

    /** ONE receive state machine, reached one way. */
    @Test
    fun homeDoesNotOpenASecondCopyOfTheReceiveScreen() {
        val screens = File("src/main/kotlin/dev/systemslibrarian/truepad/app/ui/Screens.kt").readText()
        assertTrue(
            "the home button no longer selects the Receive destination",
            screens.contains("btn-receive-pad\")) { vm.selectTab(Tab.Inbox) }"),
        )
        assertFalse(
            "home still pushes its own copy of the receive screen onto the Pads stack",
            screens.contains("btn-receive-pad\")) { vm.startReceive() }"),
        )
    }
    /**
     * A SCREEN STARTS AT ITS OWN TOP.
     *
     * One `rememberScrollState()` serves every destination and is saved across an
     * activity recreation, and nothing reset it on navigation — so arriving from a
     * screen the operator had scrolled down left the NEW screen scrolled by the
     * same amount, past its own heading. It survived only because the screens
     * happened to be similar heights: adding a paragraph to the create screen
     * pushed a pad screen's title off the top, and `UiJourneyTest
     * .stateComesBackFromTheEngineAfterRecreation` found it on a device.
     *
     * Position WITHIN a screen is still preserved while the operator is on it;
     * only a change of destination resets it.
     */
    @Test
    fun everyScreenStartsAtItsOwnTop() {
        assertTrue("the shell no longer resets the scroll on a change of screen",
                   rootSource.contains("LaunchedEffect(state.screen) { scroll.scrollTo(0) }"))
        assertTrue("the scroll state is no longer the one the reset applies to",
                   rootSource.contains("verticalScroll(scroll)"))
        assertFalse("the scroll state is created inline again, so nothing can reset it",
                    rootSource.contains("verticalScroll(rememberScrollState())"))
        // ONE container, so one reset is enough — and if a second appears, this
        // says so rather than letting it drift out of scope.
        assertEquals(
            "there is more than one scroll container; the reset covers only one",
            1,
            rootSource.split("verticalScroll(").size - 1,
        )
    }

}
