package dev.systemslibrarian.truepad.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.systemslibrarian.truepad.app.Claims
import dev.systemslibrarian.truepad.app.Egress
import dev.systemslibrarian.truepad.app.FixedRecordIntake
import dev.systemslibrarian.truepad.core.ASSESSMENT_LABEL
import dev.systemslibrarian.truepad.core.SOURCE_LABEL
import dev.systemslibrarian.truepad.core.UNPROVEN_PREMISES
import dev.systemslibrarian.truepad.app.OpResult
import dev.systemslibrarian.truepad.app.PadSize
import dev.systemslibrarian.truepad.app.PadViewModel
import dev.systemslibrarian.truepad.app.PickedSource
import dev.systemslibrarian.truepad.app.PublicTransport
import dev.systemslibrarian.truepad.app.Screen
import dev.systemslibrarian.truepad.app.Tab
import dev.systemslibrarian.truepad.app.UiState
import dev.systemslibrarian.truepad.app.AndroidStorage
import dev.systemslibrarian.truepad.app.copySensitiveText
import dev.systemslibrarian.truepad.app.shareEncryptedMessage
import dev.systemslibrarian.truepad.storage.PartyRole
import dev.systemslibrarian.truepad.storage.Party2

/*
 * The screens.
 *
 * LEVEL DISCIPLINE, carried over from the released dashboard and normative here
 * too. Level 1 is the daily actions and says nothing about the protocol. Level 2
 * is Pad details — how much is left, when it was made. Level 3 is Security —
 * directions, records, the witness, the engine's own words — and lives behind a
 * disclosure. Nothing from Level 3 surfaces above it, and the one irreversible
 * action is the quietest thing on its screen.
 *
 * The vocabulary is the released product's: "pad", "pad file", "encrypted
 * message", "the other person". Never pair, courier bundle, envelope, or peer.
 */

/* ---- home ------------------------------------------------------------------ */

@Composable
fun HomeScreen(state: UiState, vm: PadViewModel) {
    ScreenTitle("TruePad", Modifier.testTag("title-home"))
    Body("Private messages using a pad you share with one other person.")
    BannerArea(state, vm)

    FullWidth {
        PrimaryButton("Create a pad", Modifier.testTag("btn-create-pad"), busy = state.busy) {
            vm.navigate(Screen.CreatePad)
        }
        SecondaryButton("Add a shared pad", Modifier.testTag("btn-add-pad")) { vm.navigate(Screen.AddPad) }
        // SELECTS THE TAB rather than pushing a second copy of the receive screen
        // onto the Pads stack. Two routes into one state machine is how a live
        // one-time request gets stranded behind the wrong back stack.
        SecondaryButton("Receive a pad", Modifier.testTag("btn-receive-pad")) { vm.selectTab(Tab.Inbox) }
    }

    Details("How does this work?") {
        Muted("1. Create a pad — it is made on your device and never uploaded.")
        Muted("2. Give a copy to one person — give them the pad file privately.")
        Muted("3. Message each other — from then on you can both send and open messages.")
    }

    if (state.pads.isNotEmpty()) {
        Rule()
        SectionTitle("Your pads")
        Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("pad-list")) {
            for (entry in state.pads) {
                val name = entry.label.ifBlank { "Untitled pad" }
                val padSummary = entry.summary
                val status = when {
                    entry.destroyed -> "Disabled"
                    padSummary == null -> "Unavailable"
                    padSummary.meters.values.any { it.frozen } -> "Paused"
                    // maxRemainingSends, NOT remainingRecords: on a fixed store the
                    // encryption budget runs out first and the records left over
                    // cannot be spent. A pad that could never send again used to
                    // sit here saying "Ready".
                    padSummary.meters.values.all { it.maxRemainingSends == 0L } -> "Exhausted"
                    else -> "Ready"
                }
                SecondaryButton(
                    text = "$name — $status",
                    modifier = Modifier.testTag("pad-row"),
                ) { vm.openPad(entry.pairId) }
            }
        }
    } else if (state.loaded) {
        Muted("You have no pads yet.")
    }

    Rule()
    Faint(Claims.BACKUP_NOTE)
}

/* ---- create ---------------------------------------------------------------- */

@Composable
fun CreatePadScreen(state: UiState, vm: PadViewModel) {
    // THE FORM LIVES IN THE VIEW MODEL, not in `remember { }`.
    //
    // The tab shell parks BACK STACKS, not compositions. Leaving the Pads tab
    // removes this screen from the tree and discards everything remembered in it;
    // coming back restores a stack whose top still says `Screen.CreatePad`, so the
    // operator returned to what looked like the screen they left with every field
    // silently reset — including `external`, which decides where the pad's
    // material comes from. See `UiState.create`.
    val form = state.create
    val label = form.label
    val size = form.size
    val external = form.external
    val declared = form.declared
    val origin = form.origin
    val picked = form.picked
    val fixedLength = form.fixedLength
    val fixedSize = form.fixedSize

    val pickSources = rememberOpenDocuments { uris ->
        val existing = picked.map { it.uri.toString() }.toSet()
        val added = uris.filterNot { it.toString() in existing }.map { uri ->
            PickedSource(
                uri = uri,
                name = AndroidStorage.sanitiseDisplayName(uri.lastPathSegment, "source"),
                declaredOrigin = origin.trim().ifBlank { "declared by operator at creation; not verified by this tool" },
            )
        }
        vm.updateCreate { it.copy(picked = it.picked + added) }
    }

    BackLink("Home") { vm.back() }
    ScreenTitle("Create a pad", Modifier.testTag("title-create"))
    Body("A pad lets two people message each other privately. You make it here, then share one copy with the other person.")
    BannerArea(state, vm)

    OutlinedTextField(
        value = label,
        onValueChange = { new -> vm.updateCreate { it.copy(label = new.take(60)) } },
        label = { Text("Name this pad") },
        placeholder = { Text("e.g. Chat with Sam") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth().testTag("field-pad-name"),
    )

    SectionTitle("How much capacity?")
    Faint("Capacity is fixed when the pad is created and cannot be topped up later.")
    for (option in PadSize.entries) {
        // The WHOLE row is the target, not the 20dp radio inside it. A label you
        // can read but not tap is an accessibility failure and an ordinary
        // usability one; selectableGroup/selectable also makes the set announce
        // as radio buttons to TalkBack rather than as unrelated controls.
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .selectable(
                    selected = size == option,
                    role = Role.RadioButton,
                    onClick = { vm.updateCreate { it.copy(size = option) } },
                )
                .testTag("size-${option.name}"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = size == option, onClick = null)
            Column(Modifier.padding(start = 4.dp)) {
                Text("${option.label} — ${option.describe()}", style = MaterialTheme.typography.bodyLarge)
            }
        }
    }

    Rule()
    SectionTitle("Randomness")
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .selectable(selected = !external, role = Role.RadioButton,
                onClick = { vm.updateCreate { it.copy(external = false) } })
            .testTag("radio-device"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = !external, onClick = null)
        Text("Generate for me", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 4.dp))
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .selectable(selected = external, role = Role.RadioButton,
                onClick = { vm.updateCreate { it.copy(external = true) } })
            .testTag("radio-external"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = external, onClick = null)
        Text("Use external random material", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 4.dp))
    }

    if (!external) {
        Muted(Claims.DEVICE_SHORT)
        Details("What that means") { Faint(Claims.DEVICE_DETAIL) }
    } else {
        // The ceremony, in the released order. Every sentence here is
        // load-bearing claims text; see Claims.kt.
        Callout(Tone.Warn, Claims.CEREMONY_TITLE, Modifier.testTag("ceremony")) {
            Body(Claims.CEREMONY_COMBINER)
            Body(Claims.CEREMONY_CONDITIONAL)
            Body(Claims.CEREMONY_CANNOT_VERIFY)
            Faint(Claims.ceremonyLengthRule(size.requiredSourceLength()))
            Faint(Claims.CEREMONY_SECRECY)
            Faint(Claims.CEREMONY_MESSAGE_INDEPENDENCE)
            Faint(Claims.CEREMONY_ALIASING)
        }
        OutlinedTextField(
            value = origin,
            onValueChange = { new -> vm.updateCreate { it.copy(origin = new.take(200)) } },
            label = { Text("Where did this material come from?") },
            modifier = Modifier.fillMaxWidth().testTag("field-origin"),
        )
        SecondaryButton("Choose source files", Modifier.testTag("btn-pick-sources")) {
            pickSources.launch(arrayOf("*/*"))
        }
        for (p in picked) Faint("• ${p.name}")
        // APPEND-ONLY WAS A TRAP. `pickSources` only ever adds, and the form now
        // outlives the composition — so a file chosen by mistake could not be
        // taken back, and was carried into whatever pad the operator made next.
        // Removing a choice must be at least as easy as making one.
        if (picked.isNotEmpty()) {
            SecondaryButton("Clear chosen files", Modifier.testTag("btn-clear-sources")) {
                vm.updateCreate { it.copy(picked = emptyList()) }
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .toggleable(value = declared, role = Role.Checkbox,
                    onValueChange = { on -> vm.updateCreate { it.copy(declared = on) } })
                .testTag("checkbox-declaration"),
            verticalAlignment = Alignment.Top,
        ) {
            Checkbox(checked = declared, onCheckedChange = null)
            Body(Claims.OPERATOR_DECLARATION, Modifier.padding(start = 4.dp, top = 12.dp))
        }
    }

    // ADVANCED — length privacy. Off by default; the daily flow never sees it.
    // Fixed-size records hide a message's exact length by padding every message
    // to the same ciphertext size (§16). The cost is real and stated plainly.
    Rule()
    Details("Advanced") {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .toggleable(value = fixedLength, role = Role.Checkbox,
                    onValueChange = { on -> vm.updateCreate { it.copy(fixedLength = on) } })
                .testTag("checkbox-fixed-length"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = fixedLength, onCheckedChange = null)
            Body("Hide exact message lengths", Modifier.padding(start = 4.dp))
        }
        Faint(
            "Every message uses the same size, so its exact length is hidden. The cost: each message spends the " +
                "full size from the pad, even a short one. The number of messages and their timing are still visible.",
        )
        if (fixedLength) {
            OutlinedTextField(
                value = fixedSize,
                onValueChange = { new ->
                    vm.updateCreate { it.copy(fixedSize = new.filter { c -> c.isDigit() }.take(7)) }
                },
                label = { Text("Message size (bytes)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().testTag("field-fixed-size"),
            )
        }
    }

    // THE CEILING IS THE LOWER OF THE PAD'S CAPACITY AND THE ENGINE'S LIMIT.
    // This used to compare against `size.encryptionBytes` alone, which on the
    // Large preset accepted values four times what the engine would carry. See
    // FixedRecordIntake, where the rule now lives so it can be tested.
    val recordBytes: Int? = FixedRecordIntake.recordBytes(fixedLength, fixedSize, size.encryptionBytes)
    val recordValid = FixedRecordIntake.isUsable(fixedLength, fixedSize, size.encryptionBytes)

    Spacer(Modifier.height(4.dp))
    val ready = (if (external) declared && picked.isNotEmpty() else true) && recordValid
    PrimaryButton(
        text = if (state.busy) "Creating…" else "Create pad",
        modifier = Modifier.testTag("btn-submit-create"),
        enabled = ready,
        busy = state.busy,
    ) {
        if (external) vm.createPadFromFiles(label, size, picked, recordBytes)
        else vm.createPadFromDevice(label, size, recordBytes)
    }
    if (external && (!declared || picked.isEmpty())) {
        Faint("Choose at least one file and confirm the statement above.")
    }
    if (fixedLength && !recordValid) {
        Faint(FixedRecordIntake.explanation(size.encryptionBytes))
    }
    Faint("Nothing leaves this device. Creating a pad makes no network connection.")
}

/* ---- add a shared pad -------------------------------------------------------- */

@Composable
fun AddPadScreen(state: UiState, vm: PadViewModel) {
    var label by remember { mutableStateOf("") }
    val pick = rememberOpenDocument { uri -> vm.importPad(label, uri) }

    BackLink("Home") { vm.back() }
    ScreenTitle("Add a shared pad", Modifier.testTag("title-add"))
    Body("The other person made a pad and gave you the pad file. Add it here and you can both start messaging.")
    BannerArea(state, vm)

    OutlinedTextField(
        value = label,
        onValueChange = { label = it.take(60) },
        label = { Text("Name this pad") },
        placeholder = { Text("e.g. Chat with Sam") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth().testTag("field-add-name"),
    )
    PrimaryButton("Choose the pad file", Modifier.testTag("btn-pick-bundle"), busy = state.busy) {
        // The picker filter is a convenience only. Whatever comes back is
        // treated as hostile: read with a hard ceiling, then validated whole by
        // the engine before any of it becomes active.
        pick.launch(arrayOf("application/json", "application/octet-stream", "text/plain", "*/*"))
    }
    Faint(Claims.DELIVERY_ESSENTIAL)
}

/* ---- the pad ------------------------------------------------------------------ */

@Composable
fun PadScreen(state: UiState, vm: PadViewModel) {
    val summary = state.current
    val pairId = state.currentPairId

    BackLink("Home") { vm.back() }
    ScreenTitle(summary?.label?.ifBlank { "Untitled pad" } ?: "Pad", Modifier.testTag("title-pad"))
    BannerArea(state, vm)

    if (pairId == null) {
        Muted("No pad is open.")
        return
    }
    if (summary == null) {
        Callout(Tone.Danger, "This pad is not available") {
            Body("It may have been disabled, or its files may be damaged.")
        }
        return
    }

    // NULL WHEN THE PAD CANNOT SAY which half is ours, and rendered as unknown
    // rather than guessed. `sendDirection` used to resolve a null role to B->A,
    // so the headline number was the wrong half's budget — stated confidently.
    val sending = state.sendDirection?.let { summary.meters.getValue(it) }
    val frozen = summary.meters.values.any { it.frozen }

    if (sending == null) {
        // THE SEND VERB ALREADY REFUSES on a null role (`role-unknown`); this is
        // the screen saying so before the operator writes a message, rather than
        // after. The prompt names the two routes that DO record which half is
        // yours, and there is deliberately no control here that sets one.
        Callout(Tone.Warn, "TruePad cannot tell which half of this pad is yours") {
            Body(PartyRole.UNKNOWN_ORIGIN_PROMPT)
        }
    }

    if (frozen) {
        Callout(Tone.Warn, "This pad is paused", Modifier.testTag("callout-paused")) {
            Body(
                "Too many messages failed to verify, so TruePad paused this pad. Resume it only if you trust " +
                    "that those failures were harmless.",
            )
            SecondaryButton("Resume pad", Modifier.testTag("btn-resume")) { vm.clearFreeze(pairId) }
        }
    }

    // DISABLED WHEN THE PAD CANNOT SAY WHICH HALF IS OURS, as the iPhone edition
    // already does. `send` and `open` both fail closed on a null role, but only
    // after the operator has opened a screen and written a whole message — the
    // refusal was correct and arrived at the worst possible moment.
    val roleKnown = state.role != null
    FullWidth {
        PrimaryButton("Send message", Modifier.testTag("btn-send"), enabled = !frozen && roleKnown) {
            vm.navigate(Screen.Send)
        }
        SecondaryButton("Open message", Modifier.testTag("btn-open"), enabled = !frozen && roleKnown) {
            vm.navigate(Screen.Open)
        }
    }

    Rule()
    SectionTitle("Pad details")
    // maxRemainingSends, NOT remainingRecords. On a fixed store every send spends
    // a whole F-byte record, so the encryption budget bounds the count and the raw
    // record total overstates it — see DirectionMeters in truepad-storage.
    KeyValue(
        "Messages you can still send",
        sending?.maxRemainingSends?.toString()
            ?: "Unknown — TruePad cannot tell which half is yours",
    )
    KeyValue("Created", summary.createdAt.take(10).ifBlank { "—" })

    Rule()
    SectionTitle("Share this pad")
    // GATED ON THE PAD'S DURABLE HANDOFF STATE, not rendered unconditionally.
    //
    // Both routes used to be offered to every pad. The sealed route is refused by
    // the engine under the pair lock, so nothing was duplicated — but only after
    // the other person had generated a receive code, sent it, and both had
    // compared twelve words. The physical route is NOT backstopped: `exportPair`
    // lets a pad that already carries a Physical marker through, so a second raw
    // pad file really is produced, and the sentence under the button promising a
    // pad "can be given only once, whichever way you choose" was not something
    // the engine enforced. Withholding the offer is what makes it true.
    if (state.mayHandOff) {
        Muted("The other person needs a copy of this pad before you can message each other.")
        // THE SECURE ROUTE IS THE OBVIOUS ONE. It used to take two taps and a screen
        // that led with "Save as a file", so the ordinary way to give someone a pad
        // was the one an operator found second.
        PrimaryButton("Send securely to a receive code", Modifier.testTag("btn-share-sealed")) {
            vm.startSendSealed()
        }
        Faint(
            "Ask the other person to open TruePad and create a receive code. Have them send that code " +
                "to you, then paste or scan it here.",
        )
        SecondaryButton("Give this pad to someone", Modifier.testTag("btn-give-pad")) { vm.startGive() }
        Faint("You can also hand it over as a file in person. A pad can be given only once, whichever way you choose.")
    } else {
        Muted(
            state.handOffRefusal
                ?: "TruePad could not read this pad's handoff state, so it will not offer to hand " +
                    "it over. Nothing about the pad has been changed.",
            Modifier.testTag("handoff-refused"),
        )
        // THE COMMITTED PACKAGE STAYS REACHABLE. Sealing writes the package to
        // disk and the engine hands back those exact bytes for the same receive
        // request. Hiding this is what stranded a pad whose operator dismissed
        // the sheet before saving the file; the RAW pad stays blocked either way,
        // which is the part that matters for reuse.
        if (state.mayReshareSealed) {
            SecondaryButton("Hand over the same sealed file", Modifier.testTag("btn-reshare-sealed")) {
                vm.startSendSealed()
            }
        }
    }

    Rule()
    SecondaryButton("Security", Modifier.testTag("btn-security")) { vm.navigate(Screen.Details) }
    QuietDangerButton("Disable this pad", Modifier.testTag("btn-disable")) { vm.navigate(Screen.Remove) }
}

/* ---- send ---------------------------------------------------------------------- */

@Composable
fun SendScreen(state: UiState, vm: PadViewModel) {
    var text by remember { mutableStateOf("") }
    val pairId = state.currentPairId ?: return
    val context = localContext()

    BackLink("Pad") { vm.back() }
    ScreenTitle("Send message", Modifier.testTag("title-send"))
    BannerArea(state, vm)

    val result = state.lastResult
    if (result is OpResult.Sent) {
        SectionTitle("Encrypted message ready")
        Muted("Send this to the other person over any channel. Only they can open it.")
        Callout(Tone.Warn, "This is the only copy") {
            Body(
                "The pad material for this message is already used. If you leave without sending it, the message " +
                    "is lost — the pad cannot make it again.",
            )
        }
        // THE COMPACT FORM IS WHAT A PERSON IS GIVEN. The engine still emits
        // canonical JSON and that is still what is authenticated; this decides
        // which spelling a human is handed, and keeps the other one one tap away.
        // Null only if the compact form does not round-trip, in which case the
        // canonical envelope is shown and works exactly as before.
        val shown = remember(result.envelope) {
            PublicTransport.envelope(result.envelope)?.text ?: result.envelope
        }
        SelectionContainer {
            Text(
                shown,
                style = EnvelopeStyle,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp)
                    .testTag("envelope-output")
                    // A screen reader reading 400 characters of hex helps nobody.
                    // The content is offered as a labelled unit; the buttons are
                    // how it is actually used.
                    .clearAndSetSemantics { contentDescription = "The encrypted message, ready to send." },
            )
        }
        FullWidth {
            // EXACTLY THE DISPLAYED VALUE. Copy and Share both take `shown`, so
            // the screen cannot hand over a different spelling from the one the
            // operator is looking at.
            PrimaryButton("Copy", Modifier.testTag("btn-copy-envelope")) {
                context.copySensitiveText("TruePad encrypted message", shown, Egress.PUBLIC_TEXT)
            }
            SecondaryButton("Share", Modifier.testTag("btn-share-envelope")) {
                context.shareEncryptedMessage(shown, Egress.PUBLIC_TEXT)
            }
            SecondaryButton("Back to pad", Modifier.testTag("btn-back-to-pad")) { vm.clearResult(); vm.back() }
        }
        if (shown != result.envelope) {
            Details("Technical form") {
                SelectionContainer {
                    Text(
                        result.envelope,
                        style = EnvelopeStyle,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("envelope-json")
                            .clearAndSetSemantics {
                                contentDescription = "The same message in its canonical JSON form."
                            },
                    )
                }
            }
        }
        Faint(Claims.CLIPBOARD_WARNING)
        return
    }

    OutlinedTextField(
        value = text,
        onValueChange = { text = it },
        label = { Text("Message") },
        placeholder = { Text("Type your message…") },
        minLines = 4,
        modifier = Modifier.fillMaxWidth().testTag("field-message"),
    )
    Faint("Sending permanently uses part of this pad.")
    PrimaryButton(
        text = "Encrypt message",
        modifier = Modifier.testTag("btn-encrypt"),
        enabled = text.isNotBlank(),
        busy = state.busy,
    ) {
        vm.send(pairId, state.role, text)
    }
}

/* ---- open ----------------------------------------------------------------------- */

@Composable
fun OpenScreen(state: UiState, vm: PadViewModel) {
    var text by remember { mutableStateOf("") }
    val pairId = state.currentPairId ?: return
    val context = localContext()

    BackLink("Pad") { vm.back() }
    ScreenTitle("Open message", Modifier.testTag("title-open"))
    BannerArea(state, vm)

    val result = state.lastResult
    if (result is OpResult.Opened) {
        // On success the plaintext IS the screen. No cryptographic status
        // wrapped around it, no badge, no ceremony — the released rule.
        SectionTitle("Message")
        // NOT INSIDE A SelectionContainer, and this is the same decision iOS made
        // and wrote down. Removing the Copy button is not the policy if a
        // long-press and "Copy" reaches the same clipboard: the screen would say
        // "there is no copy for it" while offering one through the platform
        // instead of through TruePad. The ENVELOPE on the Send screen keeps its
        // SelectionContainer, because it is public transport and copying it is
        // the workflow.
        //
        // TalkBack is unaffected — the text is still read; only the drag-to-select
        // gesture is declined.
        Body(result.plaintext, Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("plaintext-output"))
        FullWidth {
            SecondaryButton("Back to pad") { vm.clearResult(); vm.back() }
        }
        // NO COPY. The decrypted message is on the screen and stays there. The
        // clipboard is readable by any app with focus, is kept in a platform
        // history and syncs across the operator's devices — and this screen's own
        // CLIPBOARD_WARNING conceded that the sensitive-clip mark "does not stop
        // another app from reading the clipboard". A copy adds a SECOND copy of
        // the one thing the pad exists to protect, and none is needed to read it.
        // iOS has refused this since its Open screen was written; this is Android
        // adopting the same rule. See Egress.kt.
        //
        // CLIPBOARD_WARNING is gone with the button it qualified: a warning about
        // a clipboard nothing writes to would be describing a risk this screen no
        // longer takes. The narrower true sentence replaces it.
        Faint(Claims.PLAINTEXT_STAYS_HERE)
        Details("Details") {
            Faint(
                "The tag verified before any byte was released, and this message's record is now retired — it " +
                    "cannot be opened a second time.",
            )
        }
        return
    }

    OutlinedTextField(
        value = text,
        onValueChange = { text = it },
        label = { Text("Encrypted message") },
        placeholder = { Text("Paste the encrypted message here…") },
        minLines = 4,
        modifier = Modifier.fillMaxWidth().testTag("field-envelope"),
    )
    PrimaryButton(
        text = "Open message",
        modifier = Modifier.testTag("btn-do-open"),
        enabled = text.isNotBlank(),
        busy = state.busy,
    ) {
        vm.open(pairId, state.role, text.trim())
    }
}

/* ---- security (level 3) ----------------------------------------------------------- */

@Composable
fun DetailsScreen(state: UiState, vm: PadViewModel) {
    val summary = state.current

    BackLink("Pad") { vm.back() }
    ScreenTitle("Security", Modifier.testTag("title-security"))
    Faint("Which half of each pad is yours, and what remains on it.")
    BannerArea(state, vm)

    if (summary == null) {
        Muted("No pad is open.")
        return
    }

    SectionTitle("You are")
    // DERIVED, NOT CHOSEN — when the pad can say. It used to be a free radio with
    // a global default of Alice for every pad, so two devices holding one pair
    // both sent on the same half and spent the same one-time material. The pad's
    // own origin decides: created here -> Alice, imported -> Bob.
    if (state.roleWasDerived) {
        Text(
            if (state.role == Party2.A) "Alice" else "Bob",
            Modifier.testTag("role-derived"),
            style = MaterialTheme.typography.bodyLarge,
        )
        Faint(
            "TruePad worked this out from how this pad reached this device, so it is not a " +
                "setting. Both halves of a pair must not be the same person: if they were, " +
                "both devices would spend the same pad material."
        )
    } else {
        // NO PICKER. This screen used to offer Alice/Bob radios one line under a
        // prompt that says "there is nothing for you to set by hand — a role you
        // picked would be a guess wearing a different name". The prompt was right
        // and the control was the defect: it is a SECOND role authority beside the
        // pad's origin, which is the architecture the cross-copy reuse fix exists
        // to prevent, and the Browser edition refused to add one for that reason
        // (src/browser/ui/role.ts). Unknown refuses; it does not delegate.
        Faint(PartyRole.UNKNOWN_ORIGIN_PROMPT)
    }
    Faint("The two halves of a pad are separate. You send on one and receive on the other; the other person is the mirror of this.")

    for ((direction, m) in summary.meters) {
        Rule()
        SectionTitle(direction.wire)
        KeyValue("Message packaging", FixedRecordIntake.recordModeLabel(m.record))
        KeyValue("Messages left", m.maxRemainingSends.toString())
        KeyValue("Authentication records left", m.remainingRecords.toString())
        KeyValue("Bytes left", m.remainingBytes.toString())
        KeyValue("Limited by", m.limitedBy.lowercase())
        KeyValue("Failed verifications", m.failureCount.toString())
        KeyValue("Paused", if (m.frozen) "yes" else "no")
        KeyValue("Rollback protection", m.witnessKind.wire)
        KeyValue("Rollback state", m.witnessState.wire)
        // The DERIVED deployment assessment (§ shannon). Never a stored verdict;
        // recomputed from live facts every time this screen is shown. On Android
        // it is always INSUFFICIENT EVIDENCE or NOT ELIGIBLE — never a positive
        // maximum-assurance verdict — and the reason is shown beside the label so
        // the label can never be read alone.
        KeyValue("Assessment", ASSESSMENT_LABEL.getValue(m.deployment.assessment))
        KeyValue("Source", SOURCE_LABEL.getValue(m.sourceClass))
        m.deployment.knownReason?.let { Faint(it) }
    }

    Rule()
    SectionTitle("What the assessment means")
    Faint(Claims.DEPLOYMENT_CONTEXT)
    Faint(Claims.DEPLOYMENT_UNPROVEN_HEADING)
    for (premise in UNPROVEN_PREMISES) Faint("• $premise")

    Rule()
    SectionTitle("On this device")
    Faint(Claims.BACKUP_NOTE)
    Faint(Claims.SCREEN_CAPTURE_NOTE)
    Faint(Claims.CLIPBOARD_WARNING)
    Rule()
    SectionTitle("Sharing the pad file")
    Faint(Claims.DELIVERY_ESSENTIAL)
    Faint(Claims.DELIVERY_CEREMONY)
    Faint(Claims.DELIVERY_NOT_ITS)
}

/* ---- disable ------------------------------------------------------------------------ */

@Composable
fun RemoveScreen(state: UiState, vm: PadViewModel) {
    var understood by remember { mutableStateOf(false) }
    val pairId = state.currentPairId ?: return
    val name = state.current?.label?.ifBlank { "this pad" } ?: "this pad"

    BackLink("Pad") { vm.back() }
    ScreenTitle("Disable \"$name\"?", Modifier.testTag("title-disable"))
    BannerArea(state, vm)

    Body("This permanently disables this pad. It will no longer send or open any messages, and there is no way to bring it back.")
    Faint(dev.systemslibrarian.truepad.storage.DESTROY_LIMITATION)
    Faint("Removing takes this pad out of TruePad for good. It stays permanently disabled, and this pad file can never be added back.")

    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .toggleable(value = understood, role = Role.Checkbox, onValueChange = { understood = it })
            .testTag("checkbox-understood"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = understood, onCheckedChange = null)
        Body("I understand this cannot be undone.", Modifier.padding(start = 4.dp))
    }

    // Inert until the box is ticked. No animation, no softened language, no undo.
    PrimaryButton(
        text = "Disable this pad",
        modifier = Modifier.testTag("btn-confirm-disable"),
        enabled = understood,
        busy = state.busy,
    ) {
        // The engine requires the pairId as the confirmation token. The UI
        // supplies it from the pad on screen, exactly as the released Browser
        // Edition does: the operator confirms by having opened this pad, and the
        // token is never echoed for them to copy.
        vm.removePad(pairId, pairId)
    }
    SecondaryButton("Cancel", Modifier.testTag("btn-cancel-disable")) { vm.back() }
}
