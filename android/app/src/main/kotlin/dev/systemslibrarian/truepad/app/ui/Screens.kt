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
import dev.systemslibrarian.truepad.core.ASSESSMENT_LABEL
import dev.systemslibrarian.truepad.core.SOURCE_LABEL
import dev.systemslibrarian.truepad.core.UNPROVEN_PREMISES
import dev.systemslibrarian.truepad.app.OpResult
import dev.systemslibrarian.truepad.app.PadSize
import dev.systemslibrarian.truepad.app.PadViewModel
import dev.systemslibrarian.truepad.app.PickedSource
import dev.systemslibrarian.truepad.app.Screen
import dev.systemslibrarian.truepad.app.UiState
import dev.systemslibrarian.truepad.app.AndroidStorage
import dev.systemslibrarian.truepad.app.copySensitiveText
import dev.systemslibrarian.truepad.app.shareEncryptedMessage
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
                    padSummary.meters.values.all { it.remainingRecords == 0L } -> "Exhausted"
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
    var label by remember { mutableStateOf("") }
    var size by remember { mutableStateOf(PadSize.Medium) }
    var external by remember { mutableStateOf(false) }
    var declared by remember { mutableStateOf(false) }
    var origin by remember { mutableStateOf("") }
    var picked by remember { mutableStateOf(listOf<PickedSource>()) }

    val pickSources = rememberOpenDocuments { uris ->
        val existing = picked.map { it.uri.toString() }.toSet()
        val added = uris.filterNot { it.toString() in existing }.map { uri ->
            PickedSource(
                uri = uri,
                name = AndroidStorage.sanitiseDisplayName(uri.lastPathSegment, "source"),
                declaredOrigin = origin.trim().ifBlank { "declared by operator at creation; not verified by this tool" },
            )
        }
        picked = picked + added
    }

    BackLink("Home") { vm.back() }
    ScreenTitle("Create a pad", Modifier.testTag("title-create"))
    Body("A pad lets two people message each other privately. You make it here, then share one copy with the other person.")
    BannerArea(state, vm)

    OutlinedTextField(
        value = label,
        onValueChange = { label = it.take(60) },
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
                    onClick = { size = option },
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
            .selectable(selected = !external, role = Role.RadioButton, onClick = { external = false })
            .testTag("radio-device"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = !external, onClick = null)
        Text("Generate for me", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 4.dp))
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .selectable(selected = external, role = Role.RadioButton, onClick = { external = true })
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
            onValueChange = { origin = it.take(200) },
            label = { Text("Where did this material come from?") },
            modifier = Modifier.fillMaxWidth().testTag("field-origin"),
        )
        SecondaryButton("Choose source files", Modifier.testTag("btn-pick-sources")) {
            pickSources.launch(arrayOf("*/*"))
        }
        for (p in picked) Faint("• ${p.name}")

        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .toggleable(value = declared, role = Role.Checkbox, onValueChange = { declared = it })
                .testTag("checkbox-declaration"),
            verticalAlignment = Alignment.Top,
        ) {
            Checkbox(checked = declared, onCheckedChange = null)
            Body(Claims.OPERATOR_DECLARATION, Modifier.padding(start = 4.dp, top = 12.dp))
        }
    }

    Spacer(Modifier.height(4.dp))
    val ready = if (external) declared && picked.isNotEmpty() else true
    PrimaryButton(
        text = if (state.busy) "Creating…" else "Create pad",
        modifier = Modifier.testTag("btn-submit-create"),
        enabled = ready,
        busy = state.busy,
    ) {
        if (external) vm.createPadFromFiles(label, size, picked) else vm.createPadFromDevice(label, size)
    }
    if (external && !ready) {
        Faint("Choose at least one file and confirm the statement above.")
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

    val sending = summary.meters.getValue(state.sendDirection)
    val frozen = summary.meters.values.any { it.frozen }

    if (frozen) {
        Callout(Tone.Warn, "This pad is paused", Modifier.testTag("callout-paused")) {
            Body(
                "Too many messages failed to verify, so TruePad paused this pad. Resume it only if you trust " +
                    "that those failures were harmless.",
            )
            SecondaryButton("Resume pad", Modifier.testTag("btn-resume")) { vm.clearFreeze(pairId) }
        }
    }

    FullWidth {
        PrimaryButton("Send message", Modifier.testTag("btn-send"), enabled = !frozen) { vm.navigate(Screen.Send) }
        SecondaryButton("Open message", Modifier.testTag("btn-open"), enabled = !frozen) { vm.navigate(Screen.Open) }
    }

    Rule()
    SectionTitle("Pad details")
    KeyValue("Messages you can still send", sending.remainingRecords.toString())
    KeyValue("Created", summary.createdAt.take(10).ifBlank { "—" })

    Rule()
    SectionTitle("Share this pad")
    Muted("Give the other person their copy. Until they have it, neither of you can read anything the other sends.")
    val save = rememberCreateDocument("application/json") { uri -> vm.exportPad(pairId, uri) }
    SecondaryButton("Save pad file", Modifier.testTag("btn-save-pad-file")) {
        save.launch("truepad-pad.json")
    }
    Faint("Keep the pad file secret — anyone who has it can read these messages.")

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
        SelectionContainer {
            Text(
                result.envelope,
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
            PrimaryButton("Copy", Modifier.testTag("btn-copy-envelope")) {
                context.copySensitiveText("TruePad encrypted message", result.envelope)
            }
            SecondaryButton("Share", Modifier.testTag("btn-share-envelope")) {
                context.shareEncryptedMessage(result.envelope)
            }
            SecondaryButton("Back to pad") { vm.clearResult(); vm.back() }
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
        SelectionContainer {
            Body(result.plaintext, Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("plaintext-output"))
        }
        FullWidth {
            SecondaryButton("Copy", Modifier.testTag("btn-copy-plaintext")) {
                context.copySensitiveText("TruePad message", result.plaintext)
            }
            SecondaryButton("Back to pad") { vm.clearResult(); vm.back() }
        }
        Faint(Claims.CLIPBOARD_WARNING)
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
    Faint("Implementation detail. You never need this to use TruePad.")
    BannerArea(state, vm)

    if (summary == null) {
        Muted("No pad is open.")
        return
    }

    SectionTitle("You are")
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).heightIn(min = 48.dp)
                .selectable(selected = state.role == Party2.A, role = Role.RadioButton) { vm.setRole(Party2.A) }
                .testTag("role-a"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = state.role == Party2.A, onClick = null)
            Text("Alice", Modifier.padding(start = 4.dp), style = MaterialTheme.typography.bodyLarge)
        }
        Row(
            Modifier.weight(1f).heightIn(min = 48.dp)
                .selectable(selected = state.role == Party2.B, role = Role.RadioButton) { vm.setRole(Party2.B) }
                .testTag("role-b"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = state.role == Party2.B, onClick = null)
            Text("Bob", Modifier.padding(start = 4.dp), style = MaterialTheme.typography.bodyLarge)
        }
    }
    Faint("The two halves of a pad are separate. You send on one and receive on the other; the other person is the mirror of this.")

    for ((direction, m) in summary.meters) {
        Rule()
        SectionTitle(direction.wire)
        KeyValue("Messages left", m.remainingRecords.toString())
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
