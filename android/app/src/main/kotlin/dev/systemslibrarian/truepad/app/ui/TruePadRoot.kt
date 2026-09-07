package dev.systemslibrarian.truepad.app.ui

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import dev.systemslibrarian.truepad.app.Banner
import dev.systemslibrarian.truepad.app.PadViewModel
import dev.systemslibrarian.truepad.app.Screen
import dev.systemslibrarian.truepad.app.Tab
import dev.systemslibrarian.truepad.app.UiState

/**
 * The single screen host.
 *
 * Navigation is a plain back stack in the ViewModel, not a library and not a
 * URL. That is deliberate: navigation state is NOT security-critical here and
 * must never become so. Nothing is authorised by which screen you are on — the
 * engine re-checks every gate on every call, so arriving at the send screen for
 * a disabled pad simply produces the same refusal it would anywhere else.
 */
@Composable
fun TruePadRoot(state: UiState, vm: PadViewModel) {
    // Every return to the foreground throws the UI's snapshot away and rebuilds
    // it from the engine. An activity that died mid-operation therefore cannot
    // leave the operator looking at a stale count.
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) vm.refresh()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
    }

    // BACK LEAVES THE SCREEN FIRST, THEN THE TAB. Once a tab is at its root, a
    // back press returns to Pads rather than closing the app — the ordinary
    // Android expectation for a bottom-nav shell. From Pads' own root it is not
    // handled here at all, so the system closes the app as before.
    BackHandler(enabled = state.backStack.size > 1 || state.tab != Tab.Pads) {
        if (!vm.back()) vm.selectTab(Tab.Pads)
    }

    // MODAL AND IRREVERSIBLE SCREENS HIDE THE BAR. A camera preview filling the
    // screen, a sealing ceremony and a destruction confirmation are each a place
    // where a stray tap on a tab would either abandon something the operator is
    // halfway through or obscure what they are being asked to confirm.
    val modal = state.screen in setOf(Screen.ScanQr, Screen.SendSealed, Screen.Remove)

    // A SCREEN STARTS AT ITS OWN TOP.
    //
    // One scroll state is shared by every destination and is saved across an
    // activity recreation, and nothing reset it on navigation — so arriving from
    // a screen the operator had scrolled down left the NEW screen scrolled by the
    // same amount, past its own title. It survived only because the screens
    // happened to be similar heights; adding a paragraph to one of them moved a
    // pad screen's heading off the top, which is how the instrumentation suite
    // found it. Position within a screen is still preserved while you are on it.
    val scroll = rememberScrollState()
    LaunchedEffect(state.screen) { scroll.scrollTo(0) }

    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().testTag("truepad-root")) {
            Column(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(scroll)
                    .padding(horizontal = 20.dp, vertical = 28.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                when (state.screen) {
                    Screen.Home -> HomeScreen(state, vm)
                    Screen.CreatePad -> CreatePadScreen(state, vm)
                    Screen.AddPad -> AddPadScreen(state, vm)
                    Screen.Pad -> PadScreen(state, vm)
                    Screen.Send -> SendScreen(state, vm)
                    Screen.Open -> OpenScreen(state, vm)
                    Screen.Details -> DetailsScreen(state, vm)
                    Screen.Remove -> RemoveScreen(state, vm)
                    Screen.ReceivePad -> ReceivePadScreen(state, vm)
                    Screen.GivePad -> GivePadScreen(state, vm)
                    Screen.SendSealed -> SendSealedScreen(state, vm)
                    Screen.ScanQr -> QrScanScreen(state, vm)
                    Screen.About -> AboutScreen()
                }
                Spacer(Modifier.height(40.dp))
            }
            if (!modal) BottomNav(state.tab) { vm.selectTab(it) }
        }
    }
}

/** The banner every screen shows for the last outcome. */
@Composable
fun BannerArea(state: UiState, vm: PadViewModel) {
    val banner = state.banner ?: return
    when (banner) {
        is Banner.Refused -> Callout(
            tone = if (banner.refusal.isFree) Tone.Warn else Tone.Danger,
            title = banner.refusal.headline,
            modifier = Modifier.testTag("banner-refused"),
        ) {
            if (banner.refusal.isFree) {
                Faint("Nothing was used. You can try again.")
            } else {
                Faint("Part of this pad was used. That cannot be undone.")
            }
            // The engine's own typed reason and sentence, ALWAYS available and
            // never replaced by the friendly line above it. A refusal the app
            // did not recognise is still fully readable here.
            Details("Details") {
                Faint("Reason: ${banner.refusal.reason}")
                if (banner.refusal.detail.isNotBlank()) Faint(banner.refusal.detail)
            }
        }
        is Banner.Problem -> Callout(Tone.Danger, banner.text, Modifier.testTag("banner-problem")) {}
        is Banner.Info -> Callout(Tone.Neutral, banner.text, Modifier.testTag("banner-info")) {}
        is Banner.Created -> Callout(Tone.Good, "Pad created", Modifier.testTag("banner-created")) {
            Muted("Source: ${banner.sourceLabel}")
            Body(
                "One thing left: give the other person their copy. Until they have it, neither of you can read " +
                    "anything the other sends.",
            )
            // THE NEXT STEP, NAMED AND OFFERED. This banner used to say what was
            // left to do and then leave the operator to find it — which meant the
            // normal way to share a pad was discovered by hunting, if at all.
            Faint(
                "To share it securely, ask the other person to open TruePad and create a receive " +
                    "code. Have them send that code to you, then paste or scan it here.",
            )
            // OFFERED ONLY WHERE IT BELONGS, AND ONLY WHILE IT IS TRUE.
            //
            // A banner is global state and a tab switch deliberately preserves it
            // — a refusal must survive a glance at About. That let the sender
            // ceremony be launched from the INBOX, where it discarded the live
            // receive session (`startSendSealed` resets `spt`) and pushed the
            // sender flow onto the Inbox stack, whose back link then reads "Give".
            // The request is recoverable, so this was loss rather than reuse; a
            // prompt to hand a pad out still has no business on the destination
            // that exists to take pads in.
            //
            // The eligibility half matters too: a banner outlives the act. Between
            // creating a pad and reading this, the pad can have been handed over
            // or destroyed, and `mayHandOff` is the engine's answer for whether it
            // may still leave.
            if (state.tab == Tab.Pads && state.mayHandOff) {
                PrimaryButton("Share this pad", Modifier.testTag("btn-share-this-pad")) {
                    vm.startSendSealed()
                }
            }
            // CREATING A PAD MUST NOT FORCE AN IMMEDIATE HANDOFF.
            SecondaryButton("Not now", Modifier.testTag("btn-share-not-now")) { vm.dismissBanner() }
        }
        Banner.Added -> Callout(Tone.Good, "Pad added", Modifier.testTag("banner-added")) {}
        Banner.Exported -> Callout(Tone.Good, "Pad file saved", Modifier.testTag("banner-exported")) {
            Body(dev.systemslibrarian.truepad.app.Claims.DELIVERY_ESSENTIAL)
        }
        Banner.Removed -> Callout(Tone.Good, "Removed from TruePad.", Modifier.testTag("banner-removed")) {}
        Banner.SealedSaved -> Callout(Tone.Good, "Sealed pad file saved", Modifier.testTag("banner-sealed-saved")) {
            Body(
                "Give this file to the other person over any channel — nearby (Quick Share, a cable, a drive) or " +
                    "online. Only their device can open it. Then read them the confirmation words so they can check " +
                    "the file is really from you.",
            )
        }
    }
    Spacer(Modifier.height(2.dp))
    // 48dp like every other target. Found by the accessibility sweep, which
    // walks the whole tree rather than a list of tags — this button had been
    // left at Material's 40dp default because nothing named it.
    androidx.compose.material3.TextButton(
        onClick = { vm.dismissBanner() },
        modifier = Modifier.heightIn(min = 48.dp),
    ) {
        Faint("Dismiss")
    }
}

/* ---- shared SAF launchers -------------------------------------------------- */

/**
 * Pick ONE document to read.
 *
 * OpenDocument, not GetContent: it returns a stable document URI the app can
 * read once without asking for any storage permission, and the operator chose
 * it in the system picker. The MIME filter is a convenience for the picker and
 * is NOT trusted — the bytes are validated by the engine, which refuses anything
 * that is not a well-formed pad bundle whatever it claims to be.
 */
@Composable
fun rememberOpenDocument(onPicked: (Uri) -> Unit) =
    rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) onPicked(uri)
    }

@Composable
fun rememberOpenDocuments(onPicked: (List<Uri>) -> Unit) =
    rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) onPicked(uris)
    }

/**
 * Create a document to write to.
 *
 * The operator picks the destination; TruePad never chooses one and never writes
 * to shared storage on its own. This is also why the app needs no FileProvider:
 * nothing hands another application a URI that TruePad owns.
 */
@Composable
fun rememberCreateDocument(mime: String, onPicked: (Uri) -> Unit) =
    rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(mime)) { uri ->
        if (uri != null) onPicked(uri)
    }

@Composable
fun localContext() = LocalContext.current

@Composable
fun FullWidth(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) { content() }
}
