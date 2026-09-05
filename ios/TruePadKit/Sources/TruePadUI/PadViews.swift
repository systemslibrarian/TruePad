#if os(iOS)
import SwiftUI
import TruePadClaims
import TruePadCore
import TruePadStorage

/* ============================================================================
 * The pad list and one pad's detail.
 *
 * These views are DELIBERATELY THIN. Every decision that could be wrong in a way
 * that matters lives in Presentation.swift, which has no UI import and is tested;
 * what is left here is layout, labels, and calling the engine. That split is what
 * lets CI say something meaningful about a layer it cannot run.
 *
 * ACCESSIBILITY IS NOT DECORATION HERE. A meter that VoiceOver reads as
 * "59, 64, 7, 8" tells a blind operator nothing about whether they can still send
 * a message. Every number that carries a decision is given a label that says what
 * it MEANS. Whether that actually reads well is a human gate (docs/IOS-SECURITY.md),
 * and nothing in this file is evidence that it does.
 * ========================================================================= */

// MARK: - the list

public struct PadListView: View {
    @ObservedObject public var model: PadListModel

    public init(model: PadListModel) { self.model = model }

    public var body: some View {
        NavigationStack {
            List {
                if model.rows.isEmpty {
                    // Deliberately not `ContentUnavailableView`, which is iOS 17.
                    // The package floor is iOS 16, and raising a deployment target
                    // to reach a nicer empty state is a product decision rather
                    // than a compile fix.
                    VStack(alignment: .leading, spacing: 8) {
                        Text("No pads yet").font(.headline)
                        // Says what to DO. The previous copy opened on the expert
                        // path and then called the ordinary one "weaker", which is
                        // the same misleading emphasis the create screen had.
                        Text("A pad is shared between you and one other person. Create one here, "
                             + "or receive one from someone else on the Receive tab.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                    .accessibilityElement(children: .combine)
                }
                ForEach(model.rows) { row in
                    NavigationLink(value: row.pairId) {
                        PadRowView(row: row)
                    }
                    .disabled(row.destroyed)
                }
            }
            .navigationTitle("Pads")
            .navigationDestination(for: String.self) { pairId in
                PadDetailView(model: model.detail(for: pairId))
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { model.startCreating() } label: {
                        Label("Create a pad", systemImage: "plus")
                    }
                }
            }
            .refreshable { model.reload() }
            // ON THE LIST, NOT ON THE NAVIGATION STACK. Popping back from a pad's
            // detail does not re-run the stack's onAppear, so the list could keep
            // showing a snapshot taken before a destroy — a pad that is gone still
            // reading as usable is the wrong direction for this screen to be
            // wrong in.
            .onAppear { model.reload() }
            .alert("TruePad refused", isPresented: $model.showingRefusal) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.refusalMessage ?? "")
            }
        }
    }
}

struct PadRowView: View {
    let row: PadListModel.Row

    var body: some View {
        HStack(spacing: 12) {
            // A destroyed or frozen pad is marked, so the state is visible before
            // the text is read. Colour is never the only carrier — the line below
            // says it in words, and VoiceOver reads the words.
            if row.state.isProblem {
                Image(systemName: row.state == .destroyed ? "trash.slash" : "exclamationmark.triangle")
                    .foregroundStyle(row.state == .destroyed
                                     ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.orange))
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(row.label)
                    .font(.headline)
                    .foregroundStyle(row.destroyed ? .secondary : .primary)
                Text(row.state.line)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        // The row's meaning, not its numbers.
        .accessibilityLabel(row.state.spoken(label: row.label))
    }
}

// MARK: - one pad

public struct PadDetailView: View {
    @ObservedObject public var model: PadDetailModel

    public init(model: PadDetailModel) { self.model = model }

    public var body: some View {
        List {
            // WHAT THE OPERATOR CAME HERE TO DO, FIRST. This screen used to open
            // on two sections of direction meters — offsets, record counts,
            // witness state and the deployment verdict — before it offered a way
            // to write a message. Every one of those numbers is still here, one
            // disclosure down, where it can be read rather than waded through.
            Section("Messages") {
                NavigationLink("Write a message") { SendView(model: model.sendModel()) }
                NavigationLink("Open a message") { OpenView(model: model.openModel()) }
            }

            // The headline number, in the operator's terms.
            Section {
                ForEach(model.meters, id: \.direction) { row in
                    LabeledContent(row.plainDirection(role: model.derivedRole)) {
                        Text(row.remainingLine).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(row.plainDirection(role: model.derivedRole)): \(row.remainingLine)")
                }
            } header: {
                Text("How much is left")
            }

            Section("Handing this pad over") {
                if model.mayHandOff {
                    Button("Save the pad to a file…") { model.exportPad() }
                    Button("Send it by sealed transfer…") { model.beginSealedTransfer() }
                } else {
                    Text(model.handOffRefusal ?? "This pad has already been handed over.")
                        .foregroundStyle(.secondary)
                    // THE SEALED PACKAGE IS STILL REACHABLE. Sealing commits the
                    // package to disk and `sptSeal` returns those exact bytes for
                    // the same receive request. Without this the operator who
                    // dismissed the sheet before saving the file had no way back
                    // to it, and the pad was stranded — the raw pad stays blocked
                    // either way, which is the part that matters for reuse.
                    if model.mayReshareSealed {
                        Button("Hand over the same sealed file…") { model.beginSealedTransfer() }
                    }
                }
                Text(VerbatimText.shareSheetIsACarrier)
                    .font(.footnote).foregroundStyle(.secondary)
            }

            // EVERYTHING TECHNICAL, ORGANISED RATHER THAN REMOVED. Source class,
            // delivery, storage, rollback authority, the evaluator's verdict and
            // the exact counters all still appear, verbatim, one tap down.
            Section {
                DisclosureGroup("Security details") {
                    if let role = model.derivedRole {
                        LabeledContent("This device is party", value: role == .a ? "A" : "B")
                            .accessibilityLabel("This device is party \(role == .a ? "A" : "B") for this pad.")
                    }
                    ForEach(model.meters, id: \.direction) { row in
                        MeterSection(row: row)
                    }
                }
                .accessibilityHint("Exact counters and this pad's deployment assessment.")
            }

            Section {
                NavigationLink("Destroy this pad…") { DestroyView(model: model.destroyModel()) }
                    .foregroundStyle(.red)
                    .accessibilityHint("Permanently destroys this pad.")
            } footer: {
                // VERBATIM. Never paraphrased.
                Text(VerbatimText.destructionLimitation)
            }
        }
        .navigationTitle(model.label)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $model.fileToShare, onDismiss: { model.discardSharedFile() }) { file in
            ShareSheet(items: [file.url])
        }
        // THE SENDER HALF OF THE CEREMONY. `SealView` existed, was tested, and was
        // presented by nothing at all until the physical two-device run found it.
        .sheet(isPresented: $model.sealing, onDismiss: { model.reload() }) {
            NavigationStack { SealView(model: model.sealModel()) }
        }
        .alert("TruePad refused", isPresented: $model.showingRefusal) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.refusalMessage ?? "")
        }
        .onAppear { model.reload() }
    }
}

struct MeterSection: View {
    let row: MeterRow

    var body: some View {
        LabeledContent("Messages you can still send", value: "\(row.maxRemainingSends)")
            .accessibilityLabel("You can still send \(row.maxRemainingSends) "
                                + "\(row.maxRemainingSends == 1 ? "message" : "messages") "
                                + "in this direction.")

        LabeledContent("Pad material left",
                       value: "\(row.encryptionCapacity - row.encryptionUsed) of "
                              + "\(row.encryptionCapacity) bytes")
            .accessibilityLabel("\(row.encryptionCapacity - row.encryptionUsed) bytes of pad "
                                + "material remain, out of \(row.encryptionCapacity).")

        LabeledContent("Records left",
                       value: "\(row.recordsCapacity - row.recordsUsed) of \(row.recordsCapacity)")
            .accessibilityLabel("\(row.recordsCapacity - row.recordsUsed) authentication records "
                                + "remain, out of \(row.recordsCapacity). Each message uses one.")

        LabeledContent("Runs out first", value: row.limitedBy.capitalized)
            .accessibilityLabel("Whichever runs out first: \(row.limitedBy.lowercased()).")

        if row.frozen {
            Label("Frozen after repeated verification failures", systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .accessibilityLabel("This pad is frozen after repeated verification failures. "
                                    + "Nothing was consumed. You can clear the freeze to resume.")
        }

        VStack(alignment: .leading, spacing: 4) {
            // DERIVED on every render, from live facts. Never stored.
            Text(row.verdict).font(.headline)
            if let why = row.whyNotStronger {
                Text(why).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Deployment assessment: \(row.verdict)."
                            + (row.whyNotStronger.map { " Why not stronger: \($0)" } ?? ""))
    }
}

// MARK: - destroy

public struct DestroyView: View {
    @ObservedObject public var model: DestroyModel

    public init(model: DestroyModel) { self.model = model }

    public var body: some View {
        Form {
            Section {
                // The prompt NEVER contains the value it asks for.
                Text(DestroyPrompt.text(forUnreadablePair: model.pairIsUnreadable))
                TextField("Confirmation", text: $model.typed)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Type the pad's identifier to confirm destruction. "
                                        + "TruePad will not show it to you here.")
            }
            Section {
                Button("Destroy this pad", role: .destructive) { model.destroy() }
                    .disabled(model.typed.isEmpty)
            } footer: {
                Text(VerbatimText.destructionLimitation)
            }
        }
        .navigationTitle("Destroy")
        .alert("TruePad refused", isPresented: $model.showingRefusal) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.refusalMessage ?? "")
        }
    }
}
#endif
