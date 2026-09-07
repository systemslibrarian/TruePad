package dev.systemslibrarian.truepad.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.systemslibrarian.truepad.app.Claims
import dev.systemslibrarian.truepad.app.Egress
import dev.systemslibrarian.truepad.app.PadViewModel
import dev.systemslibrarian.truepad.app.Tab
import dev.systemslibrarian.truepad.app.Screen
import dev.systemslibrarian.truepad.app.UiState
import dev.systemslibrarian.truepad.app.copySensitiveText
import dev.systemslibrarian.truepad.app.shareReceiveCode
import dev.systemslibrarian.truepad.spt.ComparisonWords

/*
 * SEALED PAD TRANSFER — the sender and receiver screens.
 *
 * This is the same protocol the Browser Edition speaks (TPR2 receive code,
 * .tps2 sealed package, the twelve-word request check and eight-word
 * confirmation), presented in the same plain vocabulary as the rest of the app.
 * The cryptography words — X-Wing, ML-KEM, request fingerprint, package
 * identity — live only behind a "Details" disclosure, never in the main flow.
 *
 * The screens hold NO authority. Every consumption decision, every refusal, the
 * one-time-ness of a request and the one-handoff-per-pad rule are the engine's;
 * these compose its verbs and draw what comes back.
 *
 * THE TRANSIENT SESSION — which for the receiver holds a decrypted pad in memory
 * — is dropped by `PadViewModel.back()` and `cancelSpt()`, which is every route
 * OUT of a ceremony screen. It is NOT dropped by `selectTab`, deliberately: a
 * glance at About must not cancel a ceremony halfway through. Nor by the Receive
 * screen's "Home" link at the Inbox tab's root, which now falls through to
 * `selectTab(Tab.Pads)` because `back()` has nothing to pop there — that link was
 * inert before, and making it work made it a tab switch rather than a back press.
 * This paragraph said "dropped the moment the operator leaves", which is true of
 * a back press and was never true of a tab switch.
 */

/* ---- the comparison ceremony ---------------------------------------------- */

/**
 * The words two people say aloud to check they are on the same transfer. Order
 * is part of the protocol, so they are numbered and shown in order. Unlike an
 * envelope, these ARE meant to be read by a screen reader — that is the whole
 * point — so they carry ordinary semantics.
 */
@Composable
fun ComparisonWords(indices: IntArray, heading: String, tag: String) {
    val words = remember(indices) { ComparisonWords.wordsFor(indices) }
    SectionTitle(heading)
    Column(
        Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag(tag),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        for ((i, word) in words.withIndex()) {
            Text(
                "${i + 1}.  $word",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onBackground,
            )
        }
    }
}

/** A long machine string (a receive code) offered as one labelled unit — reading
 *  1600 characters aloud helps nobody; the buttons are how it is actually used. */
@Composable
private fun CodeBlock(text: String, description: String, tag: String) {
    SelectionContainer {
        Text(
            text,
            style = EnvelopeStyle,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 8.dp)
                .testTag(tag)
                .clearAndSetSemantics { contentDescription = description },
        )
    }
}

/* ---- RECEIVE a pad -------------------------------------------------------- */

@Composable
fun ReceivePadScreen(state: UiState, vm: PadViewModel) {
    val context = localContext()
    val spt = state.spt

    val openPackage = rememberOpenDocument { uri -> vm.openReceivedPackage(uri) }

    // NOT `vm.back()`. This screen is the Inbox tab's ROOT, so its stack has one
    // element and `back()` returns false without changing anything — a visible
    // control that did nothing at all. Selecting the Pads tab is what the link
    // says it does.
    BackLink("Home") { if (!vm.back()) vm.selectTab(Tab.Pads) }
    ScreenTitle("Receive a pad", Modifier.testTag("title-receive"))
    BannerArea(state, vm)

    val session = spt.openSession
    if (session != null) {
        // Stage 3 — the file opened. Compare the confirmation words, then save.
        Body("The pad file opened. Before you keep it, check it is really from the person you expect.")
        ComparisonWords(session.confirmationIndices, "Compare these words", "receive-confirm-words")
        Callout(Tone.Warn, "Say these with the other person") {
            Body("Ask them to read their confirmation words. If even one word differs, do not keep this pad — stop and start again.")
        }
        var name by remember { mutableStateOf("") }
        OutlinedTextField(
            value = name,
            onValueChange = { name = it.take(60) },
            label = { Text("Name this pad") },
            placeholder = { Text("e.g. Chat with Sam") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("field-receive-name"),
        )
        PrimaryButton("The words match — add this pad", Modifier.testTag("btn-commit-receive"), busy = state.busy) {
            vm.commitReceive(name)
        }
        // A MISMATCH IS TERMINAL, and it is written to disk. Clearing the screen
        // was not enough once the Receive screen started restoring pending
        // requests: the rejected code came back on the next visit.
        SecondaryButton("The words do not match — cancel", Modifier.testTag("btn-cancel-receive")) {
            vm.rejectOpenedPackage()
        }
        Details("Details") {
            Faint("These eight words encode the confirmation value bound to the sealed package and your receive request.")
            Faint("Keeping the pad consumes the one-time receive code; it can never receive a second pad.")
        }
        return
    }

    val request = spt.receiveRequest
    if (request == null) {
        // Stage 1 — nothing published yet.
        Body("Ask someone to send you a pad securely. TruePad makes a one-time receive code; you give it to them, they send back a sealed file, and only your device can open it.")
        PrimaryButton("Create a receive code", Modifier.testTag("btn-create-receive-code"), busy = state.busy) {
            vm.createReceiveRequest()
        }
        Faint("Nothing leaves this device. Creating a receive code makes no network connection.")
        Details("How this works") {
            Muted("1. You create a receive code and give it to the other person.")
            Muted("2. They use it to seal a copy of their pad into a file.")
            Muted("3. They send you the file; you open it here and check the words match.")
        }
        return
    }

    // Stage 2 — the code is published, waiting for the sealed file.
    // THE RECIPROCAL INSTRUCTION, in the same plain terms the sender is given.
    SectionTitle("Send this receive code to the person sharing a pad with you")
    Muted("It is safe to send over any channel — it is only a request, not a pad.")
    CodeBlock(request.tpr2Text, "The receive code, ready to give to the sender.", "receive-code-output")
    FullWidth {
        PrimaryButton("Copy code", Modifier.testTag("btn-copy-receive-code")) {
            context.copySensitiveText("TruePad receive code", request.tpr2Text, Egress.PUBLIC_TEXT)
        }
        SecondaryButton("Share code", Modifier.testTag("btn-share-receive-code")) {
            context.shareReceiveCode(request.tpr2Text, Egress.PUBLIC_TEXT)
        }
    }
    // If the sender is nearby, they can scan this instead of pasting it.
    Details("Show as a QR code") {
        Muted("Hold this up for the sender to scan with their camera.")
        TprQrCode(request.tpr2Text)
    }

    ComparisonWords(request.requestIndices, "Compare these words", "receive-request-words")
    Muted("When the sender reviews your code, these twelve words appear on their device too. Read them to each other to be sure the code arrived unchanged.")

    Rule()
    SectionTitle("When they have sent you the file")
    PrimaryButton("Open the sealed pad file", Modifier.testTag("btn-open-sealed"), busy = state.busy) {
        openPackage.launch(arrayOf("application/octet-stream", "application/x-tps2", "*/*"))
    }
    // Cancelling a published code ends it on disk too — otherwise it stays
    // pending, and the restore offers it again as though nothing happened.
    SecondaryButton("Cancel", Modifier.testTag("btn-cancel-receive-code")) { vm.cancelReceiveCode() }

    Details("Details") {
        Faint("The receive code (TPR2) carries only the public recipient key and a request id. Expires after 7 days.")
        Faint("Request fingerprint: ${request.requestHashHex}")
    }
}

/* ---- GIVE a pad: choose how --------------------------------------------- */

@Composable
fun GivePadScreen(state: UiState, vm: PadViewModel) {
    val pairId = state.currentPairId ?: return
    val save = rememberCreateDocument("application/json") { uri -> vm.exportPad(pairId, uri) }

    BackLink("Pad") { vm.back() }
    ScreenTitle("Give this pad to someone", Modifier.testTag("title-give"))
    BannerArea(state, vm)

    // GATED ON THE ACT, NOT ONLY ON THE OFFER.
    //
    // The pad screen's "Share this pad" section is gated, but this screen is the
    // one that PERFORMS the handoff, and it was reachable and live regardless:
    // nothing here read `mayHandOff`, and `exportPad` did not navigate away on
    // success. So "Save as a file", tap, save — banner, screen unchanged — tap
    // again, save under a second name. The engine deliberately lets a re-export
    // through under an existing Physical marker (`exportPair`'s `else -> Unit`),
    // so two byte-identical raw copies of the pad really were produced, under a
    // callout promising it "can be handed over a single time". No race required.
    //
    // Both halves are closed: this gate, and `exportPad` returning to the pad
    // screen. The re-export the engine permits is still reachable, below, and is
    // named as the thing it actually is.
    if (!state.mayHandOff) {
        Callout(Tone.Warn, "This pad cannot be handed over again", Modifier.testTag("give-refused")) {
            Body(
                state.handOffRefusal
                    ?: "TruePad could not read this pad's handoff state, so it will not offer to " +
                        "hand it over. Nothing about the pad has been changed.",
            )
            if (state.mayReshareSealed) {
                Body(
                    "The sealed file this pad was already sealed to is still on this device. Go " +
                        "back and use \"Hand over the same sealed file\" to get it again — that " +
                        "hands back the SAME package and creates no second copy.",
                )
            }
        }
        // THE HANDOFF IS DONE; THE DELIVERY MIGHT NOT BE.
        //
        // A save can be cancelled at the file picker, land on a full disk, or go
        // to a drive that was pulled — and the engine deliberately lets a
        // re-export through under an existing Physical marker for exactly that,
        // keeping the time of the FIRST handoff. Gating the screen without this
        // turned a failed delivery into permanent loss the engine had chosen not
        // to impose. It is NOT another handoff and is not offered as one: the same
        // pad, already given away, written again.
        if (state.mayResavePhysical) {
            Rule()
            SectionTitle("The file did not reach them?")
            Muted(
                "This pad has already been handed over, so this is not a second handoff — it " +
                    "writes the same pad you already gave away. Use it only if that copy never " +
                    "arrived. Anyone holding either file can read these messages.",
            )
            SecondaryButton("Save the same pad file again", Modifier.testTag("btn-resave-file")) {
                save.launch("truepad-pad.json")
            }
        }
        return
    }

    Body("The other person needs a copy of this pad before either of you can read what the other sends. There are two ways to give it to them.")

    // THE SECURE ROUTE LEADS. Both routes are still here and both still work;
    // what changed is which one an operator meets first. Leading with "Save as a
    // file" taught people that the normal way to give someone a pad is to email
    // themselves a copy of it.
    Rule()
    SectionTitle("Securely, over any channel")
    Muted("Ask the other person to open TruePad and create a receive code, then send that code to you. You seal this pad to their code; the sealed file is safe to send over untrusted channels because only their device can open it.")
    PrimaryButton("Send securely to a receive code", Modifier.testTag("btn-give-sealed"), busy = state.busy) {
        vm.startSendSealed()
    }

    Rule()
    SectionTitle("In person")
    Muted("Save the pad to a file and hand it over yourself — on a cable, a drive, or device-to-device you control.")
    SecondaryButton("Save as a file", Modifier.testTag("btn-give-file")) {
        save.launch("truepad-pad.json")
    }
    Faint("Keep the pad file secret — anyone who has it can read these messages.")

    Rule()
    Callout(Tone.Warn, "A pad is given only once") {
        Body("Whichever way you choose, this pad can be handed over a single time. Sending it securely means it cannot also be saved as a file, and the other way round. To share with someone new, create a new pad.")
    }
}

/* ---- SEND a pad securely (sealed transfer) ------------------------------- */

@Composable
fun SendSealedScreen(state: UiState, vm: PadViewModel) {
    val context = localContext()
    val pairId = state.currentPairId ?: return
    val spt = state.spt

    val saveSealed = rememberCreateDocument("application/octet-stream") { uri -> vm.saveSealedPackage(uri) }

    BackLink("Give") { vm.back() }
    ScreenTitle("Send securely", Modifier.testTag("title-send-sealed"))
    BannerArea(state, vm)

    val sealed = spt.sealed
    if (sealed != null) {
        // Stage 3 — the pad is sealed. Read the words, save the file.
        if (sealed.reshared) {
            Callout(Tone.Neutral, "Already sealed to this code") {
                Body("This pad was already sealed to this same receive code. TruePad returned the exact same file and words — it did not seal it again.")
            }
        }
        Body("The pad is sealed to the other person's receive code. Save the file and get it to them, then read them these words.")
        ComparisonWords(sealed.confirmationIndices, "Read these words to the other person", "send-confirm-words")
        Muted("The same eight words appear on their device when they open the file. If any word differs, the file is not the one you sealed — do not proceed.")

        Rule()
        PrimaryButton("Save the sealed file", Modifier.testTag("btn-save-sealed"), busy = state.busy) {
            saveSealed.launch("truepad-sealed.tps2")
        }
        Faint("The sealed file is safe to send over any channel — nearby (Quick Share, cable, drive) or online. Only the intended receiver can open it.")
        SecondaryButton("Done — back to pad", Modifier.testTag("btn-sealed-done")) { vm.cancelSpt(Screen.Pad) }

        Details("Details") {
            Faint("Package identity: ${sealed.packageIdentityB64}")
            Faint("Request fingerprint: ${sealed.requestHashHex}")
            Faint("The whole, unused pad is sealed with X-Wing (ML-KEM-768 + X25519) to the recipient's one-time key.")
        }
        return
    }

    val review = spt.sendReview
    if (review == null) {
        // Stage 1 — paste the receiver's code.
        var code by remember { mutableStateOf("") }
        Body("Ask the other person for their receive code. If they are nearby, scan their QR code; otherwise paste the code they sent you.")
        PrimaryButton("Scan QR code", Modifier.testTag("btn-scan-qr"), busy = state.busy) { vm.scanReceiveCode() }
        OutlinedTextField(
            value = code,
            onValueChange = { code = it },
            label = { Text("…or paste the receive code") },
            placeholder = { Text("Paste the TPR2: code here…") },
            minLines = 3,
            modifier = Modifier.fillMaxWidth().testTag("field-receive-code"),
        )
        SecondaryButton(
            text = "Review pasted code",
            modifier = Modifier.testTag("btn-review-code"),
            enabled = code.isNotBlank(),
        ) {
            vm.reviewSealRequest(code)
        }
        Faint("Reviewing a code does not send anything and does not use the pad.")
        return
    }

    // Stage 2 — review the words, then seal.
    //
    // RE-SHARING IS NOT SEALING, AND IS NOT DESCRIBED AS IT. Coming back to the
    // request this pad was ALREADY sealed to hands over the bytes the engine
    // committed then: nothing is encapsulated, no second copy is created, and the
    // pad has already left. Saying "Sealing gives this pad away" and "this pad can
    // be given only once" there implies a second send is about to happen, which is
    // precisely what cannot occur. Asked of the same comparison `sptSeal` makes.
    val reshare = vm.sealIsReshare(pairId)
    Body("Check these twelve words against the ones on the other person's device. They must match exactly before you seal the pad.")
    ComparisonWords(review.requestIndices, "Compare these words", "send-request-words")
    if (reshare) {
        Callout(Tone.Neutral, "This pad was already sealed to this code", Modifier.testTag("callout-reshare")) {
            Body("TruePad will hand back the SAME sealed file it made then — nothing is encrypted again and no second copy is created. The pad has already left this device.")
        }
    } else {
        Callout(Tone.Warn, "Sealing gives this pad away") {
            Body("If the words match, sealing hands this whole pad to that receive code. This pad can be given only once, so it cannot then be saved as a file for anyone else.")
        }
    }
    PrimaryButton(
        if (reshare) "Get the sealed file again" else "The words match — seal the pad",
        Modifier.testTag("btn-seal"),
        busy = state.busy,
    ) {
        vm.sealPad(pairId)
    }
    SecondaryButton("The words do not match — cancel", Modifier.testTag("btn-cancel-seal")) { vm.cancelSpt(Screen.Pad) }

    Details("Details") {
        Faint("Request fingerprint: ${review.requestHashHex}")
        Faint("The twelve words encode this fingerprint; comparing them detects a code that was altered in transit.")
    }
}
