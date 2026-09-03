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
import dev.systemslibrarian.truepad.app.PadViewModel
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
 * these compose its verbs and draw what comes back. The transient session
 * (which for the receiver holds a decrypted pad in memory) is dropped the moment
 * the operator leaves — see PadViewModel.back()/cancelSpt().
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

    BackLink("Home") { vm.back() }
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
        SecondaryButton("The words do not match — cancel", Modifier.testTag("btn-cancel-receive")) {
            vm.cancelSpt(Screen.Home)
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
    SectionTitle("Give this receive code to the sender")
    Muted("It is safe to send over any channel — it is only a request, not a pad.")
    CodeBlock(request.tpr2Text, "The receive code, ready to give to the sender.", "receive-code-output")
    FullWidth {
        PrimaryButton("Copy code", Modifier.testTag("btn-copy-receive-code")) {
            context.copySensitiveText("TruePad receive code", request.tpr2Text)
        }
        SecondaryButton("Share code", Modifier.testTag("btn-share-receive-code")) {
            context.shareReceiveCode(request.tpr2Text)
        }
    }

    ComparisonWords(request.requestIndices, "Compare these words", "receive-request-words")
    Muted("When the sender reviews your code, these twelve words appear on their device too. Read them to each other to be sure the code arrived unchanged.")

    Rule()
    SectionTitle("When they have sent you the file")
    PrimaryButton("Open the sealed pad file", Modifier.testTag("btn-open-sealed"), busy = state.busy) {
        openPackage.launch(arrayOf("application/octet-stream", "application/x-tps2", "*/*"))
    }
    SecondaryButton("Cancel", Modifier.testTag("btn-cancel-receive-code")) { vm.cancelSpt(Screen.Home) }

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

    Body("The other person needs a copy of this pad before either of you can read what the other sends. There are two ways to give it to them.")

    Rule()
    SectionTitle("In person")
    Muted("Save the pad to a file and hand it over yourself — on a cable, a drive, or device-to-device you control.")
    PrimaryButton("Save as a file", Modifier.testTag("btn-give-file"), busy = state.busy) {
        save.launch("truepad-pad.json")
    }
    Faint("Keep the pad file secret — anyone who has it can read these messages.")

    Rule()
    SectionTitle("Securely, over any channel")
    Muted("If the other person is far away, they create a receive code and give it to you. You seal this pad to that code; the sealed file is safe to send over untrusted channels because only their device can open it.")
    SecondaryButton("Send securely to a receive code", Modifier.testTag("btn-give-sealed")) { vm.startSendSealed() }

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
        Body("Ask the other person for their receive code and paste it here.")
        OutlinedTextField(
            value = code,
            onValueChange = { code = it },
            label = { Text("Receive code") },
            placeholder = { Text("Paste the TPR2: code here…") },
            minLines = 3,
            modifier = Modifier.fillMaxWidth().testTag("field-receive-code"),
        )
        PrimaryButton(
            text = "Review this code",
            modifier = Modifier.testTag("btn-review-code"),
            enabled = code.isNotBlank(),
            busy = state.busy,
        ) {
            vm.reviewSealRequest(code)
        }
        Faint("Reviewing a code does not send anything and does not use the pad.")
        return
    }

    // Stage 2 — review the words, then seal.
    Body("Check these twelve words against the ones on the other person's device. They must match exactly before you seal the pad.")
    ComparisonWords(review.requestIndices, "Compare these words", "send-request-words")
    Callout(Tone.Warn, "Sealing gives this pad away") {
        Body("If the words match, sealing hands this whole pad to that receive code. This pad can be given only once, so it cannot then be saved as a file for anyone else.")
    }
    PrimaryButton("The words match — seal the pad", Modifier.testTag("btn-seal"), busy = state.busy) {
        vm.sealPad(pairId)
    }
    SecondaryButton("The words do not match — cancel", Modifier.testTag("btn-cancel-seal")) { vm.cancelSpt(Screen.Pad) }

    Details("Details") {
        Faint("Request fingerprint: ${review.requestHashHex}")
        Faint("The twelve words encode this fingerprint; comparing them detects a code that was altered in transit.")
    }
}
